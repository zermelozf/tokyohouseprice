"""What a plot is like to stand on, from what the listing already says.

None of this needs another request: it is all in the spec sheet, written as
prose that nobody reads twice. The 私道負担・道路 line carries which way the plot
faces and how wide the road is; その他制限事項 and 特記事項 carry the defects that
decide whether a house is buildable, mortgageable, or dark.

Aspect is the one worth being careful about. A road guarantees open sky — no
neighbour can build in it — so the direction of the frontage is the closest
thing to a light measurement available without modelling every surrounding
roof. It is reported as an aspect, not as sunlight hours, because that is what
it is.
"""
from __future__ import annotations

import re

# SUUMO writes directions as one or two kanji before the width: 南4ｍ幅,
# 北東4ｍ幅. Two-character ones first, or 南 would match inside 南東.
DIRECTIONS = [
    ("南東", "SE"), ("南西", "SW"), ("北東", "NE"), ("北西", "NW"),
    ("東南", "SE"), ("西南", "SW"), ("東北", "NE"), ("西北", "NW"),
    ("南", "S"), ("北", "N"), ("東", "E"), ("西", "W"),
]
# How much open sky each aspect buys in Tokyo, 0-1. South is the whole point;
# north frontage means the sunny side of the plot is your neighbour's wall.
ASPECT_LIGHT = {"S": 1.0, "SE": 0.9, "SW": 0.85, "E": 0.65, "W": 0.6,
                "NE": 0.4, "NW": 0.35, "N": 0.25}

# Things that change what you can build, or whether a bank will lend.
FLAGS = {
    "corner":        (r"角地",              "corner plot — light on two sides, and 建ぺい率 is usually raised"),
    "flag_lot":      (r"旗竿|敷地延長|路地状", "flag lot — the house sits behind a driveway, with little frontage"),
    "no_rebuild":    (r"再建築不可",         "cannot be rebuilt — hard to mortgage and to sell on"),
    "encroachment":  (r"越境",              "something crosses the boundary — a wall, eaves, or pipes"),
    "slope":         (r"高低差|擁壁|がけ|傾斜", "level change, retaining wall or cliff on the plot"),
    "build_tied":    (r"建築条件",           "you must build with the seller's builder"),
    "power_line":    (r"高圧線",            "under or beside a power line"),
    "cemetery":      (r"墓地",              "next to a cemetery"),
    "setback_todo":  (r"セットバック[^。、]{0,6}(要|有|必要)", "must cede land to widen the road"),
}


def _zen2han(s: str) -> str:
    return s.translate(str.maketrans("０１２３４５６７８９．ｍ％（）", "0123456789.m%()"))


def frontages(raw: str | None) -> list[dict]:
    """Every road the plot touches: which way it faces and how wide it is.

    '無、南4ｍ幅（接道幅8.2ｍ）' is one road; '南西4.2ｍ幅、東2.8ｍ幅' is two, and a
    plot touching two roads at an angle is usually a corner.
    """
    if not raw:
        return []
    text = _zen2han(raw)
    out = []
    for m in re.finditer(r"(南東|南西|北東|北西|東南|西南|東北|西北|南|北|東|西)\s*([\d.]+)\s*m", text):
        jp, code = m.group(1), next(c for j, c in DIRECTIONS if j == m.group(1))
        width = float(m.group(2))
        if 0 < width < 50:
            out.append({"dir": code, "dir_ja": jp, "width_m": width})
    return out


def flags(specs: dict) -> list[str]:
    blob = " ".join(str(v) for v in specs.values())
    return [k for k, (pat, _) in FLAGS.items() if re.search(pat, blob)]


def annotate(rows: list[dict], specs_by_id: dict[str, dict]) -> list[dict]:
    """Attach `plot` to every row we have a spec sheet for."""
    for r in rows:
        specs = specs_by_id.get(r.get("property_id"))
        if not specs:
            r["plot"] = None
            continue
        s = {re.sub(r"\s*ヒント\s*$", "", k.rstrip(":").strip()).replace("･", "・"): v
             for k, v in specs.items()}
        roads = frontages(s.get("私道負担・道路"))
        fl = flags(s)
        # A plot touching two roads facing different ways is a corner even when
        # the listing does not use the word.
        if len({f["dir"] for f in roads}) > 1 and "corner" not in fl:
            fl.append("corner")
        best = max(roads, key=lambda f: ASPECT_LIGHT.get(f["dir"], 0), default=None)
        aspect = best["dir"] if best else None
        # Open sky in front, widened a little by a wide road and by a second
        # frontage. Deliberately not called sunlight: it says which way the plot
        # faces and how much room is in front of it, which is all the listing
        # can support.
        light = None
        if aspect:
            light = ASPECT_LIGHT[aspect]
            light += 0.05 * min(best["width_m"], 8) / 8      # a wide road helps
            if "corner" in fl:
                light += 0.1
            light = round(min(1.0, light), 2)
        r["plot"] = {
            "frontages": roads,
            "aspect": aspect,
            "aspect_ja": best["dir_ja"] if best else None,
            "road_width_m": best["width_m"] if best else None,
            "frontage_m": _frontage_width(s),
            "light_score": light,
            "flags": fl,
            "notes": [FLAGS[k][1] for k in fl],
        }
    return rows


def _frontage_width(s: dict) -> float | None:
    """接道幅 or 間口 — how wide the plot is where it meets the road."""
    for field in ("私道負担・道路", "その他概要・特記事項", "その他制限事項"):
        text = _zen2han(str(s.get(field) or ""))
        m = re.search(r"(?:接道幅|間口)\s*[:：]?\s*(?:約)?([\d.]+)\s*m", text)
        if m:
            w = float(m.group(1))
            if 0 < w < 100:
                return w
    return None
