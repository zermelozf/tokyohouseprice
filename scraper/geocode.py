"""Coordinates for listings SUUMO gives no pin for.

This is a fallback, not the main route to a position. Of 1,544 listings, 755
carry SUUMO's own pin, 12 (all chintai) publish none on either the detail page
or the /kankyo/ tab, and the remaining 777 have simply never been detail-
scraped — they sit outside the enrichment gate (ENRICH_COMMUTE_MAX_MIN,
ENRICH_BUDGET_YEN in pipeline.py), so nothing has fetched their page.

Scraping those 777 would give exact pins, plus the specs, zoning and hazard
that geocoding cannot supply. But until that is worth ~30 minutes of crawling,
they could be listed and not drawn, and the map silently held fewer listings
than the table. Geocoding closes that gap immediately and costs one lookup per
distinct 丁目 rather than one page fetch per listing.

An exact pin always wins: annotate() only fills rows that have none, so
enriching a listing later replaces its approximate position automatically.

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
