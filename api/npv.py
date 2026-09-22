import pandas as pd
import numpy as np
import numpy_financial as npf
from pydantic import BaseModel, PrivateAttr
from typing import Optional, List
from collections import defaultdict


class CashFlow(BaseModel):
    year: int
    rent_cost: float
    house_cost: float
    loan_cost: float
    # Year-0 acquisition taxes/fees. Reported separately so consumers that
    # rebuild the buy stream from these fields do not silently drop it.
    acquisition_cost: float = 0.0
    house_value: float
    loan_value: float
    sale_value: float
    stock_value: float
    buy_npv: float
    buy_irr: Optional[float]


class RealEstate(BaseModel):
    house_value: float = 20000000
    land_value: float = 60000000
    house_age: int = 0
    fully_amortized_age: int = 22
    appreciation_rate: float = 0.01
    maintenance_rate: float = 0.005

    # Tax rates were hardcoded; they are parameters now so callers can set the
    # municipality's actual rates. Defaults are the standard 1.4% / 0.3%.
    property_tax_rate: float = 0.014      # 固定資産税
    city_planning_rate: float = 0.003     # 都市計画税
    assessment_ratio: float = 0.7         # 課税標準 as a share of market value

    # 住宅用地の特例: land under a home is assessed at a fraction of its value —
    # 1/6 (固定資産税) and 1/3 (都市計画税) for the first 200m², 1/3 and 2/3 above
    # that. It is the single biggest term in a Japanese homeowner's tax bill, so
    # leaving it out overstates tax badly on land-heavy property. Default False
    # keeps every existing caller's numbers identical.
    residential_land: bool = False
    land_m2: Optional[float] = None       # None -> treat as all 小規模 (≤200m²)

    # Ownership costs were frozen in nominal terms while rent inflated, which
    # quietly favoured buying by more the longer the horizon.
    cost_inflation_rate: float = 0.0
    # Maintenance was charged on land+building. You do not maintain land, and
    # basing it on the whole price makes a land-heavy property pay MORE upkeep.
    maintenance_on_building_only: bool = False
    # Extra maintenance per year of building age: real spend is back-loaded
    # (外壁/屋根/水回り at the 10/15/20-year marks), not flat for 40 years.
    maintenance_age_slope: float = 0.0
    # A standing house keeps some market value even when tax-depreciated to 0.
    house_residual_ratio: float = 0.0
    # 固定資産税評価額 runs ~70% of market for land but nearer 50-60% of
    # construction cost for buildings. None -> use assessment_ratio for both.
    building_assessment_ratio: Optional[float] = None
    # 新築住宅の減額: 固定資産税 on the building halved for the first N years.
    new_build_relief_years: int = 0

    @property
    def initial_value(self):
        return self.house_value + self.land_value

    def house_value_at_year(self, year):
        # (year + 1) because value_at_year is an END-of-year valuation: one
        # year of ownership has elapsed, matching the land-appreciation term.
        straight_line = 1 - min(1, (year + 1 + self.house_age) / self.fully_amortized_age)
        return self.house_value * max(straight_line, self.house_residual_ratio)

    def land_value_at_year(self, year):
        return self.land_value * (1 + self.appreciation_rate)**(year + 1)

    def value_at_year(self, year):
        return self.house_value_at_year(year) + self.land_value_at_year(year)

    def maintenance_at_year(self, year):
        """Upkeep in year `year`, inflated, and rising with the building's age."""
        base = self.house_value if self.maintenance_on_building_only else self.initial_value
        age = self.house_age + year
        rate = self.maintenance_rate * (1 + self.maintenance_age_slope * age)
        return base * rate * (1 + self.cost_inflation_rate) ** year

    def _land_tax_shares(self):
        """(固定資産税, 都市計画税) multipliers on the assessed land value."""
        if not self.residential_land:
            return 1.0, 1.0
        if self.land_m2 is None or self.land_m2 <= 200:
            small = 1.0
        else:
            small = 200.0 / self.land_m2
        large = 1.0 - small
        return small / 6 + large / 3, small / 3 + large * 2 / 3

    def tax_at_year(self, year):
        """Annual 固定資産税 + 都市計画税, land and building assessed separately."""
        land_fixed_share, land_city_share = self._land_tax_shares()
        b_ratio = (self.assessment_ratio if self.building_assessment_ratio is None
                   else self.building_assessment_ratio)
        land_assessed = self.land_value_at_year(year) * self.assessment_ratio
        house_assessed = self.house_value_at_year(year) * b_ratio
        # 新築軽減 applies to 固定資産税 only, and only to a building bought new.
        relief = 0.5 if (self.house_age == 0 and year < self.new_build_relief_years) else 1.0
        fixed = (land_assessed * land_fixed_share
                 + house_assessed * relief) * self.property_tax_rate
        city = (land_assessed * land_city_share + house_assessed) * self.city_planning_rate
        return fixed + city

    def cashflow(self, year):
        return -self.maintenance_at_year(year) - self.tax_at_year(year)


class Rent(BaseModel):
    monthly_rent: float = 200000
    renewal_fee_months: int = 2
    inflation_rate: float = 0.0

    # Real move-in costs the model never charged. 敷金 is deliberately absent:
    # it is refundable, so it is not a cost (only its opportunity cost is, and
    # that is small enough to leave to the discount rate).
    key_money_months: float = 0.0     # 礼金, non-refundable, per move
    guarantee_months: float = 0.0     # 保証料 / 保証会社, per move
    moving_cost: float = 0.0          # removals, agent fee, setup
    move_every_years: int = 0         # 0 -> never moves again

    def _move_cost(self, monthly):
        return (self.key_money_months + self.guarantee_months) * monthly + self.moving_cost

    def cashflow(self, year):
        current_monthly_rent = self.monthly_rent * (1 + self.inflation_rate) ** year
        flow = -current_monthly_rent * 12
        if year > 0 and year % 2 == 0:  # every 2 years, starting year 2 (index 1)
            flow -= self.renewal_fee_months * current_monthly_rent
        if year == 0:
            flow -= self._move_cost(current_monthly_rent)
        elif self.move_every_years and year % self.move_every_years == 0:
            flow -= self._move_cost(current_monthly_rent)
        return flow


class Loan(BaseModel):
    principal: float = 0
    down_payment: int = 20000000
    yearly_interest: float = 0.015
    term: int = 30

    # 住宅ローン控除: a credit on the year-end balance for the first N years.
    # Worth several million yen and previously absent altogether.
    tax_credit_rate: float = 0.0        # 0.007 under the current regime
    tax_credit_years: int = 0           # 13 for a qualifying new home
    tax_credit_cap: float = 0.0         # annual ceiling, 0 -> uncapped
    upfront_fee: float = 0.0            # 融資手数料 / 保証料, paid at drawdown

    class Config:
        arbitrary_types_allowed = True

    @property
    def monthly_payment(self):
        payment = -npf.pmt(self.yearly_interest / 12, self.term * 12, self.principal)
        return payment

    def tax_credit_at_year(self, year):
        """住宅ローン控除 for `year` — a credit, so a positive cashflow."""
        if not self.tax_credit_rate or year >= self.tax_credit_years or not self.principal:
            return 0.0
        credit = abs(self.value_at_year(year)) * self.tax_credit_rate
        return min(credit, self.tax_credit_cap) if self.tax_credit_cap else credit

    def cashflow(self, year):
        if self.principal == 0:
            return -self.down_payment - self.upfront_fee if year == 0 else 0
        cashflow = 0.0 if year >= self.term else -self.monthly_payment * 12
        if year == 0:
            cashflow -= self.down_payment + self.upfront_fee
        return cashflow + self.tax_credit_at_year(year)

    def value_at_year(self, year):
        remaining_periods = max(0, (self.term - year - 1) * 12)
        remaining_balance = npf.pv(self.yearly_interest / 12, remaining_periods, -self.monthly_payment)
        return -remaining_balance


class NpvParams(BaseModel):
    real_estate: RealEstate = RealEstate()
    loan: Loan = Loan()
    rent: Rent = Rent()

    simulation_years: int = 40
    opportunity_cost_rate: float = 0.04
    broker_fee: float = 0.03

    # 不動産取得税 + 登録免許税 + 司法書士 + 印紙税, as a share of price. Charged
    # once at purchase; only the broker fee used to be modelled, so all-in
    # acquisition cost was roughly half of reality.
    acquisition_cost_pct: float = 0.0
    # 譲渡所得税 on the sale. 39.63% within 5 years, 20.315% after; a primary
    # residence gets the 3,000万円特別控除. All default to 0 (previous behaviour).
    cgt_short_rate: float = 0.0
    cgt_long_rate: float = 0.0
    cgt_short_years: int = 5
    cgt_exemption: float = 0.0
    # Haircut on the sale for time-on-market / negotiation, on top of the fee.
    sale_discount_pct: float = 0.0


def _net_sale(params: NpvParams, year: int) -> float:
    """Sale proceeds after the agent, a market haircut, and 譲渡所得税.

    取得費 for the gain is the purchase price less the building depreciation
    already taken — which is why holding longer both lowers the rate and
    raises the taxable gain.
    """
    house = params.real_estate
    gross = house.value_at_year(year) * (1 - params.broker_fee) * (1 - params.sale_discount_pct)
    rate = (params.cgt_short_rate if year < params.cgt_short_years
            else params.cgt_long_rate)
    if not rate:
        return gross
    basis = house.house_value_at_year(year) + house.land_value
    gain = max(0.0, gross - basis - params.cgt_exemption)
    return gross - gain * rate


def calculate_buy_vs_rent(params: NpvParams) -> List[CashFlow]:
    n = params.simulation_years
    house = params.real_estate
    rent = params.rent
    loan = params.loan
    # Acquisition taxes and fees are a year-0 outflow on top of the price.
    acquisition = house.initial_value * params.acquisition_cost_pct

    cashflows = []
    rent_cashflows = []
    buy_cashflows = []
    
    for year in range(n + 1):
        rent_cashflows.append(rent.cashflow(year))
        sale_cash = house.cashflow(year) + \
            loan.cashflow(year) + \
            (-acquisition if year == 0 else 0) + \
            loan.value_at_year(year) + \
            _net_sale(params, year)
        
        cashflow_diff = np.array(buy_cashflows + [sale_cash]) - np.array(rent_cashflows)
        irr_value = npf.irr(cashflow_diff)
        if np.isnan(irr_value) or np.isinf(irr_value):
            irr_value = None
        else:
            irr_value = float(irr_value)
        buy_cashflows.append(house.cashflow(year) + loan.cashflow(year)
                             + (-acquisition if year == 0 else 0))
        
        stock_value = 0.0
        for i, (r, b) in enumerate(zip(rent_cashflows, buy_cashflows)):
            stock_value += (r - b) * (1 + params.opportunity_cost_rate) ** (year - i)

        cashflow = CashFlow(
            year=year,
            rent_cost=rent.cashflow(year),
            house_cost=house.cashflow(year),
            loan_cost=loan.cashflow(year),
            acquisition_cost=(-acquisition if year == 0 else 0.0),
            house_value=house.value_at_year(year),
            loan_value=loan.value_at_year(year),
            sale_value=_net_sale(params, year) + loan.value_at_year(year),
            buy_npv=npf.npv(
                params.opportunity_cost_rate, 
                cashflow_diff
            ),
            buy_irr=irr_value,
            stock_value=stock_value
        )
        
        cashflows.append(cashflow)

    return cashflows


    
    