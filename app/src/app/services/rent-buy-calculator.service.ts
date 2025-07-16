import { Injectable } from '@angular/core';

export interface RentBuyData {
  year: number;
  vRent: number;
  vBuy: number;
}

export interface NPVData {
  year: number;
  npvAtRate: number;
  cumulativeCashFlow: number;
}

export interface IRRData {
  year: number;
  irr: number | null;
}

@Injectable({
  providedIn: 'root'
})
export class RentBuyCalculatorService {
  // Property characteristics
  private readonly buyPrice = 99_700_000; // ¥99.7M
  private readonly monthlyRent = 430_000;  // ¥430K/month

  // Assumptions for calculations
  private readonly downPaymentRatio = 0.1;
  private readonly mortgageRate = 0.015;
  private readonly mortgageYears = 20;
  private readonly propertyTaxRate = 0.014;
  private readonly transactionCosts = 0.035;
  private readonly maintenanceCost = 0.01;

  getBuyCashflow(years: number): number[] {

    const downPayment = this.buyPrice * this.downPaymentRatio;
    const loanAmount = this.buyPrice * (1 + this.transactionCosts) - downPayment;
    const annualMortgage = this.calculateAnnualMortgage(loanAmount);
    const annualPropertyTax = this.buyPrice * 0.7 * this.propertyTaxRate;
    const annualMaintenance = this.buyPrice * this.maintenanceCost;
    const propertyValue = this.buyPrice * (1 - this.transactionCosts);

    const cashFlows: number[] = [];

    // Add annual costs
    for (let year = 0; year <= years; year++) {
      let annualCost = annualPropertyTax + annualMaintenance;
      if (year < this.mortgageYears) {
        annualCost += annualMortgage;
      }
      cashFlows.push(-annualCost);
    }

    // Calculate remaining loan balance 
    let remainingLoan = loanAmount;
    for (let year = 0; year <= years; year++) {
      const interestPayment = remainingLoan * this.mortgageRate;
      const principalPayment = annualMortgage - interestPayment;
      remainingLoan = Math.max(0, remainingLoan - principalPayment);
    }

    cashFlows[0] -= downPayment;
    cashFlows[years] += propertyValue - remainingLoan;

    return cashFlows;
  }

  getRentCashflow(years: number): number[] {

    const annualRent = this.monthlyRent * 12;
    const cashFlows: number[] = [];

    for (let year = 0; year <= years; year++) {
      cashFlows.push(-annualRent);
    }

    return cashFlows;
  }

  getRentCosts(years: number): number[] {
    const data = [];

    for (let year = 0; year <= years; year++) {
      const rentCashflows = this.getRentCashflow(year);
      const vRent = rentCashflows.reduce((sum, cf) => sum + cf, 0);
      data.push(vRent);
    }
    return data;
  }

  getBuyCosts(years: number): number[] {
    const data = [];

    for (let year = 0; year <= years; year++) {
      const buyCashflows = this.getBuyCashflow(year);
      const vBuy = buyCashflows.reduce((sum, cf) => sum + cf, 0);
      data.push(vBuy);
    }
    return data;
  }

  /**
   * Calculate NPV of a cashflow array at given discount rate
   */
  npv(cashflows: number[], discountRate: number): number {
    return cashflows.reduce((npv, cf, t) => npv + cf / Math.pow(1 + discountRate, t), 0);
  }

  /**
   * Calculate IRR of a cashflow array
   */
  irr(cashflows: number[]): number | null {
    // Check if there are both positive and negative cash flows
    const hasPositive = cashflows.some(cf => cf > 0);
    const hasNegative = cashflows.some(cf => cf < 0);

    if (!hasPositive || !hasNegative) {
      return null; // IRR is undefined
    }

    // Use Newton-Raphson method to find IRR
    return this.newtonRaphsonIRR(cashflows);
  }


  // =========================================================================
  // HELPER FUNCTIONS: Private utility methods
  // =========================================================================

    private calculateAnnualMortgage(loanAmount: number): number {
    const annualRate = this.mortgageRate;
    const numYears = this.mortgageYears;
    return (loanAmount * annualRate * Math.pow(1 + annualRate, numYears)) / 
           (Math.pow(1 + annualRate, numYears) - 1);
  }

  private newtonRaphsonIRR(cashFlows: number[], maxIterations: number = 100, tolerance: number = 1e-6): number | null {
    let rate = 0.1; // Initial guess: 10%

    for (let i = 0; i < maxIterations; i++) {
      const npvValue = this.npv(cashFlows, rate);
      const npvDerivative = this.calculateNPVDerivative(cashFlows, rate);

      if (Math.abs(npvDerivative) < tolerance) {
        return null; // Derivative too small, can't continue
      }

      const newRate = rate - npvValue / npvDerivative;

      if (Math.abs(newRate - rate) < tolerance) {
        return newRate; // Converged
      }

      rate = newRate;

      // Prevent negative rates or extremely high rates
      if (rate < -0.99 || rate > 10) {
        return null;
      }
    }

    return null; // Did not converge
  }

  private calculateNPVDerivative(cashFlows: number[], rate: number): number {
    return cashFlows.reduce((derivative, cf, t) =>
      t > 0 ? derivative - (t * cf) / Math.pow(1 + rate, t + 1) : derivative, 0);
  }
} 