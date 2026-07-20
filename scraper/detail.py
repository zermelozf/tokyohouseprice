"""Scrape a single property detail page.

Detail pages differ per property type, but all render their specs as
<th>/<td> (or <dt>/<dd>) tables. We save the raw HTML (bronze) and extract
every label/value pair generically, so nothing is lost even before a
type-specific parser exists.
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from bs4 import BeautifulSoup

from . import bronze
from .db import init_db
from .fetch import Fetcher


def extract_specs(html: str) -> dict:
    """Pull every th/td and dt/dd label->value pair from a detail page."""
    soup = BeautifulSoup(html, "lxml")
    specs: dict[str, str] = {}
    for th in soup.select("th"):
        td = th.find_next_sibling("td")
        if td is None:
            continue
        k = " ".join(th.get_text(" ", strip=True).split())
        v = " ".join(td.get_text(" ", strip=True).split())
        if k and v and k not in specs:
            specs[k] = v
    for dt in soup.select("dt"):
        dd = dt.find_next_sibling("dd")
        if dd is None:
            continue
        k = " ".join(dt.get_text(" ", strip=True).split())
        v = " ".join(dd.get_text(" ", strip=True).split())
        if k and v and k not in specs:
            specs[k] = v
    title = soup.select_one("h1")
    return {"title": title.get_text(strip=True) if title else None, "specs": specs}


def scrape_property(url: str, fetcher: Fetcher | None = None) -> dict:
    """Fetch one property page, persist raw HTML to bronze, return extracted specs."""
    own = fetcher is None
    fetcher = fetcher or Fetcher()
    conn = init_db()
    try:
        html = fetcher.get(url)
        m = re.search(r"/((?:nc|jnc)_[0-9]+)/", url)
        pid = m.group(1) if m else "detail"
        bronze.save_page(conn, source="suumo", market="detail", category="detail",
                         ward=pid, page=1, url=url, html=html, n_cards=1)
        result = extract_specs(html)
        result.update({"url": url, "property_id": pid,
                       "scraped_at": datetime.now().isoformat()})
        return result
    finally:
        conn.close()
        if own:
            fetcher.close()


if __name__ == "__main__":
    import sys
    print(json.dumps(scrape_property(sys.argv[1]), ensure_ascii=False, indent=2))
