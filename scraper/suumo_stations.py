"""Map station names to SUUMO's own station codes, so searches can be built
from a list of stations rather than from wards.

SUUMO identifies a station by a 9-digit code: the 4-digit line code followed by
5 digits for the station. A results URL accepts the code repeated, and — tested
— it accepts codes from *different lines in the same URL*, with no `rn` needed,
because the line is implied by the prefix. That is what makes a
"these 118 specific stations" search expressible as a single URL.

The map is scraped once from the 沿線 index pages and cached; line and station
codes are stable.

    sale    &rnek=<code>   on /jj/bukken/ichiran/JJ012FC001/
    rent    &ek=<code>     on /jj/chintai/ichiran/FR301FC001/
"""
from __future__ import annotations

import logging
import re
from datetime import datetime

from .db import connect, init_db
from .fetch import Fetcher

log = logging.getLogger("suumo.stations")

BASE = "https://suumo.jp"
# Prefecture 沿線 indexes to walk. The 30-minute catchment spills into Saitama
# (戸田/川口/浦和), so Tokyo alone is not enough.
INDEXES = {
    "tokyo": "/chintai/tokyo/ensen/",
    "saitama": "/chintai/saitama/ensen/",
}

_LINE = re.compile(
    r'name="rn"\s+value="(\d+)"[^>]*>\s*<label><a href="([^"]+)">([^<]+)</a>')
_STATION = re.compile(
    r'<input[^>]*name="ek"[^>]*value="(\d+)"[^>]*>(.{0,200}?)</label>', re.S)


def normalize(name: str) -> str:
    """SUUMO and OpenStreetMap disagree on small-kana and bracket conventions:
    西ヶ原四丁目 vs 西ケ原四丁目, 二重橋前〈丸の内〉 vs 二重橋前. Fold both to a
    common key so the two catalogues can be joined."""
    n = re.sub(r"[〈（(\[].*?[〉）)\]]", "", name)
    n = n.replace("ヶ", "ケ").replace("ヵ", "カ").replace("　", "")
    n = re.sub(r"駅$", "", n.strip())
    return n


def lines(fetcher: Fetcher) -> list[dict]:
    out = []
    for pref, path in INDEXES.items():
        html = fetcher.get(BASE + path)
        for code, page, name in _LINE.findall(html):
            out.append({"pref": pref, "rn": code, "page": page, "line": name.strip()})
    # A line crossing a prefecture border has one page per prefecture, each
    # listing only that prefecture's stations — so dedupe on the page, not on
    # the line code, or every Saitama stop on the 埼京線 goes missing.
    seen, uniq = set(), []
    for line in out:
        if line["page"] in seen:
            continue
        seen.add(line["page"])
        uniq.append(line)
    return uniq


def scrape_line(line: dict, fetcher: Fetcher) -> list[tuple[str, str]]:
    html = fetcher.get(BASE + line["page"])
    out = []
    for code, label in _STATION.findall(html):
        name = re.sub(r"<[^>]+>", "", label).strip().split("\n")[0].strip()
        name = re.sub(r"\(.*?\)|\s*\(\d[\d,]*\)\s*$", "", name).strip()
        if name:
            out.append((name, code))
    return out


def build(min_delay: float = 1.5, max_delay: float = 2.5,
          stop_when: set[str] | None = None) -> int:
    """Walk every line page and cache each station's code.

    `stop_when` is a set of normalised names still wanted; the walk ends early
    once they are all found, which usually saves most of the ~130 pages.
    """
    conn = init_db()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS suumo_station_code (
            name_key TEXT NOT NULL, station TEXT, line TEXT, rn TEXT,
            code TEXT NOT NULL, fetched_at TEXT,
            PRIMARY KEY (name_key, code))""")
        conn.commit()
    finally:
        conn.close()

    wanted = set(stop_when or ())
    found_keys: set[str] = set()
    n = 0
    with Fetcher(min_delay=min_delay, max_delay=max_delay) as fetcher:
        for line in lines(fetcher):
            try:
                stations = scrape_line(line, fetcher)
            except Exception as exc:
                log.warning("line %s failed: %s", line["line"], exc)
                continue
            rows = [(normalize(nm), nm, line["line"], line["rn"], code,
                     datetime.now().isoformat()) for nm, code in stations]
            if rows:
                conn = init_db()
                try:
                    conn.executemany(
                        "INSERT OR REPLACE INTO suumo_station_code "
                        "(name_key, station, line, rn, code, fetched_at) "
                        "VALUES (?,?,?,?,?,?)", rows)
                    conn.commit()
                finally:
                    conn.close()
                n += len(rows)
                found_keys |= {r[0] for r in rows}
            if wanted and wanted <= found_keys:
                log.info("all wanted stations found after %s", line["line"])
                break
    return n


def codes_for(names: list[str]) -> tuple[dict[str, str], list[str]]:
    """(name -> code, missing). A station on several lines resolves to one code;
    SUUMO treats any of its codes as the same place for searching."""
    conn = connect()
    try:
        rows = list(conn.execute(
            "SELECT name_key, station, line, code FROM suumo_station_code"))
    finally:
        conn.close()
    by_key: dict[str, list] = {}
    for r in rows:
        by_key.setdefault(r["name_key"], []).append(r)
    out, missing = {}, []
    for name in names:
        hits = by_key.get(normalize(name))
        if hits:
            out[name] = hits[0]["code"]
        else:
            missing.append(name)
    return out, missing
