"""Parsing helpers: turn SUUMO's Japanese text fields into typed values."""
from __future__ import annotations

import re
from datetime import datetime

from .config import WARD_JP


def ward_from_address(address: str | None) -> str | None:
    """'東京都世田谷区北烏山７' -> 'setagaya'. Longest name first avoids partials."""
    if not address:
        return None
    for jp in sorted(WARD_JP, key=len, reverse=True):
        if jp in address:
            return WARD_JP[jp]
    return None

# --- price ------------------------------------------------------------------
_OKU = 10 ** 8   # 億
_MAN = 10 ** 4   # 万


def parse_price_yen(text: str | None) -> int | None:
    """'1980万円' -> 19800000 ; '1億2500万円' -> 125000000 ; '5.5万円' -> 55000.

    Returns the first/min amount found (see parse_price_range for ranges).
    """
    if not text:
        return None
    total = 0
    matched = False
    m = re.search(r"([0-9]+)\s*億", text)
    if m:
        total += int(m.group(1)) * _OKU
        matched = True
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*万", text)
    if m:
        total += int(float(m.group(1)) * _MAN)
        matched = True
    if not matched:  # plain yen, e.g. '9800円'
        m = re.search(r"([0-9,]+)\s*円", text)
        if m:
            total += int(m.group(1).replace(",", ""))
            matched = True
    return total if matched else None


def parse_price_range(text: str | None) -> tuple[int | None, int | None]:
    """Handle multi-unit ranges like '1980万円～2980万円' -> (min, max)."""
    if not text:
        return None, None
    parts = re.split(r"[~〜～]", text)
    lo = parse_price_yen(parts[0])
    hi = parse_price_yen(parts[-1]) if len(parts) > 1 else None
    return lo, hi


# --- area -------------------------------------------------------------------
def parse_area_m2(text: str | None) -> float | None:
    """'39m2', '92.46m 2', '39㎡' -> float. Ranges return the first value."""
    if not text:
        return None
    m = re.search(r"([0-9]+(?:\.[0-9]+)?)\s*(?:m|㎡)", text)
    return float(m.group(1)) if m else None


# --- station ----------------------------------------------------------------
_STATION_RE = re.compile(
    r"(?P<line>.+?)[「/](?P<station>.+?)[」/]?\s*(?:駅)?\s*(?:徒歩|歩)\s*(?P<walk>[0-9]+)\s*分"
)


def parse_stations(text: str | None) -> list[dict]:
    """Parse one or many 'line/station walk-min' fragments.

    Sale:  '京王線「千歳烏山」徒歩18分'
    Rent:  '東急大井町線/九品仏駅 歩8分'
    """
    if not text:
        return []
    out: list[dict] = []
    for frag in re.split(r"[\n,、]|\s{2,}", text):
        frag = frag.strip()
        if not frag:
            continue
        m = _STATION_RE.search(frag)
        if m:
            out.append({
                "line": m.group("line").strip(),
                "station": m.group("station").strip("駅 「」/"),
                "walk_min": int(m.group("walk")),
            })
    return out


def nearest_walk_min(stations: list[dict]) -> int | None:
    mins = [s["walk_min"] for s in stations if s.get("walk_min") is not None]
    return min(mins) if mins else None


# --- age / build date -------------------------------------------------------
def parse_build_date(text: str | None) -> tuple[int | None, int | None]:
    """'1963年11月' -> (1963, 11) ; '2020年' -> (2020, None)."""
    if not text:
        return None, None
    y = re.search(r"([0-9]{4})\s*年", text)
    mo = re.search(r"年\s*([0-9]{1,2})\s*月", text)
    return (int(y.group(1)) if y else None,
            int(mo.group(1)) if mo else None)


def parse_age_years(text: str | None, ref_year: int | None = None) -> int | None:
    """From '築8年' -> 8, '新築' -> 0, or from a '1963年11月' build date."""
    if not text:
        return None
    if "新築" in text:
        return 0
    m = re.search(r"築\s*([0-9]+)\s*年", text)
    if m:
        return int(m.group(1))
    year, _ = parse_build_date(text)
    if year:
        ref = ref_year or datetime.now().year
        return max(ref - year, 0)
    return None
