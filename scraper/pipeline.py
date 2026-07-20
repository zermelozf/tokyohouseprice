"""Orchestrate a crawl: fetch -> bronze -> parse -> silver, page by page."""
from __future__ import annotations

import logging
from datetime import datetime

from . import bronze, silver, parse_sale, parse_rent, suumo_url, normalize
from .config import CATEGORIES, WARDS, build_search_url
from .db import init_db
from .fetch import Fetcher

log = logging.getLogger("suumo.pipeline")

_PARSERS = {"sale": parse_sale.parse_page, "rent": parse_rent.parse_page}


def crawl_category_ward(conn, fetcher: Fetcher, category: str, ward: str,
                        max_pages: int = 5) -> dict:
    """Crawl up to `max_pages` of one category+ward. Returns a small summary."""
    cat = CATEGORIES[category]
    parse_page = _PARSERS[cat["parser"]]
    ctx = {"market": cat["market"], "category": category, "ward": ward}
    now = datetime.now()

    total_records = 0
    pages_done = 0
    for page in range(1, max_pages + 1):
        url = build_search_url(category, ward, page)
        html = fetcher.get(url)
        records = parse_page(html, ctx)
        bronze.save_page(conn, source="suumo", market=cat["market"],
                         category=category, ward=ward, page=page, url=url,
                         html=html, n_cards=len(records))
        if not records:
            log.info("%s/%s page %d: 0 cards, stopping", category, ward, page)
            break
        snaps = [silver.to_snapshot(r, scraped_at=now) for r in records]
        n = silver.upsert(conn, snaps)
        total_records += n
        pages_done = page
        log.info("%s/%s page %d: %d listings", category, ward, page, n)

    return {"category": category, "ward": ward,
            "pages": pages_done, "listings": total_records}


def crawl_url(url: str, max_pages: int = 5,
              min_delay: float = 2.0, max_delay: float = 4.0) -> dict:
    """Crawl a pasted SUUMO search-results URL, paginating and storing to bronze+silver."""
    meta = suumo_url.parse_suumo_url(url)
    parse_page = _PARSERS[meta["parser"]]
    ctx = {"market": meta["market"], "category": meta["category"], "ward": meta["ward_label"]}
    now = datetime.now()

    conn = init_db()
    total, pages_done = 0, 0
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for page in range(1, max_pages + 1):
            purl = suumo_url.page_url(url, page)
            html = fetcher.get(purl)
            records = parse_page(html, ctx)
            for r in records:  # label each listing by its own ward (URL may span several)
                r["ward"] = normalize.ward_from_address(r.get("address")) or meta["ward_label"]
            bronze.save_page(conn, source="suumo", market=meta["market"],
                             category=meta["category"], ward=meta["ward_label"],
                             page=page, url=purl, html=html, n_cards=len(records))
            if not records:
                break
            n = silver.upsert(conn, [silver.to_snapshot(r, scraped_at=now) for r in records])
            total += n
            pages_done = page
            log.info("url-crawl %s/%s page %d: %d listings",
                     meta["category"], meta["ward_label"], page, n)
    conn.close()
    return {"url": url, **meta, "pages": pages_done, "listings": total}


def crawl(categories: list[str], wards: list[str], max_pages: int = 5,
          min_delay: float = 2.0, max_delay: float = 4.0) -> list[dict]:
    """Crawl the cartesian product of categories x wards."""
    for c in categories:
        if c not in CATEGORIES:
            raise ValueError(f"unknown category {c!r}")
    for w in wards:
        if w not in WARDS:
            raise ValueError(f"unknown ward {w!r}")

    conn = init_db()
    summaries: list[dict] = []
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for ward in wards:
            for category in categories:
                try:
                    s = crawl_category_ward(conn, fetcher, category, ward, max_pages)
                    summaries.append(s)
                except Exception as exc:  # keep going; one failure shouldn't abort the crawl
                    log.error("crawl %s/%s failed: %s", category, ward, exc)
                    summaries.append({"category": category, "ward": ward,
                                      "pages": 0, "listings": 0, "error": str(exc)})
    conn.close()
    return summaries
