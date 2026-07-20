"""Parse SUUMO *rent* search pages (cassetteitem cards).

A cassetteitem is one building; each room row becomes its own listing record,
carrying the building-level context (address, stations, age, floors).
"""
from __future__ import annotations

from bs4 import BeautifulSoup

from .config import BASE


def _text(node) -> str | None:
    return node.get_text(strip=True) if node else None


def parse_page(html: str, ctx: dict) -> list[dict]:
    soup = BeautifulSoup(html, "lxml")
    records: list[dict] = []
    for building in soup.select(".cassetteitem"):
        title = _text(building.select_one(".cassetteitem_content-title"))
        label = _text(building.select_one(".cassetteitem_content-label"))
        address = _text(building.select_one(".cassetteitem_detail-col1"))
        stations = [t for t in (
            d.get_text(strip=True) for d in building.select(".cassetteitem_detail-col2 div")
        ) if t]
        col3 = [d.get_text(strip=True) for d in building.select(".cassetteitem_detail-col3 div")]
        build_raw = col3[0] if len(col3) > 0 else None   # 築8年
        floors = col3[1] if len(col3) > 1 else None       # 2階建
        # building id from any room link (jnc_...) handled per-room below
        for row in building.select("table.cassetteitem_other tbody tr"):
            a = row.select_one('a[href*="/chintai/"]')
            href = a["href"] if a and a.has_attr("href") else None
            url = BASE + href if href and href.startswith("/") else href
            pid = None
            if href:
                for seg in href.strip("/").split("/"):
                    if seg.startswith("jnc_"):
                        pid = seg
                        break
            floor_cell = row.select_one("td:nth-of-type(3)")
            rec = {
                "source": "suumo",
                "market": ctx["market"],
                "category": ctx["category"],
                "ward": ctx["ward"],
                "property_id": pid,
                "building_id": title,   # rooms of the same building share this
                "url": url,
                "title": title,
                "property_label": label,
                "price_raw": _text(row.select_one(".cassetteitem_price--rent")),
                "admin_fee_raw": _text(row.select_one(".cassetteitem_price--administration")),
                "deposit_raw": _text(row.select_one(".cassetteitem_price--deposit")),
                "key_money_raw": _text(row.select_one(".cassetteitem_price--gratuity")),
                "layout": _text(row.select_one(".cassetteitem_madori")),
                "building_area_raw": _text(row.select_one(".cassetteitem_menseki")),
                "land_area_raw": None,
                "address": address,
                "station_raw": " , ".join(stations) if stations else None,
                "unit_floor": _text(floor_cell),
                "floors": floors,
                "build_raw": build_raw,
                "raw": {
                    "title": title, "label": label, "address": address,
                    "stations": stations, "build": build_raw, "floors": floors,
                    "row_text": " ".join(row.get_text(" ", strip=True).split()),
                },
            }
            if rec["property_id"] or rec["price_raw"]:
                records.append(rec)
    return records
