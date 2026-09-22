"""Who may use the tool, and who they share with.

Two questions, kept apart because they are different:

    allowed?   is this email in app_user — may it call the API at all
    peers      whose reviews and saved views does it see — everyone sharing a
               group with it, plus itself

A group is a household: the people looking for one house together. Sharing is
by membership rather than by a flag on each review, so adding someone shows
them the whole history at once and removing them stops it, without touching a
single review row.

Everything here is stored, nothing is configured: the allowlist and the admin
flag are rows, so adding the person you are buying a house with — or handing
them the keys — is a click rather than an edit to a systemd unit and a restart.

The one hard problem with no configuration is the first user: an empty table has
no admin, so nobody can add one. This takes the usual way out — whoever signs in
first to an empty table becomes the admin. It is a single unavoidable moment of
trust, it happens on a tool that is not yet reachable by anyone else, and it is
visible afterwards in the list rather than hidden in a unit file.
"""
from __future__ import annotations

from datetime import datetime

from .db import connect, init_db


def _now() -> str:
    return datetime.now().isoformat()


def is_empty() -> bool:
    """No users at all — the one state in which anyone may claim the tool."""
    conn = connect()
    try:
        return conn.execute("SELECT COUNT(*) c FROM app_user").fetchone()["c"] == 0
    finally:
        conn.close()


def claim(email: str, name: str | None = None) -> dict:
    """First sign-in on an empty install: that person becomes the admin."""
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO app_user "
            "(email, name, is_admin, added_by, added_at) VALUES (?,?,1,?,?)",
            ((email or "").lower(), name, "first sign-in", _now()))
        conn.commit()
        return {"email": (email or "").lower(), "is_admin": True}
    finally:
        conn.close()


def admins() -> list[str]:
    conn = connect()
    try:
        return [r["email"] for r in
                conn.execute("SELECT email FROM app_user WHERE is_admin = 1")]
    finally:
        conn.close()


def is_admin(email: str) -> bool:
    """Admins manage people and groups."""
    email = (email or "").lower()
    conn = connect()
    try:
        r = conn.execute("SELECT is_admin FROM app_user WHERE email = ?",
                         (email,)).fetchone()
        return bool(r and r["is_admin"])
    finally:
        conn.close()


def set_admin(email: str, admin: bool) -> dict:
    """Refuses to remove the last admin: a tool nobody can administer is a tool
    that needs a database client to fix."""
    email = (email or "").lower()
    if not admin and admins() == [email]:
        raise ValueError("that is the only admin — make someone else one first")
    conn = init_db()
    try:
        conn.execute("UPDATE app_user SET is_admin = ? WHERE email = ?",
                     (1 if admin else 0, email))
        conn.commit()
        return {"email": email, "is_admin": admin}
    finally:
        conn.close()


def is_allowed(email: str) -> bool:
    email = (email or "").lower()
    if not email:
        return False
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
    if admins() == [email]:
        raise ValueError("that is the only admin — make someone else one first")
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
            "SELECT email, name, is_admin, added_at, last_seen FROM app_user "
            "ORDER BY email")]
        groups = []
        for g in conn.execute("SELECT id, name, created_by FROM user_group ORDER BY name"):
            members = [dict(r) for r in conn.execute(
                "SELECT m.email, m.role, u.name FROM group_member m "
                "LEFT JOIN app_user u ON u.email = m.email "
                "WHERE m.group_id = ? ORDER BY m.email", (g["id"],))]
            groups.append({**dict(g), "members": members,
                           "mine": any(m["email"] == (email or "").lower() for m in members)})
        return {"users": users, "groups": groups,
                "me": (email or "").lower(),
                "is_admin": is_admin(email),
                "peers": sorted(peers(email))}
    finally:
        conn.close()
