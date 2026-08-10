"""Financial comparison of two listings, on top of the existing NPV model.

Deliberately adds no second model: every number here comes out of
`npv.calculate_buy_vs_rent`, the same engine behind the rent-or-buy article.
This module only does two things the engine cannot:

  1. maps a scraped listing onto NpvParams (the split of an asking price into
     land + building, an age into remaining depreciation, a category into a
     legal useful life), and
  2. reduces the engine's per-year output to one comparable number per option.

The comparable number is the present value of *housing cost* over the horizon:

    rent   PV = Σ rent_cashflow(t) / (1+r)^t
    buy    PV = Σ (house_cost(t) + loan_cost(t)) / (1+r)^t
                + sale_value(N) / (1+r)^N      ← sale proceeds net of debt

Both are negative (money out), so "less negative wins", and both are on the
same footing whichever pair the user picked: rent vs buy, buy vs buy, or rent
vs rent. For rent-vs-buy the engine's own differential (`buy_npv`, `buy_irr`)
is reported as well — that is the article's headline metric, and it comes from
a single call with one listing as the property and the other as the rent.

Note buy-vs-buy needs a rent baseline only because the engine is written as a
differential; it cancels out of the comparison (PV_A − PV_B is the same for any
baseline), which is why the UI is free to default it.
"""
from __future__ import annotations

import math
import re

from typing import Literal, Optional

from pydantic import BaseModel

import numpy as np
import numpy_financial as npf

from npv import NpvParams, RealEstate, Rent, Loan, calculate_buy_vs_rent
from scraper import query

# Legal useful life (法定耐用年数) of the building, by construction type. SUUMO
# categories map cleanly enough: mansions are RC, houses are wooden.
USEFUL_LIFE = {"used_mansion": 47, "new_house": 22, "used_house": 22}
DEFAULT_USEFUL_LIFE = 22
# Replacement cost differs by structure: RC costs far more per m² than 木造.
RC_CATEGORIES = {"used_mansion"}


class Assumptions(BaseModel):
    """Shared across both options — a comparison is only honest if the
    financing and macro assumptions are identical on each side.

    Defaults are the rent-or-buy article's own form defaults, so this tool and
    that page answer the same question the same way unless you change them.
    """
    loan_rate: float = 0.015
    loan_term: int = 35
    down_payment_pct: float = 0.20
    broker_fee_pct: float = 0.035
    maintenance_rate: float = 0.005
    rent_inflation: float = 0.01
    # Land is priced relative to the rents it produces, not in isolation.
    # A property growing faster than its rent means the gross yield falls
    # forever (3.5% land vs 1% rent compresses a 4% yield to 1.5% over 40
    # years) — a real bet, but one that should be stated rather than buried in
    # an absolute number. So the input is the SPREAD over rent inflation:
    #     0.0   land tracks rents, yields flat  (the neutral default)
    #     0.025 the old 3.5% absolute, when rent inflation is 1%
    # The effective rate is derived and echoed back as land_appreciation.
    land_spread_vs_rent: float = 0.0
    # Ownership costs inflate too — freezing them while rent grew was a
    # systematic thumb on the scale for buying. None -> track `rent_inflation`,
    # so one inflation number moves the whole model coherently.
    cost_inflation: Optional[float] = None
    renewal_fee_months: int = 1
    # REAL return on the alternative portfolio. It has to be real: holding a
    # nominal 6% while inflation moves silently cuts the real return, which
    # made high inflation look like a windfall for buying. Nominal is derived.
    opportunity_cost_real: float = 0.05
    simulation_years: int = 40
    # Replacement cost of the building as new. Used to split an asking price
    # into land and building, which is what drives depreciation.
    build_cost_per_m2: int = 250_000          # 木造
    build_cost_per_m2_rc: int = 350_000       # RC (マンション)
    property_tax_rate: float = 0.014      # 固定資産税
    city_planning_rate: float = 0.003     # 都市計画税
    building_assessment_ratio: float = 0.55   # buildings assess below land
    new_build_relief_years: int = 3           # 新築住宅の固定資産税減額
    maintenance_on_building_only: bool = True
    maintenance_age_slope: float = 0.02       # +2% of the base rate per year of age
    house_residual_ratio: float = 0.10        # a standing house is never worth 0
    # 不動産取得税 + 登録免許税 + 司法書士 + 印紙税
    acquisition_cost_pct: float = 0.04
    loan_upfront_fee_pct: float = 0.022       # 融資手数料 / 保証料
    # 住宅ローン控除
    mortgage_credit_rate: float = 0.007
    mortgage_credit_years: int = 13
    mortgage_credit_cap: int = 315_000
    # 譲渡所得税 (短期 / 長期) with the 3,000万円 residence deduction
    cgt_short_rate: float = 0.3963
    cgt_long_rate: float = 0.20315
    cgt_short_years: int = 5
    cgt_exemption: int = 30_000_000
    sale_discount_pct: float = 0.0            # time-on-market haircut
    # Renter move-in costs, previously not charged at all
    key_money_months: float = 1.0             # 礼金
    guarantee_months: float = 0.5             # 保証料
    moving_cost: int = 300_000
    move_every_years: int = 0                 # 0 -> assumed never to move again
    # A bare plot is not somewhere you can live, so comparing one against a
    # house means pricing the house you would have to build on it.
    land_build_m2: int = 120
    # 住宅用地の特例 — on by default here because every category this tool
    # compares except `land` has a home standing on it, which is exactly when
    # the reduction applies.
    residential_land_relief: bool = True
    # Rent baseline for buy-vs-buy (cancels out of the difference).
    baseline_monthly_rent: int = 250_000


    @property
    def inflation(self) -> float:
        """The single macro number: rents, ownership costs and land all key off it."""
        return self.rent_inflation

    @property
    def costs_inflation(self) -> float:
        return self.rent_inflation if self.cost_inflation is None else self.cost_inflation

    @property
    def opportunity_cost(self) -> float:
        """Nominal discount rate = real return compounded with inflation.

        The loan rate is deliberately NOT treated this way: a fixed-rate
        mortgage is a nominal contract, and its erosion by inflation is the
        genuine benefit of owning — the one effect this should preserve.
        """
        return (1 + self.opportunity_cost_real) * (1 + self.inflation) - 1

    @property
    def land_appreciation(self) -> float:
        """Absolute land growth actually handed to the engine."""
        return self.rent_inflation + self.land_spread_vs_rent


class CompareRequest(BaseModel):
    property_ids: list[str]
    scrape_date: Optional[str] = None
    assumptions: Assumptions = Assumptions()
    # Which option every IRR is measured against. Any option will do — the
    # anchor sets the level, not the ranking. Default: least capital committed.
    anchor_index: Optional[int] = None


def _listing(property_id: str, scrape_date: Optional[str]) -> Optional[dict]:
    """Latest snapshot of one property, with the era fields attached."""
    f = {"limit": 1}
    if scrape_date:
        f["date_from"] = f["date_to"] = scrape_date
    rows = [r for r in query.search_db({k: v for k, v in f.items() if k != "limit"})
            if r["property_id"] == property_id]
    return rows[0] if rows else None


def _zen2han(s: str) -> str:
    """SUUMO writes these ratios with full-width digits about half the time."""
    return s.translate(str.maketrans("０１２３４５６７８９％：、", "0123456789%:,"))


def zoning(property_id: str) -> dict:
    """建ぺい率 / 容積率 from the enriched detail page, if it was crawled.

    Three formats seen in the wild, and the key itself varies (･ vs ・, a stray
    'ヒント' left on older snapshots, and 建ぺい率 misspelt 建ペい率):
        '60％・240％'
        '建ぺい率：６０％、容積率：１５０％'
        '建ペい率：60％、容積率：150％'
    """
    det = query.get_detail(property_id) or {}
    specs = det.get("specs") or {}
    raw = next((v for k, v in specs.items()
                if "建ぺい" in k or "建ペい" in k or "容積" in k), None)
    if not raw:
        return {}
    nums = re.findall(r"(\d+(?:\.\d+)?)\s*%", _zen2han(raw))
    if len(nums) < 2:
        return {}
    return {"coverage_pct": float(nums[0]), "far_pct": float(nums[1]),
            "zoning_raw": raw}


def buildable(row: dict, want_m2: float) -> dict:
    """Can `want_m2` of floor area legally go on this plot?

    容積率 caps total floor area, 建ぺい率 caps the footprint — so a small plot
    can still take a big house by going up, and the footprint limit only tells
    you how many storeys it needs. Unknown zoning is reported as unknown, never
    as permission.
    """
    land = row.get("land_m2") or 0
    z = zoning(row["property_id"])
    if not z or not land:
        return {"known": False, "want_m2": want_m2, "land_m2": land or None}
    max_floor = land * z["far_pct"] / 100
    max_footprint = land * z["coverage_pct"] / 100
    return {
        "known": True, "want_m2": want_m2, "land_m2": land,
        "coverage_pct": z["coverage_pct"], "far_pct": z["far_pct"],
        "zoning_raw": z["zoning_raw"],
        "max_floor_m2": max_floor, "max_footprint_m2": max_footprint,
        "fits": want_m2 <= max_floor + 1e-9,
        "storeys_needed": math.ceil(want_m2 / max_footprint) if max_footprint else None,
    }


def asking_price(row: dict) -> tuple[float, bool]:
    """(price, was_a_range). '6280万円～6840万円' stored price_yen as the LOW
    bound, so every ranged listing was modelled at its cheapest — take the
    midpoint instead and tell the caller it is an estimate."""
    lo = float(row.get("price_yen") or 0)
    hi = float(row.get("price_max_yen") or 0)
    if hi and hi > lo:
        return (lo + hi) / 2, True
    return lo, False


def _split_price(row: dict, a: Assumptions) -> dict:
    """Asking price -> (as-new building value, land value, age, useful life).

    The engine depreciates `house_value` from new over `fully_amortized_age`
    counting `house_age` already elapsed, so it wants the building's
    replacement cost, not its current worth. Land is then the residual of the
    asking price — which is what actually holds value in Tokyo, and why two
    houses at the same price can diverge sharply over a 35-year horizon.
    """
    price, _ = asking_price(row)
    cat = row.get("category")
    life = USEFUL_LIFE.get(cat, DEFAULT_USEFUL_LIFE)
    unit = a.build_cost_per_m2_rc if cat in RC_CATEGORIES else a.build_cost_per_m2
    age = row.get("age_years")
    age_assumed = age is None
    if age_assumed:
        # Genuinely new for a 新築 listing. For anything else the age is simply
        # missing, and assuming "brand new" is the optimistic end of the range —
        # flagged so the card can say so rather than pass it off as known.
        age = 0
    bld = row.get("building_m2") or 0
    if row.get("category") == "land" or not bld:
        # You cannot live on a plot, so a bare-land option is only comparable
        # once it carries the house you would have to build. That construction
        # cost is part of the investment, and the new building then depreciates
        # like any other.
        build_m2 = float(a.land_build_m2 or 0)
        construction = build_m2 * a.build_cost_per_m2
        return {"house_value": construction, "land_value": float(price),
                "house_age": 0, "fully_amortized_age": DEFAULT_USEFUL_LIFE,
                "building_now": construction, "note": None,
                "built_house_m2": build_m2, "construction_cost": construction}

    as_new = bld * unit
    # Must use the SAME floor as RealEstate.house_value_at_year, or the split
    # writes the building to zero while the engine still carries a residual —
    # and the property ends up valued above the price actually paid for it.
    remaining = max(1 - age / life, a.house_residual_ratio)
    now = as_new * remaining
    land = float(price) - now
    note = None
    if land < 0:
        # Building alone is worth more than the asking price — the replacement
        # cost assumption is too high for this listing. Cap rather than hand
        # the engine a negative land value.
        note = (f"building at ¥{unit:,}/m² exceeds the asking price; "
                "land floored at 0 — lower build cost/m² for a fairer split")
        land, as_new, now = 0.0, float(price) / max(remaining, 1e-9), float(price)
    return {"house_value": float(as_new), "land_value": float(land),
            "house_age": int(age), "fully_amortized_age": life,
            "building_now": float(now), "note": note,
            "age_assumed": age_assumed, "build_cost_used": unit}


def _monthly_rent(row: dict) -> int:
    """Rent as the tenant actually pays it: rent + 管理費. Deposit and 礼金 are
    not in the engine's rent model, so they are reported, not charged."""
    return int((row.get("price_yen") or 0) + (row.get("admin_fee_yen") or 0))


def _params(row: dict, a: Assumptions, *, baseline_rent: int) -> tuple[NpvParams, dict]:
    """One listing -> NpvParams. A rent listing drives the rent side and leaves
    the property side empty; a sale listing does the reverse."""
    if row.get("market") == "rent":
        rent_monthly = _monthly_rent(row)
        # Two rents need no discounting to compare — the one-offs just amortise
        # over the stay. Reported so the UI can skip the model entirely.
        months = max(1, a.simulation_years * 12)
        one_off = ((a.key_money_months + a.guarantee_months) * rent_monthly
                   + a.moving_cost)
        derived = {"mode": "rent", "monthly_rent": rent_monthly,
                   "deposit_yen": row.get("deposit_yen"),
                   "key_money_yen": row.get("key_money_yen"),
                   "renewal_per_month": a.renewal_fee_months * rent_monthly / 24,
                   "one_off_total": one_off,
                   "effective_monthly": (rent_monthly
                                         + a.renewal_fee_months * rent_monthly / 24
                                         + one_off / months)}
        return NpvParams(
            real_estate=RealEstate(house_value=0, land_value=0, house_age=0,
                                   fully_amortized_age=DEFAULT_USEFUL_LIFE,
                                   appreciation_rate=a.land_appreciation,
                                   maintenance_rate=0),
            loan=Loan(principal=0, down_payment=0,
                      yearly_interest=a.loan_rate, term=a.loan_term),
            rent=Rent(monthly_rent=rent_monthly,
                      renewal_fee_months=a.renewal_fee_months,
                      inflation_rate=a.rent_inflation,
                      key_money_months=a.key_money_months,
                      guarantee_months=a.guarantee_months,
                      moving_cost=a.moving_cost,
                      move_every_years=a.move_every_years),
            simulation_years=a.simulation_years,
            opportunity_cost_rate=a.opportunity_cost,
            broker_fee=a.broker_fee_pct,
        ), derived

    split = _split_price(row, a)
    price, price_was_range = asking_price(row)
    # Construction is a 請負契約 with the builder — no broker fee on it, but it
    # is still capital you have to raise, so it belongs in both the deposit and
    # the loan.
    construction = float(split.get("construction_cost") or 0)
    invested = price + construction
    down = invested * a.down_payment_pct
    principal = max(0.0, price * (1 + a.broker_fee_pct) + construction - down)
    # The relief needs a home on the land: a `land` listing is a bare plot, and
    # taxing it as residential would flatter it by ~50% against the houses it
    # is being compared with.
    is_home = (row.get("building_m2") or 0) > 0 or construction > 0
    estate = RealEstate(
        house_value=split["house_value"], land_value=split["land_value"],
        house_age=split["house_age"],
        fully_amortized_age=split["fully_amortized_age"],
        appreciation_rate=a.land_appreciation,
        maintenance_rate=a.maintenance_rate,
        property_tax_rate=a.property_tax_rate,
        city_planning_rate=a.city_planning_rate,
        residential_land=a.residential_land_relief and is_home,
        land_m2=row.get("land_m2"),
        cost_inflation_rate=a.costs_inflation,
        maintenance_on_building_only=a.maintenance_on_building_only,
        maintenance_age_slope=a.maintenance_age_slope,
        house_residual_ratio=a.house_residual_ratio,
        building_assessment_ratio=a.building_assessment_ratio,
        new_build_relief_years=a.new_build_relief_years)

    # Property tax is charged by the engine but has no parameter, so it is
    # invisible unless reported. Back it out of the engine's own year-0 figure
    # rather than restating its rates here, so this cannot drift from npv.py.
    maintenance_y1 = estate.maintenance_at_year(0)
    tax_y1 = estate.tax_at_year(0)
    derived = {"mode": "buy", "price_yen": price, **split,
               "invested": invested,
               "down_payment": down, "principal": principal,
               "property_tax_y1": tax_y1, "maintenance_y1": maintenance_y1,
               "assessed_y1": estate.value_at_year(0) * estate.assessment_ratio,
               "price_was_range": price_was_range,
               "acquisition_cost": invested * a.acquisition_cost_pct,
               "loan_upfront_fee": principal * a.loan_upfront_fee_pct,
               "residential_relief": estate.residential_land,
               "tax_without_relief": estate.model_copy(
                   update={"residential_land": False}).tax_at_year(0)}
    return NpvParams(
        real_estate=estate,
        loan=Loan(principal=principal, down_payment=down,
                  yearly_interest=a.loan_rate, term=a.loan_term,
                  tax_credit_rate=a.mortgage_credit_rate,
                  tax_credit_years=a.mortgage_credit_years,
                  tax_credit_cap=a.mortgage_credit_cap,
                  upfront_fee=principal * a.loan_upfront_fee_pct),
        rent=Rent(monthly_rent=baseline_rent,
                  renewal_fee_months=a.renewal_fee_months,
                  inflation_rate=a.rent_inflation,
                  key_money_months=a.key_money_months,
                  guarantee_months=a.guarantee_months,
                  moving_cost=a.moving_cost,
                  move_every_years=a.move_every_years),
        simulation_years=a.simulation_years,
        opportunity_cost_rate=a.opportunity_cost,
        broker_fee=a.broker_fee_pct,
        acquisition_cost_pct=a.acquisition_cost_pct,
        cgt_short_rate=a.cgt_short_rate,
        cgt_long_rate=a.cgt_long_rate,
        cgt_short_years=a.cgt_short_years,
        cgt_exemption=a.cgt_exemption,
        sale_discount_pct=a.sale_discount_pct,
    ), derived


def _pv_series(flows: list, mode: str, rate: float) -> list[dict]:
    """Cumulative PV of housing cost, year by year, as if you moved out at the
    end of that year — so a buy option is credited its sale proceeds at each
    horizon, not only the last one. That is what makes the curves comparable at
    every point, and where the two lines cross is the real break-even."""
    out, running = [], 0.0
    for t, f in enumerate(flows):
        disc = (1 + rate) ** t
        if mode == "rent":
            running += f.rent_cost / disc
            pv, equity = running, 0.0
        else:
            running += (f.house_cost + f.loan_cost + f.acquisition_cost) / disc
            equity = f.sale_value / disc
            pv = running + equity
        out.append({"year": t, "pv_cost": pv, "cum_cost_no_exit": running,
                    "exit_value_pv": equity,
                    # Undiscounted too: "what lands in your account that year"
                    # is the number people actually reason about.
                    "exit_value": (0.0 if mode == "rent" else f.sale_value)})
    return out


MAX_OPTIONS = 4


def _monthly_recurring(yearly: list[float], derived: dict) -> list[float]:
    """Yearly cash -> positive monthly outgoings, with year 0's one-off
    purchase/move-in costs removed so the figure means the same in every year."""
    one_offs = (derived.get("down_payment", 0) + derived.get("acquisition_cost", 0)
                + derived.get("loan_upfront_fee", 0) + derived.get("one_off_total", 0))
    out = [-c / 12 for c in yearly]
    if out:
        out[0] -= one_offs / 12
    return out


def _yearly_costs(flows: list, mode: str) -> list[float]:
    """Yearly cash out, WITHOUT any exit proceeds."""
    return [f.rent_cost if mode == "rent"
            else f.house_cost + f.loan_cost + f.acquisition_cost for f in flows]


def _stream_to(costs: list[float], exits: list[float], horizon: int) -> list[float]:
    """The cash stream if you exit at `horizon`: costs up to then, plus the
    sale in that final year."""
    out = list(costs[:horizon + 1])
    out[horizon] += exits[horizon]
    return out


def _irr(stream) -> Optional[float]:
    arr = np.asarray(stream, dtype=float)
    if not (np.any(arr > 0) and np.any(arr < 0)):
        return None
    try:
        v = npf.irr(arr)
    except Exception:
        return None
    return None if v is None or np.isnan(v) or np.isinf(v) else float(v)


def _raw_cashflows(flows: list, mode: str) -> list[float]:
    """Each option's own yearly cash, with the exit proceeds folded into the
    final year — the stream you would hand to an IRR."""
    out = []
    for f in flows:
        out.append(f.rent_cost if mode == "rent"
                   else f.house_cost + f.loan_cost + f.acquisition_cost)
    if mode != "rent":
        out[-1] += flows[-1].sale_value
    return out


def irr_matrix(options: list[dict], anchor: int, hurdle: float) -> dict:
    """IRR of (option - anchor) at EVERY exit year, for every other option.

    One anchor, one difference stream per option per horizon. The anchor shifts
    every curve by the same amount, so it changes the numbers but not which
    option is on top.
    """
    a_costs, a_exits = options[anchor]["flow_costs"], options[anchor]["exit_values"]
    n = len(a_costs) - 1
    out = {}
    for i, o in enumerate(options):
        if i == anchor:
            continue
        series = []
        for h in range(n + 1):
            diff = (np.asarray(_stream_to(o["flow_costs"], o["exit_values"], h))
                    - np.asarray(_stream_to(a_costs, a_exits, h)))
            # NPV of the same difference stream, so the card can report both
            # at whatever exit year the user forces.
            series.append({"year": h, "irr": _irr(diff),
                           "npv": float(npf.npv(hurdle, diff))})
        rated = [(p["year"], p["irr"]) for p in series if p["irr"] is not None]
        best_year, best_irr = max(rated, key=lambda t: t[1]) if rated else (None, None)
        # An IRR only means "return" when the stream INVESTS: cash out first,
        # back later. Switching to an option that needs LESS capital frees cash
        # now and costs later — a financing stream, whose IRR is the rate you
        # are effectively paying. Higher is then WORSE, and ranking the two
        # shapes together silently compares a return against an interest rate.
        t0 = o["flow_costs"][0] - a_costs[0]
        shape = "investing" if t0 < 0 else "financing"
        out[i] = {"series": series, "peak_year": best_year, "peak_irr": best_irr,
                  "irr_at_horizon": series[-1]["irr"], "shape": shape,
                  "t0_delta": t0}
    return out


def _incremental_irr(cheap: list[float], dear: list[float]) -> Optional[float]:
    """Return on the EXTRA capital that stepping up from `cheap` to `dear` needs.

    IRR on each option separately is scale-blind: a high rate on a small outlay
    can look better than a lower rate on a much larger one that creates far more
    value. The decision-relevant question for mutually exclusive options is
    whether the *increment* clears your hurdle, which is what this answers.
    """
    diff = np.array(dear) - np.array(cheap)
    if not (np.any(diff > 0) and np.any(diff < 0)):
        return None                      # no sign change -> no IRR exists
    try:
        v = npf.irr(diff)
    except Exception:
        return None
    return None if v is None or np.isnan(v) or np.isinf(v) else float(v)


def compare(req: CompareRequest) -> dict:
    a = req.assumptions
    ids = req.property_ids[:MAX_OPTIONS]
    rows = [_listing(pid, req.scrape_date) for pid in ids]
    if len(rows) < 2:
        return {"error": "pick at least 2 listings to compare"}
    if any(r is None for r in rows):
        missing = [p for p, r in zip(ids, rows) if r is None]
        return {"error": f"listing not found: {missing}"}
    if any((r.get("price_yen") or 0) <= 0 for r in rows):
        return {"error": "a listing has no usable price (価格未定) — cannot model it"}

    # Buy-vs-buy needs some rent stream for the engine; it cancels out of the
    # comparison. When one side IS a rent listing, use it, so the differential
    # the engine reports is exactly "buy this instead of renting that".
    rent_rows = [r for r in rows if r.get("market") == "rent"]
    baseline = _monthly_rent(rent_rows[0]) if rent_rows else a.baseline_monthly_rent

    options = []
    for row in rows:
        params, derived = _params(row, a, baseline_rent=baseline)
        flows = calculate_buy_vs_rent(params)
        series = _pv_series(flows, derived["mode"], a.opportunity_cost)
        final = series[-1]
        # A built plot is compared on the floor area you would build, not on
        # its (nonexistent) current building.
        built = derived.get("built_house_m2")
        area = built or row.get("building_m2") or row.get("land_m2") or None
        options.append({
            "cashflows": _raw_cashflows(flows, derived["mode"]),
            "flow_costs": _yearly_costs(flows, derived["mode"]),
            # Recurring monthly cash out. The year-0 one-offs (deposit,
            # acquisition tax, loan fee, 礼金) are stripped out and reported
            # separately — folded in they would read as a monstrous "monthly".
            "monthly_costs": _monthly_recurring(
                _yearly_costs(flows, derived["mode"]), derived),
            "upfront_cash": (derived.get("down_payment", 0)
                             + derived.get("acquisition_cost", 0)
                             + derived.get("loan_upfront_fee", 0)
                             + derived.get("one_off_total", 0)),
            "exit_values": [p["exit_value"] for p in series],
            "property_id": row["property_id"],
            "title": row.get("title"), "url": row.get("url"),
            "market": row.get("market"), "category": row.get("category"),
            "ward": row.get("ward"), "layout": row.get("layout"),
            "price_yen": row.get("price_yen"), "price_raw": row.get("price_raw"),
            "building_m2": row.get("building_m2"), "land_m2": row.get("land_m2"),
            "age_years": row.get("age_years"), "era": row.get("era"),
            "build_year_est": row.get("build_year_est"),
            "era_approx": row.get("era_approx"),
            "derived": derived,
            "buildable": buildable(row, built) if built else None,
            "series": series,
            "pv_cost": final["pv_cost"],
            "pv_cost_per_m2": (final["pv_cost"] / area) if area else None,
            "exit_value_pv": final["exit_value_pv"],
            "exit_value_nominal": final["exit_value"],
            "monthly_equivalent": _monthly_equivalent(
                final["pv_cost"], a.opportunity_cost, a.simulation_years),
        })

    # Least-negative PV wins. With more than two options the runner-up gap is
    # what matters, so "advantage" is measured against the next best, not
    # against an arbitrary other option.
    order = sorted(range(len(options)), key=lambda i: -options[i]["pv_cost"])
    best, runner_up = order[0], order[1]
    n_rent, n_buy = len(rent_rows), len(rows) - len(rent_rows)
    verdict = {
        "cheaper_index": best,
        "ranking": order,
        "pv_advantage": abs(options[best]["pv_cost"] - options[runner_up]["pv_cost"]),
        "kind": ("rent_vs_buy" if n_rent and n_buy else
                 "rent_vs_rent" if not n_buy else "buy_vs_buy"),
        "baseline_monthly_rent": baseline,
        "baseline_note": None if rent_rows else (
            "no rent listing picked: the rent baseline only lets the engine run; "
            "it cancels out of the differences between the options"),
    }

    # Stepping up the ladder: order by capital actually committed on day one,
    # then price each step. This is the multi-option form of an IRR decision.
    def upfront(o):
        d = o["derived"]
        return (d.get("down_payment", 0) + d.get("acquisition_cost", 0)
                + d.get("loan_upfront_fee", 0)) if d["mode"] != "rent" else 0.0

    ladder = sorted(range(len(options)), key=lambda i: upfront(options[i]))
    steps = []
    hurdle = a.opportunity_cost
    for lo, hi in zip(ladder, ladder[1:]):
        extra = upfront(options[hi]) - upfront(options[lo])
        irr = _incremental_irr(options[lo]["cashflows"], options[hi]["cashflows"])
        steps.append({
            "from_index": lo, "to_index": hi,
            "extra_capital": extra,
            "incremental_irr": irr,
            "npv_delta": options[hi]["pv_cost"] - options[lo]["pv_cost"],
            "clears_hurdle": None if irr is None else irr > hurdle,
        })
    # IRR of every option against one anchor, at every exit year.
    anchor = req.anchor_index if (req.anchor_index is not None
                                  and 0 <= req.anchor_index < len(options)) else ladder[0]
    mat = irr_matrix(options, anchor, a.opportunity_cost)
    # Rank on investing streams only. If the anchor is not the cheapest option,
    # some comparisons are financing-shaped and a naive "highest IRR" would
    # invert them, so say so rather than return a number that reads fine and
    # is wrong.
    investing = {i: d for i, d in mat.items() if d["shape"] == "investing"}
    rated = [(i, d["peak_irr"]) for i, d in investing.items() if d["peak_irr"] is not None]
    verdict["anchor_index"] = anchor
    verdict["irr_vs_anchor"] = mat
    verdict["best_by_irr"] = max(rated, key=lambda t: t[1])[0] if rated else None
    mixed = len(investing) != len(mat)
    verdict["irr_anchor_valid"] = not mixed
    verdict["irr_anchor_note"] = None if not mixed else (
        "Anchor is not the least-capital option, so some comparisons free cash "
        "up front instead of committing it. Their IRR is a borrowing rate, not "
        "a return, and cannot be ranked against the others. Re-anchor on the "
        "cheapest option for a single comparable ranking.")

    verdict["ladder"] = ladder
    verdict["steps"] = steps
    verdict["hurdle_rate"] = hurdle

    # IRR needs a baseline: it is the return on choosing X *instead of* Y.
    # The two questions this tool answers need different baselines, and both
    # are rungs of the same ladder:
    #
    #   WHEN to sell  -> baseline is renting the same period. Owning always
    #                    displaces renting, so that is the true counterfactual,
    #                    and both sides then cover the same N years.
    #   WHICH to buy  -> baseline is the next-cheapest option (the `steps`
    #                    ladder above). Rent, needing no capital, is rung 0.
    #
    # When no rent listing is picked the assumed baseline rent stands in, so
    # timing still works for a buy-vs-buy set; `baseline_source` says which.
    verdict["baseline_source"] = ("picked rent listing" if n_rent == 1 else
                                  "assumed rent (no single rent listing picked)")
    if n_buy:
        per_buy = {}
        for idx, row in enumerate(rows):
            if row.get("market") == "rent":
                continue
            params, _ = _params(row, a, baseline_rent=baseline)
            flows = calculate_buy_vs_rent(params)
            # IRR at every horizon, not just the last. PV cannot answer "when
            # should I sell": PV at year 10 buys 10 years of housing and PV at
            # year 40 buys 40, so they are not comparable to each other. A rate
            # is scale-free across time, so its peak is a real timing signal.
            irr_series = [{"year": f.year, "irr": f.buy_irr} for f in flows]
            rated = [(f.year, f.buy_irr) for f in flows if f.buy_irr is not None]
            peak_year, peak_irr = max(rated, key=lambda t: t[1]) if rated else (None, None)
            per_buy[idx] = {
                "npv_at_horizon": flows[-1].buy_npv,
                "irr_at_horizon": flows[-1].buy_irr,
                "breakeven_year": next((f.year for f in flows if f.buy_npv > 0), None),
                "irr_series": irr_series,
                "peak_irr_year": peak_year,
                "peak_irr": peak_irr,
                "npv_series": [{"year": f.year, "npv": f.buy_npv} for f in flows],
                "peak_npv_year": max(flows, key=lambda f: f.buy_npv).year,
            }
        verdict["buy_vs_rent_by_option"] = per_buy
        # Kept for the single-pair case, which is what the UI headlines.
        if n_buy == 1:
            verdict["buy_vs_rent"] = per_buy[next(iter(per_buy))]

    return {"assumptions": {**a.model_dump(),
                            "land_appreciation": a.land_appreciation,
                            "opportunity_cost": a.opportunity_cost,
                            "cost_inflation_effective": a.costs_inflation},
            "options": options, "verdict": verdict}


def _monthly_equivalent(pv: float, rate: float, years: int) -> float:
    """The level monthly payment with the same present value — a PV of ¥-90M
    over 35 years means little; "¥-310k/month" is a number you can feel."""
    n = years + 1
    if rate <= 0:
        return pv / (n * 12)
    annuity = (1 - (1 + rate) ** -n) / rate
    return pv / annuity / 12
