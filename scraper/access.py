"""Who may use the tool, and who they share with.

Two questions, kept apart because they are different:

    allowed?   is this email in app_user — may it call the API at all
    peers      whose reviews and saved views does it see — everyone sharing a
               group with it, plus itself

A group is a household: the people looking for one house together. Sharing is
by membership rather than by a flag on each review, so adding someone shows
them the whole history at once and removing them stops it, without touching a
single review row.

The allowlist lives in the database rather than in an environment variable
because adding the person you are buying a house with should not require
editing a systemd unit and restarting a service. SCRAPER_OWNER_EMAIL remains as
the bootstrap: it is always allowed, and is inserted automatically so an empty
table cannot lock everyone out.
"""
from __future__ import annotations

import os
from datetime import datetime

from .db import connect, init_db

OWNER_EMAIL = os.environ.get("SCRAPER_OWNER_EMAIL", "arnaud@linalgo.com").lower()


def _now() -> str:
    return datetime.now().isoformat()


def bootstrap() -> None:
    """Make sure the owner exists, so a fresh database has a way in."""
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO app_user (email, name, added_by, added_at) "
            "VALUES (?,?,?,?)", (OWNER_EMAIL, "owner", "bootstrap", _now()))
        conn.commit()
    finally:
        conn.close()


def is_allowed(email: str) -> bool:
    email = (email or "").lower()
    if not email:
        return False
    if email == OWNER_EMAIL:
        return True                      # the bootstrap can never be locked out
    conn = connect()
    try:
        return conn.execute("SELECT 1 FROM app_user WHERE email = ?",
                            (email,)).fetchone() is not None
    finally:
        conn.close()


def seen(email: str, name: str | None = None, uid: str | None = None) -> None:
    """Record a sign-in. Fills in the name and uid Google gave us, which is how
    a row added as a bare email address acquires a human name."""
    conn = init_db()
    try:
        conn.execute(
            "UPDATE app_user SET last_seen = ?, "
            "name = COALESCE(NULLIF(?, ''), name), uid = COALESCE(?, uid) "
            "WHERE email = ?", (_now(), name or "", uid, (email or "").lower()))
        conn.commit()
    finally:
        conn.close()


def groups_of(email: str) -> list[dict]:
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(
            "SELECT g.id, g.name, m.role FROM user_group g "
            "JOIN group_member m ON m.group_id = g.id "
            "WHERE m.email = ? ORDER BY g.name", ((email or "").lower(),))]
    finally:
        conn.close()


def peers(email: str) -> set[str]:
    """Every email whose reviews and saved views this person may see.

    Always includes themselves, so someone in no group still sees their own
    work — a new user is not an error state.
    """
    email = (email or "").lower()
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT m2.email FROM group_member m1 "
            "JOIN group_member m2 ON m2.group_id = m1.group_id "
            "WHERE m1.email = ?", (email,)).fetchall()
    finally:
        conn.close()
    return {r["email"] for r in rows} | {email}


# --- management -------------------------------------------------------------

def add_user(email: str, name: str | None, by: str) -> dict:
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO app_user (email, name, added_by, added_at) "
            "VALUES (?,?,?,?)", ((email or "").lower(), name, by, _now()))
        conn.commit()
        return {"email": (email or "").lower(), "name": name}
    finally:
        conn.close()


def remove_user(email: str) -> dict:
    """Remove access. Reviews stay: they are a record of what was decided, and
    deleting them would quietly change the shortlist for everyone else."""
    email = (email or "").lower()
    if email == OWNER_EMAIL:
        raise ValueError("the owner cannot be removed")
    conn = init_db()
    try:
        conn.execute("DELETE FROM group_member WHERE email = ?", (email,))
        n = conn.execute("DELETE FROM app_user WHERE email = ?", (email,)).rowcount
        conn.commit()
        return {"removed": n > 0, "email": email}
    finally:
        conn.close()


def create_group(name: str, by: str) -> dict:
    conn = init_db()
    try:
        cur = conn.execute(
            "INSERT INTO user_group (name, created_by, created_at) VALUES (?,?,?)",
            (name, by, _now()))
        gid = cur.lastrowid
        # Whoever makes a group is in it, and can manage it.
        conn.execute("INSERT OR REPLACE INTO group_member (group_id, email, role, added_at) "
                     "VALUES (?,?,?,?)", (gid, by.lower(), "owner", _now()))
        conn.commit()
        return {"id": gid, "name": name}
    finally:
        conn.close()


def add_member(group_id: int, email: str, role: str = "member") -> dict:
    """Adding someone to a group also grants access: the two would otherwise
    drift apart, and a member who cannot sign in is a confusing thing to see in
    the list."""
    email = (email or "").lower()
    conn = init_db()
    try:
        conn.execute("INSERT OR IGNORE INTO app_user (email, added_by, added_at) "
                     "VALUES (?,?,?)", (email, f"group:{group_id}", _now()))
        conn.execute("INSERT OR REPLACE INTO group_member (group_id, email, role, added_at) "
                     "VALUES (?,?,?,?)", (group_id, email, role, _now()))
        conn.commit()
        return {"group_id": group_id, "email": email, "role": role}
    finally:
        conn.close()


def remove_member(group_id: int, email: str) -> dict:
    conn = init_db()
    try:
        n = conn.execute("DELETE FROM group_member WHERE group_id = ? AND email = ?",
                         (group_id, (email or "").lower())).rowcount
        conn.commit()
        return {"removed": n > 0}
    finally:
        conn.close()


def overview(email: str) -> dict:
    """The access picture for one caller: everyone allowed, every group they
    are in and who else is in it."""
    conn = connect()
    try:
        users = [dict(r) for r in conn.execute(
            "SELECT email, name, added_at, last_seen FROM app_user ORDER BY email")]
        groups = []
        for g in conn.execute("SELECT id, name, created_by FROM user_group ORDER BY name"):
            members = [dict(r) for r in conn.execute(
                "SELECT m.email, m.role, u.name FROM group_member m "
                "LEFT JOIN app_user u ON u.email = m.email "
                "WHERE m.group_id = ? ORDER BY m.email", (g["id"],))]
            groups.append({**dict(g), "members": members,
                           "mine": any(m["email"] == (email or "").lower() for m in members)})
        return {"users": users, "groups": groups,
                "me": (email or "").lower(), "owner": OWNER_EMAIL,
                "peers": sorted(peers(email))}
    finally:
        conn.close()
