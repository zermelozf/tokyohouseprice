"""Command-line interface for the SUUMO scraper.

Examples:
  # Crawl everything (all sale types + rent) for two wards, 5 pages each
  python -m scraper crawl --ward setagaya,meguro --max-pages 5

  # Crawl just used houses across all 23 wards
  python -m scraper crawl --category used_house --ward all --max-pages 3

  # One property, all specs
  python -m scraper property https://suumo.jp/chukoikkodate/tokyo/sc_setagaya/nc_20933882/

  # Trends and price changes
  python -m scraper trends --market sale --ward setagaya
  python -m scraper changes --ward setagaya
"""
from __future__ import annotations

import argparse
import json
import logging

from . import gold
from .config import ALL_CATEGORIES, SALE_CATEGORIES, WARDS
from .detail import scrape_property
from .pipeline import crawl, crawl_url


def _resolve(value: str, valid: list[str], name: str) -> list[str]:
    if value == "all":
        return list(valid)
    items = [v.strip() for v in value.split(",") if v.strip()]
    bad = [i for i in items if i not in valid]
    if bad:
        raise SystemExit(f"unknown {name}: {bad}\n  valid: {valid}")
    return items


def main(argv: list[str] | None = None) -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    p = argparse.ArgumentParser(prog="scraper", description="SUUMO scraper (medallion)")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("crawl", help="crawl categories x wards into bronze+silver")
    c.add_argument("--category", default="all",
                   help=f"comma list or 'all' (sale-only: 'sale'); options: {ALL_CATEGORIES}")
    c.add_argument("--ward", default="all", help="comma list or 'all' (23 wards)")
    c.add_argument("--max-pages", type=int, default=5)
    c.add_argument("--min-delay", type=float, default=2.0)
    c.add_argument("--max-delay", type=float, default=4.0)

    cu = sub.add_parser("crawl-url", help="crawl a pasted SUUMO search-results URL")
    cu.add_argument("url")
    cu.add_argument("--max-pages", type=int, default=5)
    cu.add_argument("--min-delay", type=float, default=2.0)
    cu.add_argument("--max-delay", type=float, default=4.0)

    d = sub.add_parser("property", help="scrape one property detail page")
    d.add_argument("url")

    t = sub.add_parser("trends", help="print trend aggregates")
    t.add_argument("--market"); t.add_argument("--category"); t.add_argument("--ward")

    ch = sub.add_parser("changes", help="list properties whose price changed over time")
    ch.add_argument("--market"); ch.add_argument("--ward")

    args = p.parse_args(argv)

    if args.cmd == "crawl":
        cats = SALE_CATEGORIES if args.category == "sale" else _resolve(
            args.category, ALL_CATEGORIES, "category")
        wards = _resolve(args.ward, list(WARDS), "ward")
        summaries = crawl(cats, wards, max_pages=args.max_pages,
                          min_delay=args.min_delay, max_delay=args.max_delay)
        total = sum(s["listings"] for s in summaries)
        print(json.dumps(summaries, ensure_ascii=False, indent=2))
        print(f"\nTOTAL listings upserted: {total}")
    elif args.cmd == "crawl-url":
        summary = crawl_url(args.url, max_pages=args.max_pages,
                            min_delay=args.min_delay, max_delay=args.max_delay)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    elif args.cmd == "property":
        print(json.dumps(scrape_property(args.url), ensure_ascii=False, indent=2))
    elif args.cmd == "trends":
        print(json.dumps(gold.trends(args.market, args.category, args.ward),
                         ensure_ascii=False, indent=2))
    elif args.cmd == "changes":
        print(json.dumps(gold.price_changes(args.market, args.ward),
                         ensure_ascii=False, indent=2))
