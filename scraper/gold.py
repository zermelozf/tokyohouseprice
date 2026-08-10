"""Gold layer: trend aggregates over the silver snapshots.

Everything here is a query over listings_snapshot, so trends update
automatically as more daily snapshots accumulate.
"""
from __future__ import annotations

from .db import connect


def trends(market: str | None = None, category: str | None = None,
           ward: str | None = None) -> list[dict]:
    """Per (scrape_date, market, category, ward): inventory, median price, median ¥/m².

    Median ¥/m² uses building area for houses/mansions/rent and land area for land.
    """
    where, params = [], []
    if market:
        where.append("market = ?"); params.append(market)
    if category:
        where.append("category = ?"); params.append(category)
    if ward:
        where.append("ward = ?"); params.append(ward)
    clause = ("WHERE " + " AND ".join(where)) if where else ""

    # SQLite has no median(); approximate with the middle row via window ordering.
    sql = f"""
    WITH base AS (
        SELECT scrape_date, market, category, ward, price_yen,
               COALESCE(NULLIF(building_m2, 0), land_m2) AS area_m2
        FROM listings_snapshot
        {clause}
    ),
    ranked AS (
        SELECT scrape_date, market, category, ward, price_yen,
               CASE WHEN area_m2 > 0 THEN price_yen * 1.0 / area_m2 END AS ppm2
        FROM base
    )
    SELECT scrape_date, market, category, ward,
           COUNT(*)                               AS n_listings,
           CAST(AVG(price_yen) AS INTEGER)        AS mean_price_yen,
           CAST(MIN(price_yen) AS INTEGER)        AS min_price_yen,
           CAST(MAX(price_yen) AS INTEGER)        AS max_price_yen,
           CAST(AVG(ppm2) AS INTEGER)             AS mean_price_per_m2
    FROM ranked
    GROUP BY scrape_date, market, category, ward
    ORDER BY scrape_date, market, category, ward
    """
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()


def price_changes(market: str | None = None, ward: str | None = None) -> list[dict]:
    """Properties whose price_yen changed between their first and latest snapshot."""
    where, params = ["price_yen IS NOT NULL"], []
    if market:
        where.append("market = ?"); params.append(market)
    if ward:
        where.append("ward = ?"); params.append(ward)
    clause = "WHERE " + " AND ".join(where)
    sql = f"""
    WITH s AS (
        SELECT property_id, ward, category, url, title, price_yen, scrape_date,
               FIRST_VALUE(price_yen) OVER w AS first_price,
               LAST_VALUE(price_yen)  OVER w AS last_price,
               COUNT(*)               OVER (PARTITION BY property_id) AS n_obs
        FROM listings_snapshot
        {clause}
        WINDOW w AS (PARTITION BY property_id ORDER BY scrape_date
                     ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
    )
    SELECT DISTINCT property_id, ward, category, title, url,
           first_price, last_price, (last_price - first_price) AS delta_yen
    FROM s
    WHERE n_obs > 1 AND first_price <> last_price
    ORDER BY ABS(last_price - first_price) DESC
    """
    conn = connect()
    try:
        return [dict(r) for r in conn.execute(sql, params).fetchall()]
    finally:
        conn.close()
