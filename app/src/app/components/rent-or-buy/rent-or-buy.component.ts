import { Component, ViewChild, ElementRef, AfterViewInit, OnDestroy, Inject, LOCALE_ID } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { Router, ActivatedRoute } from '@angular/router';
import Chart from 'chart.js/auto';
import { Subject, fromEvent, debounceTime, takeUntil, throttleTime } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RentBuyCalculatorService } from '../../services/rent-buy-calculator.service';
import { AnalyticsService } from '../../services/analytics.service';

interface CashFlow {
  year: number;
  rent_cost: number;
  house_cost: number;
  loan_cost: number;
  house_value: number;
  loan_value: number;
  sale_value: number;
  stock_value: number;
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
  @ViewChild('houseVsStockChart') houseVsStockChartRef!: ElementRef<HTMLCanvasElement>;
  
  private npvChart: Chart | null = null;
  private irrChart: Chart | null = null;
  private cashflowChart: Chart | null = null;
  private houseVsStockChart: Chart | null = null;
  private destroy$ = new Subject<void>();
  private formChange$ = new Subject<void>();
  private urlUpdate$ = new Subject<void>();
  private apiUrl = environment.apiUrl;
  
  expertModeBuy = true;
  expertModeRent = false;
  
  // Collapse states for each section
  isPropertyCollapsed = false;
  isLoanCollapsed = false;
  isRentCollapsed = false;
  isEconomicCollapsed = false;
  
  // Intro box state
  isIntroVisible = true;
  isIntroFadingOut = false;
  hasUserMadeChanges = false;
  isInitializing = true;
  
  // Mobile FAB system  
  isFabOpen = false;
  activeModal: string | null = null;
  isMobileButtonVisible = true;
  private lastScrollTop = 0;
  
  // Tutorial system
  isTutorialOpen = false;
  tutorialStep = 1;
  tutorialData = {
    monthlyRent: 150,
    housePrice: 5000,
    hasLoan: true,
    downPayment: 20,
    loanRate: 1.5,
    loanPeriod: 35,
    hasInvestment: true,
    investmentReturn: 7
  };
  
  cashFlowData: CashFlow[] = [];
  error: string | null = null;
  shareButtonText = 'Share';
  showShareModal = false;
  shareUrl = '';
  copyButtonText = 'Copy Link';
  
  // Financial analysis results
  minYearsForAdvantage: number | null = null;
  optimalYearsForMaxNpv: number | null = null;
  maxNpvValue: number | null = null;
  sellBeforeNegative: number | null = null;
  financialRecommendation: string = '';
  recommendationSegments: Array<{text: string, isNumber: boolean}> = [];

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

  constructor(
    private http: HttpClient, 
    private router: Router,
    private route: ActivatedRoute,
    private analytics: AnalyticsService,
    @Inject(LOCALE_ID) private locale: string
  ) {
    console.log('RentOrBuyComponent constructor - API URL:', this.apiUrl);
    this.loadParametersFromUrl();
    this.onPropertyPriceChange(this.buy.propertyPrice);
    
    // Ensure gift money and guarantee are synced with monthly rent from start
    this.rent.giftMoney = this.rent.monthlyRent;
    this.rent.guarantee = this.rent.monthlyRent;
    
    // Set up debounced form changes
    this.formChange$.pipe(
      debounceTime(500), // Wait 500ms after the last change
      takeUntil(this.destroy$)
    ).subscribe(() => {
      console.log('Debounced form change triggered');
      this.calculateNpv();
    });
    
    // Set up debounced URL updates
    this.urlUpdate$.pipe(
      debounceTime(1000), // Wait 1 second after the last change for URL updates
      takeUntil(this.destroy$)
    ).subscribe(() => {
      console.log('Updating URL with current parameters');
      this.updateUrlWithCurrentParameters();
    });
    
    // Mark initialization as complete
    this.isInitializing = false;
  }

  private loadParametersFromUrl(): void {
    const params = this.route.snapshot.queryParams;
    
    // Load buy parameters
    if (params['propertyPrice']) this.buy.propertyPrice = +params['propertyPrice'];
    if (params['housePrice']) this.buy.housePrice = +params['housePrice'];
    if (params['landPrice']) this.buy.landPrice = +params['landPrice'];
    if (params['maintenance']) this.buy.maintenance = +params['maintenance'];
    if (params['propertyTax']) this.buy.propertyTax = +params['propertyTax'];
    if (params['buildingAge']) this.buy.buildingAge = +params['buildingAge'];
    if (params['feeRate']) this.buy.feeRate = +params['feeRate'];
    if (params['amortizationPeriod']) this.buy.amortizationPeriod = +params['amortizationPeriod'];
    
    // Load rent parameters
    if (params['monthlyRent']) this.rent.monthlyRent = +params['monthlyRent'];
    if (params['giftMoney']) this.rent.giftMoney = +params['giftMoney'];
    if (params['guarantee']) this.rent.guarantee = +params['guarantee'];
    if (params['renewal']) this.rent.renewal = +params['renewal'];
    
    // Load macro parameters
    if (params['inflationRate']) this.macro.inflationRate = +params['inflationRate'];
    if (params['landAppreciation']) this.macro.landAppreciation = +params['landAppreciation'];
    if (params['opportunityCost']) this.macro.opportunityCost = +params['opportunityCost'];
    if (params['simulationYears']) this.macro.simulationYears = +params['simulationYears'];
    
    // Load loan parameters
    if (params['loanPeriod']) this.loan.loanPeriod = +params['loanPeriod'];
    if (params['loanFee']) this.loan.loanFee = +params['loanFee'];
    if (params['loanRate']) this.loan.loanRate = +params['loanRate'];
    if (params['upfrontAmount']) this.loan.upfrontAmount = +params['upfrontAmount'];
    
    // Load UI state
    if (params['expertBuy'] !== undefined) this.expertModeBuy = params['expertBuy'] === 'true';
    if (params['expertRent'] !== undefined) this.expertModeRent = params['expertRent'] === 'true';
  }

  private updateUrlWithCurrentParameters(): void {
    const queryParams = {
      // Buy parameters
      propertyPrice: this.buy.propertyPrice,
      housePrice: this.buy.housePrice,
      landPrice: this.buy.landPrice,
      maintenance: this.buy.maintenance,
      propertyTax: this.buy.propertyTax,
      buildingAge: this.buy.buildingAge,
      feeRate: this.buy.feeRate,
      amortizationPeriod: this.buy.amortizationPeriod,
      
      // Rent parameters
      monthlyRent: this.rent.monthlyRent,
      giftMoney: this.rent.giftMoney,
      guarantee: this.rent.guarantee,
      renewal: this.rent.renewal,
      
      // Macro parameters
      inflationRate: this.macro.inflationRate,
      landAppreciation: this.macro.landAppreciation,
      opportunityCost: this.macro.opportunityCost,
      simulationYears: this.macro.simulationYears,
      
      // Loan parameters
      loanPeriod: this.loan.loanPeriod,
      loanFee: this.loan.loanFee,
      loanRate: this.loan.loanRate,
      upfrontAmount: this.loan.upfrontAmount,
      
      // UI state
      expertBuy: this.expertModeBuy,
      expertRent: this.expertModeRent
    };

    this.router.navigate([], {
      relativeTo: this.route,
      queryParams: queryParams,
      replaceUrl: true
    });
  }

  copyShareUrl(): void {
    this.analytics.logShareFromShareBox();
    this.generateShareUrl();
  }

  copyShareUrlFromAdvice(): void {
    this.analytics.logShareFromAdviceBox();
    this.generateShareUrl();
  }

  private generateShareUrl(): void {
    // Manually construct the share URL with all current parameters
    const baseUrl = window.location.origin + window.location.pathname;
    const queryParams = new URLSearchParams({
      // Buy parameters
      propertyPrice: this.buy.propertyPrice.toString(),
      housePrice: this.buy.housePrice.toString(),
      landPrice: this.buy.landPrice.toString(),
      maintenance: this.buy.maintenance.toString(),
      propertyTax: this.buy.propertyTax.toString(),
      buildingAge: this.buy.buildingAge.toString(),
      feeRate: this.buy.feeRate.toString(),
      amortizationPeriod: this.buy.amortizationPeriod.toString(),
      
      // Rent parameters
      monthlyRent: this.rent.monthlyRent.toString(),
      giftMoney: this.rent.giftMoney.toString(),
      guarantee: this.rent.guarantee.toString(),
      renewal: this.rent.renewal.toString(),
      
      // Macro parameters
      inflationRate: this.macro.inflationRate.toString(),
      landAppreciation: this.macro.landAppreciation.toString(),
      opportunityCost: this.macro.opportunityCost.toString(),
      simulationYears: this.macro.simulationYears.toString(),
      
      // Loan parameters
      loanPeriod: this.loan.loanPeriod.toString(),
      loanFee: this.loan.loanFee.toString(),
      loanRate: this.loan.loanRate.toString(),
      upfrontAmount: this.loan.upfrontAmount.toString(),
      
      // UI state
      expertBuy: this.expertModeBuy.toString(),
      expertRent: this.expertModeRent.toString()
    });
    
    this.shareUrl = `${baseUrl}?${queryParams.toString()}`;
    this.showShareModal = true;
  }

  closeShareModal(): void {
    this.showShareModal = false;
    this.copyButtonText = 'Copy Link';
  }

  copyUrlFromModal(): void {
    if (navigator.clipboard && window.isSecureContext) {
      // Use modern clipboard API
      navigator.clipboard.writeText(this.shareUrl).then(() => {
        this.copyButtonText = 'Copied!';
        setTimeout(() => {
          this.copyButtonText = 'Copy Link';
        }, 2000);
      }).catch(err => {
        console.error('Failed to copy URL: ', err);
        this.fallbackCopyTextToClipboard(this.shareUrl);
      });
    } else {
      // Fallback for older browsers
      this.fallbackCopyTextToClipboard(this.shareUrl);
    }
  }

  private fallbackCopyTextToClipboard(text: string): void {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-999999px";
    textArea.style.top = "-999999px";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      document.execCommand('copy');
      this.copyButtonText = 'Copied!';
      setTimeout(() => {
        this.copyButtonText = 'Copy Link';
      }, 2000);
    } catch (err) {
      console.error('Fallback: Could not copy text: ', err);
      this.copyButtonText = 'Copy failed';
      setTimeout(() => {
        this.copyButtonText = 'Copy Link';
      }, 2000);
    }
    
    document.body.removeChild(textArea);
  }

  ngAfterViewInit(): void {
    // Wait a bit for the view to be fully rendered
    setTimeout(() => {
      console.log('ngAfterViewInit - attempting to calculate NPV');
      console.log('Chart refs available:', !!this.npvChartRef, !!this.irrChartRef, !!this.cashflowChartRef, !!this.houseVsStockChartRef);
      this.updateSliderStyles();
      // Calculate NPV on initialization
      this.calculateNpv();
    }, 100);

    // Add scroll event listener for mobile button visibility
    fromEvent(window, 'scroll')
      .pipe(
        throttleTime(100), // Throttle to improve performance
        takeUntil(this.destroy$)
      )
      .subscribe(() => {
        this.onScroll();
      });
  }

  isMobileView(): boolean {
    return window.innerWidth <= 768;
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
    if (this.houseVsStockChart) {
      this.houseVsStockChart.destroy();
    }
  }

  onPropertyPriceChange(newPrice: number): void {
    console.log('onPropertyPriceChange called with:', newPrice);
    this.analytics.logInputChange('propertyPrice', newPrice);
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

  onRentChange(): void {
    console.log('onRentChange called');
    this.analytics.logInputChange('monthlyRent', this.rent.monthlyRent);
    // Automatically set gift money and guarantee to equal monthly rent
    this.rent.giftMoney = this.rent.monthlyRent;
    this.rent.guarantee = this.rent.monthlyRent;
    this.onFormChange();
  }

  // Analytics-enabled input change handlers
  onHousePriceChange(): void {
    this.analytics.logInputChange('housePrice', this.buy.housePrice);
    this.onExpertBuyChange();
  }

  onLandPriceChange(): void {
    this.analytics.logInputChange('landPrice', this.buy.landPrice);
    this.onExpertBuyChange();
  }

  onMaintenanceChange(): void {
    this.analytics.logInputChange('maintenance', this.buy.maintenance);
    this.onFormChange();
  }

  onPropertyTaxChange(): void {
    this.analytics.logInputChange('propertyTax', this.buy.propertyTax);
    this.onFormChange();
  }

  onBuildingAgeChange(): void {
    this.analytics.logInputChange('buildingAge', this.buy.buildingAge);
    this.onFormChange();
  }

  onAmortizationPeriodChange(): void {
    this.analytics.logInputChange('amortizationPeriod', this.buy.amortizationPeriod);
    this.onFormChange();
  }

  onAgentFeeChange(): void {
    this.analytics.logInputChange('agentFee', this.buy.feeRate);
    this.onFormChange();
  }

  onRentInflationChange(): void {
    this.analytics.logInputChange('rentInflation', this.macro.inflationRate);
    this.onFormChange();
  }

  onLoanPeriodChange(): void {
    this.analytics.logInputChange('loanPeriod', this.loan.loanPeriod);
    this.onFormChange();
  }

  onLoanFeeChange(): void {
    this.analytics.logInputChange('loanFee', this.loan.loanFee);
    this.onFormChange();
  }

  onLoanRateChange(): void {
    this.analytics.logInputChange('loanRate', this.loan.loanRate);
    this.onFormChange();
  }

  onDownPaymentChange(): void {
    this.analytics.logInputChange('downPayment', this.loan.upfrontAmount);
    this.onFormChange();
  }

  onHouseAppreciationChange(): void {
    this.analytics.logInputChange('houseAppreciation', this.macro.landAppreciation);
    this.onFormChange();
  }

  onOpportunityCostChange(): void {
    this.analytics.logInputChange('opportunityCost', this.macro.opportunityCost);
    this.onFormChange();
  }

  private updateSliderStyles(): void {
    // Update CSS custom properties for slider fill effect
    // Use data attributes to identify sliders instead of relying on DOM order
    const sliderMappings = {
      'rent-inflation': { value: this.macro.inflationRate, min: 0, max: 10 },
      'amortization-period': { value: this.buy.amortizationPeriod, min: 0, max: 50 },
      'building-age': { value: this.buy.buildingAge, min: 0, max: 50 },
      'maintenance': { value: this.buy.maintenance, min: 0, max: 5 },
      'property-tax': { value: this.buy.propertyTax, min: 0, max: 3 },
      'agent-fee': { value: this.buy.feeRate, min: 0, max: 10 },
      'loan-period': { value: this.loan.loanPeriod, min: 1, max: 50 },
      'loan-fee': { value: this.loan.loanFee, min: 0, max: 5 },
      'loan-rate': { value: this.loan.loanRate, min: 0, max: 10 },
      'down-payment': { value: this.loan.upfrontAmount, min: 0, max: 100 },
      'house-appreciation': { value: this.macro.landAppreciation, min: -5, max: 15 },
      'opportunity-cost': { value: this.macro.opportunityCost, min: 0, max: 15 }
    };

    // Update sliders using data attributes for reliable identification
    Object.entries(sliderMappings).forEach(([key, config]) => {
      const slider = document.querySelector(`input[type="range"][data-slider="${key}"]`) as HTMLElement;
      if (slider) {
        const { value, min, max } = config;
        const percentage = ((value - min) / (max - min)) * 100;
        slider.style.setProperty('--fill-percentage', `${percentage}%`);
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

  closeIntroBox(): void {
    this.hideIntroWithAnimation();
  }

  private hideIntroWithAnimation(): void {
    if (this.isIntroFadingOut || !this.isIntroVisible) {
      return; // Already hiding or hidden
    }
    
    this.isIntroFadingOut = true;
    
    // Hide the element after the animation completes (0.8s)
    setTimeout(() => {
      this.isIntroVisible = false;
      this.isIntroFadingOut = false;
    }, 800);
  }

  private triggerFormChange(): void {
    console.log('triggerFormChange called - emitting form change');
    
    // Hide intro box on first user interaction (not during initialization)
    if (!this.hasUserMadeChanges && !this.isInitializing) {
      this.hasUserMadeChanges = true;
      this.hideIntroWithAnimation();
    }
    
    this.formChange$.next();
    this.urlUpdate$.next();
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
    this.error = null;
    
    const params = this.mapToNpvParams();
    const url = `${this.apiUrl}/npv`;
    console.log('Sending NPV request to:', url);
    console.log('Request params:', params);
    
    this.http.post<CashFlow[]>(url, params).subscribe({
      next: (data) => {
        console.log('NPV response received:', data);
        this.cashFlowData = data;
        // Try to create charts after a short delay to ensure DOM is ready
        setTimeout(() => {
          this.createCharts();
        }, 100);
      },
      error: (err) => {
        console.error('NPV calculation error:', err);
        this.error = `Failed to calculate NPV. Error: ${err.message || err.status || 'Unknown error'}. Please ensure the backend is running on ${this.apiUrl}`;
      }
    });
  }

  private createCharts(): void {
    if (!this.cashFlowData || this.cashFlowData.length === 0) {
      console.log('No cash flow data available for charts');
      return;
    }
    
    console.log('Attempting to create charts...');
    this.analyzeNpvData();
    this.createNpvChart();
    this.createIrrChart();
    this.createCashflowChart();
    this.createHouseVsStockChart();
  }

  private analyzeNpvData(): void {
    if (!this.cashFlowData || this.cashFlowData.length === 0) {
      this.minYearsForAdvantage = null;
      this.optimalYearsForMaxNpv = null;
      this.maxNpvValue = null;
      this.sellBeforeNegative = null;
      this.financialRecommendation = 'No data available for analysis.';
      return;
    }

    // Find first year where NPV > 0 (breakeven point)
    let firstPositiveYear: number | null = null;
    
    // Find year with maximum NPV (optimal point)
    let maxNpv = -Infinity;
    let optimalYear: number | null = null;
    
    // Track when NPV goes negative again after being positive
    let hasBeenPositive = false;
    let lastPositiveYear: number | null = null;
    
    for (const data of this.cashFlowData) {
      // Track first positive NPV
      if (data.buy_npv > 0 && firstPositiveYear === null) {
        firstPositiveYear = data.year;
      }
      
      // Track maximum NPV
      if (data.buy_npv > maxNpv) {
        maxNpv = data.buy_npv;
        optimalYear = data.year;
      }
      
      // Track when NPV becomes negative after being positive
      if (data.buy_npv > 0) {
        hasBeenPositive = true;
        lastPositiveYear = data.year;
      } else if (hasBeenPositive && data.buy_npv <= 0) {
        // NPV went negative after being positive
        break;
      }
    }

    this.minYearsForAdvantage = firstPositiveYear;
    this.optimalYearsForMaxNpv = optimalYear;
    this.maxNpvValue = maxNpv > -Infinity ? maxNpv : null;
    
    // Set sell before negative only if NPV actually goes negative again
    if (hasBeenPositive && lastPositiveYear !== null) {
      const nextYear = lastPositiveYear + 1;
      const nextYearData = this.cashFlowData.find(d => d.year === nextYear);
      if (nextYearData && nextYearData.buy_npv <= 0) {
        this.sellBeforeNegative = lastPositiveYear;
      } else {
        this.sellBeforeNegative = null;
      }
    } else {
      this.sellBeforeNegative = null;
    }

    // Generate recommendation text
    this.generateFinancialRecommendation();
  }

  private getTranslatedText(key: string, fallback: string): string {
    if (this.locale === 'ja') {
      const translations: { [key: string]: string } = {
        'never_advantageous': 'この設定では、賃貸の方が購入よりも常にお金を節約できます。',
        'unable_to_calculate': '現在のデータでは最適戦略を計算できません。',
        'right_away': 'すぐに',
        'after_years_prefix': '住んでから',
        'after_years_suffix': '年後に',
        'save_compared_to_renting': '万円を賃貸と比較して節約',
        'buying_pays_off': '購入は',
        'pays_off_and_best_savings': 'に投資回収し、',
        'best_savings_at_year': '年目に最高の節約効果を発揮します',
        'buying_starts_paying_off': '購入は',
        'starts_paying_off': 'に投資回収を始めます。',
        'for_maximum_savings': '最大の節約のため、',
        'stay_until_year': '年目まで住み続けてください',
        'after_year_renting_cheaper': '年目以降、賃貸の方が安くなります。',
        'sell_before_year': 'また、',
        'sell_before_year_suffix': '年目前に売却すべきです - その後は賃貸の方が安くなります。',
        'and_save': 'そして'
      };
      return translations[key] || fallback;
    }
    return fallback;
  }

  private generateFinancialRecommendation(): void {
    if (this.minYearsForAdvantage === null) {
      this.financialRecommendation = ' ' + this.getTranslatedText('never_advantageous', 'With these settings, renting would always save you more money than buying.');
      this.parseRecommendationForHighlighting(this.financialRecommendation);
    } else if (this.optimalYearsForMaxNpv === null) {
      this.financialRecommendation = ' ' + this.getTranslatedText('unable_to_calculate', 'Unable to calculate the best strategy with current data.');
      this.parseRecommendationForHighlighting(this.financialRecommendation);
    } else {
      const breakEvenText = this.minYearsForAdvantage === 1 
        ? this.getTranslatedText('right_away', 'right away')
        : this.locale === 'ja' 
          ? `${this.getTranslatedText('after_years_prefix', 'after living there for')}${this.minYearsForAdvantage}${this.getTranslatedText('after_years_suffix', ' years')}`
          : `${this.minYearsForAdvantage} years`;
      
      const profitText = this.maxNpvValue 
        ? this.locale === 'ja'
          ? `${this.getTranslatedText('and_save', ' and save')}${Math.round(this.maxNpvValue / 10000)}${this.getTranslatedText('save_compared_to_renting', ' 万円 compared to renting')}`
          : ` and save ${Math.round(this.maxNpvValue / 10000)} 万円 compared to renting`
        : '';
      
      let recommendation = '';
      
      if (this.minYearsForAdvantage === this.optimalYearsForMaxNpv) {
        if (this.locale === 'ja') {
          recommendation = ` 🏠 ${this.getTranslatedText('buying_pays_off', 'Buying pays off')}${breakEvenText}${this.getTranslatedText('pays_off_and_best_savings', ' and gives you the best savings at year')}${this.optimalYearsForMaxNpv}${this.getTranslatedText('best_savings_at_year', '')}${profitText}。`;
        } else {
          recommendation = ` 🏠 Buying pays off ${breakEvenText} and gives you the best savings at year ${this.optimalYearsForMaxNpv}${profitText}.`;
        }
      } else {
        if (this.locale === 'ja') {
          recommendation = ` 🏠 ${this.getTranslatedText('buying_starts_paying_off', 'Don\'t buy if')}${breakEvenText}${this.getTranslatedText('starts_paying_off', '.')} ${this.getTranslatedText('for_maximum_savings', 'For maximum savings, sell on year')}${this.optimalYearsForMaxNpv}${this.getTranslatedText('sell_on_year', '')}${profitText}。`;
        } else {
          recommendation = ` 🏠 Don't buy if you can't stay in the house for at least ${breakEvenText}. For maximum savings, sell on year ${this.optimalYearsForMaxNpv}${profitText}.`;
        }
      }
      
      // Add advice about selling before losses (only if max year is not 40)
      if (this.sellBeforeNegative !== null && this.optimalYearsForMaxNpv !== 40) {
        if (this.sellBeforeNegative === this.optimalYearsForMaxNpv) {
          if (this.locale === 'ja') {
            recommendation += ` ⚠️ ${this.sellBeforeNegative}${this.getTranslatedText('after_year_renting_cheaper', ' After year, renting becomes cheaper again.')}`;
          } else {
            recommendation += ` ⚠️ After year ${this.sellBeforeNegative}, renting becomes cheaper again.`;
          }
        } else {
          if (this.locale === 'ja') {
            recommendation += ` ⚠️ ${this.getTranslatedText('sell_before_year', 'Also, you should sell before year')}${this.sellBeforeNegative + 1}${this.getTranslatedText('sell_before_year_suffix', ' - after that, renting becomes cheaper.')}`;
          } else {
            recommendation += ` ⚠️ Also, you should sell before year ${this.sellBeforeNegative + 1} because you will lose money compared to renting after that.`;
          }
        }
      }
      
      this.financialRecommendation = recommendation;
      this.parseRecommendationForHighlighting(recommendation);
    }
  }

  private parseRecommendationForHighlighting(text: string): void {
    this.recommendationSegments = [];
    
    // Regular expression to match numbers (including those followed by 万円, years, 年目, 年後, etc.)
    const numberRegex = /(\d+(?:\s*万円|\s*years?|\s*年目?|\s*年後)?)/g;
    
    let lastIndex = 0;
    let match;
    
    while ((match = numberRegex.exec(text)) !== null) {
      // Add text before the number
      if (match.index > lastIndex) {
        this.recommendationSegments.push({
          text: text.substring(lastIndex, match.index),
          isNumber: false
        });
      }
      
      // Add the number itself
      this.recommendationSegments.push({
        text: match[1],
        isNumber: true
      });
      
      lastIndex = match.index + match[1].length;
    }
    
    // Add remaining text after the last number
    if (lastIndex < text.length) {
      this.recommendationSegments.push({
        text: text.substring(lastIndex),
        isNumber: false
      });
    }
  }

  private createNpvChart(): void {
    if (!this.npvChartRef) {
      console.error('NPV chart ref not available');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const npvData = this.cashFlowData.map(d => d.buy_npv / 10000); // Convert to man-yen

    // Create separate datasets for positive and negative areas
    const positiveData = npvData.map(val => val >= 0 ? val : null);
    const negativeData = npvData.map(val => val < 0 ? val : null);

    // If chart exists, carefully update data while preserving all styling
    if (this.npvChart) {
      this.npvChart.data.labels = years;
      
      // Ensure we have the right number of datasets
      if (this.npvChart.data.datasets.length !== 3) {
        // Recreate the chart if dataset structure is wrong
        this.npvChart.destroy();
        this.npvChart = null;
        this.createNpvChart();
        return;
      }
      
      // Update data while explicitly preserving all styling properties
             Object.assign(this.npvChart.data.datasets[0], {
         data: positiveData,
         label: $localize`:@@chart.betterToBuy:Better to Buy`,
         borderColor: '#4ecdc4',
         backgroundColor: 'rgba(78, 205, 196, 0.3)',
         borderWidth: 2,
         pointBackgroundColor: 'transparent',
         pointBorderColor: '#4ecdc4',
         pointBorderWidth: 2,
         pointHoverBackgroundColor: '#4ecdc4',
         pointRadius: 3,
         pointHoverRadius: 5,
         tension: 0.3,
         fill: 'origin',
         spanGaps: false
       });
       
       Object.assign(this.npvChart.data.datasets[1], {
         data: negativeData,
         label: $localize`:@@chart.betterToRent:Better to Rent`,
         borderColor: '#ff6b6b',
         backgroundColor: 'rgba(255, 107, 107, 0.3)',
         borderWidth: 2,
         pointBackgroundColor: 'transparent',
         pointBorderColor: '#ff6b6b',
         pointBorderWidth: 2,
         pointHoverBackgroundColor: '#ff6b6b',
         pointRadius: 3,
         pointHoverRadius: 5,
         tension: 0.3,
         fill: 'origin',
         spanGaps: false
       });
      
      Object.assign(this.npvChart.data.datasets[2], {
        data: npvData,
                 label: $localize`:@@chart.npvLine:NPV Line`,
        borderColor: '#333',
        backgroundColor: 'transparent',
        borderWidth: 2,
        pointBackgroundColor: 'transparent',
        pointBorderColor: 'transparent',
        pointRadius: 0,
        pointHoverRadius: 0,
        tension: 0.3,
        fill: false
      });
      
      this.npvChart.update('none');
      return;
    }

    const ctx = this.npvChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get NPV chart context');
      return;
    }

    console.log('Creating NPV chart with data:', { years, npvData });

    this.npvChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          {
            label: $localize`:@@chart.betterToBuy:Better to Buy`,
            data: positiveData,
            borderColor: '#4ecdc4',
            backgroundColor: 'rgba(78, 205, 196, 0.3)',
            borderWidth: 2,
            pointBackgroundColor: 'transparent',
            pointBorderColor: '#4ecdc4',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: '#4ecdc4',
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.3,
            fill: 'origin',
            spanGaps: false
          },
          {
            label: $localize`:@@chart.betterToRent:Better to Rent`,
            data: negativeData,
            borderColor: '#ff6b6b',
            backgroundColor: 'rgba(255, 107, 107, 0.3)',
            borderWidth: 2,
            pointBackgroundColor: 'transparent',
            pointBorderColor: '#ff6b6b',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: '#ff6b6b',
            pointRadius: 3,
            pointHoverRadius: 5,
            tension: 0.3,
            fill: 'origin',
            spanGaps: false
          },
          {
            label: $localize`:@@chart.npvLine:NPV Line`,
            data: npvData,
            borderColor: '#333',
            backgroundColor: 'transparent',
            borderWidth: 2,
            pointBackgroundColor: 'transparent',
            pointBorderColor: 'transparent',
            pointRadius: 0,
            pointHoverRadius: 0,
            tension: 0.3,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 750,
          easing: 'easeInOutQuart'
        },
        transitions: {
          active: {
            animation: {
              duration: 400
            }
          }
        },
        interaction: {
          intersect: false,
          mode: 'index'
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: $localize`:@@chart.npvYenMan:NPV (万円)`
            },
            grid: {
              color: '#e0e0e0'
            }
          },
          x: {
            title: {
              display: true,
              text: $localize`:@@chart.year:Year`
            },
            grid: {
              color: '#e0e0e0'
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: 'Net Present Value: Buy vs Rent'
          },
          legend: {
            display: true,
            labels: {
              filter: function(legendItem: any, chartData: any) {
                return legendItem.text !== $localize`:@@chart.npvLine:NPV Line`;
              }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              title: function(context: any) {
                return `${$localize`:@@chart.year:Year`} ${context[0].label}`;
              },
              label: function(context: any) {
                const value = Math.round(context.parsed.y);
                if (context.datasetIndex === 2) { // NPV Line dataset
                  return `NPV: ${value}万円`;
                }
                return `${context.dataset.label}: ${value}万円`;
              }
            }
          }
        }
      }
    });
  }

  private createIrrChart(): void {
    if (!this.irrChartRef) {
      console.error('IRR chart ref not available');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const irrData = this.cashFlowData.map(d => d.buy_irr ? d.buy_irr * 100 : null);

    // If chart exists, update data with smooth animation
    if (this.irrChart) {
      this.irrChart.data.labels = years;
      this.irrChart.data.datasets[0].data = irrData;
      this.irrChart.update('none');
      return;
    }

    const ctx = this.irrChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get IRR chart context');
      return;
    }

    console.log('Creating IRR chart with data:', { years, irrData });

    this.irrChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [{
          label: $localize`:@@chart.irrPercent:IRR (%)`,
          data: irrData,
          borderColor: 'rgb(255, 99, 132)',
          backgroundColor: 'rgba(255, 99, 132, 0.2)',
          pointBackgroundColor: 'transparent',
          pointBorderColor: 'rgb(255, 99, 132)',
          pointBorderWidth: 2,
          pointHoverBackgroundColor: 'rgb(255, 99, 132)',
          pointRadius: 4,
          pointHoverRadius: 6,
          tension: 0.1,
          spanGaps: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 750,
          easing: 'easeInOutQuart'
        },
        transitions: {
          active: {
            animation: {
              duration: 400
            }
          }
        },
        scales: {
          y: {
            min: 0,
            title: {
              display: true,
              text: $localize`:@@chart.irrPercent:IRR (%)`
            }
          },
          x: {
            title: {
              display: true,
              text: $localize`:@@chart.year:Year`
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: $localize`:@@chart.internalRateOfReturnTitle:Internal Rate of Return: Buy vs Rent`
          },
          legend: {
            display: true
          },
          tooltip: {
            callbacks: {
              label: function(context: any) {
                if (context.parsed.y === null) return context.dataset.label + ': N/A';
                return context.dataset.label + ': ' + Math.round(context.parsed.y) + '%';
              }
            }
          }
        }
      }
    });
  }

  private createCashflowChart(): void {
    if (!this.cashflowChartRef) {
      console.error('Cashflow chart ref not available');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const rentCashflow = this.cashFlowData.map(d => d.rent_cost / 10000); // Convert to man-yen
    const buyCashflow = this.cashFlowData.map(d => (d.house_cost + d.loan_cost) / 10000); // Convert to man-yen

    // If chart exists, update data with smooth animation
    if (this.cashflowChart) {
      this.cashflowChart.data.labels = years;
      this.cashflowChart.data.datasets[0].data = rentCashflow;
      this.cashflowChart.data.datasets[1].data = buyCashflow;
      this.cashflowChart.update('none');
      return;
    }

    const ctx = this.cashflowChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get cashflow chart context');
      return;
    }

    console.log('Creating cashflow chart with data:', { years, rentCashflow, buyCashflow });

    this.cashflowChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: years,
        datasets: [
          {
            label: $localize`:@@chart.rentCashflow:Rent Cashflow`,
            data: rentCashflow,
            backgroundColor: 'rgba(255, 99, 132, 0.7)',
            borderColor: 'rgb(255, 99, 132)',
            borderWidth: 1
          },
          {
            label: $localize`:@@chart.buyCashflow:Buy Cashflow`,
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
        animation: {
          duration: 750,
          easing: 'easeInOutQuart'
        },
        transitions: {
          active: {
            animation: {
              duration: 400
            }
          }
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: $localize`:@@chart.cashflowYenMan:Cashflow (万円)`
            }
          },
          x: {
            title: {
              display: true,
              text: $localize`:@@chart.year:Year`
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: $localize`:@@chart.annualCashflowTitle:Annual Cashflow: Rent vs Buy`
          },
          legend: {
            display: true
          },
          tooltip: {
            callbacks: {
              label: function(context: any) {
                return context.dataset.label + ': ' + Math.round(context.parsed.y) + '万円';
              }
            }
          }
        }
      }
    });
  }

  private createHouseVsStockChart(): void {
    if (!this.houseVsStockChartRef) {
      console.error('House vs Stock chart ref not available');
      return;
    }

    const years = this.cashFlowData.map(d => d.year);
    const buyNetWorth = this.cashFlowData.map(d => d.sale_value / 10000); // Net worth = sale value after broker fees and loan payoff
    const stockValue = this.cashFlowData.map(d => d.stock_value / 10000); // Convert to man-yen

    // If chart exists, update data with smooth animation
    if (this.houseVsStockChart) {
      this.houseVsStockChart.data.labels = years;
      this.houseVsStockChart.data.datasets[0].data = buyNetWorth;
      this.houseVsStockChart.data.datasets[1].data = stockValue;
      this.houseVsStockChart.update('none');
      return;
    }

    const ctx = this.houseVsStockChartRef.nativeElement.getContext('2d');
    if (!ctx) {
      console.error('Could not get House vs Stock chart context');
      return;
    }

    console.log('Creating Buy Net Worth vs Stock chart with data:', { years, buyNetWorth, stockValue });

    this.houseVsStockChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: years,
        datasets: [
          {
            label: $localize`:@@chart.buyHouse:Buy House`,
            data: buyNetWorth,
            borderColor: 'rgb(255, 159, 64)',
            backgroundColor: 'rgba(255, 159, 64, 0.2)',
            pointBackgroundColor: 'transparent',
            pointBorderColor: 'rgb(255, 159, 64)',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: 'rgb(255, 159, 64)',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.1,
            fill: false
          },
          {
            label: $localize`:@@chart.investInStocks:Invest in Stocks`,
            data: stockValue,
            borderColor: 'rgb(75, 192, 192)',
            backgroundColor: 'rgba(75, 192, 192, 0.2)',
            pointBackgroundColor: 'transparent',
            pointBorderColor: 'rgb(75, 192, 192)',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: 'rgb(75, 192, 192)',
            pointRadius: 4,
            pointHoverRadius: 6,
            tension: 0.1,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: {
          duration: 750,
          easing: 'easeInOutQuart'
        },
        transitions: {
          active: {
            animation: {
              duration: 400
            }
          }
        },
        interaction: {
          mode: 'index',
          intersect: false
        },
        scales: {
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: $localize`:@@chart.valueYenMan:Value (万円)`
            }
          },
          x: {
            title: {
              display: true,
              text: $localize`:@@chart.year:Year`
            }
          }
        },
        plugins: {
          title: {
            display: true,
            text: $localize`:@@chart.buyHouseVsStockTitle:Buy House vs Stock Investment Net Worth`
          },
          legend: {
            display: true
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: function(context: any) {
                return context.dataset.label + ': ' + Math.round(context.parsed.y) + '万円';
              }
            }
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

  // Mobile FAB methods
  toggleFab(): void {
    this.isFabOpen = !this.isFabOpen;
  }
  
  openAdvancedOptions(): void {
    // Check if we're on mobile (screen width <= 768px)
    if (window.innerWidth <= 768) {
      // Mobile: close intro box first, then open the sub-options menu with backdrop
      this.closeIntroBox();
      // Small delay to ensure intro box is closed before opening mobile options
      setTimeout(() => {
        this.isFabOpen = true;
      }, 100);
    } else {
      // Desktop: close the intro box to reveal the form
      this.closeIntroBox();
    }
  }
  
  onScroll(): void {
    const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    // Hide button when scrolling down, show when scrolling up
    if (currentScrollTop > this.lastScrollTop && currentScrollTop > 100) {
      // Scrolling down and past initial 100px
      this.isMobileButtonVisible = false;
    } else if (currentScrollTop < this.lastScrollTop) {
      // Scrolling up
      this.isMobileButtonVisible = true;
    }
    
    this.lastScrollTop = currentScrollTop;
  }

  openModal(type: string): void {
    this.activeModal = type;
    this.isFabOpen = false; // Close FAB when modal opens
    
    // Update slider styles after modal renders
    setTimeout(() => {
      this.updateSliderStyles();
    }, 50);
  }

  closeModal(): void {
    this.activeModal = null;
  }

  getModalTitle(): string {
    switch (this.activeModal) {
      case 'rental': return $localize`:@@rentorbuy.rentalOption:Rental Option`;
      case 'property': return $localize`:@@rentorbuy.propertyDetails:Property Details`;
      case 'loan': return $localize`:@@rentorbuy.loanDetails:Loan Details`;
      case 'economic': return $localize`:@@rentorbuy.economicFactors:Economic Factors`;
      default: return '';
    }
  }

  // Chart Info Modal
  activeChartInfo: string | null = null;

  openChartInfoModal(chartType: string): void {
    this.activeChartInfo = chartType;
  }

  closeChartInfoModal(): void {
    this.activeChartInfo = null;
  }

  getChartInfoTitle(): string {
    switch (this.activeChartInfo) {
      case 'npv': return $localize`:@@rentorbuy.npvChart:Net Present Value (NPV)`;
      case 'networth': return $localize`:@@rentorbuy.buyNetWorthVsStockChart:Buy House vs Invest in Stock Net Worth`;
      case 'cashflow': return $localize`:@@rentorbuy.annualCashflowChart:Annual Cashflow Comparison`;
      case 'irr': return $localize`:@@rentorbuy.irrChart:Internal Rate of Return (IRR)`;
      default: return '';
    }
  }
  
  // Tutorial methods
  openTutorial(): void {
    this.isTutorialOpen = true;
    this.tutorialStep = 1;
    this.resetTutorialData();
  }
  
  closeTutorial(): void {
    this.isTutorialOpen = false;
    this.tutorialStep = 1;
  }
  
  nextTutorialStep(): void {
    if (this.tutorialStep < 3) {
      this.tutorialStep++;
    }
  }
  
  previousTutorialStep(): void {
    if (this.tutorialStep > 1) {
      this.tutorialStep--;
    }
  }
  
  completeTutorial(): void {
    // Apply tutorial data to the main form
    this.rent.monthlyRent = this.tutorialData.monthlyRent;
    
    // Allocate property price: 3500万円 to house, rest to land
    const propertyPrice = this.tutorialData.housePrice;
    this.buy.housePrice = 3500; // Fixed house price
    this.buy.landPrice = propertyPrice - 3500; // Remaining amount goes to land
    
    if (this.tutorialData.hasLoan) {
      this.loan.loanPeriod = this.tutorialData.loanPeriod;
      this.loan.loanRate = this.tutorialData.loanRate;
      this.loan.upfrontAmount = this.tutorialData.downPayment;
    } else {
      // If no loan, set upfront amount to 100%
      this.loan.upfrontAmount = 100;
    }
    
    if (this.tutorialData.hasInvestment) {
      this.macro.opportunityCost = this.tutorialData.investmentReturn;
    } else {
      this.macro.opportunityCost = 0;
    }
    
    // Trigger calculation
    this.onFormChange();
    
    // Close tutorial
    this.closeTutorial();
    
    // Close intro box
    this.closeIntroBox();
  }
  
  private resetTutorialData(): void {
    this.tutorialData = {
      monthlyRent: 20,
      housePrice: 7000,
      hasLoan: true,
      downPayment: 20,
      loanRate: 1.5,
      loanPeriod: 35,
      hasInvestment: true,
      investmentReturn: 7
    };
    
    // Ensure smooth initial state for animations
    setTimeout(() => {
      // This ensures the conditional fields start in the correct state
      this.tutorialData = { ...this.tutorialData };
    }, 100);
  }
}