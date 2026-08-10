"""Scrape a single property detail page.

Detail pages differ per property type, but all render their specs as
<th>/<td> (or <dt>/<dd>) tables. We save the raw HTML (bronze) and extract
every label/value pair generically, so nothing is lost even before a
type-specific parser exists.
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime

from bs4 import BeautifulSoup

from . import bronze
from .db import init_db
from .fetch import Fetcher

log = logging.getLogger("suumo.detail")


def _label(node) -> str:
    """Clean label text from a th/dt: SUUMO wraps a 'ヒント' help-tooltip <a> and a
    hidden <input> inside the header cell, which otherwise pollute the key
    (e.g. '建ぺい率・容積率 ヒント'). Drop those, then strip a trailing 'ヒント'."""
    for junk in node.select('a[id^="jsiHint"], a.icBeginner2, input, script'):
        junk.decompose()
    k = " ".join(node.get_text(" ", strip=True).split())
    return re.sub(r"\s*ヒント\s*$", "", k)


def extract_specs(html: str) -> dict:
    """Pull every th/td and dt/dd label->value pair from a detail page."""
    soup = BeautifulSoup(html, "lxml")
    specs: dict[str, str] = {}
    for th in soup.select("th"):
        td = th.find_next_sibling("td")
        if td is None:
            continue
        k = _label(th)
        v = " ".join(td.get_text(" ", strip=True).split())
        if k and v and k not in specs:
            specs[k] = v
    for dt in soup.select("dt"):
        dd = dt.find_next_sibling("dd")
        if dd is None:
            continue
        k = _label(dt)
        v = " ".join(dd.get_text(" ", strip=True).split())
        if k and v and k not in specs:
            specs[k] = v
    title = soup.select_one("h1")
    return {"title": title.get_text(strip=True) if title else None, "specs": specs}


# Sale detail pages embed the exact geocoded pin in a googleMapsSettings JS
# block:  ,initIdo : '35.75685…'  (緯度/latitude)  ,initKeido : '139.54036…' (経度/longitude)
_IDO = re.compile(r"initIdo\s*:\s*'(-?\d+\.\d+)'")
_KEIDO = re.compile(r"initKeido\s*:\s*'(-?\d+\.\d+)'")

# Rent (chintai) pages carry no pin at all: the map lives on the /kankyo/
# ("地図・周辺環境") tab, as a JSON blob for the Google Maps widget:
#   <script id="js-gmapData" type="application/json">{"center":{"lat":…,"lng":…},…}
_GMAP = re.compile(
    r'id="js-gmapData"[^>]*>\s*(\{.*?\})\s*</script>', re.S)


def extract_location(html: str) -> dict:
    """Pull the exact lat/lng from a detail page, in either of SUUMO's formats."""
    ido, keido = _IDO.search(html), _KEIDO.search(html)
    if ido and keido:
        return {"lat": float(ido.group(1)), "lng": float(keido.group(1))}
    blob = _GMAP.search(html)
    if blob:
        try:
            center = (json.loads(blob.group(1)) or {}).get("center") or {}
            if center.get("lat") is not None and center.get("lng") is not None:
                return {"lat": float(center["lat"]), "lng": float(center["lng"])}
        except (ValueError, TypeError):
            pass
    return {"lat": None, "lng": None}


def kankyo_url(url: str) -> str | None:
    """The /kankyo/ tab of a chintai listing, which is where its map lives.
    None for anything that isn't a chintai detail URL."""
    m = re.match(r"(https?://[^?#]*?/chintai/j?nc_[0-9]+/)([?#].*)?$", url or "")
    return f"{m.group(1)}kankyo/{m.group(2) or ''}" if m else None


def scrape_detail(url: str, fetcher: Fetcher | None = None) -> dict:
    """Fetch one detail page and return the exact pin plus the full spec table.

    Lightweight sibling of scrape_property (no bronze write). `specs` is every
    label→value pair on the page — structure, land rights, zoning, building/
    floor-area ratios, road access, transaction terms, etc. — kept verbatim so
    takken-relevant fields and future model features are all preserved.
    """
    own = fetcher is None
    fetcher = fetcher or Fetcher()
    try:
        html = fetcher.get(url)
        loc = extract_location(html)
        # Chintai keeps its map on a separate tab, so the pin costs one more
        # fetch. Best-effort: a listing without coordinates is still worth
        # storing for its specs.
        if loc["lat"] is None and (tab := kankyo_url(url)):
            try:
                loc = extract_location(fetcher.get(tab))
            except Exception as exc:
                log.warning("kankyo fetch failed for %s: %s", url, exc)
    finally:
        if own:
            fetcher.close()
    extracted = extract_specs(html)
    specs = extracted["specs"]
    m = re.search(r"/((?:nc|jnc)_[0-9]+)/", url)
    return {
        "property_id": m.group(1) if m else None,
        "url": url,
        "lat": loc["lat"],
        "lng": loc["lng"],
        "address": specs.get("所在地") or specs.get("住所"),
        "title": extracted.get("title"),
        "specs": specs,
    }


def scrape_property(url: str, fetcher: Fetcher | None = None) -> dict:
    """Fetch one property page, persist raw HTML to bronze, return extracted specs."""
    own = fetcher is None
    fetcher = fetcher or Fetcher()
    conn = init_db()
    try:
        html = fetcher.get(url)
        m = re.search(r"/((?:nc|jnc)_[0-9]+)/", url)
        pid = m.group(1) if m else "detail"
        bronze.save_page(conn, source="suumo", market="detail", category="detail",
                         ward=pid, page=1, url=url, html=html, n_cards=1)
        result = extract_specs(html)
        result.update({"url": url, "property_id": pid,
                       "scraped_at": datetime.now().isoformat()})
        return result
    finally:
        conn.close()
        if own:
            fetcher.close()


if __name__ == "__main__":
    import sys
    print(json.dumps(scrape_property(sys.argv[1]), ensure_ascii=False, indent=2))
