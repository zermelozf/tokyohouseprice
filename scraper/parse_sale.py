"""Parse SUUMO *sale* search pages (property_unit cards).

Emits one raw record per listing. The raw label->value map is preserved
verbatim under ``raw`` so nothing is lost before normalization (bronze intent).
"""
from __future__ import annotations

from bs4 import BeautifulSoup

from .config import BASE


def _card_fields(card) -> dict:
    """Extract the dt/dd label map inside a property_unit card."""
    fields: dict[str, str] = {}
    for dt in card.select("dt"):
        dd = dt.find_next_sibling("dd")
        if dd is None:
            continue
        key = dt.get_text(strip=True)
        val = dd.get_text(" ", strip=True)
        if key:
            fields[key] = val
    return fields


def parse_page(html: str, ctx: dict) -> list[dict]:
    """Return a list of raw records from one sale search-results page."""
    soup = BeautifulSoup(html, "lxml")
    records: list[dict] = []
    for card in soup.select("div.property_unit"):
        a = card.select_one(".property_unit-title a")
        href = a["href"] if a and a.has_attr("href") else None
        fields = _card_fields(card)
        if not href and not fields:
            continue
        url = BASE + href if href and href.startswith("/") else href
        # property id: .../nc_20933882/
        pid = None
        if href:
            for seg in href.strip("/").split("/"):
                if seg.startswith("nc_"):
                    pid = seg
                    break
            pid = pid or href.strip("/")
        records.append({
            "source": "suumo",
            "market": ctx["market"],
            "category": ctx["category"],
            "ward": ctx["ward"],
            "property_id": pid,
            "building_id": None,
            "url": url,
            "title": (a.get_text(strip=True) if a else fields.get("物件名")),
            # normalized-input fields (Japanese labels -> our schema, done in normalize step)
            "price_raw": fields.get("販売価格"),
            "address": fields.get("所在地"),
            "station_raw": fields.get("沿線・駅"),
            "land_area_raw": fields.get("土地面積"),
            "building_area_raw": fields.get("建物面積"),
            "layout": fields.get("間取り"),
            "build_raw": fields.get("築年月"),
            "raw": fields,
        })
    return records
