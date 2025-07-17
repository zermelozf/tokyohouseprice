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
import { RentBuyCalculatorService, RentBuyData } from '../../services/rent-buy-calculator.service';

// Register Chart.js components
Chart.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

@Component({
  selector: 'app-rent-vs-buy-chart',
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
          Cumulative cash flows show the total amount spent over time for each option. 
          The rent option follows a linear path with constant monthly payments, while the buy option 
          shows higher initial costs due to the down payment, followed by a slighly curved path of as 
          the mortgage is paid off on year 35. After that, the slope improves just slighly and stays 
          constant.
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
export class RentVsBuyChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartCanvas', { static: true }) chartCanvas!: ElementRef<HTMLCanvasElement>;

  private chart: Chart | null = null;
  private data: RentBuyData[] = [];

  constructor(private calculator: RentBuyCalculatorService) {}

  ngOnInit() {
    this.calculateData();
  }

  ngAfterViewInit() {
    this.createChart();
  }

  private calculateData() {
    const maxYears = this.calculator.simumlationYears;
    const rentCosts = this.calculator.getRentCosts(maxYears);
    const buyCosts = this.calculator.getBuyCosts(maxYears);

    this.data = [];
    for (let year = 0; year <= maxYears; year++) {

      this.data.push({
        year,
        vRent: rentCosts[year],
        vBuy: buyCosts[year]
      });
    }
  }

  private createChart() {
    const ctx = this.chartCanvas.nativeElement.getContext('2d');
    if (!ctx) return;

    const labels = this.data.map(d => d.year.toString());
    const rentData = this.data.map(d => d.vRent / 1_000_000); // Convert to millions
    const buyData = this.data.map(d => d.vBuy / 1_000_000); // Convert to millions

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels: labels,
        datasets: [
          {
            label: 'Rent Value',
            data: rentData,
            borderColor: '#ff6b6b',
            borderWidth: 3,
            pointBackgroundColor: '#ff6b6b',
            pointBorderColor: '#ff6b6b',
            pointRadius: 2,
            pointHoverRadius: 6,
            tension: 0.4,
            fill: false
          },
          {
            label: 'Buy Value',
            data: buyData,
            borderColor: '#4ecdc4',
            borderWidth: 3,
            pointBackgroundColor: '#4ecdc4',
            pointBorderColor: '#4ecdc4',
            pointRadius: 2,
            pointHoverRadius: 6,
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
            text: 'Cumulative Cash Flows: Value of Rent vs Buy',
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
              title: (context: TooltipItem<'line'>[]) => {
                return `Year ${context[0].label}`;
              },
              label: (context: TooltipItem<'line'>) => {
                const value = context.parsed.y;
                const label = context.dataset.label;
                return `${label}: ¥${value.toFixed(1)}M`;
              },
              afterBody: (context: TooltipItem<'line'>[]) => {
                if (context.length === 2) {
                  const buyValue = context.find(c => c.dataset.label?.includes('Buy'))?.parsed.y || 0;
                  const rentValue = context.find(c => c.dataset.label?.includes('Rent'))?.parsed.y || 0;
                  const difference = buyValue - rentValue;
                  return [`Difference: ¥${difference.toFixed(1)}M`];
                }
                return [];
              }
            }
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: 'Years'
            },
            grid: {
              color: '#e0e0e0'
            }
          },
          y: {
            title: {
              display: true,
              text: 'Cumulative Value (¥ millions)'
            },
            grid: {
              color: '#e0e0e0'
            },
            ticks: {
              callback: function(value) {
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