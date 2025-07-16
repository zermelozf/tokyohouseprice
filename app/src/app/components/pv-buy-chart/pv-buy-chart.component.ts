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
    ChartOptions,
    TooltipItem
} from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { RentBuyCalculatorService } from '../../services/rent-buy-calculator.service';

// Register Chart.js components
Chart.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend,
    Filler,
    annotationPlugin
);

interface DataPoint {
    year: number;
    pvDifference: number;
}

@Component({
    selector: 'app-pv-buy-chart',
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
          The present value advantage shows when buying becomes financially superior to renting
          in net present value terms. Positive values indicate buying is better, while negative 
          values favor renting. The analysis accounts for the time value of money at a 5% discount rate,
          revealing the optimal holding periods for real estate investment. The blue point and grey vertical 
          line highlight the maximum present value advantage and its corresponding optimal holding period.
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
export class PvBuyChartComponent implements OnInit, AfterViewInit, OnDestroy {
    @ViewChild('chartCanvas', { static: true }) chartCanvas!: ElementRef<HTMLCanvasElement>;

    private chart: Chart | null = null;
    private data: DataPoint[] = [];

    constructor(private calculator: RentBuyCalculatorService) { }

    ngOnInit() {
        this.calculateData();
    }

    ngAfterViewInit() {
        this.createChart();
    }

    private calculateData() {
        // Calculate NPV difference using base service functions with 5% discount rate
        const discountRate = 0.05;
        
        for (let year = 0; year <= 25; year++) {
            const rentCashFlow = this.calculator.getRentCashflow(year);
            const buyCashFlow = this.calculator.getBuyCashflow(year);
            const buyPV = this.calculator.npv(buyCashFlow, discountRate);
            const rentPV = this.calculator.npv(rentCashFlow, discountRate);

            this.data.push({
                year,
                pvDifference: buyPV - rentPV
            });
        }
    }

    private createChart() {
        const ctx = this.chartCanvas.nativeElement.getContext('2d');
        if (!ctx) return;

        const labels = this.data.map(d => d.year.toString());
        const differenceData = this.data.map(d => d.pvDifference / 1_000_000); // Convert to millions

        // Find maximum PV difference value and its index
        const maxPV = Math.max(...differenceData);
        const maxPVIndex = differenceData.indexOf(maxPV);
        const maxPVYear = this.data[maxPVIndex].year;

        // Create a separate dataset for the highlighted maximum point
        const maxPointData = differenceData.map((value, index) =>
            index === maxPVIndex ? value : null
        );

        // Create datasets for positive and negative areas
        const positiveData = differenceData.map(val => val >= 0 ? val : null);
        const negativeData = differenceData.map(val => val < 0 ? val : null);

        const config: ChartConfiguration<'line'> = {
            type: 'line',
            data: {
                labels: labels,
                datasets: [
                    {
                        label: 'Buying is Better',
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
                        label: 'Renting is Better',
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
                        label: 'PV Advantage',
                        data: differenceData,
                        borderColor: '#333',
                        borderWidth: 2,
                        pointBackgroundColor: 'transparent',
                        pointBorderColor: 'transparent',
                        pointRadius: 0,
                        pointHoverRadius: 0,
                        tension: 0.4,
                        fill: false
                    },
                    {
                        label: 'Maximum Point',
                        data: maxPointData,
                        borderColor: 'transparent',
                        backgroundColor: 'transparent',
                        pointBackgroundColor: '#4ecdc4',
                        pointBorderColor: '#4ecdc4',
                        pointRadius: 6,
                        pointHoverRadius: 8,
                        showLine: false
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
                        text: `Maximum PV Advantage: ¥${maxPV.toFixed(1)}M (Year ${maxPVYear})`,
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
                    legend: {
                        display: true,
                        position: 'top',
                        labels: {
                            filter: function (legendItem: any, chartData: any) {
                                return legendItem.text !== 'PV Advantage' && legendItem.text !== 'Maximum Point';
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
                                return `Holding Period: ${context[0].label} years`;
                            },
                            label: (context: TooltipItem<'line'>) => {
                                const value = context.parsed.y;
                                const isMax = context.datasetIndex === 3; // Maximum Point dataset is now at index 3
                                return isMax ?
                                    `PV Advantage: ¥${value.toFixed(1)}M (Maximum)` :
                                    `PV Advantage: ¥${value.toFixed(1)}M`;
                            }
                        }
                    },
                    annotation: {
                        annotations: {
                            maxLine: {
                                type: 'line',
                                xMin: maxPVYear.toString(),
                                xMax: maxPVYear.toString(),
                                borderColor: '#777',
                                borderWidth: 2,
                                borderDash: [5, 5],
                                drawTime: 'beforeDatasetsDraw',
                                label: {
                                    display: true,
                                    content: `Optimal: Year ${maxPVYear}`,
                                    position: 'start',
                                    backgroundColor: 'rgba(255, 255, 255, 0.9)',
                                    color: '#777',
                                    font: {
                                        size: 12,
                                        weight: 'bold'
                                    },
                                    padding: 4,
                                    borderRadius: 4
                                }
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: 'Holding Period (years)'
                        },
                        grid: {
                            color: '#e0e0e0'
                        }
                    },
                    y: {
                        title: {
                            display: true,
                            text: 'Present Value (¥ millions)'
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