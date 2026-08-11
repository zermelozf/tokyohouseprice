"""How big a house a plot can legally carry.

A land listing's headline 容積率 is the *designated* figure, and it is usually
not what you can build. Where the frontage road is under 12 m the floor-area
ratio is additionally capped at

    road width (m) × 0.4   in residential zones
    road width (m) × 0.6   elsewhere

and the binding limit is the lower of the two. That is not a corner case here:
the median frontage in this data is 4.0 m, and across 301 plots with a stated
width the road limit binds on 111 — so quoting the designated ratio would
overstate what fits on roughly a third of them.

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


def _norm_key(k: str) -> str:
    """A spec label, in whichever form it was stored.

    Two things vary. SUUMO writes the separator as either the full-width ・ or
    the half-width ･, and rows scraped before the extractor learned to drop the
    'ヒント' help-tooltip still carry it in the key ('建ぺい率･容積率 ヒント').
    Normalising on read means those rows work without being re-scraped."""
    k = re.sub(r"\s*ヒント\s*$", "", k.rstrip(":").strip())
    return k.replace("･", "・")


# --- land you cannot build on ------------------------------------------------
# 土地面積 is the plot you buy, not the plot you may build on. Two things come
# off it, and both are stated in the listing:
#
#   セットバック  建築基準法42条2項: a plot fronting a road under 4 m must cede
#                 land until the road measures 4 m. The ceded strip stops being
#                 敷地面積, so it reduces the footprint and the floor area
#                 alike. Written '済' when it has already happened — in which
#                 case the stated area is already net and nothing comes off —
#                 or '要', sometimes with the square metres.
#   私道負担      a share of a private road inside the boundary. Same effect:
#                 it is not building land.
#
# Ignoring these overstates what fits, and the median frontage in this data is
# 4.0 m, so it is not a corner case.
_SETBACK_DONE = re.compile(r"セットバック[^。、]{0,6}(?:済|完了)")
_SETBACK_AREA = re.compile(r"セットバック[^。、]{0,12}?([\d.]+)\s*(?:~|～|-)?\s*([\d.]+)?\s*(?:m2|m 2|㎡)")
_SETBACK_NEED = re.compile(r"セットバック[^。、]{0,6}(?:要|有|必要)")
# The 私道負担 field leads with its area, or with 無 when there is none.
_ROAD_BURDEN = re.compile(r"^\s*(?:共有持分)?\s*([\d.]+)\s*(?:m2|m 2|㎡)")


def parse_setback(raw: str | None) -> tuple[float | None, str]:
    """(square metres to cede, status). Status is 'done' when it has already
    happened, 'required' when it has not, 'none' when the listing says so, and
    'unknown' when it is silent."""
    if not raw:
        return None, "unknown"
    text = _zen2han(raw)
    if _SETBACK_DONE.search(text):
        return None, "done"          # the stated area is already net
    m = _SETBACK_AREA.search(text)
    if m:
        # A range ('0.86～0.98m2') is per-区画; take the larger, which is the
        # one that binds the plot it applies to.
        vals = [float(v) for v in m.groups() if v]
        return (max(vals) if vals else None), "required"
    if _SETBACK_NEED.search(text):
        return None, "required"      # stated but not quantified
    return None, "none" if "セットバック" in text else "unknown"


def parse_road_burden(raw: str | None) -> float | None:
    """私道負担 in square metres, when the listing leads with it."""
    if not raw:
        return None
    m = _ROAD_BURDEN.search(_zen2han(raw))
    return float(m.group(1)) if m else None


def buildable_land(land_m2: float, s: dict) -> tuple[float, dict]:
    """(land you may build on, what came off it)."""
    blob = " ".join(v for k, v in s.items()
                    if k in ("私道負担・道路", "その他制限事項", "備考") and v)
    setback, status = parse_setback(blob)
    burden = parse_road_burden(s.get("私道負担・道路"))
    off = (setback or 0) + (burden or 0)
    # A deduction bigger than half the plot means the fields have been read
    # wrongly — report it rather than publishing an implausible capacity.
    if off >= land_m2 * 0.5:
        off = 0.0
        status = status if status == "done" else "unclear"
        setback = burden = None
    return land_m2 - off, {
        "setback_m2": setback,
        "setback_status": status,
        "road_burden_m2": burden,
        "deducted_m2": round(off, 2) if off else None,
    }


def capacity(land_m2: float | None, specs: dict | None) -> dict | None:
    """What can be built on this plot. None when the zoning is unknown."""
    if not land_m2 or not specs:
        return None
    s = {_norm_key(k): v for k, v in specs.items()}
    coverage, far = parse_ratios(s.get("建ぺい率・容積率"))
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

    # Ratios apply to the land you may build on, not the land you buy.
    net_land, deductions = buildable_land(land_m2, s)
    max_floor = net_land * far_eff / 100
    max_footprint = net_land * coverage / 100
    return {
        "land_m2": land_m2,
        "buildable_land_m2": round(net_land, 2) if net_land != land_m2 else None,
        **deductions,
        "land_m2_max": land_max,
        "max_floor_m2_largest": (round((land_max - (land_m2 - net_land)) * far_eff / 100, 1)
                                 if land_max else None),
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
