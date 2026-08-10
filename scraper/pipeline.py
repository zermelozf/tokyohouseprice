"""Orchestrate a crawl: fetch -> bronze -> parse -> silver, page by page."""
from __future__ import annotations

import logging
from datetime import datetime

from . import bronze, silver, parse_sale, parse_rent, suumo_url, normalize, detail, query
from . import commute
from .config import CATEGORIES, WARDS, build_search_url
from .db import init_db
from .fetch import Fetcher

log = logging.getLogger("suumo.pipeline")

_PARSERS = {"sale": parse_sale.parse_page, "rent": parse_rent.parse_page}


# Detail pages are the expensive half of a crawl — one fetch per property, two
# for rent (the map lives on a separate tab). A property an hour from the school
# is never going to be chosen, so paying for its exact coordinates is waste.
ENRICH_COMMUTE_MAX_MIN = 40
# SUUMO's own price ceiling stops at 1億2千万, so the budget cannot be pushed
# into the search URL — which means over-budget listings arrive anyway. Gate
# the detail fetch on it too, or the expensive half of the crawl is spent on
# properties that were never candidates.
ENRICH_BUDGET_YEN = 200_000_000


def _worth_enriching(pids: list[str], commute_max: int | None,
                     budget_yen: int | None) -> set[str]:
    """Which of `pids` deserve a detail fetch.

    Anything that cannot be judged — no cached commute, no price — is kept, so
    a missing lookup never silently drops a listing.
    """
    if not pids or (commute_max is None and budget_yen is None):
        return set(pids)
    cache = commute.table()
    conn = query.connect()
    try:
        rows = conn.execute(
            "SELECT DISTINCT property_id, station_raw, category, building_m2, price_yen "
            "FROM listings_snapshot "
            f"WHERE property_id IN ({','.join('?' * len(pids))})", pids).fetchall()
    finally:
        conn.close()
    keep = set(pids)
    for r in rows:
        if commute_max is not None:
            got = commute.listing_commute(r["station_raw"], cache)
            if got and got["commute_min"] > commute_max:
                keep.discard(r["property_id"])
                continue
        if budget_yen is not None and r["price_yen"] is not None:
            cap = query.budget_ceiling(dict(r), {"budget_yen": budget_yen})
            if cap is not None and r["price_yen"] > cap:
                keep.discard(r["property_id"])
    return keep


def enrich_details(fetcher: Fetcher, scraped: dict[str, str], scrape_date: str,
                   commute_max: int | None = ENRICH_COMMUTE_MAX_MIN,
                   budget_yen: int | None = ENRICH_BUDGET_YEN) -> int:
    """Post-processing: fetch each just-crawled property's detail page for its
    exact location + full spec table, storing a (property_id, scrape_date)
    snapshot. Skips properties already enriched today, and any beyond
    `commute_max` minutes of the school; one failure never aborts the rest.
    Returns how many were newly fetched.
    """
    done = 0
    near = _worth_enriching([p for p in scraped if p], commute_max, budget_yen)
    skipped = len(scraped) - len(near)
    if skipped:
        log.info("enrich: skipping %d listing(s) beyond %s min or over ¥%s",
                 skipped, commute_max, f"{budget_yen:,}" if budget_yen else "—")
    for pid, url in scraped.items():
        if not pid or not url or pid not in near or query.get_detail(pid, scrape_date):
            continue
        try:
            res = detail.scrape_detail(url, fetcher=fetcher)
            query.save_detail(res, scrape_date=scrape_date)
            done += 1
        except Exception as exc:  # keep going; enrichment is best-effort
            log.warning("enrich %s failed: %s", pid, exc)
    return done


def crawl_category_ward(conn, fetcher: Fetcher, category: str, ward: str,
                        max_pages: int = 5, scraped: dict | None = None) -> dict:
    """Crawl up to `max_pages` of one category+ward. Returns a small summary.
    If `scraped` is given, records each listing's {property_id: url} for the
    post-crawl detail enrichment pass."""
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
        if scraped is not None:
            for r in records:
                if r.get("property_id") and r.get("url"):
                    scraped[r["property_id"]] = r["url"]
        snaps = [silver.to_snapshot(r, scraped_at=now) for r in records]
        n = silver.upsert(conn, snaps)
        total_records += n
        pages_done = page
        log.info("%s/%s page %d: %d listings", category, ward, page, n)

    return {"category": category, "ward": ward,
            "pages": pages_done, "listings": total_records}


def crawl_url(url: str, max_pages: int = 5,
              min_delay: float = 2.0, max_delay: float = 4.0,
              enrich: bool = True) -> dict:
    """Crawl a pasted SUUMO search-results URL (bronze+silver), then (if `enrich`)
    fetch each listing's detail page for exact location + full specs."""
    meta = suumo_url.parse_suumo_url(url)
    parse_page = _PARSERS[meta["parser"]]
    ctx = {"market": meta["market"], "category": meta["category"], "ward": meta["ward_label"]}
    now = datetime.now()

    conn = init_db()
    total, pages_done, enriched = 0, 0, 0
    scraped: dict[str, str] = {}
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for page in range(1, max_pages + 1):
            purl = suumo_url.page_url(url, page)
            html = fetcher.get(purl)
            records = parse_page(html, ctx)
            for r in records:  # label each listing by its own ward (URL may span several)
                r["ward"] = normalize.ward_from_address(r.get("address")) or meta["ward_label"]
                if r.get("property_id") and r.get("url"):
                    scraped[r["property_id"]] = r["url"]
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
        if enrich and scraped:
            day = now.strftime("%Y-%m-%d")
            enriched = enrich_details(fetcher, scraped, day)
            log.info("enriched %d/%d detail pages", enriched, len(scraped))
    conn.close()
    return {"url": url, **meta, "pages": pages_done, "listings": total,
            "enriched": enriched, "seen": len(scraped)}


def crawl(categories: list[str], wards: list[str], max_pages: int = 5,
          min_delay: float = 2.0, max_delay: float = 4.0,
          enrich: bool = True) -> list[dict]:
    """Crawl the cartesian product of categories x wards, then (if `enrich`)
    fetch each listing's detail page for exact location + full specs."""
    for c in categories:
        if c not in CATEGORIES:
            raise ValueError(f"unknown category {c!r}")
    for w in wards:
        if w not in WARDS:
            raise ValueError(f"unknown ward {w!r}")

    conn = init_db()
    summaries: list[dict] = []
    scraped: dict[str, str] = {}
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for ward in wards:
            for category in categories:
                try:
                    s = crawl_category_ward(conn, fetcher, category, ward, max_pages,
                                            scraped=scraped)
                    summaries.append(s)
                except Exception as exc:  # keep going; one failure shouldn't abort the crawl
                    log.error("crawl %s/%s failed: %s", category, ward, exc)
                    summaries.append({"category": category, "ward": ward,
                                      "pages": 0, "listings": 0, "error": str(exc)})
        if enrich and scraped:
            day = datetime.now().strftime("%Y-%m-%d")
            got = enrich_details(fetcher, scraped, day)
            log.info("enriched %d/%d detail pages", got, len(scraped))
            summaries.append({"category": "(details)", "ward": "", "pages": 0,
                              "listings": 0, "enriched": got, "seen": len(scraped)})
    conn.close()
    return summaries
