"""Static catalog: Tokyo ward codes, SUUMO category endpoints, and paths.

Also loads the project-local `.env` (see `load_env`) before anything reads
`os.environ`, so credentials stay scoped to this repo rather than living in a
machine-wide config.
"""
from __future__ import annotations

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = Path(os.environ.get("SUUMO_ENV_FILE", PROJECT_ROOT / ".env"))


def load_env(path: Path = ENV_FILE) -> list[str]:
    """Read `KEY=value` lines from a project-local .env into os.environ.

    Real environment variables always win, so a cron line or a one-off
    `FOO=bar python -m scraper …` can still override the file. Returns the keys
    it set, for `--check` to report. No dependency on python-dotenv: the format
    here is deliberately just `KEY=value`, `#` comments and blank lines.
    """
    if not path.exists():
        return []

    applied = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            applied.append(key)
    return applied


LOADED_ENV_KEYS = load_env()

# --- storage layout (medallion) --------------------------------------------
DATA_DIR = Path(os.environ.get("SUUMO_DATA_DIR", Path(__file__).resolve().parent / "data"))
BRONZE_DIR = DATA_DIR / "bronze"          # raw gzipped HTML pages
DB_PATH = DATA_DIR / "suumo.db"           # manifest (bronze meta) + silver + gold

# --- SUUMO request constants ------------------------------------------------
BASE = "https://suumo.jp"
AR_KANTO = "030"        # area: Kanto
TA_TOKYO = "13"         # prefecture: Tokyo

# Sale listings: /jj/bukken/ichiran/JJ012FC001/?ar=&bs=&ta=&sc=
SALE_ICHIRAN = "/jj/bukken/ichiran/JJ012FC001/"
# Rent listings: /jj/chintai/ichiran/FR301FC001/?ar=&bs=040&ta=&sc=
RENT_ICHIRAN = "/jj/chintai/ichiran/FR301FC001/"

# The 23 special wards of Tokyo -> SUUMO city code (sc)
WARDS: dict[str, str] = {
    "chiyoda": "13101", "chuo": "13102", "minato": "13103", "shinjuku": "13104",
    "bunkyo": "13105", "taito": "13106", "sumida": "13107", "koto": "13108",
    "shinagawa": "13109", "meguro": "13110", "ota": "13111", "setagaya": "13112",
    "shibuya": "13113", "nakano": "13114", "suginami": "13115", "toshima": "13116",
    "kita": "13117", "arakawa": "13118", "itabashi": "13119", "nerima": "13120",
    "adachi": "13121", "katsushika": "13122", "edogawa": "13123",
}

# Categories. market=sale uses `bs` on SALE_ICHIRAN; market=rent uses RENT_ICHIRAN (bs=040).
# `parser` selects which card parser to use ("sale" -> property_unit, "rent" -> cassetteitem).
CATEGORIES: dict[str, dict] = {
    "used_mansion": {"market": "sale", "bs": "011", "label": "中古マンション", "parser": "sale"},
    "new_house":    {"market": "sale", "bs": "020", "label": "新築一戸建て", "parser": "sale"},
    "used_house":   {"market": "sale", "bs": "021", "label": "中古一戸建て", "parser": "sale"},
    "land":         {"market": "sale", "bs": "030", "label": "土地",         "parser": "sale"},
    "rent":         {"market": "rent", "bs": "040", "label": "賃貸",         "parser": "rent"},
    # NOTE: 新築マンション (bs=010) is served from a different endpoint (/ms/shinchiku/)
    # and is not yet supported here.
}

SALE_CATEGORIES = [k for k, v in CATEGORIES.items() if v["market"] == "sale"]
ALL_CATEGORIES = list(CATEGORIES)

# Japanese ward name (as it appears in addresses) -> ward key. Used to label
# each listing by ward when a pasted URL spans multiple/undeclared wards.
WARD_JP: dict[str, str] = {
    "千代田区": "chiyoda", "中央区": "chuo", "港区": "minato", "新宿区": "shinjuku",
    "文京区": "bunkyo", "台東区": "taito", "墨田区": "sumida", "江東区": "koto",
    "品川区": "shinagawa", "目黒区": "meguro", "大田区": "ota", "世田谷区": "setagaya",
    "渋谷区": "shibuya", "中野区": "nakano", "杉並区": "suginami", "豊島区": "toshima",
    "北区": "kita", "荒川区": "arakawa", "板橋区": "itabashi", "練馬区": "nerima",
    "足立区": "adachi", "葛飾区": "katsushika", "江戸川区": "edogawa",
}


def build_search_url(category: str, ward: str, page: int = 1) -> str:
    """Build a first/N-th page search-results URL for a category + ward."""
    if category not in CATEGORIES:
        raise ValueError(f"unknown category {category!r}; choose from {ALL_CATEGORIES}")
    if ward not in WARDS:
        raise ValueError(f"unknown ward {ward!r}; choose from {list(WARDS)}")
    cat = CATEGORIES[category]
    sc = WARDS[ward]
    path = RENT_ICHIRAN if cat["market"] == "rent" else SALE_ICHIRAN
    url = f"{BASE}{path}?ar={AR_KANTO}&bs={cat['bs']}&ta={TA_TOKYO}&sc={sc}"
    if page > 1:
        url += f"&page={page}"
    return url
