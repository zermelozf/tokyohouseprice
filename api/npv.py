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

    @property
    def initial_value(self):
        return self.house_value + self.land_value

    def value_at_year(self, year):
        house_val = self.house_value * (1 - min(1, (year + 1 + self.house_age) / self.fully_amortized_age))
        land_val = self.land_value * (1 + self.appreciation_rate)**(year + 1)
        return house_val + land_val

    def cashflow(self, year):
        maintenance = -self.initial_value * self.maintenance_rate
        assessed_value = self.value_at_year(year) * 0.7
        tax = -assessed_value * (0.014 + 0.003) # Property tax + City planning tax
        return maintenance + tax


class Rent(BaseModel):
    monthly_rent: float = 200000
    renewal_fee_months: int = 2
    inflation_rate: float = 0.0

    def cashflow(self, year):
        current_monthly_rent = self.monthly_rent * (1 + self.inflation_rate) ** year
        flow = -current_monthly_rent * 12
        if year > 0 and year % 2 == 0:  # every 2 years, starting year 2 (index 1)
            flow -= self.renewal_fee_months * current_monthly_rent
        return flow


class Loan(BaseModel):
    principal: float = 0
    down_payment: int = 20000000
    yearly_interest: float = 0.015
    term: int = 30

    class Config:
        arbitrary_types_allowed = True

    @property
    def monthly_payment(self):
        payment = -npf.pmt(self.yearly_interest / 12, self.term * 12, self.principal)
        return payment

    def cashflow(self, year):
        if self.principal == 0 or year >= self.term:
            return 0
        cashflow = -self.monthly_payment * 12
        if year == 0:
            cashflow -= self.down_payment
        return cashflow

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


def calculate_buy_vs_rent(params: NpvParams) -> List[CashFlow]:
    n = params.simulation_years
    house = params.real_estate
    rent = params.rent
    loan = params.loan

    cashflows = []
    rent_cashflows = []
    buy_cashflows = []
    
    for year in range(n + 1):
        rent_cashflows.append(rent.cashflow(year))
        sale_cash = house.cashflow(year) + \
            loan.cashflow(year) + \
            loan.value_at_year(year) + \
            house.value_at_year(year) * (1 - params.broker_fee)
        
        cashflow_diff = np.array(buy_cashflows + [sale_cash]) - np.array(rent_cashflows)
        irr_value = npf.irr(cashflow_diff)
        if np.isnan(irr_value) or np.isinf(irr_value):
            irr_value = None
        else:
            irr_value = float(irr_value)
        buy_cashflows.append(house.cashflow(year) + loan.cashflow(year))
        
        stock_value = 0.0
        for i, (r, b) in enumerate(zip(rent_cashflows, buy_cashflows)):
            stock_value += (r - b) * (1 + params.opportunity_cost_rate) ** (year - i)

        cashflow = CashFlow(
            year=year,
            rent_cost=rent.cashflow(year),
            house_cost=house.cashflow(year),
            loan_cost=loan.cashflow(year),
            house_value=house.value_at_year(year),
            loan_value=loan.value_at_year(year),
            sale_value=house.value_at_year(year) * (1 - params.broker_fee) + loan.value_at_year(year),
            buy_npv=npf.npv(
                params.opportunity_cost_rate, 
                cashflow_diff
            ),
            buy_irr=irr_value,
            stock_value=stock_value
        )
        
        cashflows.append(cashflow)

    return cashflows


    
    