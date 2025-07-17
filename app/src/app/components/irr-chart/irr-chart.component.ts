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
  ChartConfiguration,
  ChartOptions,
  TooltipItem
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { RentBuyCalculatorService, IRRData } from '../../services/rent-buy-calculator.service';

// Register Chart.js components
Chart.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  annotationPlugin
);

@Component({
  selector: 'app-irr-chart',
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
          The Internal Rate of Return (IRR) represents the annualized return rate of the buy vs rent investment 
          over different holding periods. Higher IRR values indicate better investment performance.
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
export class IrrChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas', { static: true }) chartCanvas!: ElementRef<HTMLCanvasElement>;

  private chart: Chart | null = null;
  private data: IRRData[] = [];

  constructor(private calculator: RentBuyCalculatorService) {}

  ngOnInit() {
    this.calculateData();
  }

  ngAfterViewInit() {
    this.createChart();
  }

  ngOnDestroy() {
    if (this.chart) {
      this.chart.destroy();
    }
  }

  private calculateData() {
    // Calculate IRR data using base service functions
    this.data = [];
    const simulationYears = this.calculator.simumlationYears;
    
    for (let year = 0; year <= simulationYears; year++) {
      const rentCashFlow = this.calculator.getRentCashflow(year);
      const buyCashFlow = this.calculator.getBuyCashflow(year);
      const diffCashflows = [];
      for (let i = 0; i<=year; i++) {
        diffCashflows.push(buyCashFlow[i] - rentCashFlow[i]);
      }
      const irrValue = this.calculator.irr(diffCashflows);
      
      this.data.push({
        year,
        irr: irrValue
      });
    }
  }

  private createChart() {
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    // Filter out null values for display
    const validData = this.data.filter(d => d.irr !== null);
    const labels = validData.map(d => d.year.toString());
    const irrValues = validData.map(d => (d.irr as number) * 100); // Convert to percentage

    // Find maximum IRR value and its index
    const maxIRR = Math.max(...irrValues);
    const maxIRRIndex = irrValues.indexOf(maxIRR);
    const maxIRRYear = validData[maxIRRIndex].year;

    // Calculate reference lines
    const opportunityCostPercent = this.calculator.opportunityCost * 100;
    const annualRent = 430_000 * 12; // Monthly rent * 12
    const buyPrice = 99_700_000;
    const propertyTaxRate = 0.014;
    const maintenanceCost = 0.01;
    const rentalYieldPercent = ((annualRent / buyPrice) - ((propertyTaxRate * 0.7) + maintenanceCost)) * 100;

    // Create point colors array - highlight max IRR point
    const pointColors = irrValues.map((_, index) => 
      index === maxIRRIndex ? '#e74c3c' : '#9b59b6'
    );
    const pointRadii = irrValues.map((_, index) => 
      index === maxIRRIndex ? 6 : 3
    );

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'IRR (%)',
            data: irrValues,
            borderColor: '#9b59b6',
            borderWidth: 3,
            pointBackgroundColor: pointColors,
            pointBorderColor: pointColors,
            pointRadius: pointRadii,
            pointHoverRadius: 8,
            tension: 0.4,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: {
              display: true,
              text: 'Holding Period (Years)',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            grid: {
              color: 'rgba(0, 0, 0, 0.1)'
            }
          },
          y: {
            title: {
              display: true,
              text: 'Internal Rate of Return (%)',
              font: {
                size: 14,
                weight: 'bold'
              }
            },
            min: 0,
            grid: {
              color: 'rgba(0, 0, 0, 0.1)'
            },
            ticks: {
              callback: function(value) {
                return value + '%';
              }
            }
          }
        },
        plugins: {
          legend: {
            display: false
          },
          title: {
            display: true,
            text: `Maximum IRR: ${maxIRR.toFixed(2)}% (Year ${maxIRRYear})`,
            font: {
              size: 16,
              weight: 'bold'
            },
            color: '#2c3e50',
            padding: {
              top: 10,
              bottom: 20
            }
          },
          tooltip: {
            mode: 'nearest',
            intersect: false,
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: 'white',
            bodyColor: 'white',
            borderColor: '#9b59b6',
            borderWidth: 1,
            callbacks: {
              label: function(context: TooltipItem<'line'>) {
                const value = context.parsed.y;
                const isMax = context.dataIndex === maxIRRIndex;
                return isMax ? 
                  `IRR: ${value.toFixed(2)}% (Maximum)` : 
                  `IRR: ${value.toFixed(2)}%`;
              }
            }
          },
          annotation: {
            annotations: {
              maxLine: {
                type: 'line',
                xMin: maxIRRYear.toString(),
                xMax: maxIRRYear.toString(),
                borderColor: '#e74c3c',
                borderWidth: 2,
                borderDash: [5, 5],
                label: {
                  display: true,
                  content: `Optimal: Year ${maxIRRYear}`,
                  position: 'start',
                  backgroundColor: 'rgba(231, 76, 60, 0.8)',
                  color: 'white',
                  font: {
                    size: 12,
                    weight: 'bold'
                  },
                  padding: 4,
                  borderRadius: 4
                }
              },
              opportunityCostLine: {
                type: 'line',
                yMin: opportunityCostPercent,
                yMax: opportunityCostPercent,
                borderColor: 'rgba(128, 128, 128, 0.4)',
                borderWidth: 2,
                borderDash: [4, 4],
                label: {
                  display: true,
                  content: `Opportunity Cost: ${opportunityCostPercent.toFixed(1)}%`,
                  position: 'end',
                  yAdjust: -15,
                  backgroundColor: 'rgba(128, 128, 128, 0.1)',
                  color: '#666666',
                  font: {
                    size: 10
                  },
                  padding: 2,
                  borderRadius: 2
                }
              },
              rentalYieldLine: {
                type: 'line',
                yMin: rentalYieldPercent,
                yMax: rentalYieldPercent,
                borderColor: 'rgba(128, 128, 128, 0.4)',
                borderWidth: 2,
                borderDash: [4, 4],
                label: {
                  display: true,
                  content: `Long Term Yield: ${rentalYieldPercent.toFixed(1)}%`,
                  position: 'end',
                  yAdjust: -15,
                  backgroundColor: 'rgba(128, 128, 128, 0.1)',
                  color: '#666666',
                  font: {
                    size: 10
                  },
                  padding: 2,
                  borderRadius: 2
                }
              }
            }
          }
        },
        interaction: {
          mode: 'nearest',
          intersect: false
        }
      }
    };

    this.chart = new Chart(ctx, config);
  }
} 