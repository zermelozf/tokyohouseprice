import { Component, OnInit, AfterViewInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Chart,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartConfiguration,
  TooltipItem
} from 'chart.js';
import { RentBuyCalculatorService, RentBuyData } from '../../services/rent-buy-calculator.service';

// Register Chart.js components
Chart.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface DifferenceData {
  year: number;
  difference: number;
}

@Component({
  selector: 'app-cumulative-difference-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="chart-wrapper">
      <div class="graph-container">
        <canvas #chartCanvas></canvas>
      </div>
      <div class="figure-caption">
        <p i18n="@@chart.cumulativeDifferenceFigureCaption">
          <span class="figure-label">Figure:</span> 
          The difference between cumulative cash flows clearly shows the breakeven point where buying 
          becomes financially advantageous over renting. Positive values indicate that buying results 
          in better financial outcomes, while negative values favor renting. The steeper positive slope 
          after year 35 reflects the elimination of mortgage payments.
        </p>
      </div>
    </div>
  `,
  styles: [`
    .chart-wrapper {
      margin: 2rem 0;
    }
    .graph-container {
      width: 100%;
      height: 400px;
      margin-bottom: 1rem;
    }
    .figure-caption {
      margin: 1rem 2rem 2rem 2rem;
      text-align: justify;
    }
    .figure-caption p {
      margin: 0;
      font-size: 0.9rem;
      line-height: 1.6;
      color: #333;
      font-family: 'Times New Roman', Times, serif;
    }
    .figure-label {
      font-weight: bold;
      font-style: italic;
    }
  `]
})
export class CumulativeDifferenceChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas', { static: true }) chartCanvas!: ElementRef<HTMLCanvasElement>;

  private chart: Chart | null = null;
  private data: DifferenceData[] = [];

  constructor(private calculator: RentBuyCalculatorService) { }

  ngOnInit() {
    this.calculateData();
  }

  ngAfterViewInit() {
    this.createChart();
  }

  private calculateData() {
    // Calculate cumulative difference data using base service functions
    this.data = [];

    for (let year = 0; year <= 25; year++) {

      // Get cashflows and calculate cumulative totals
      const rentCashflows = this.calculator.getRentCashflow(year);
      const buyCashflows = this.calculator.getBuyCashflow(year);

      const vRent = rentCashflows.reduce((sum, cf) => sum + cf, 0);
      const vBuy = buyCashflows.reduce((sum, cf) => sum + cf, 0);
      const difference = vBuy - vRent; // Buy - Rent

      this.data.push({
        year,
        difference
      });
    }
  }

  private createChart() {
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const labels = this.data.map(d => d.year.toString());
    const differenceData = this.data.map(d => d.difference / 1_000_000); // Convert to millions

    // Create datasets for positive and negative areas
    const positiveData = differenceData.map(val => val >= 0 ? val : null);
    const negativeData = differenceData.map(val => val < 0 ? val : null);

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: $localize`:@@chart.buyingIsBetter:Buying is Better`,
            data: positiveData,
            borderColor: '#4ecdc4',
            backgroundColor: 'rgba(78, 205, 196, 0.3)',
            borderWidth: 3,
            pointBackgroundColor: '#4ecdc4',
            pointBorderColor: '#4ecdc4',
            pointRadius: 2,
            pointHoverRadius: 6,
            tension: 0.4,
            fill: 'origin',
            spanGaps: false
          },
          {
            label: $localize`:@@chart.rentingIsBetter:Renting is Better`,
            data: negativeData,
            borderColor: '#ff6b6b',
            backgroundColor: 'rgba(255, 107, 107, 0.3)',
            borderWidth: 3,
            pointBackgroundColor: '#ff6b6b',
            pointBorderColor: '#ff6b6b',
            pointRadius: 2,
            pointHoverRadius: 6,
            tension: 0.4,
            fill: 'origin',
            spanGaps: false
          },
          {
            label: $localize`:@@chart.buyRentDifference:Buy - Rent Difference`,
            data: differenceData,
            borderColor: '#333',
            borderWidth: 2,
            pointBackgroundColor: '#333',
            pointBorderColor: '#333',
            pointRadius: 1,
            pointHoverRadius: 4,
            tension: 0.4,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: 'index'
        },
        plugins: {
          title: {
            display: true,
            text: $localize`:@@chart.cumulativeCashFlowDifferenceTitle:Cumulative Cash Flow Difference: Buy vs Rent`,
            font: {
              size: 16
            }
          },
          legend: {
            display: true,
            position: 'top',
            labels: {
              filter: function (legendItem: any, chartData: any) {
                return legendItem.text !== $localize`:@@chart.buyRentDifference:Buy - Rent Difference`;
              }
            }
          },
          tooltip: {
            mode: 'index',
            intersect: false,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: 'white',
            bodyColor: 'white',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            callbacks: {
              title: (context: TooltipItem<'line'>[]) => {
                return `Year ${context[0].label}`;
              },
              label: (context: TooltipItem<'line'>) => {
                const value = context.parsed.y;
                const interpretation = value > 0 ? 
                  $localize`:@@chart.differenceInterpretation:Difference: ¥M (Buying is better)` :
                  $localize`:@@chart.differenceInterpretationRent:Difference: ¥M (Renting is better)`;
                return interpretation.replace('¥M', `¥${value.toFixed(1)}M`);
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: $localize`:@@chart.years:Years`
            },
            grid: {
              color: '#e0e0e0'
            }
          },
          y: {
            title: {
              display: true,
              text: $localize`:@@chart.cumulativeDifferenceYenMillions:Cumulative Difference (¥ millions)`
            },
            grid: {
              color: '#e0e0e0'
            },
            ticks: {
              callback: function (value) {
                return `¥${value}M`;
              }
            }
          }
        }
      }
    };

    this.chart = new Chart(ctx, config);
  }

  ngOnDestroy() {
    if (this.chart) {
      this.chart.destroy();
    }
  }
} 