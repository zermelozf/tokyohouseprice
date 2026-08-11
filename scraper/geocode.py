"""Coordinates for listings SUUMO gives no pin for.

Most detail pages embed an exact position, but a substantial minority do not:
chintai pages carry theirs on the /kankyo/ tab, and some listings publish none
at all — neither tab holds a latitude in any form. Those rows could not be
drawn, so the map showed fewer listings than the table, which makes the two
views disagree about what exists.

The address is always present, so it is geocoded instead, via the GSI address
service (国土地理院) — the same source already used for elevation, free and
without a key:

    https://msearch.gsi.go.jp/address-search/AddressSearch?q=<address>

IMPORTANT: this resolves to 丁目 (chome), not to the building. SUUMO's listings
are addressed to that precision anyway ('東京都板橋区西台２'), so nothing finer
is available from them — but a geocoded point is the centre of a block, and can
sit a couple of hundred metres from the property. Every row records where its
position came from in `location_source`, so an approximate point is never
presented as a surveyed one.

Cached by address string: listings in the same chome legitimately share a
point, so 789 unpinned rows cost far fewer lookups than that.
"""
from __future__ import annotations

import json
import logging
import urllib.parse
import urllib.request
from datetime import datetime

from .db import connect, init_db

log = logging.getLogger("suumo.geocode")

GSI_SEARCH = "https://msearch.gsi.go.jp/address-search/AddressSearch?q={q}"


def fetch(address: str) -> dict | None:
    """(lat, lng, title) for an address, or None when GSI cannot place it."""
    url = GSI_SEARCH.format(q=urllib.parse.quote(address))
    req = urllib.request.Request(url, headers={"User-Agent": "tokyohouseprice/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            hits = json.loads(r.read().decode("utf-8", "replace"))
    except Exception as exc:
        log.warning("geocode %s failed: %s", address, exc)
        return None
    if not hits:
        return None
    # GSI returns best-match first, as [lng, lat] GeoJSON order.
    top = hits[0]
    lng, lat = top["geometry"]["coordinates"][:2]
    return {"lat": float(lat), "lng": float(lng),
            "title": (top.get("properties") or {}).get("title")}


def table() -> dict[str, dict]:
    conn = connect()
    try:
        return {r["address"]: dict(r) for r in conn.execute("SELECT * FROM geocode_cache")}
    finally:
        conn.close()


def save(address: str, d: dict) -> None:
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO geocode_cache (address, lat, lng, title, fetched_at) "
            "VALUES (?,?,?,?,?)",
            (address, d.get("lat"), d.get("lng"), d.get("title"),
             datetime.now().isoformat()))
        conn.commit()
    finally:
        conn.close()


def annotate(rows: list[dict]) -> list[dict]:
    """Fill in coordinates the detail page did not provide, and record for
    every row how precisely its position is known."""
    missing = {r["address"] for r in rows
               if not r.get("lat") and r.get("address")}
    cache = table() if missing else {}
    for r in rows:
        if r.get("lat") and r.get("lng"):
            r["location_source"] = "exact"
            continue
        hit = cache.get(r.get("address") or "")
        if hit and hit["lat"] is not None:
            r["lat"], r["lng"] = hit["lat"], hit["lng"]
            r["location_source"] = "geocoded"   # chome centre, not the building
        else:
            r["location_source"] = None
    return rows


def refresh(addresses: list[str], delay: float = 0.4) -> int:
    """Fill the cache for these addresses. One lookup per distinct string."""
    import time
    have = table()
    todo = [a for a in dict.fromkeys(addresses) if a and a not in have]
    done = 0
    for a in todo:
        d = fetch(a)
        if d:
            save(a, d)
            done += 1
        time.sleep(delay)
    return done
