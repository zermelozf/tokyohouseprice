"""Silver layer: normalize raw records into typed listing snapshots and upsert."""
from __future__ import annotations

import json
from datetime import datetime

from . import normalize as N


def to_snapshot(rec: dict, scraped_at: datetime | None = None) -> dict:
    """Convert a parser raw record into a normalized listings_snapshot row."""
    scraped_at = scraped_at or datetime.now()
    stations = N.parse_stations(rec.get("station_raw"))
    price_lo, price_hi = N.parse_price_range(rec.get("price_raw"))
    build_year, build_month = N.parse_build_date(rec.get("build_raw"))
    age = N.parse_age_years(rec.get("build_raw"), ref_year=scraped_at.year)

    return {
        "property_id": rec.get("property_id"),
        "scrape_date": scraped_at.strftime("%Y-%m-%d"),
        "source": rec.get("source", "suumo"),
        "market": rec["market"],
        "category": rec["category"],
        "ward": rec["ward"],
        "building_id": rec.get("building_id"),
        "url": rec.get("url"),
        "title": rec.get("title"),
        "address": rec.get("address"),
        "station_raw": rec.get("station_raw"),
        "stations_json": json.dumps(stations, ensure_ascii=False),
        "nearest_walk_min": N.nearest_walk_min(stations),
        "price_yen": price_lo,
        "price_max_yen": price_hi,
        "price_raw": rec.get("price_raw"),
        "admin_fee_yen": N.parse_price_yen(rec.get("admin_fee_raw")),
        "deposit_yen": N.parse_price_yen(rec.get("deposit_raw")),
        "key_money_yen": N.parse_price_yen(rec.get("key_money_raw")),
        "layout": rec.get("layout"),
        "land_m2": N.parse_area_m2(rec.get("land_area_raw")),
        "building_m2": N.parse_area_m2(rec.get("building_area_raw")),
        "unit_floor": rec.get("unit_floor"),
        "floors": rec.get("floors"),
        "build_year": build_year,
        "build_month": build_month,
        "age_years": age,
        "scraped_at": scraped_at.isoformat(),
        "raw_json": json.dumps(rec.get("raw", {}), ensure_ascii=False),
    }


_COLS = [
    "property_id", "scrape_date", "source", "market", "category", "ward",
    "building_id", "url", "title", "address", "station_raw", "stations_json",
    "nearest_walk_min", "price_yen", "price_max_yen", "price_raw",
    "admin_fee_yen", "deposit_yen", "key_money_yen", "layout", "land_m2",
    "building_m2", "unit_floor", "floors", "build_year", "build_month",
    "age_years", "scraped_at", "raw_json",
]


def upsert(conn, snapshots: list[dict]) -> int:
    """Insert-or-replace snapshot rows keyed on (property_id, scrape_date)."""
    rows = [tuple(s.get(c) for c in _COLS) for s in snapshots if s.get("property_id")]
    if not rows:
        return 0
    placeholders = ",".join("?" * len(_COLS))
    conn.executemany(
        f"INSERT OR REPLACE INTO listings_snapshot ({','.join(_COLS)}) "
        f"VALUES ({placeholders})",
        rows,
    )
    conn.commit()
    return len(rows)
