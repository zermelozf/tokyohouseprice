import { Component, ViewChild, ElementRef, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import Chart from 'chart.js/auto';
import { Subject, debounceTime, takeUntil } from 'rxjs';
import { environment } from '../../../environments/environment';

interface CashFlow {
  year: number;
  rent_cost: number;
  house_cost: number;
  loan_cost: number;
  house_value: number;
  loan_value: number;
  sale_value: number;
  buy_npv: number;
  buy_irr: number | null;
}

interface NpvParams {
  real_estate: {
    house_value: number;
    land_value: number;
    house_age: number;
    fully_amortized_age: number;
    appreciation_rate: number;
    maintenance_rate: number;
  };
  loan: {
    principal: number;
    down_payment: number;
    yearly_interest: number;
    term: number;
  };
  rent: {
    monthly_rent: number;
    renewal_fee_months: number;
    inflation_rate: number;
  };
  bank_interest_rate: number;
  simulation_years: number;
  opportunity_cost_rate: number;
  broker_fee: number;
}

@Component({
  selector: 'app-rent-or-buy',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './rent-or-buy.component.html',
  styleUrls: ['./rent-or-buy.component.scss']
})
export class RentOrBuyComponent implements AfterViewInit, OnDestroy {
  @ViewChild('npvChart') npvChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('irrChart') irrChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('cashflowChart') cashflowChartRef!: ElementRef<HTMLCanvasElement>;
  
  private npvChart: Chart | null = null;
  private irrChart: Chart | null = null;
  private cashflowChart: Chart | null = null;
  private destroy$ = new Subject<void>();
  private formChange$ = new Subject<void>();
  private apiUrl = environment.apiUrl;
  
  expertModeBuy = true;
  expertModeRent = false;
  
  // Collapse states for each section
  isPropertyCollapsed = false;
  isLoanCollapsed = false;
  isRentCollapsed = false;
  isEconomicCollapsed = false;
  
  cashFlowData: CashFlow[] = [];
  isLoading = false;
  error: string | null = null;

  buy = {
    propertyPrice: 8000,
    housePrice: 3000,
    landPrice: 5000,
    maintenance: 0.5,
    propertyTax: 1.4,
    buildingAge: 0,
    feeRate: 3.5,
    amortizationPeriod: 35
  };

  rent = {
    monthlyRent: 25,
    giftMoney: 25,
    guarantee: 25,
    renewal: 1,
  };

  macro = {
    inflationRate: 1.0,
    landAppreciation: 3.5,
    opportunityCost: 6.0,
    simulationYears: 40
  };

  loan = {
    loanPeriod: 35,
    loanFee: 0.0,
    loanRate: 1.5,
    upfrontAmount: 20.0,
  };

  constructor(private http: HttpClient) {
    console.log('RentOrBuyComponent constructor - API URL:', this.apiUrl);
    this.onPropertyPriceChange(this.buy.propertyPrice);
    
    // Set up debounced form changes
    this.formChange$.pipe(
      debounceTime(500), // Wait 500ms after the last change
      takeUntil(this.destroy$)
    ).subscribe(() => {
      console.log('Debounced form change triggered');
      this.calculateNpv();
    });
  }

  ngAfterViewInit(): void {
    // Wait a bit for the view to be fully rendered
    setTimeout(() => {
      console.log('ngAfterViewInit - attempting to calculate NPV');
      console.log('Chart refs available:', !!this.npvChartRef, !!this.irrChartRef, !!this.cashflowChartRef);
      this.updateSliderStyles();
      this.calculateNpv();
    }, 100);
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    
    if (this.npvChart) {
      this.npvChart.destroy();
    }
    if (this.irrChart) {
      this.irrChart.destroy();
    }
    if (this.cashflowChart) {
      this.cashflowChart.destroy();
    }
  }

  onPropertyPriceChange(newPrice: number): void {
    console.log('onPropertyPriceChange called with:', newPrice);
    this.buy.propertyPrice = newPrice;
    this.triggerFormChange();
  }
  
  onExpertBuyChange(): void {
    console.log('onExpertBuyChange called');
    this.buy.propertyPrice = this.buy.housePrice + this.buy.landPrice;
    this.triggerFormChange();
  }

  onFormChange(): void {
    console.log('onFormChange called');
    this.updateSliderStyles();
    this.triggerFormChange();
  }

  private updateSliderStyles(): void {
    // Update CSS custom properties for slider fill effect
    const sliders = [
      // Property sliders
      { value: this.buy.amortizationPeriod, min: 0, max: 50 },
      { value: this.buy.buildingAge, min: 0, max: 50 },
      { value: this.buy.maintenance, min: 0, max: 5 },
      { value: this.buy.propertyTax, min: 0, max: 3 },
      { value: this.buy.feeRate, min: 0, max: 10 },
      // Loan sliders
      { value: this.loan.loanPeriod, min: 1, max: 50 },
      { value: this.loan.loanFee, min: 0, max: 5 },
      { value: this.loan.loanRate, min: 0, max: 10 },
      { value: this.loan.upfrontAmount, min: 0, max: 100 },
      // Economic factors sliders
      { value: this.macro.inflationRate, min: 0, max: 10 },
      { value: this.macro.landAppreciation, min: -5, max: 15 },
      { value: this.macro.opportunityCost, min: 0, max: 15 }
    ];

    const rangeInputs = document.querySelectorAll('input[type="range"]');
    rangeInputs.forEach((slider, index) => {
      if (sliders[index]) {
        const { value, min, max } = sliders[index];
        const percentage = ((value - min) / (max - min)) * 100;
        (slider as HTMLElement).style.setProperty('--fill-percentage', `${percentage}%`);
      }
    });
  }

  togglePropertySection(): void {
    this.isPropertyCollapsed = !this.isPropertyCollapsed;
  }

  toggleLoanSection(): void {
    this.isLoanCollapsed = !this.isLoanCollapsed;
  }

  toggleRentSection(): void {
    this.isRentCollapsed = !this.isRentCollapsed;
  }

  toggleEconomicSection(): void {
    this.isEconomicCollapsed = !this.isEconomicCollapsed;
  }

  private triggerFormChange(): void {
    console.log('triggerFormChange called - emitting form change');
    this.formChange$.next();
  }

  private mapToNpvParams(): NpvParams {
    const houseValue = this.buy.housePrice * Math.max(0, 1 - this.buy.buildingAge / this.buy.amortizationPeriod);
    const totalPropertyValue = (houseValue + this.buy.landPrice) * 10000;
    const brokerFees = totalPropertyValue * (this.buy.feeRate / 100);
    const totalCostWithFees = totalPropertyValue + brokerFees;
    const downPayment = totalPropertyValue * (this.loan.upfrontAmount / 100);
    const principal = Math.max(0, totalCostWithFees - downPayment);
    
    console.log('Principal calculation:', {
      totalPropertyValue,
      brokerFees,
      totalCostWithFees,
      downPayment,
      principal
    });
    
    return {
      real_estate: {
        house_value: this.buy.housePrice * 10000,
        land_value: this.buy.landPrice * 10000,
        house_age: this.buy.buildingAge,
        fully_amortized_age: this.buy.amortizationPeriod,
        appreciation_rate: this.macro.landAppreciation / 100,
        maintenance_rate: this.buy.maintenance / 100
      },
      loan: {
        principal: principal,
        down_payment: downPayment,
        yearly_interest: this.loan.loanRate / 100,
        term: this.loan.loanPeriod
      },
      rent: {
        monthly_rent: this.rent.monthlyRent * 10000,
        renewal_fee_months: this.rent.renewal,
        inflation_rate: this.macro.inflationRate / 100
      },
      bank_interest_rate: 0.01,
      simulation_years: this.macro.simulationYears,
      opportunity_cost_rate: this.macro.opportunityCost / 100,
      broker_fee: this.buy.feeRate / 100
    };
  }

  calculateNpv(): void {
    this.isLoading = true;
    this.error = null;
    
    const params = this.mapToNpvParams();
    const url = `${this.apiUrl}/npv`;
    console.log('Sending NPV request to:', url);
    console.log('Request params:', params);
    
    this.http.post<CashFlow[]>(url, params).subscribe({
      next: (data) => {
        console.log('NPV response received:', data);
        this.cashFlowData = data;
        this.isLoading = false;
        // Try to create charts after a short delay to ensure DOM is ready
        setTimeout(() => {
          this.createCharts();
        }, 100);
      },
      error: (err) => {
        console.error('NPV calculation error:', err);
        this.error = `Failed to calculate NPV. Error: ${err.message || err.status || 'Unknown error'}. Please ensure the backend is running on ${this.apiUrl}`;
        this.isLoading = false;
      }
    });
  }

  private createCharts(): void {
    if (!this.cashFlowData || this.cashFlowData.length === 0) {
      console.log('No cash flow data available for charts');
      return;
    }
    
    console.log('Attempting to create charts...');
    this.createNpvChart();
    this.createIrrChart();
    this.createCashflowChart();
  }

  private createNpvChart(): void {
    if (this.npvChart) {
      this.npvChart.destroy();
    }

    if (!this.npvChartRef) {
      console.error('NPV chart ref not available');
      return;
    }

    const ctx = this.npvChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get NPV chart context');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const npvData = this.cashFlowData.map(d => d.buy_npv / 10000); // Convert to man-yen

    console.log('Creating NPV chart with data:', { years, npvData });

    this.npvChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [{
          label: 'NPV (Buy vs Rent)',
          data: npvData,
          borderColor: 'rgb(75, 192, 192)',
          backgroundColor: 'rgba(75, 192, 192, 0.2)',
          tension: 0.1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'NPV (万円)'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Year'
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: 'Net Present Value: Buy vs Rent'
          },
          legend: {
            display: true
          }
        }
      }
    });
  }

  private createIrrChart(): void {
    if (this.irrChart) {
      this.irrChart.destroy();
    }

    if (!this.irrChartRef) {
      console.error('IRR chart ref not available');
      return;
    }

    const ctx = this.irrChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get IRR chart context');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const irrData = this.cashFlowData.map(d => d.buy_irr ? d.buy_irr * 100 : null);

    console.log('Creating IRR chart with data:', { years, irrData });

    this.irrChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [{
          label: 'IRR (%)',
          data: irrData,
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          tension: 0.1,
          spanGaps: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            title: {
              display: true,
              text: 'IRR (%)'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Year'
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: 'Internal Rate of Return: Buy vs Rent'
          },
          legend: {
            display: true
          }
        }
      }
    });
  }

  private createCashflowChart(): void {
    if (this.cashflowChart) {
      this.cashflowChart.destroy();
    }

    if (!this.cashflowChartRef) {
      console.error('Cashflow chart ref not available');
      return;
    }

    const ctx = this.cashflowChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get cashflow chart context');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const rentCashflow = this.cashFlowData.map(d => d.rent_cost / 10000); // Convert to man-yen
    const buyCashflow = this.cashFlowData.map(d => (d.house_cost + d.loan_cost) / 10000); // Convert to man-yen

    console.log('Creating cashflow chart with data:', { years, rentCashflow, buyCashflow });

    this.cashflowChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: years,
        datasets: [
          {
            label: 'Rent Cashflow',
            data: rentCashflow,
            backgroundColor: 'rgba(255, 99, 132, 0.7)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
          },
          {
            label: 'Buy Cashflow',
            data: buyCashflow,
            backgroundColor: 'rgba(54, 162, 235, 0.7)',
            borderColor: 'rgb(54, 162, 235)',
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: 'Cashflow (万円)'
            }
          },
          x: {
            title: {
              display: true,
              text: 'Year'
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: 'Annual Cashflow: Rent vs Buy'
          },
          legend: {
            display: true
          }
        }
      }
    });
  }

  get houseAndLandPrice(): number {
    return this.buy.housePrice + this.buy.landPrice;
  }

  get agentFees(): number {
    return this.houseAndLandPrice * this.buy.feeRate / 100;
  }

  get maintenanceFee(): number {
    return this.houseAndLandPrice * this.buy.maintenance / 100;
  }

  get monthlyPayment(): number {
    const P: number = this.houseAndLandPrice * (1 - this.loan.upfrontAmount / 100);
    const r: number = this.loan.loanRate / 100 / 12;
    const n: number = this.loan.loanPeriod * 12;
    if (r === 0) {
      return P / n;
    }
    return P * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  get monthlyBuyCost(): number {
    const propertyTax = (this.houseAndLandPrice * this.buy.propertyTax / 100) / 12;
    const maintenance = this.maintenanceFee / 12;
    return this.monthlyPayment + propertyTax + maintenance;
  }

  get monthlyRentCost(): number {
    return this.rent.monthlyRent;
  }
}