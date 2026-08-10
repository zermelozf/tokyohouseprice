"""One-shot fetch of the census + projection data behind the Tokyo map.

This is NOT part of the build. The 2020 census is final and the IPSS
projections are revised roughly every five years, so this script was run once
and its output — app/public/chome-stats.json — is committed. It only exists so
that the provenance of every number on the map is auditable, and so the file
can be regenerated if the source tables are ever revised.

    python scripts/fetch_map_data.py            # reuse anything in scripts/raw/
    python scripts/fetch_map_data.py --refresh  # re-download the sources

Sources
-------
Block level (町丁・字等), 3,039 polygons, joined on the 11-digit KEY_CODE that
`app/public/plo.json` already carries:
    令和2年国勢調査 小地域集計, via the e-Stat statistical GIS download.
    https://www.e-stat.go.jp/gis/statmap-search?page=1&type=1&toukeiCode=00200521

Ward level (23 special wards), used only for the 2050 outlook in the popup —
population projections are not published below municipality level:
    国立社会保障・人口問題研究所「日本の地域別将来推計人口（令和5(2023)年推計）」
    https://www.ipss.go.jp/pp-shicyoson/j/shicyoson23/t-page.asp
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = Path(__file__).resolve().parent / "raw"
OUT_PATH = ROOT / "app" / "public" / "chome-stats.json"
PLO_PATH = ROOT / "app" / "public" / "plo.json"

TOKYO_PREF = "13"

# ----------------------------------------------------------------- block level

ESTAT_GIS = "https://www.e-stat.go.jp/gis/statmap-search/data"

# e-Stat table id -> the columns we keep, as {output field: 1-based column index
# within that table's value block}. Column meanings are in the second header row
# of each file; the mapping below records them in English.
ESTAT_TABLES = {
    # 年齢（5歳階級、4区分）別、男女別人口
    "T001082": {
        "pop": 1,          # 総数（年齢不詳含む）
        "age_0_14": 17,    # 15歳未満
        "age_15_64": 18,   # 15～64歳
        "age_65": 19,      # 65歳以上
        "age_75": 20,      # 75歳以上
        "age_20_24": 6,
        "age_25_29": 7,
        "age_30_34": 8,
        "age_35_39": 9,
    },
    # 世帯人員別一般世帯数
    "T001083": {
        "hh_general": 1,   # 一般世帯数
        "hh_1person": 2,   # 世帯人員1人
    },
    # 世帯の家族類型別一般世帯数
    "T001084": {
        "hh_couple_kids": 5,   # 夫婦と子供から成る世帯
        "hh_under6": 7,        # 6歳未満世帯員のいる世帯
        "hh_under18": 8,       # 18歳未満世帯員のいる世帯
    },
    # 住宅の所有の関係別一般世帯数
    "T001085": {
        "hh_housed": 1,      # 住宅に住む一般世帯
        "hh_owned": 2,       # 持ち家
        "hh_priv_rent": 3,   # 民営借家
    },
    # 住宅の建て方別世帯数
    "T001086": {
        "hh_main": 1,        # 主世帯数
        "hh_detached": 2,    # 一戸建
        "hh_apt_6_10": 7,    # 共同住宅6～10階建
        "hh_apt_11plus": 8,  # 共同住宅11階建以上
    },
    # 職業（大分類）別就業者数
    "T001104": {
        "workers": 1,           # 総数
        "work_managers": 2,     # A 管理的職業従事者
        "work_professional": 3, # B 専門的・技術的職業従事者
    },
}

# e-Stat marks withheld values (disclosure control on very small blocks) with
# "*" or "X", and a genuine zero with "-".
WITHHELD = {"*", "X", ""}
ZERO = {"-"}

# --------------------------------------------------------------- ward level

IPSS_BASE = "https://www.ipss.go.jp/pp-shicyoson/j/shicyoson23/2gaiyo_hyo"
IPSS_TABLES = {
    "kekkahyo1": "total",
    "kekkahyo2_1": "age0_14",
    "kekkahyo2_2": "age15_64",
    "kekkahyo2_3": "age65plus",
    "kekkahyo2_4": "age75plus",
}
YEARS = [2020, 2025, 2030, 2035, 2040, 2045, 2050]

WARD_NAMES_EN = {
    13101: "Chiyoda", 13102: "Chuo", 13103: "Minato", 13104: "Shinjuku",
    13105: "Bunkyo", 13106: "Taito", 13107: "Sumida", 13108: "Koto",
    13109: "Shinagawa", 13110: "Meguro", 13111: "Ota", 13112: "Setagaya",
    13113: "Shibuya", 13114: "Nakano", 13115: "Suginami", 13116: "Toshima",
    13117: "Kita", 13118: "Arakawa", 13119: "Itabashi", 13120: "Nerima",
    13121: "Adachi", 13122: "Katsushika", 13123: "Edogawa",
}


def fetch(url: str, path: Path) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    print(f"downloading {url}")
    urllib.request.urlretrieve(url, path)
    return path


def read_estat_table(stats_id: str, columns: dict[str, int], refresh: bool) -> dict[str, dict]:
    """Return {KEY_CODE: {field: value|None}} for one e-Stat small-area table."""
    path = RAW_DIR / f"{stats_id}.zip"
    if refresh or not path.exists():
        fetch(f"{ESTAT_GIS}?statsId={stats_id}&code={TOKYO_PREF}&downloadType=2", path)

    with zipfile.ZipFile(path) as z:
        text = z.read(z.namelist()[0]).decode("cp932")

    rows = list(csv.reader(io.StringIO(text)))
    # Row 0 is the column codes, row 1 the Japanese labels, data starts at row 2.
    # KEY_CODE is column 0, followed by a run of bookkeeping columns whose width
    # varies by table (mesh files carry four, small-area files seven), so locate
    # the value block by its first `T00…` column rather than assuming.
    header = rows[0]
    offset = next(i for i, name in enumerate(header) if name.startswith(stats_id))

    out: dict[str, dict] = {}
    for row in rows[2:]:
        values = {}
        for field, index in columns.items():
            raw = row[offset + index - 1].strip()
            if raw in WITHHELD:
                values[field] = None
            elif raw in ZERO:
                values[field] = 0
            else:
                values[field] = int(raw)
        out[row[0]] = values
    return out


def read_ipss(refresh: bool) -> dict[str, dict]:
    tables = {}
    for stem, key in IPSS_TABLES.items():
        path = RAW_DIR / f"{stem}.xlsx"
        if refresh or not path.exists():
            fetch(f"{IPSS_BASE}/{stem}.xlsx", path)

        # 3 header rows, then row 4 holds the years; column 0 is the municipality
        # code and columns 4-10 the headcounts for 2020-2050.
        df = pd.read_excel(path, header=None, skiprows=5, usecols=[0, *range(4, 11)])
        df = df[df[0].isin(WARD_NAMES_EN)]
        missing = set(WARD_NAMES_EN) - set(df[0])
        if missing:
            raise RuntimeError(f"{stem}: missing ward codes {sorted(missing)}")
        tables[key] = {
            int(r[0]): {y: int(r[4 + i]) for i, y in enumerate(YEARS)}
            for _, r in df.iterrows()
        }

    wards = {}
    for code, name_en in WARD_NAMES_EN.items():
        total = tables["total"][code]
        wards[str(code)] = {
            "name_en": name_en,
            "population": {str(y): total[y] for y in YEARS},
            "age_share": {
                band: {str(y): round(tables[band][code][y] / total[y], 5) for y in YEARS}
                for band in ("age0_14", "age15_64", "age65plus", "age75plus")
            },
            "age_count": {
                band: {str(y): tables[band][code][y] for y in YEARS}
                for band in ("age0_14", "age15_64", "age65plus", "age75plus")
            },
        }
    return wards


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="re-download sources")
    args = parser.parse_args()

    plo_keys = [f["properties"]["KEY_CODE"] for f in json.loads(PLO_PATH.read_text())]

    blocks: dict[str, dict] = {key: {} for key in plo_keys}
    for stats_id, columns in ESTAT_TABLES.items():
        table = read_estat_table(stats_id, columns, args.refresh)
        matched = sum(1 for key in blocks if key in table)
        print(f"{stats_id}: {matched}/{len(blocks)} blocks matched")
        if matched != len(blocks):
            raise RuntimeError(f"{stats_id} does not cover every polygon")
        for key in blocks:
            blocks[key].update(table[key])

    payload = {
        "meta": {
            "block_source": "令和2年国勢調査 小地域集計 (e-Stat 統計GIS)",
            "block_source_url":
                "https://www.e-stat.go.jp/gis/statmap-search?page=1&type=1&toukeiCode=00200521",
            "ward_source": "IPSS 日本の地域別将来推計人口 (令和5(2023)年推計)",
            "ward_source_url": "https://www.ipss.go.jp/pp-shicyoson/j/shicyoson23/t-page.asp",
            "note": "Block figures are the 2020 census. Ward figures for 2025-2050 "
                    "are projections; they exist only at municipality level. "
                    "null means e-Stat withheld the value for disclosure control.",
            "projection_years": YEARS,
        },
        "blocks": blocks,
        "wards": read_ipss(args.refresh),
    }

    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    print(f"wrote {OUT_PATH} ({OUT_PATH.stat().st_size / 1024:.0f} KB, {len(blocks)} blocks)")


if __name__ == "__main__":
    main()
