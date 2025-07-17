import { Component, OnInit, AfterViewInit, OnDestroy, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  Chart,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ChartConfiguration,
  TooltipItem
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { RentBuyCalculatorService } from '../../services/rent-buy-calculator.service';

// Register Chart.js components
Chart.register(
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  annotationPlugin
);

interface CashFlowData {
  year: number;
  rentCashFlow: number;
  buyCashFlow: number;
}

@Component({
  selector: 'app-cashflow-chart',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="chart-wrapper">
      <div class="graph-container">
        <canvas #chartCanvas></canvas>
      </div>
      <div class="figure-caption">
        <p>
          <span class="figure-label">Figure:</span> 
          Annual cash flows show the yearly financial impact of each option. 
          The rent option shows consistent annual payments of ¥5.16M per year.
          The buy option shows higher initial costs due to the down payment (year 0), 
          annual operating costs including mortgage payments (years 1-20), then reduced costs 
          after mortgage payoff (years 21-24), and positive cash flow in year 25 from property 
          sale proceeds. The grey dashed line indicates when the mortgage is fully paid off.
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
    .figure-title {
      font-weight: bold;
    }
  `]
})
export class CashflowChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas', { static: true }) chartCanvas!: ElementRef<HTMLCanvasElement>;

  private chart: Chart | null = null;
  private data: CashFlowData[] = [];

  constructor(private calculator: RentBuyCalculatorService) {}

  ngOnInit() {
    this.calculateData();
  }

  ngAfterViewInit() {
    this.createChart();
  }

  private calculateData() {
    const maxYears = 25;
    
    // Get cashflows from the service - use version with sale proceeds for realistic annual cashflows
    const rentCashFlow= this.calculator.getRentCashflow(maxYears);
    const buyCashFlow = this.calculator.getBuyCashflow(maxYears);

    // Convert the cashflow arrays to annual data for the chart
    for (let year = 0; year <= maxYears; year++) {
      this.data.push({
        year,
        rentCashFlow: rentCashFlow[year],
        buyCashFlow: buyCashFlow[year]
      });
    }
  }

  private createChart() {
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const labels = this.data.map(d => d.year.toString());
    const rentData = this.data.map(d => d.rentCashFlow / 1_000_000); // Convert to millions
    const buyData = this.data.map(d => d.buyCashFlow / 1_000_000); // Convert to millions



    const config: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Rent Cash Flow',
            data: rentData,
            backgroundColor: 'rgba(255, 107, 107, 0.7)',
            borderColor: '#ff6b6b',
            borderWidth: 1
          },
          {
            label: 'Buy Cash Flow',
            data: buyData,
            backgroundColor: 'rgba(78, 205, 196, 0.7)',
            borderColor: '#4ecdc4',
            borderWidth: 1
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
            text: 'Annual Cash Flows: Rent vs Buy',
            font: {
              size: 16
            }
          },
          legend: {
            display: true,
            position: 'top'
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
              title: (context: TooltipItem<'bar'>[]) => {
                const year = context[0].label;
                const yearNum = parseInt(year);
                if (year === '0') return 'Initial Year';
                if (year === '25') return 'Sale Year (25)';
                if (yearNum === 20) return `Year ${year} (Last mortgage payment)`;
                if (yearNum === 21) return `Year ${year} (Mortgage paid off)`;
                return `Year ${year}`;
              },
              label: (context: TooltipItem<'bar'>) => {
                const value = context.parsed.y;
                const label = context.dataset.label;
                const year = parseInt(context.label || '0');
                
                if (context.label === '25' && label?.includes('Buy')) {
                  return `${label} (incl. sale): ¥${value.toFixed(1)}M`;
                }
                if (label?.includes('Buy') && year > 20 && year < 25) {
                  return `${label} (no mortgage): ¥${value.toFixed(1)}M`;
                }
                return `${label}: ¥${value.toFixed(1)}M`;
              },
              afterBody: (context: TooltipItem<'bar'>[]) => {
                const year = parseInt(context[0].label || '0');
                if (year === 20) {
                  return 'Final mortgage payment made';
                }
                if (year === 21) {
                  return 'Only property tax & maintenance from now on';
                }
                return '';
              }
            }
          },
          annotation: {
            annotations: {
              mortgagePayoff: {
                type: 'line',
                scaleID: 'x',
                value: '20',
                borderColor: '#888888',
                borderWidth: 2,
                borderDash: [6, 4],
                label: {
                  display: true,
                  content: 'Mortgage Paid Off',
                  position: 'center',
                  backgroundColor: 'rgba(136, 136, 136, 0.8)',
                  color: 'white',
                  font: {
                    size: 11,
                    weight: 'normal'
                  },
                  padding: 4,
                  borderRadius: 3,
                  yAdjust: -30
                }
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Year'
            },
            grid: {
              color: '#e0e0e0'
            }
          },
          y: {
            title: {
              display: true,
              text: 'Cash Flow (¥ millions)'
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