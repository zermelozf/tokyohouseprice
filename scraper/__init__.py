"""SUUMO scraper — personal house-hunting data platform.

Medallion architecture:
  bronze  -> raw HTML pages saved to disk (gzip) + a fetch manifest (nothing lost)
  silver  -> parsed, normalized, typed listing observations (one row per property per scrape)
  gold    -> trend aggregates (median price, price/m2, inventory) by market/category/ward/date

Covers SUUMO sales (used/new houses, used mansions, land) and rentals.
See scraper/README.md for usage.
"""

__all__ = ["config", "fetch", "bronze", "silver", "gold", "pipeline"]
