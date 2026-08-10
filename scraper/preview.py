"""Live preview: fetch a small real sample from SUUMO for chosen criteria.

Used by the dashboard to validate filters before committing to a scheduled
crawl. Persists to bronze/silver only when persist=True (default off, so testing
criteria doesn't clutter the dataset).
"""
from __future__ import annotations

from datetime import datetime

from . import bronze, silver, parse_sale, parse_rent, query, suumo_url, normalize
from .config import CATEGORIES, build_search_url
from .db import init_db
from .fetch import Fetcher

_PARSERS = {"sale": parse_sale.parse_page, "rent": parse_rent.parse_page}


def run(categories: list[str], wards: list[str], filters: dict,
        max_pages: int = 1, persist: bool = False,
        min_delay: float = 1.0, max_delay: float = 2.0) -> dict:
    """Fetch a live sample, normalize, apply filters. Returns rows + counts."""
    now = datetime.now()
    conn = init_db() if persist else None
    raw_rows: list[dict] = []
    pages_fetched = 0
    try:
        with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
            for ward in wards:
                for category in categories:
                    cat = CATEGORIES[category]
                    parse_page = _PARSERS[cat["parser"]]
                    ctx = {"market": cat["market"], "category": category, "ward": ward}
                    for page in range(1, max_pages + 1):
                        url = build_search_url(category, ward, page)
                        html = fetcher.get(url)
                        pages_fetched += 1
                        recs = parse_page(html, ctx)
                        snaps = [silver.to_snapshot(r, scraped_at=now) for r in recs]
                        raw_rows.extend(snaps)
                        if persist:
                            bronze.save_page(conn, source="suumo", market=cat["market"],
                                             category=category, ward=ward, page=page,
                                             url=url, html=html, n_cards=len(recs))
                            silver.upsert(conn, snaps)
                        if not recs:
                            break
    finally:
        if conn:
            conn.close()

    matched = query.apply(raw_rows, filters)
    return {
        "fetched": len(raw_rows),
        "matched": len(matched),
        "pages_fetched": pages_fetched,
        "persisted": persist,
        "rows": matched,
    }


def run_url(url: str, filters: dict, max_pages: int = 1, persist: bool = False,
            min_delay: float = 1.0, max_delay: float = 2.0) -> dict:
    """Live preview from a pasted SUUMO search-results URL."""
    meta = suumo_url.parse_suumo_url(url)
    parse_page = _PARSERS[meta["parser"]]
    ctx = {"market": meta["market"], "category": meta["category"], "ward": meta["ward_label"]}
    now = datetime.now()
    conn = init_db() if persist else None
    raw_rows: list[dict] = []
    pages_fetched = 0
    try:
        with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
            for page in range(1, max_pages + 1):
                purl = suumo_url.page_url(url, page)
                html = fetcher.get(purl)
                pages_fetched += 1
                recs = parse_page(html, ctx)
                for r in recs:
                    r["ward"] = normalize.ward_from_address(r.get("address")) or meta["ward_label"]
                snaps = [silver.to_snapshot(r, scraped_at=now) for r in recs]
                raw_rows.extend(snaps)
                if persist:
                    bronze.save_page(conn, source="suumo", market=meta["market"],
                                     category=meta["category"], ward=meta["ward_label"],
                                     page=page, url=purl, html=html, n_cards=len(recs))
                    silver.upsert(conn, snaps)
                if not recs:
                    break
    finally:
        if conn:
            conn.close()

    matched = query.apply(raw_rows, filters)
    return {"fetched": len(raw_rows), "matched": len(matched),
            "pages_fetched": pages_fetched, "persisted": persist,
            "meta": meta, "rows": matched}
