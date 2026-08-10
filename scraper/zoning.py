"""How big a house a plot can legally carry.

A land listing's headline 容積率 is the *designated* figure, and it is usually
not what you can build. Where the frontage road is under 12 m the floor-area
ratio is additionally capped at

    road width (m) × 0.4   in residential zones
    road width (m) × 0.6   elsewhere

and the binding limit is the lower of the two. That is not a corner case here:
the median frontage in this data is 4.0 m, and the road limit binds on 247 of
252 plots — so quoting the designated ratio would overstate what fits on almost
every one of them.

    max floor area = land × min(designated 容積率, road limit)
    max footprint  = land × 建ぺい率
    storeys needed = ceil(floor / footprint)
"""
from __future__ import annotations

import math
import re

# 住居系 zones take the stricter 0.4 multiplier. SUUMO abbreviates the names
# (１種中高 for 第一種中高層住居専用地域), so match on the abbreviations.
RESIDENTIAL = ("低層", "中高", "住居", "田園")
ROAD_FACTOR_RESIDENTIAL = 0.4
ROAD_FACTOR_OTHER = 0.6
# Above this width the road no longer constrains the ratio.
ROAD_LIMIT_APPLIES_BELOW_M = 12.0


def _zen2han(s: str) -> str:
    return s.translate(str.maketrans("０１２３４５６７８９％：、．ｍ",
                                     "0123456789%:,.m"))


def parse_ratios(raw: str | None) -> tuple[float | None, float | None]:
    """(建ぺい率, 容積率) as percentages.

    Read by label, never by position. Agents append bonuses in parentheses —
        建ペい率：60％(70%※角地緩和により)（…＋10％）、容積率：160%
    — so "the first two percentages" picks up 60 and 70 and mistakes the
    corner-lot bonus for the floor-area ratio. The base figure before any
    parenthesis is the one that always applies; the bonuses need a corner plot
    or fireproof construction, which the listing does not confirm.
    """
    if not raw:
        return None, None
    text = _zen2han(raw)
    # 建ぺい率 is written with either hiragana ぺ or (mistakenly) katakana ペ.
    cov = re.search(r"建[ぺペ]い率[^0-9]{0,4}(\d+(?:\.\d+)?)\s*%", text)
    far = re.search(r"容積率[^0-9]{0,4}(\d+(?:\.\d+)?)\s*%", text)
    if cov and far:
        return float(cov.group(1)), float(far.group(1))
    # The terse form carries no labels at all: "60％・240％".
    nums = re.findall(r"(\d+(?:\.\d+)?)\s*%", text)
    if len(nums) >= 2:
        return float(nums[0]), float(nums[1])
    return None, None


def parse_road_width(raw: str | None) -> float | None:
    """Frontage width in metres from the 私道負担・道路 line.

    Several forms appear: '道路幅：3.4ｍ', '南西4.2ｍ幅（接道幅7.2ｍ）'. Where a
    plot fronts more than one road the widest governs, which is what the law
    uses."""
    if not raw:
        return None
    text = _zen2han(raw)
    widths = [float(m) for m in re.findall(r"道路幅[:：]\s*([\d.]+)", text)]
    widths += [float(m) for m in re.findall(r"([\d.]+)\s*m\s*幅", text)]
    widths = [w for w in widths if 0 < w < 50]
    return max(widths) if widths else None


def road_factor(zone: str | None) -> float:
    """The multiplier on road width. A plot spanning two zones takes the
    stricter one, since the stricter rule governs its portion."""
    if not zone:
        return ROAD_FACTOR_RESIDENTIAL      # assume the stricter when unknown
    return (ROAD_FACTOR_RESIDENTIAL if any(t in zone for t in RESIDENTIAL)
            else ROAD_FACTOR_OTHER)


def parse_land_range(raw: str | None) -> tuple[float | None, float | None]:
    """(smallest, largest) plot in a listing. A 分譲地 sells several 区画 under
    one listing — '65.77m2～131.54m2' — and the crawler stores the smallest, so
    a capacity computed from it understates the larger plots by half."""
    if not raw:
        return None, None
    nums = [float(m) for m in re.findall(r"([\d.]+)\s*m", _zen2han(raw))]
    nums = [n for n in nums if 5 < n < 100000]
    if not nums:
        return None, None
    return min(nums), max(nums)


# Restrictions SUuMO names in その他制限事項 but never quantifies. Each can only
# reduce what fits, so they are reported as caveats rather than computed.
RESTRICTION_FLAGS = {
    "高度地区": "height district — a north-side slope limit applies",
    "高さ最高限度有": "an absolute height cap applies",
    "日影制限有": "shadow rules limit height near boundaries",
    "敷地面積最低限度有": "a minimum plot size applies, so it may not be divisible",
    "宅地造成工事規制区域": "earthworks are regulated",
}


def parse_restrictions(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [note for key, note in RESTRICTION_FLAGS.items() if key in raw]


def capacity(land_m2: float | None, specs: dict | None) -> dict | None:
    """What can be built on this plot. None when the zoning is unknown."""
    if not land_m2 or not specs:
        return None
    s = {k.rstrip(":").strip(): v for k, v in specs.items()}
    coverage, far = parse_ratios(s.get("建ぺい率・容積率") or s.get("建ぺい率･容積率"))
    if coverage is None or far is None:
        return None
    zone = (s.get("用途地域") or "").strip() or None
    road = parse_road_width(s.get("私道負担・道路"))

    far_road = None
    if road is not None and road < ROAD_LIMIT_APPLIES_BELOW_M:
        far_road = road * road_factor(zone) * 100

    far_eff = far if far_road is None else min(far, far_road)
    limited_by = "designated" if (far_road is None or far <= far_road) else "road width"

    lo, hi = parse_land_range(s.get("土地面積"))
    # The stored area is the smallest 区画; price the largest too, so a
    # subdivision is not judged on its narrowest lot.
    land_max = hi if (hi and hi > land_m2 * 1.01) else None

    max_floor = land_m2 * far_eff / 100
    max_footprint = land_m2 * coverage / 100
    return {
        "land_m2": land_m2,
        "land_m2_max": land_max,
        "max_floor_m2_largest": round(land_max * far_eff / 100, 1) if land_max else None,
        "restrictions": parse_restrictions(s.get("その他制限事項")),
        "coverage_pct": coverage,
        "far_pct": far,
        "far_effective_pct": far_eff,
        "road_width_m": road,
        "zone": zone,
        "limited_by": limited_by,
        "max_floor_m2": round(max_floor, 1),
        "max_footprint_m2": round(max_footprint, 1),
        "storeys_needed": math.ceil(max_floor / max_footprint) if max_footprint else None,
    }


# Not modelled, and each can only reduce the figure above:
#   斜線制限 / 日影規制      setback and shadow rules
#   絶対高さ制限            10-12 m cap in 低層 zones, so roughly 3 storeys
#   建ぺい率の緩和           +10% for a corner plot, +10% for a fireproof build
#                          in a 防火地域 — these would raise the footprint
NOT_MODELLED = ("斜線制限", "日影規制", "絶対高さ制限", "建ぺい率の緩和")
