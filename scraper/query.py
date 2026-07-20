"""Shared filter logic over normalized listings (DB rows or live-preview records).

Filters are applied *after* scraping — the crawler captures everything, and you
slice it here. The same Filters dict drives both the local DB search and the
in-memory live preview so criteria behave identically in both.
"""
from __future__ import annotations

from .db import connect

# Filters is a plain dict with any of these optional keys:
#   markets: [str]  categories: [str]  wards: [str]
#   price_min/price_max (yen)  bld_min/bld_max (m2)  land_min/land_max (m2)
#   layout (substring)  walk_max (min)  age_max (years)
#   sort ('price'|'price_desc'|'ppm2'|'walk'|'age')  limit (int)


def _area(row) -> float | None:
    b = row.get("building_m2") or 0
    return b or row.get("land_m2")


def matches(row: dict, f: dict) -> bool:
    """In-memory predicate used by the live preview."""
    def rng(v, lo, hi):
        if v is None:
            return not (f.get(lo) or f.get(hi))  # unknown value fails an active bound
        if f.get(lo) is not None and v < f[lo]:
            return False
        if f.get(hi) is not None and v > f[hi]:
            return False
        return True

    if f.get("markets") and row.get("market") not in f["markets"]:
        return False
    if f.get("categories") and row.get("category") not in f["categories"]:
        return False
    if f.get("wards") and row.get("ward") not in f["wards"]:
        return False
    if not rng(row.get("price_yen"), "price_min", "price_max"):
        return False
    if not rng(row.get("building_m2"), "bld_min", "bld_max"):
        return False
    if not rng(row.get("land_m2"), "land_min", "land_max"):
        return False
    if f.get("layout") and (f["layout"] or "").lower() not in (row.get("layout") or "").lower():
        return False
    if f.get("walk_max") is not None and (row.get("nearest_walk_min") is None
                                          or row["nearest_walk_min"] > f["walk_max"]):
        return False
    if f.get("age_max") is not None and (row.get("age_years") is None
                                         or row["age_years"] > f["age_max"]):
        return False
    return True


def apply(rows: list[dict], f: dict) -> list[dict]:
    out = [r for r in rows if matches(r, f)]
    out = sort_rows(out, f.get("sort"))
    limit = f.get("limit")
    return out[:limit] if limit else out


def sort_rows(rows: list[dict], sort: str | None) -> list[dict]:
    big = float("inf")
    keymap = {
        "price": lambda r: (r.get("price_yen") is None, r.get("price_yen") or big),
        "price_desc": lambda r: -(r.get("price_yen") or 0),
        "walk": lambda r: (r.get("nearest_walk_min") is None, r.get("nearest_walk_min") or big),
        "age": lambda r: (r.get("age_years") is None, r.get("age_years") or big),
        "ppm2": lambda r: (_area(r) in (None, 0), (r.get("price_yen") or big) / (_area(r) or big)),
    }
    return sorted(rows, key=keymap[sort]) if sort in keymap else rows


# --- local DB search --------------------------------------------------------
_COLS = ", ".join("s." + c for c in (
    "property_id", "scrape_date", "market", "category", "ward", "url", "title",
    "address", "station_raw", "nearest_walk_min", "price_yen", "price_max_yen",
    "price_raw", "admin_fee_yen", "deposit_yen", "key_money_yen", "layout",
    "land_m2", "building_m2", "floors", "build_year", "age_years"))


def search_db(f: dict) -> list[dict]:
    """Query the latest snapshot per property from listings_snapshot."""
    where, params = [], []
    for key, col in (("markets", "market"), ("categories", "category"), ("wards", "ward")):
        vals = f.get(key)
        if vals:
            where.append(f"{col} IN ({','.join('?' * len(vals))})")
            params += list(vals)
    for key, expr in (("price_min", "price_yen >= ?"), ("price_max", "price_yen <= ?"),
                      ("bld_min", "building_m2 >= ?"), ("bld_max", "building_m2 <= ?"),
                      ("land_min", "land_m2 >= ?"), ("land_max", "land_m2 <= ?"),
                      ("walk_max", "nearest_walk_min <= ?"), ("age_max", "age_years <= ?")):
        if f.get(key) is not None:
            where.append(expr)
            params.append(f[key])
    if f.get("layout"):
        where.append("layout LIKE ?")
        params.append(f"%{f['layout']}%")
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    # latest snapshot per property
    sql = f"""
    WITH latest AS (
        SELECT property_id, MAX(scrape_date) AS d
        FROM listings_snapshot GROUP BY property_id
    )
    SELECT {_COLS} FROM listings_snapshot s
    JOIN latest l ON l.property_id = s.property_id AND l.d = s.scrape_date
    {clause}
    """
    conn = connect()
    try:
        rows = [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()
    rows = sort_rows(rows, f.get("sort"))
    limit = f.get("limit")
    return rows[:limit] if limit else rows


def db_summary() -> dict:
    """Small status panel: totals, per-category counts, date range."""
    conn = connect()
    try:
        total = conn.execute("SELECT COUNT(*) FROM listings_snapshot").fetchone()[0]
        distinct = conn.execute(
            "SELECT COUNT(DISTINCT property_id) FROM listings_snapshot").fetchone()[0]
        by_cat = [dict(r) for r in conn.execute(
            """SELECT market, category, COUNT(DISTINCT property_id) n
               FROM listings_snapshot GROUP BY market, category ORDER BY market, category""")]
        dates = conn.execute(
            "SELECT MIN(scrape_date), MAX(scrape_date) FROM listings_snapshot").fetchone()
        return {"total_rows": total, "distinct_properties": distinct,
                "by_category": by_cat, "first_scrape": dates[0], "last_scrape": dates[1]}
    finally:
        conn.close()
