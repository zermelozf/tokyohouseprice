"""Bronze layer: persist every raw HTML page and record it in the manifest."""
from __future__ import annotations

import gzip
import hashlib
from datetime import datetime

from .config import BRONZE_DIR


def save_page(conn, *, source: str, market: str, category: str, ward: str,
              page: int, url: str, html: str, n_cards: int | None = None) -> str:
    """Write gzipped HTML to disk and insert a manifest row. Returns the path."""
    now = datetime.now()
    scrape_date = now.strftime("%Y-%m-%d")
    body = html.encode("utf-8")
    sha = hashlib.sha256(body).hexdigest()

    out_dir = BRONZE_DIR / source / market / category / ward / scrape_date
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"page_{page:03d}.html.gz"
    with gzip.open(path, "wb") as fh:
        fh.write(body)

    conn.execute(
        """INSERT INTO fetch_manifest
           (source, market, category, ward, page, url, fetched_at, scrape_date,
            http_ok, n_bytes, n_cards, sha256, path)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (source, market, category, ward, page, url, now.isoformat(), scrape_date,
         1, len(body), n_cards, sha, str(path)),
    )
    conn.commit()
    return str(path)


def read_page(path: str) -> str:
    with gzip.open(path, "rb") as fh:
        return fh.read().decode("utf-8")
