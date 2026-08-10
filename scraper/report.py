"""Daily crawl report: build it as HTML and mail it through AWS SES.

Runs from cron, independent of the dashboard and the API — it reads the SQLite
DB directly. Delivery is AWS SES in eu-west-1, the account datakokoro's Trigger
Email extension also sends through. Configuration lives in the project-local
`.env`; see scraper/README.md.

    python -m scraper daily-report                     # send it
    python -m scraper daily-report --check             # pre-flight, sends nothing
    python -m scraper daily-report --test-send         # 3-line sender test
    python -m scraper daily-report --dry-run --out /tmp/report.html
"""

from __future__ import annotations

import html
import json
import os
from datetime import date, datetime
from email.mime.application import MIMEApplication
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from . import config, mapimage, query
from .config import DATA_DIR

def _recipients(raw: str | None) -> list[str]:
    """Split a comma-separated recipient list, dropping blanks."""
    return [a.strip() for a in (raw or "").split(",") if a.strip()]


DEFAULT_TO = _recipients(os.environ.get(
    "REPORT_TO_EMAIL", "arnaud.rachez@gmail.com,ms.estelle.dumas@gmail.com"))

# Linked from the map image, so the mail is one click from the live dashboard.
DASHBOARD_URL = os.environ.get(
    "REPORT_DASHBOARD_URL", "http://stellar-dev/tokyohouseprice/scraper")
# No default sender on purpose. SES only accepts a verified identity, and a
# stale default (a domain from a retired project) fails at send time with an
# opaque SES error — better to say so up front.
# datakokoro.com is the sending domain: it is verified in this SES account
# already, since the Trigger Email extension delivers newsletter mail from it.
DEFAULT_FROM = os.environ.get("REPORT_FROM_EMAIL", "noreply@datakokoro.com")

# eu-west-1, matching the SES account datakokoro's Trigger Email extension
# already delivers through. A verified identity is per-region, so pointing this
# at the wrong region fails even when the address is verified elsewhere.
SES_REGION = os.environ.get("AWS_SES_REGION_NAME", "eu-west-1")

# "ses"  -> SES API via boto3, using IAM credentials (access key + secret).
# "smtp" -> SES SMTP endpoint, using the SMTP username/password pair. These are
#           NOT interchangeable: an SES SMTP password is derived from an IAM
#           secret key, so having one does not give you the other. Use whichever
#           credential you actually hold.
TRANSPORT = os.environ.get("REPORT_TRANSPORT", "ses").lower()

SMTP_HOST = os.environ.get("SMTP_HOST", f"email-smtp.{SES_REGION}.amazonaws.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASSWORD = os.environ.get("SMTP_PASSWORD")

JOBS_PATH = DATA_DIR / "scheduler.json"


# --------------------------------------------------------------- gathering

def _jobs() -> list[dict]:
    """Scheduler state, so the email can say whether each crawler actually ran."""
    try:
        return json.loads(JOBS_PATH.read_text())
    except Exception:
        return []


def gather(target: str | None = None) -> dict:
    """Everything the email needs: the latest crawl, its diff, and the map."""
    dates = query.crawl_dates()
    if not dates:
        return {"dates": [], "latest": None, "diff": None, "jobs": _jobs()}

    latest = target or dates[0]["date"]
    previous = next((d["date"] for d in dates if d["date"] < latest), None)

    diff = query.crawl_diff(previous, latest) if previous else None
    points = query.map_points({"categories": [], "wards": [], "limit": 5000,
                               "date_from": latest, "date_to": latest})

    return {
        "dates": dates,
        "latest": next((d for d in dates if d["date"] == latest), None),
        "previous": previous,
        "diff": diff,
        "points": points,
        "jobs": _jobs(),
        "summary": query.db_summary(),
    }


# ------------------------------------------------------------------ render

_CSS_TABLE = ("width:100%;border-collapse:collapse;font-size:13px;"
              "font-family:-apple-system,Segoe UI,sans-serif")
_CSS_TH = ("text-align:left;padding:6px 8px;border-bottom:1px solid #e5e7eb;"
           "color:#6b7280;font-size:11px;text-transform:uppercase;"
           "letter-spacing:.04em")
_CSS_TD = "padding:6px 8px;border-bottom:1px solid #f3f4f6;vertical-align:top"


def _esc(v) -> str:
    return html.escape(str(v)) if v is not None else "&mdash;"


def _yen(v) -> str:
    return f"¥{int(v):,}" if v else "&mdash;"


def _card(value, label: str, color: str) -> str:
    return (f'<td style="padding:10px 6px;text-align:center;border:1px solid {color}33;'
            f'border-radius:8px;background:{color}11">'
            f'<div style="font-size:22px;font-weight:700;color:#111">{value}</div>'
            f'<div style="font-size:11px;color:#6b7280;text-transform:uppercase;'
            f'letter-spacing:.04em">{label}</div></td>')


def _rows_table(rows: list[dict], cols: list[tuple[str, str]], limit: int = 25) -> str:
    if not rows:
        return '<p style="color:#6b7280;font-size:13px">None.</p>'

    head = "".join(f'<th style="{_CSS_TH}">{c[1]}</th>' for c in cols)
    body = []
    for r in rows[:limit]:
        cells = []
        for field, _ in cols:
            if field == "title":
                # Agent copy, so it is long and says little — clip it and let
                # the numbers lead. Truncated here rather than with CSS, which
                # mail clients honour unevenly.
                raw = (r.get("title") or r.get("address") or "").strip()
                text = _esc(raw[:38] + "…" if len(raw) > 38 else raw)
                url = r.get("url") or "#"
                cells.append(f'<td style="{_CSS_TD};color:#6b7280;font-size:12px">'
                             f'<a href="{html.escape(url)}" style="color:#6b7280">{text}</a></td>')
            elif field in ("land_m2", "building_m2"):
                v = r.get(field)
                cells.append(f'<td style="{_CSS_TD};text-align:right;white-space:nowrap">'
                             f'{f"{v:g}" if v else "&mdash;"}</td>')
            elif field == "walk":
                v = r.get("nearest_walk_min")
                cells.append(f'<td style="{_CSS_TD};text-align:right;white-space:nowrap">'
                             f'{f"{v}′" if v is not None else "&mdash;"}</td>')
            elif field == "price_yen":
                cells.append(f'<td style="{_CSS_TD};text-align:right;white-space:nowrap">'
                             f'{_esc(r.get("price_raw")) if r.get("price_raw") else _yen(r.get(field))}</td>')
            elif field == "changes":
                bits = []
                for c in r.get("changes") or []:
                    bits.append(f'<div><span style="color:#6b7280">{_esc(c["label"])}</span> '
                                f'<s style="color:#9ca3af">{_esc(c["from"])}</s> → '
                                f'<b>{_esc(c["to"])}</b></div>')
                cells.append(f'<td style="{_CSS_TD};font-size:12px">{"".join(bits)}</td>')
            elif field == "scope":
                label = {"absent": "search not run",
                         "partial": "search ran shallower"}.get(r.get("scope"), "")
                cells.append(f'<td style="{_CSS_TD};color:#a08a4a;white-space:nowrap">{label}</td>')
            else:
                cells.append(f'<td style="{_CSS_TD}">{_esc(r.get(field))}</td>')
        body.append(f"<tr>{''.join(cells)}</tr>")

    more = ""
    if len(rows) > limit:
        more = (f'<p style="color:#6b7280;font-size:12px">'
                f'…and {len(rows) - limit} more.</p>')
    return (f'<table style="{_CSS_TABLE}"><thead><tr>{head}</tr></thead>'
            f'<tbody>{"".join(body)}</tbody></table>{more}')


def render_html(data: dict, has_image: bool = True) -> str:
    latest = data.get("latest")
    diff = data.get("diff")
    day = latest["date"] if latest else "no crawl yet"

    parts = [
        '<div style="font-family:-apple-system,Segoe UI,sans-serif;max-width:760px;'
        'margin:0 auto;padding:20px;color:#111">',
        f'<h1 style="margin:0 0 4px;font-size:20px">SUUMO crawl &mdash; {day}</h1>',
    ]

    if not latest:
        parts.append('<p style="color:#6b7280">Nothing crawled yet.</p></div>')
        return "".join(parts)

    parts.append(
        f'<p style="margin:0 0 18px;color:#6b7280;font-size:13px">'
        f'{latest["properties"]} properties captured, '
        f'{latest["started"][11:16]}&ndash;{latest["finished"][11:16]}. '
        f'{len(data.get("points") or [])} have an exact location.</p>')

    # --- headline diff numbers
    if diff:
        not_recrawled = diff["counts"]["gone_partial"] + diff["counts"]["gone_absent"]
        cards = [
            _card(diff["counts"]["new"], "new", "#16a34a"),
            _card(diff["counts"]["delisted"], "delisted", "#dc2626"),
            _card(diff["counts"]["changed"], "changed", "#f59e0b"),
            _card(diff["counts"]["unchanged"], "unchanged", "#6b7280"),
        ]
        if diff["counts"].get("relisted"):
            cards.insert(3, _card(diff["counts"]["relisted"], "relisted", "#2563eb"))
        if not_recrawled:
            cards.append(_card(not_recrawled, "not re-crawled", "#a16207"))
        parts.append(
            f'<p style="font-size:12px;color:#6b7280;margin:0 0 6px">'
            f'versus {diff["date_from"]}</p>'
            f'<table style="width:100%;border-spacing:6px;border-collapse:separate">'
            f'<tr>{"".join(cards)}</tr></table>')

    # --- map, linked to the live dashboard
    if has_image:
        parts.append(
            f'<a href="{html.escape(DASHBOARD_URL)}" '
            f'style="display:block;margin:18px 0;text-decoration:none">'
            f'<img src="cid:mapimage" alt="Map of crawled listings — open the dashboard" '
            f'style="width:100%;border-radius:8px;border:1px solid #e5e7eb;display:block">'
            f'<span style="display:block;margin-top:6px;font-size:12px;color:#6b7280">'
            f'Open the dashboard &rarr;</span></a>')

    # --- crawler status
    jobs = data.get("jobs") or []
    if jobs:
        rows = []
        for j in jobs:
            ok = j.get("last_status") == "ok"
            colour = "#16a34a" if ok else "#dc2626"
            last = (j.get("last_run") or "")[:16].replace("T", " ")
            rows.append(
                f'<tr><td style="{_CSS_TD}">{_esc(j.get("name"))}</td>'
                f'<td style="{_CSS_TD};color:{colour}">{_esc(j.get("last_status") or "never run")}</td>'
                f'<td style="{_CSS_TD}">{last}</td>'
                f'<td style="{_CSS_TD};text-align:right">{_esc(j.get("last_listings"))}</td>'
                f'<td style="{_CSS_TD};color:#dc2626;font-size:12px">'
                f'{_esc(j.get("last_error")) if j.get("last_error") else ""}</td></tr>')
        parts.append('<h2 style="font-size:15px;margin:22px 0 8px">Crawlers</h2>')
        parts.append(
            f'<table style="{_CSS_TABLE}"><thead><tr>'
            f'<th style="{_CSS_TH}">job</th><th style="{_CSS_TH}">status</th>'
            f'<th style="{_CSS_TH}">last run</th>'
            f'<th style="{_CSS_TH};text-align:right">listings</th>'
            f'<th style="{_CSS_TH}">error</th>'
            f'</tr></thead><tbody>{"".join(rows)}</tbody></table>')

    if not diff:
        parts.append('<p style="color:#6b7280;font-size:13px;margin-top:18px">'
                     'Only one crawl on record &mdash; nothing to compare against yet.</p>')
        return "".join(parts) + "</div>"

    # --- a narrower crawl reads as delistings unless it is called out
    if diff["narrowed"]:
        parts.append(
            f'<p style="margin:18px 0;padding:10px 12px;background:#fdfaf0;'
            f'border:1px solid #ecdfae;border-radius:8px;font-size:12.5px;color:#6b5a2a">'
            f'&#9888;&#65039; The {diff["date_to"]} crawl was narrower than {diff["date_from"]} &mdash; '
            f'{len(diff["narrowed"])} search URL(s) returned fewer results or were not fetched. '
            f'Listings only seen under those URLs are counted as <i>not re-crawled</i>, '
            f'not delisted.</p>')

    parts.append('<h2 style="font-size:15px;margin:22px 0 8px">&#127381; New listings</h2>')
    parts.append(_rows_table(diff["new"], [
        ("ward", "ward"), ("category", "type"), ("price_yen", "price"),
        ("land_m2", "land m²"), ("building_m2", "bldg m²"), ("layout", "layout"),
        ("walk", "walk"), ("title", "listing")]))

    delisted = [g for g in diff["gone"] if g.get("scope") == "covered"]
    parts.append('<h2 style="font-size:15px;margin:22px 0 8px">&#128683; Delisted</h2>')
    parts.append(_rows_table(delisted, [
        ("ward", "ward"), ("category", "type"), ("price_yen", "last price"),
        ("land_m2", "land m²"), ("building_m2", "bldg m²"), ("layout", "layout"),
        ("walk", "walk"), ("title", "listing")]))

    if diff.get("relisted"):
        parts.append('<h2 style="font-size:15px;margin:22px 0 8px">&#9851;&#65039; Relisted</h2>')
        parts.append('<p style="color:#6b7280;font-size:12.5px;margin:0 0 8px">'
                     'Same title and price re-posted under a new SUUMO id &mdash; the agent '
                     'refreshing the listing date, not a sale followed by a new listing.</p>')
        parts.append(_rows_table(
            [{**r["to"], "old_id": r["from"]["property_id"]} for r in diff["relisted"]],
            [("ward", "ward"), ("price_yen", "price"), ("land_m2", "land m²"),
             ("building_m2", "bldg m²"), ("title", "listing"),
             ("old_id", "old id"), ("property_id", "new id")]))

    parts.append('<h2 style="font-size:15px;margin:22px 0 8px">&#9999;&#65039; Changed</h2>')
    parts.append(_rows_table(diff["changed"], [
        ("ward", "ward"), ("price_yen", "price"), ("land_m2", "land m²"),
        ("building_m2", "bldg m²"), ("title", "listing"),
        ("changes", "what changed")]))

    other = [g for g in diff["gone"] if g.get("scope") != "covered"]
    if other:
        parts.append('<h2 style="font-size:15px;margin:22px 0 8px">&#128371;&#65039; Not re-crawled</h2>')
        parts.append(_rows_table(other, [
            ("ward", "ward"), ("category", "type"), ("price_yen", "last price"),
            ("land_m2", "land m²"), ("building_m2", "bldg m²"),
            ("title", "listing"), ("scope", "why")], limit=15))

    parts.append('<p style="margin-top:26px;color:#9ca3af;font-size:11px">'
                 'Generated by the local SUUMO scraper on the Mac Studio.</p></div>')
    return "".join(parts)


def subject_for(data: dict) -> str:
    latest = data.get("latest")
    day = latest["date"] if latest else date.today().isoformat()
    subject = f"【Tokyohouseprice】SUUMO report {day}"

    diff = data.get("diff")
    if not diff:
        return subject
    c = diff["counts"]
    bits = []
    if c["new"]:
        bits.append(f"{c['new']} new")
    if c["delisted"]:
        bits.append(f"{c['delisted']} delisted")
    if c["changed"]:
        bits.append(f"{c['changed']} changed")
    if c.get("relisted"):
        bits.append(f"{c['relisted']} relisted")
    return f"{subject} — {', '.join(bits) if bits else 'no changes'}"


# -------------------------------------------------------------------- send

class SenderNotConfigured(RuntimeError):
    """Raised when the sender identity is missing, unverified or unusable."""


def build_message(data: dict, to_addrs: list[str], from_addr: str) -> MIMEMultipart:
    latest = data.get("latest")
    day = latest["date"] if latest else "no crawl"
    png = None
    if data.get("points"):
        try:
            png = mapimage.render(
                data["points"],
                title=f"SUUMO crawl {day} · {len(data['points'])} located")
        except Exception:
            png = None      # a tile-server hiccup must not lose the whole report

    root = MIMEMultipart("related")
    root["Subject"] = subject_for(data)
    root["From"] = from_addr
    root["To"] = ", ".join(to_addrs)

    alt = MIMEMultipart("alternative")
    root.attach(alt)
    alt.attach(MIMEText(_plain_text(data), "plain", "utf-8"))
    alt.attach(MIMEText(render_html(data, has_image=png is not None), "html", "utf-8"))

    if png:
        img = MIMEImage(png, _subtype="png")
        img.add_header("Content-ID", "<mapimage>")
        img.add_header("Content-Disposition", "inline", filename=f"map-{day}.png")
        root.attach(img)
    return root


def _plain_text(data: dict) -> str:
    latest, diff = data.get("latest"), data.get("diff")
    if not latest:
        return "Nothing crawled yet."
    lines = [f"SUUMO crawl {latest['date']}",
             f"{latest['properties']} properties captured."]
    if diff:
        c = diff["counts"]
        lines += [
            "",
            f"vs {diff['date_from']}:",
            f"  new        {c['new']}",
            f"  delisted   {c['delisted']}",
            f"  changed    {c['changed']}",
            f"  unchanged  {c['unchanged']}",
            f"  not re-crawled {c['gone_partial'] + c['gone_absent']}",
        ]
    return "\n".join(lines)


def send(msg: MIMEMultipart, to_addrs: list[str], from_addr: str) -> str:
    """Send a prepared message. Returns a message id (or '' for SMTP)."""
    if TRANSPORT == "smtp":
        return _send_smtp(msg, to_addrs, from_addr)

    import boto3
    from botocore.exceptions import ClientError

    ses = boto3.client("ses", region_name=SES_REGION)
    try:
        res = ses.send_raw_email(Source=from_addr, Destinations=to_addrs,
                                 RawMessage={"Data": msg.as_bytes()})
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code")
        # Running nightly from cron, so the common misconfigurations have to
        # explain themselves in the log rather than land as a traceback.
        if code == "MessageRejected" and "not verified" in str(exc):
            raise SenderNotConfigured(
                f"SES will not send as {from_addr}: it is not a verified identity "
                f"in {SES_REGION}. Set REPORT_FROM_EMAIL in .env to an address that "
                f"is — the same one datakokoro's Trigger Email extension sends from "
                f"(its DEFAULT_FROM parameter), or check the SES console's Verified "
                f"identities for {SES_REGION}.") from exc
        if code in {"AccessDenied", "AccessDeniedException"}:
            raise SenderNotConfigured(
                f"the IAM user is not allowed to send: {exc}. It needs the "
                f"ses:SendRawEmail permission.") from exc
        raise
    return res["MessageId"]


def check(from_addr: str | None = DEFAULT_FROM,
          to_addrs: list[str] | None = None) -> dict:
    """Pre-flight the mail setup without sending anything.

    Answers the question cron cannot: are the credentials visible, is the sender
    verified *in this region*, and is the account out of the SES sandbox?
    """
    to_addrs = to_addrs or DEFAULT_TO
    out: dict = {"env_file": str(config.ENV_FILE),
                 "env_file_found": config.ENV_FILE.exists(),
                 "env_keys_loaded": config.LOADED_ENV_KEYS,
                 "region": SES_REGION, "transport": TRANSPORT,
                 "from": from_addr, "to": to_addrs, "problems": []}

    if not from_addr:
        out["problems"].append("REPORT_FROM_EMAIL is not set")
        return out

    if TRANSPORT == "smtp":
        out["smtp_host"] = f"{SMTP_HOST}:{SMTP_PORT}"
        out["smtp_user"] = SMTP_USER or None
        if not (SMTP_USER and SMTP_PASSWORD):
            out["problems"].append("SMTP_USER / SMTP_PASSWORD are not both set")
        return out

    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError:
        out["problems"].append("boto3 is not installed (pip install -r scraper/requirements.txt)")
        return out

    session = boto3.Session(region_name=SES_REGION)
    creds = session.get_credentials()
    if not creds:
        out["problems"].append(
            "no AWS credentials found — set AWS_PROFILE, or AWS_ACCESS_KEY_ID "
            "and AWS_SECRET_ACCESS_KEY")
        return out
    # Only the key id, never the secret: this output goes into a cron log.
    out["access_key_id"] = creds.access_key
    out["credential_source"] = getattr(creds, "method", "unknown")

    ses = session.client("ses")
    domain = from_addr.split("@")[-1]
    unknown: list[str] = []

    def probe(label: str, call):
        """Run a read-only SES call, tolerating a send-only IAM policy.

        A key scoped to just ses:SendRawEmail — which is all the daily report
        actually needs — cannot make these introspection calls. That is a gap in
        what we can *verify*, not a fault in the setup, so it must not be
        reported as a problem.
        """
        try:
            return call()
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in {
                    "AccessDenied", "AccessDeniedException", "UnauthorizedOperation"}:
                unknown.append(label)
                return None
            out["problems"].append(f"SES {label} failed: {exc}")
        except BotoCoreError as exc:
            out["problems"].append(f"SES {label} failed: {exc}")
        return None

    attrs = probe("identity verification", lambda: ses.get_identity_verification_attributes(
        Identities=[from_addr, domain])["VerificationAttributes"])
    if attrs is not None:
        out["verification"] = {k: v.get("VerificationStatus") for k, v in attrs.items()}
        if not any(v.get("VerificationStatus") == "Success" for v in attrs.values()):
            out["problems"].append(
                f"neither {from_addr} nor {domain} is verified in {SES_REGION}")

    quota = probe("send quota", ses.get_send_quota)
    if quota is not None:
        out["send_quota_24h"] = quota["Max24HourSend"]
        # 200/day is the SES sandbox allowance; above it means production access.
        out["sandbox"] = quota["Max24HourSend"] <= 200
        if out["sandbox"]:
            out["problems"].append(
                f"account looks sandboxed (quota {quota['Max24HourSend']}/day) — "
                f"every recipient ({', '.join(to_addrs)}) must also be verified")

    enabled = probe("account sending enabled", ses.get_account_sending_enabled)
    if enabled is not None and not enabled["Enabled"]:
        out["problems"].append("sending is disabled on this SES account")

    if unknown:
        # Credentials authenticated (an invalid key would have failed differently),
        # so the only way left to confirm the setup is to send one for real.
        out["credentials_valid"] = True
        out["could_not_verify"] = unknown
        out["note"] = ("key is scoped to sending only, so the checks above could not "
                       "run — send a real one to confirm: python -m scraper daily-report")

    return out


def test_send(from_addr: str, to_addrs: list[str] | None = None) -> dict:
    """Send a three-line message to prove a sender identity works.

    With a send-only IAM key there is no way to read back which identities are
    verified, so the only test is a real send — and building the whole report
    (which fetches a few dozen map tiles) just to fail on the From line is a
    waste. This is the cheap version.
    """
    to_addrs = to_addrs or DEFAULT_TO
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "【Tokyohouseprice】sender test"
    msg["From"] = from_addr
    msg["To"] = ", ".join(to_addrs)
    msg.attach(MIMEText(
        f"Sender test from the SUUMO scraper.\n\n"
        f"From: {from_addr}\nRegion: {SES_REGION}\n\n"
        f"If this arrived, put that address in REPORT_FROM_EMAIL.\n",
        "plain", "utf-8"))

    try:
        return {"from": from_addr, "to": to_addrs, "sent": True,
                "message_id": send(msg, to_addrs, from_addr)}
    except SenderNotConfigured as exc:
        return {"from": from_addr, "to": to_addrs, "sent": False, "error": str(exc)}


def _send_smtp(msg: MIMEMultipart, to_addrs: list[str], from_addr: str) -> str:
    """Deliver over the SES SMTP endpoint — the same path the Trigger Email
    extension uses, for when the SMTP credential pair is what you have."""
    import smtplib
    import ssl

    if not SMTP_USER or not SMTP_PASSWORD:
        raise SenderNotConfigured(
            "REPORT_TRANSPORT=smtp needs SMTP_USER and SMTP_PASSWORD "
            "(the SES SMTP credential pair, not an IAM secret key).")

    context = ssl.create_default_context()
    if SMTP_PORT == 465:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(from_addr, to_addrs, msg.as_string())
    else:
        with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
            server.starttls(context=context)
            server.login(SMTP_USER, SMTP_PASSWORD)
            server.sendmail(from_addr, to_addrs, msg.as_string())
    return ""


def daily_report(to_addrs: list[str] | None = None, from_addr: str | None = DEFAULT_FROM,
                 target: str | None = None, dry_run: bool = False,
                 out_path: str | None = None) -> dict:
    """Build (and unless `dry_run`, send) the daily report."""
    to_addrs = to_addrs or DEFAULT_TO
    # Validate before building: assembling the report fetches a few dozen
    # basemap tiles, so a missing credential should surface first.
    if not dry_run:
        if not from_addr:
            raise SenderNotConfigured(
                f"No sender address. Set REPORT_FROM_EMAIL (or pass --from) to an "
                f"address verified in SES {SES_REGION}. List them with: "
                f"aws ses list-identities --region {SES_REGION}")
        if TRANSPORT == "smtp" and not (SMTP_USER and SMTP_PASSWORD):
            raise SenderNotConfigured(
                "REPORT_TRANSPORT=smtp needs SMTP_USER and SMTP_PASSWORD "
                "(the SES SMTP credential pair, not an IAM secret key).")
    from_addr = from_addr or "report@localhost"     # placeholder for --dry-run
    data = gather(target)
    # Built once: rendering the map means fetching a few dozen basemap tiles,
    # so this must not happen twice when --out and a real send are combined.
    msg = build_message(data, to_addrs, from_addr)

    result = {"date": (data.get("latest") or {}).get("date"),
              "subject": subject_for(data),
              "points": len(data.get("points") or [])}

    if out_path:
        for part in msg.walk():
            if part.get_content_type() == "text/html":
                with open(out_path, "w", encoding="utf-8") as fh:
                    fh.write(part.get_payload(decode=True).decode("utf-8"))
                result["html"] = out_path
            elif part.get_content_type() == "image/png":
                png_path = out_path.rsplit(".", 1)[0] + ".png"
                with open(png_path, "wb") as fh:
                    fh.write(part.get_payload(decode=True))
                result["png"] = png_path

    if not dry_run:
        result["message_id"] = send(msg, to_addrs, from_addr)
        result["sent_to"] = to_addrs
        result["transport"] = TRANSPORT
    return result
