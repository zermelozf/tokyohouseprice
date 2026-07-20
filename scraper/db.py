"""SQLite connection + schema for the manifest (bronze meta) and silver tables."""
from __future__ import annotations

import sqlite3

from .config import DB_PATH, DATA_DIR

SCHEMA = """
-- Bronze: one row per HTTP page fetched; `path` points at the gzipped HTML.
CREATE TABLE IF NOT EXISTS fetch_manifest (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    source      TEXT NOT NULL,
    market      TEXT NOT NULL,
    category    TEXT NOT NULL,
    ward        TEXT NOT NULL,
    page        INTEGER NOT NULL,
    url         TEXT NOT NULL,
    fetched_at  TEXT NOT NULL,
    scrape_date TEXT NOT NULL,
    http_ok     INTEGER NOT NULL,
    n_bytes     INTEGER,
    n_cards     INTEGER,
    sha256      TEXT,
    path        TEXT
);

-- Silver: one normalized observation per (property, scrape_date). Re-scraping
-- the same day updates the row; a new day inserts a new snapshot -> time series.
CREATE TABLE IF NOT EXISTS listings_snapshot (
    property_id   TEXT NOT NULL,
    scrape_date   TEXT NOT NULL,
    source        TEXT NOT NULL,
    market        TEXT NOT NULL,
    category      TEXT NOT NULL,
    ward          TEXT NOT NULL,
    building_id   TEXT,
    url           TEXT,
    title         TEXT,
    address       TEXT,
    station_raw   TEXT,
    stations_json TEXT,
    nearest_walk_min INTEGER,
    price_yen     INTEGER,
    price_max_yen INTEGER,
    price_raw     TEXT,
    admin_fee_yen INTEGER,
    deposit_yen   INTEGER,
    key_money_yen INTEGER,
    layout        TEXT,
    land_m2       REAL,
    building_m2   REAL,
    unit_floor    TEXT,
    floors        TEXT,
    build_year    INTEGER,
    build_month   INTEGER,
    age_years     INTEGER,
    scraped_at    TEXT,
    raw_json      TEXT,
    PRIMARY KEY (property_id, scrape_date)
);

CREATE INDEX IF NOT EXISTS idx_snap_query
    ON listings_snapshot (market, category, ward, scrape_date);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(conn: sqlite3.Connection | None = None) -> sqlite3.Connection:
    conn = conn or connect()
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
