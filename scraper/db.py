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
    -- 賃貸マンション / 賃貸一戸建て / 中古一戸建て … the card's own type label.
    -- Rent needs it: a flat and a house are both category='rent' but are not
    -- remotely the same product, and their size floors differ.
    property_label TEXT,
    image_url     TEXT,
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

-- Detail-page enrichment. Same snapshot model as listings_snapshot: one row per
-- (property, scrape_date) — re-scraping the same day updates the row, a new day
-- inserts a new snapshot (time series). Holds the exact geocoded location the
-- list pages lack, plus the full detail spec table (every 重要事項/takken-relevant
-- label→value pair) as JSON so we can promote fields to a model without re-scraping.
CREATE TABLE IF NOT EXISTS property_detail (
    property_id  TEXT NOT NULL,
    scrape_date  TEXT NOT NULL,
    url          TEXT,
    lat          REAL,
    lng          REAL,
    address      TEXT,
    title        TEXT,
    specs_json   TEXT,        -- full {label: value} map from the detail page
    images_json  TEXT,        -- the property's own photos, in page order
    n_specs      INTEGER,
    fetched_at   TEXT,
    PRIMARY KEY (property_id, scrape_date)
);

-- Named filter presets. The map carries a lot of state (eight ranges plus a
-- dozen scalars), so retyping it is the main friction in coming back to a
-- search you had already tuned.
CREATE TABLE IF NOT EXISTS saved_filter (
    name        TEXT PRIMARY KEY,
    filters     TEXT,          -- JSON blob, opaque to the server
    created     TEXT
);

-- Manual verdicts. Keyed on property_id alone, not (property_id, date): a
-- judgement about a place does not expire when the crawl re-runs, and it must
-- survive the listing being relisted under a new price.
CREATE TABLE IF NOT EXISTS listing_review (
    property_id  TEXT PRIMARY KEY,
    verdict      TEXT,          -- good | maybe | bad
    tags         TEXT,          -- comma-separated, free-form
    note         TEXT,
    reviewed_at  TEXT
);

-- Transit time from a station to the Lycée Français. Timetables move rarely,
-- so this is fetched once and cached; `via` records which of the walkable
-- stations gave the best total.
-- Every station within reach, from OpenStreetMap. Fetched once; the commute
-- job walks this list.
CREATE TABLE IF NOT EXISTS station_catalog (
    station      TEXT PRIMARY KEY,
    lat          REAL,
    lng          REAL,
    distance_km  REAL,
    fetched_at   TEXT
);

CREATE TABLE IF NOT EXISTS station_commute (
    station             TEXT PRIMARY KEY,
    via                 TEXT,
    transit_min         INTEGER,
    transfers           INTEGER,
    fare_yen            INTEGER,
    walk_from_dest_min  INTEGER,
    total_min           INTEGER,
    -- 0 = coarse (one destination), 1 = refined against all of them.
    refined             INTEGER DEFAULT 0,
    fetched_at          TEXT
);
"""


def _migrate(conn: sqlite3.Connection) -> None:
    """Drop the old single-row property_detail (keyed on property_id only) so it
    is recreated with the (property_id, scrape_date) snapshot schema. It's a
    re-fetchable cache, so dropping it loses nothing permanent."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(property_detail)").fetchall()]
    if cols and "scrape_date" not in cols:
        conn.execute("DROP TABLE property_detail")
        conn.commit()


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(conn: sqlite3.Connection | None = None) -> sqlite3.Connection:
    conn = conn or connect()
    _migrate(conn)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn
