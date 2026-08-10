"""Shared filter logic over normalized listings (DB rows or live-preview records).

Filters are applied *after* scraping — the crawler captures everything, and you
slice it here. The same Filters dict drives both the local DB search and the
in-memory live preview so criteria behave identically in both.
"""
from __future__ import annotations

import re

from . import commute
from .db import connect

# Filters is a plain dict with any of these optional keys:
#   markets: [str]  categories: [str]  wards: [str]
#   price_min/price_max (yen)  bld_min/bld_max (m2)  land_min/land_max (m2)
#   layout (substring)  walk_max (min)  age_max (years)
#   sort ('price'|'price_desc'|'ppm2'|'walk'|'age')  limit (int)


def _area(row) -> float | None:
    b = row.get("building_m2") or 0
    return b or row.get("land_m2")


# --- seismic standard (耐震基準) -------------------------------------------
# Two revisions of 建築基準法 split the stock into tiers that price and finance
# very differently:
#   1981-06-01  新耐震基準
#   2000-06-01  2000年基準 (木造: 地盤調査・柱頭柱脚金物・耐力壁バランス)
#
# Both took effect mid-year and key off the 建築確認 date, while listings only
# state a completion year — so a year on either boundary genuinely cannot be
# resolved from this data. Those land in the lower (safer) tier and are flagged
# `era_approx`, as are rent cards, whose year is itself derived from 築N年.
ERAS = {
    "kyu":   {"label": "旧耐震 (pre-1981)",       "max_year": 1981},
    "shin":  {"label": "新耐震 (1982-2000)",      "max_year": 2000},
    "y2000": {"label": "2000年基準 (2001-)",      "max_year": None},
}
_BOUNDARY_YEARS = {1981, 1982, 2000, 2001}


def build_year_of(row: dict) -> tuple[int | None, bool]:
    """(year, approximate?) — the stated build year, else one derived from
    築N年 against the crawl date, which is what rent cards always give."""
    if row.get("build_year") is not None:
        return int(row["build_year"]), False
    age, crawled = row.get("age_years"), (row.get("scrape_date") or "")[:4]
    if age is None or not crawled.isdigit():
        return None, False
    return int(crawled) - int(age), True


def seismic_era(row: dict) -> dict:
    """Which seismic-standard tier a listing falls in, and how sure we are."""
    year, approx = build_year_of(row)
    if year is None:
        return {"era": None, "build_year_est": None, "era_approx": False}
    era = "kyu" if year <= 1981 else ("shin" if year <= 2000 else "y2000")
    return {"era": era, "build_year_est": year,
            "era_approx": approx or year in _BOUNDARY_YEARS}


# --- budget ----------------------------------------------------------------
# SUUMO's price ceiling stops at 1億2千万, so a budget above that cannot be put
# in the search URL at all — it has to be applied here instead. Land is a
# special case: buying a plot commits you to building on it, so the plot has to
# come in under the budget *minus* the house.
def budget_ceiling(row: dict, f: dict) -> float | None:
    total = f.get("budget_yen")
    if total is None:
        return None
    if row.get("category") == "land" or not (row.get("building_m2") or 0):
        build_m2 = f.get("budget_build_m2", 130)
        cost_m2 = f.get("budget_build_cost_m2", 250_000)
        return total - build_m2 * cost_m2
    return total


def apply_budget(rows: list[dict], f: dict) -> list[dict]:
    if f.get("budget_yen") is None:
        return rows
    out = []
    for r in rows:
        cap = budget_ceiling(r, f)
        price = r.get("price_yen")
        if price is not None and cap is not None and price <= cap:
            out.append(r)
    return out


def annotate_era(rows: list[dict]) -> list[dict]:
    for r in rows:
        r.update(seismic_era(r))
    return rows


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
    if f.get("eras") and seismic_era(row)["era"] not in f["eras"]:
        return False
    return True


def apply(rows: list[dict], f: dict) -> list[dict]:
    out = annotate_era([r for r in rows if matches(r, f)])
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
        "commute": lambda r: (r.get("commute_min") is None, r.get("commute_min") or big),
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

    # Crawled-time window: restrict which snapshots count, so "latest per
    # property" means the latest crawl *within* [date_from, date_to]. Dates are
    # 'YYYY-MM-DD' (scrape_date); both bounds inclusive.
    date_where, date_params = [], []
    if f.get("date_from"):
        date_where.append("scrape_date >= ?")
        date_params.append(f["date_from"])
    if f.get("date_to"):
        date_where.append("scrape_date <= ?")
        date_params.append(f["date_to"])
    cte_clause = ("WHERE " + " AND ".join(date_where)) if date_where else ""

    # Coordinates ride along when the property has been detail-enriched (LEFT
    # JOIN — most rows have none, and that must not drop them). Lets the UI
    # export map-ready rows without a second round trip.
    sql = f"""
    WITH latest AS (
        SELECT property_id, MAX(scrape_date) AS d
        FROM listings_snapshot {cte_clause} GROUP BY property_id
    ),
    det AS (
        SELECT property_id, MAX(scrape_date) AS d
        FROM property_detail WHERE lat IS NOT NULL GROUP BY property_id
    )
    SELECT {_COLS}, pd.lat AS lat, pd.lng AS lng FROM listings_snapshot s
    JOIN latest l ON l.property_id = s.property_id AND l.d = s.scrape_date
    LEFT JOIN det ON det.property_id = s.property_id
    LEFT JOIN property_detail pd
           ON pd.property_id = det.property_id AND pd.scrape_date = det.d
    {clause}
    """
    conn = connect()
    try:
        # CTE placeholders bind first (it appears first in the SQL text).
        rows = [dict(r) for r in conn.execute(sql, date_params + params).fetchall()]
    finally:
        conn.close()
    # Era is filtered in Python, not SQL: the rule needs a build year that may
    # have to be derived from 築N年, so keeping one implementation beats
    # restating the fallback as a CASE expression here and in map_points.
    rows = commute.annotate(annotate_era(rows))
    if f.get("eras"):
        rows = [r for r in rows if r["era"] in f["eras"]]
    if f.get("commute_max") is not None:
        rows = [r for r in rows if r["commute_min"] is not None
                and r["commute_min"] <= f["commute_max"]]
    rows = apply_budget(rows, f)
    rows = sort_rows(rows, f.get("sort"))
    limit = f.get("limit")
    return rows[:limit] if limit else rows


def map_points(f: dict) -> list[dict]:
    """Latest listing snapshot for each property that has an enriched location,
    joined to its most recent detail coordinates. Powers the Report map.
    Honours the same category/ward/price/date filters as search_db."""
    where, params = [], []
    for key, col in (("markets", "market"), ("categories", "category"), ("wards", "ward")):
        vals = f.get(key)
        if vals:
            where.append(f"s.{col} IN ({','.join('?' * len(vals))})")
            params += list(vals)
    for key, expr in (("price_min", "s.price_yen >= ?"), ("price_max", "s.price_yen <= ?")):
        if f.get(key) is not None:
            where.append(expr)
            params.append(f[key])
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    date_where, date_params = [], []
    if f.get("date_from"):
        date_where.append("scrape_date >= ?")
        date_params.append(f["date_from"])
    if f.get("date_to"):
        date_where.append("scrape_date <= ?")
        date_params.append(f["date_to"])
    cte_clause = ("WHERE " + " AND ".join(date_where)) if date_where else ""

    sql = f"""
    WITH latest AS (
        SELECT property_id, MAX(scrape_date) AS d
        FROM listings_snapshot {cte_clause} GROUP BY property_id
    ),
    det AS (
        SELECT property_id, MAX(scrape_date) AS d
        FROM property_detail WHERE lat IS NOT NULL GROUP BY property_id
    )
    SELECT s.property_id, pd.lat, pd.lng, s.market, s.category, s.ward,
           s.price_yen, s.price_raw, s.url, s.title, s.address, s.layout,
           s.building_m2, s.land_m2, s.nearest_walk_min, s.station_raw,
           s.build_year, s.age_years, s.scrape_date
    FROM listings_snapshot s
    JOIN latest l ON l.property_id = s.property_id AND l.d = s.scrape_date
    JOIN det ON det.property_id = s.property_id
    JOIN property_detail pd ON pd.property_id = det.property_id AND pd.scrape_date = det.d
    {clause}
    """
    conn = connect()
    try:
        rows = commute.annotate(annotate_era([dict(r) for r in conn.execute(
            sql, date_params + params).fetchall()]))
    finally:
        conn.close()
    if f.get("eras"):
        rows = [r for r in rows if r["era"] in f["eras"]]
    if f.get("commute_max") is not None:
        rows = [r for r in rows if r["commute_min"] is not None
                and r["commute_min"] <= f["commute_max"]]
    return apply_budget(rows, f)


# --- on-demand detail enrichment (exact location) --------------------------

def get_detail(property_id: str, scrape_date: str | None = None) -> dict | None:
    """Return a cached detail snapshot (with parsed specs). With `scrape_date`,
    that specific day's snapshot; otherwise the most recent one. None if absent."""
    if not property_id:
        return None
    import json
    cols = ("property_id, scrape_date, url, lat, lng, address, title, "
            "specs_json, n_specs, fetched_at")
    conn = connect()
    try:
        if scrape_date:
            row = conn.execute(
                f"SELECT {cols} FROM property_detail "
                "WHERE property_id = ? AND scrape_date = ?",
                (property_id, scrape_date)).fetchone()
        else:
            row = conn.execute(
                f"SELECT {cols} FROM property_detail WHERE property_id = ? "
                "ORDER BY scrape_date DESC LIMIT 1", (property_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        d["specs"] = json.loads(d.pop("specs_json") or "{}")
        return d
    finally:
        conn.close()


_NEXT_UPDATE_KEYS = ("次回更新予定日", "情報提供日")


def detail_fresh_until(property_id: str) -> str | None:
    """The date SUUMO says it will next refresh this listing, from the most
    recent detail snapshot — 'YYYY-MM-DD', or None if unknown.

    Detail pages carry 次回更新予定日, typically a week out. Re-fetching before
    then buys nothing: the page is guaranteed not to have been refreshed.
    """
    import json as _json
    import re as _re
    conn = connect()
    try:
        row = conn.execute(
            "SELECT specs_json FROM property_detail WHERE property_id = ? "
            "ORDER BY scrape_date DESC LIMIT 1", (property_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    specs = {k.rstrip(":").strip(): v
             for k, v in (_json.loads(row["specs_json"] or "{}")).items()}
    for key in _NEXT_UPDATE_KEYS:
        raw = specs.get(key)
        if not raw:
            continue
        m = (_re.search(r"(\d{4})年(\d{1,2})月(\d{1,2})日", raw)
             or _re.search(r"(\d{4})/(\d{1,2})/(\d{1,2})", raw))
        if m:
            y, mo, dy = map(int, m.groups())
            return f"{y:04d}-{mo:02d}-{dy:02d}"
    return None


def save_detail(d: dict, scrape_date: str | None = None) -> None:
    """Upsert a detail snapshot on (property_id, scrape_date): same day updates,
    new day inserts a new snapshot (time series)."""
    if not d.get("property_id"):
        return
    import json
    from datetime import datetime
    now = datetime.now()
    day = scrape_date or now.strftime("%Y-%m-%d")
    specs = d.get("specs") or {}
    conn = connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO property_detail "
            "(property_id, scrape_date, url, lat, lng, address, title, "
            " specs_json, n_specs, fetched_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (d["property_id"], day, d.get("url"), d.get("lat"), d.get("lng"),
             d.get("address"), d.get("title"),
             json.dumps(specs, ensure_ascii=False), len(specs),
             now.isoformat()))
        conn.commit()
    finally:
        conn.close()


# --- crawl-to-crawl diff ---------------------------------------------------

# Fields worth reporting as a change. Deliberately excludes `age_years` (derived
# from the calendar, so it drifts on its own) and `scraped_at`/`raw_json`.
_DIFF_FIELDS = [
    ("price_yen", "price"),
    ("price_max_yen", "price (max)"),
    ("price_raw", "price text"),
    ("admin_fee_yen", "admin fee"),
    ("deposit_yen", "deposit"),
    ("key_money_yen", "key money"),
    ("layout", "layout"),
    ("land_m2", "land m²"),
    ("building_m2", "building m²"),
    ("nearest_walk_min", "walk min"),
    ("floors", "floors"),
    ("unit_floor", "unit floor"),
    ("build_year", "built"),
    ("title", "title"),
    ("address", "address"),
    ("station_raw", "station"),
    ("url", "url"),
]

_DIFF_CARD = ("property_id, scrape_date, market, category, ward, url, title, "
              "address, station_raw, nearest_walk_min, price_yen, price_raw, "
              "layout, land_m2, building_m2, build_year, age_years")


def _base_url(url: str) -> str:
    """Drop the &page=N so every page of one search counts as that one search."""
    return re.sub(r"[&?]page=\d+", "", url or "")


def crawl_dates() -> list[dict]:
    """Every scrape_date present, newest first, with how much it captured."""
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(
            """SELECT scrape_date AS date,
                      COUNT(DISTINCT property_id) AS properties,
                      MIN(scraped_at) AS started, MAX(scraped_at) AS finished
               FROM listings_snapshot
               GROUP BY scrape_date ORDER BY scrape_date DESC""")]
    finally:
        conn.close()


def crawl_diff(date_from: str, date_to: str) -> dict:
    """What changed between two crawl dates.

    A property present on `date_from` but not on `date_to` is *gone*, which is
    not the same as *delisted* — it also happens when that day's jobs simply did
    not cover it. The two are separated per (category, ward) group by comparing
    how much each group captured on each date:

        absent   the group captured nothing on `date_to` — pure scope gap
        partial  the group shrank, so a miss could be either cause
        covered  the group held up, so a miss really is a delisting

    `search_urls` reports the same thing at crawl level from fetch_manifest, so
    a narrower second crawl is visible rather than reading as a wave of exits.
    """
    conn = connect()
    try:
        rows = {}
        for day in (date_from, date_to):
            rows[day] = {
                r["property_id"]: dict(r) for r in conn.execute(
                    f"SELECT {_DIFF_CARD} FROM listings_snapshot WHERE scrape_date = ?",
                    (day,))
            }

        # Per-(category, ward) capture on each side, so a job that did not run
        # is visible rather than silently reading as a wave of delistings.
        coverage: dict[tuple, dict] = {}
        for day, key in ((date_from, "from"), (date_to, "to")):
            for r in conn.execute(
                    """SELECT category, ward, COUNT(DISTINCT property_id) n
                       FROM listings_snapshot WHERE scrape_date = ?
                       GROUP BY category, ward""", (day,)):
                entry = coverage.setdefault((r["category"], r["ward"]),
                                            {"category": r["category"], "ward": r["ward"],
                                             "from": 0, "to": 0})
                entry[key] = r["n"]

        # Which search URLs each crawl actually fetched, and how deep.
        #
        # A job can run several times a day (every 6h, say), so summing n_cards
        # over a date would compare "yesterday's five runs" against "today's two
        # so far" and read as a shrinking crawl. Take the best single run
        # instead — MAX per (url, page), summed over pages — which is what
        # "how deep did this search go" actually means, independent of how many
        # times it ran.
        # Keyed on the base URL so every page of one search collapses into a
        # single row — otherwise "?…&page=2" shows up as its own search, always
        # with zero results, which is just noise in the coverage table.
        urls: dict[str, dict] = {}
        for day, key in ((date_from, "from"), (date_to, "to")):
            for r in conn.execute(
                    """SELECT url, category, page, MAX(n_cards) best
                       FROM fetch_manifest WHERE scrape_date = ?
                       GROUP BY url, category, page""", (day,)):
                base = _base_url(r["url"])
                entry = urls.setdefault(base, {
                    "url": base, "category": r["category"],
                    "from_pages": 0, "from_cards": 0, "to_pages": 0, "to_cards": 0})
                entry[f"{key}_pages"] += 1
                entry[f"{key}_cards"] += r["best"] or 0
    finally:
        conn.close()

    before, after = rows[date_from], rows[date_to]

    # Scope is judged on *which searches ran*, never on how much they returned.
    # Result counts are not independent of the answer: a group shrinks precisely
    # because a listing was delisted, so using counts to decide whether the
    # delisting was observable is circular, and files real delistings under
    # "uncertain". Comparing the set of search URLs fetched is independent of
    # what those searches happened to contain.
    def searched(day: str) -> dict[str, set]:
        by_cat: dict[str, set] = {}
        for u in urls.values():
            if u[f"{'from' if day == date_from else 'to'}_pages"]:
                by_cat.setdefault(u["category"], set()).add(_base_url(u["url"]))
        return by_cat

    ran_from, ran_to = searched(date_from), searched(date_to)

    def scope_of(card: dict) -> str:
        cat = card["category"]
        was, now = ran_from.get(cat, set()), ran_to.get(cat, set())
        if not now:
            return "absent"        # nothing for this category ran at all
        if was - now:
            return "partial"       # a search that ran before did not run again
        return "covered"           # same searches ran; a miss is a real miss

    added = [after[p] for p in after.keys() - before.keys()]

    gone = []
    for pid in before.keys() - after.keys():
        card = dict(before[pid])
        card["scope"] = scope_of(card)
        gone.append(card)

    # SUUMO agents routinely re-post a property under a fresh id to refresh its
    # listing date. That shows up as one delisting plus one new listing, which
    # is phantom churn — pair them up and report them as what they are.
    relisted = []
    if added and gone:
        def fingerprint(r: dict) -> tuple | None:
            title, price = (r.get("title") or "").strip(), r.get("price_yen")
            return (title, price) if title and price else None

        gone_by_print = {}
        for g in gone:
            fp = fingerprint(g)
            if fp:
                gone_by_print.setdefault(fp, []).append(g)

        for new_card in list(added):
            bucket = gone_by_print.get(fingerprint(new_card) or ())
            if not bucket:
                continue
            old_card = bucket.pop()
            relisted.append({"from": old_card, "to": new_card})
            added.remove(new_card)
            gone.remove(old_card)

    changed = []
    for pid in before.keys() & after.keys():
        a, b = before[pid], after[pid]
        deltas = [
            {"field": field, "label": label, "from": a.get(field), "to": b.get(field)}
            for field, label in _DIFF_FIELDS
            if a.get(field) != b.get(field)
        ]
        if deltas:
            card = dict(b)
            card["changes"] = deltas
            changed.append(card)

    key = lambda r: (r.get("ward") or "", r.get("price_yen") or 0)
    tally = lambda s: sum(1 for g in gone if g["scope"] == s)
    # Judged on pages fetched, not results returned — for the same reason
    # `scope_of` is: a search returns fewer listings *because* one was delisted,
    # so flagging that as reduced coverage contradicts the very count it feeds.
    narrowed = [u for u in urls.values() if u["to_pages"] < u["from_pages"]]

    return {
        "date_from": date_from,
        "date_to": date_to,
        "counts": {
            "before": len(before),
            "after": len(after),
            "new": len(added),
            "delisted": tally("covered"),
            "gone_partial": tally("partial"),
            "gone_absent": tally("absent"),
            "relisted": len(relisted),
            "changed": len(changed),
            "unchanged": len(before.keys() & after.keys()) - len(changed),
        },
        "new": sorted(added, key=key),
        "gone": sorted(gone, key=key),
        "changed": sorted(changed, key=key),
        "relisted": sorted(relisted, key=lambda r: key(r["to"])),
        "coverage": sorted(coverage.values(), key=lambda c: (c["category"], c["ward"])),
        "search_urls": sorted(urls.values(), key=lambda u: u["url"]),
        "narrowed": sorted(narrowed, key=lambda u: u["url"]),
    }


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
