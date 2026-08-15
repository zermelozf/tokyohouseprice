"""Who is calling, verified.

The browser signs in with Firebase (Google) and sends the resulting ID token as
`Authorization: Bearer <token>`. This checks the token's signature against
Google's published keys, so a route guard in the Angular app is a convenience
rather than the protection: the API cannot be curled past it.

Verifying needs no service-account credentials — Firebase ID tokens are RS256
JWTs signed by a Google key whose public certificate is published, and the
project ID is enough to check they were minted for this project:

    iss  https://securetoken.google.com/<project-id>
    aud  <project-id>

Access is an allowlist of email addresses, because the alternative — any Google
account on earth — is not a door you want on a tool that spends money on
crawling and holds your notes about where you might live.
"""
from __future__ import annotations

import os
import time
from typing import Optional

import httpx
import jwt
from fastapi import Header, HTTPException
from jwt import PyJWKClient, PyJWKClientError

# The scraper package lives at the repo root; make it importable from api/.
import sys
from pathlib import Path
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scraper import access  # noqa: E402

PROJECT_ID = os.environ.get("FIREBASE_PROJECT_ID", "tokyohouseprice")
# Overridable so the verification path itself can be tested against a signer
# we control, rather than being taken on trust because it is hard to exercise.
CERT_URL = os.environ.get(
    "FIREBASE_CERT_URL",
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com")
ISSUER = f"https://securetoken.google.com/{PROJECT_ID}"

# Who may use the scraper now lives in the database (scraper.access), so adding
# the person you are buying a house with is a click rather than an edit to a
# systemd unit and a restart. The owner is the bootstrap that can never be
# locked out; SCRAPER_ALLOWED_EMAILS is still honoured and seeded into the
# table on startup, so an existing deployment keeps working.
OWNER_EMAIL = os.environ.get("SCRAPER_OWNER_EMAIL", "arnaud@linalgo.com")
_ENV_ALLOWED = {e.strip().lower() for e in
                os.environ.get("SCRAPER_ALLOWED_EMAILS", "").split(",") if e.strip()}

# Set AUTH_DISABLED=1 to run the API with no login at all. Only sane on a
# machine nobody else can reach, and it is off by default so that "it works on
# my laptop" cannot quietly become "it is open to the internet".
AUTH_DISABLED = os.environ.get("AUTH_DISABLED") == "1"

_jwks: Optional[PyJWKClient] = None


def _jwk_client() -> PyJWKClient:
    global _jwks
    if _jwks is None:
        # PyJWKClient caches the keys and refetches when it meets an unknown
        # kid, which is what Google's rotation needs.
        _jwks = PyJWKClient(CERT_URL, cache_keys=True)
    return _jwks


class User(dict):
    """A verified caller: uid, email, name, picture."""

    @property
    def uid(self) -> str: return self.get("uid", "")

    @property
    def email(self) -> str: return self.get("email", "")

    @property
    def name(self) -> str: return self.get("name") or self.get("email", "")


def verify(token: str) -> User:
    """Decode and check a Firebase ID token. Raises on anything wrong."""
    try:
        key = _jwk_client().get_signing_key_from_jwt(token).key
        claims = jwt.decode(token, key, algorithms=["RS256"],
                            audience=PROJECT_ID, issuer=ISSUER)
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "sign-in expired — sign in again")
    # A token signed by a key Google does not publish raises from the key
    # lookup, not from decoding, and PyJWKClientError is not an
    # InvalidTokenError — so letting it through turned a rejected token into a
    # 500 with a stack trace. Anything that fails to verify is a 401.
    except (jwt.InvalidTokenError, PyJWKClientError, httpx.HTTPError) as exc:
        raise HTTPException(401, f"invalid sign-in: {exc}")
    except Exception as exc:                      # malformed header, bad base64…
        raise HTTPException(401, f"invalid sign-in: {exc}")
    # Firebase puts the subject in `sub`; `auth_time` guards against a token
    # minted before the user actually authenticated.
    if not claims.get("sub"):
        raise HTTPException(401, "token has no subject")
    if claims.get("auth_time", 0) > time.time() + 60:
        raise HTTPException(401, "token is not valid yet")
    return User(uid=claims["sub"], email=(claims.get("email") or "").lower(),
                name=claims.get("name"), picture=claims.get("picture"),
                email_verified=claims.get("email_verified", False))


def current_user(authorization: str = Header(default="")) -> User:
    """FastAPI dependency: the verified caller, or 401/403.

    With AUTH_DISABLED=1 it returns a local stand-in so the tool still runs
    offline, and says so in the identity rather than pretending to be someone.
    """
    if AUTH_DISABLED:
        return User(uid="local", email=OWNER_EMAIL.lower(), name="local (auth disabled)")
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "sign in to use the scraper")
    user = verify(authorization.split(" ", 1)[1].strip())
    if not access.is_allowed(user.email):
        raise HTTPException(403, f"{user.email} is not on the allowlist for this tool")
    # Records the name Google gave us, so a row added as a bare address gains a
    # human name the first time its owner signs in.
    access.seen(user.email, user.name, user.uid)
    return user


def _seed() -> None:
    """Carry SCRAPER_ALLOWED_EMAILS into the table once, then forget it: the
    list is managed in the app from here on."""
    access.bootstrap()
    for email in _ENV_ALLOWED:
        access.add_user(email, None, "env:SCRAPER_ALLOWED_EMAILS")


_seed()
