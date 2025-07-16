import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RentVsBuyChartComponent } from '../rent-vs-buy-chart/rent-vs-buy-chart.component';
import { PvBuyChartComponent } from '../pv-buy-chart/pv-buy-chart.component';
import { CashflowChartComponent } from '../cashflow-chart/cashflow-chart.component';
import { CumulativeDifferenceChartComponent } from '../cumulative-difference-chart/cumulative-difference-chart.component';
import { IrrChartComponent } from '../irr-chart/irr-chart.component';
import { RentBuyCalculatorService } from '../../services/rent-buy-calculator.service';

@Component({
  selector: 'app-rent-or-buy-article',
  standalone: true,
  imports: [CommonModule, RentVsBuyChartComponent, PvBuyChartComponent, CashflowChartComponent, CumulativeDifferenceChartComponent, IrrChartComponent],
  templateUrl: './rent-or-buy-article.component.html',
  styleUrls: ['./rent-or-buy-article.component.scss']
})
export class RentOrBuyArticleComponent implements OnInit {
  breakevenYear: number = 11; // Default fallback
  
  constructor(private calculator: RentBuyCalculatorService) { }
  
  ngOnInit() {
    this.breakevenYear = this.calculateBreakevenYear();
  }

  private calculateBreakevenYear(maxYears: number = 40): number {
    for (let year = 0; year <= maxYears; year++) {
      const rentCashflows = this.calculator.getRentCashflow(year);
      const buyCashflows = this.calculator.getBuyCashflow(year);
      
      const vRent = rentCashflows.reduce((sum, cf) => sum + cf, 0);
      const vBuy = buyCashflows.reduce((sum, cf) => sum + cf, 0);
      const cumulativeCashFlow = vBuy - vRent;
      
      if (cumulativeCashFlow > 0) { // Buy - Rent < 0 means buying is better
        return year;
      }
    }
    
    return -1; // No breakeven found within the timeframe
  }
  
  scrollToChart() {
    const element = document.getElementById('cashflowChart');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }
} 