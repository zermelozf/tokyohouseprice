import { Component, OnInit, AfterViewInit, ViewChild, ElementRef, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { trigger, state, style, transition, animate } from '@angular/animations';
import { TokyoMapComponent } from '../tokyo-map/tokyo-map.component';
import { DepreciationGraphComponent } from '../depreciation-graph/depreciation-graph.component';
import { FloorRatioChartComponent } from '../floor-ratio-chart/floor-ratio-chart.component';
import { BuildingRatioChartComponent } from '../building-ratio-chart/building-ratio-chart.component';
import { LandShapeChartComponent } from '../land-shape-chart/land-shape-chart.component';
import { LandOrientationChartComponent } from '../land-orientation-chart/land-orientation-chart.component';
import { WalkingTimeChartComponent } from '../walking-time-chart/walking-time-chart.component';
import { LandValueEvolutionChartComponent } from '../land-value-evolution-chart/land-value-evolution-chart.component';
import { ModelScoresHistogramComponent } from '../model-scores-histogram/model-scores-histogram.component';
import { ImportanceChartComponent } from '../importance-chart/importance-chart.component';
import { CommentsComponent } from '../comments/comments.component';
import { AnalyticsService } from '../../services/analytics.service';

// Add MathJax type declarations
declare global {
  interface Window {
    MathJax?: {
      tex?: {
        inlineMath: string[][];
        displayMath: string[][];
        processEscapes: boolean;
      };
      options?: {
        skipHtmlTags: string[];
      };
      typeset: (elements: Element[]) => void;
    };
  }
}

declare const MathJax: any;

@Component({
  selector: 'app-house-price-article',
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    TokyoMapComponent,
    DepreciationGraphComponent,
    FloorRatioChartComponent,
    BuildingRatioChartComponent,
    LandShapeChartComponent,
    LandOrientationChartComponent,
    WalkingTimeChartComponent,
    LandValueEvolutionChartComponent,
    ModelScoresHistogramComponent,
    ImportanceChartComponent,
    CommentsComponent
  ],
  templateUrl: './house-price-article.component.html',
  styleUrls: ['./house-price-article.component.scss'],
  animations: [
    trigger('expandCollapse', [
      state('collapsed', style({
        height: '0',
        opacity: '0',
        overflow: 'hidden',
        padding: '0',
        margin: '0'
      })),
      state('expanded', style({
        height: '*',
        opacity: '1',
        overflow: 'visible',
        padding: '1rem 0',
        margin: '1rem 0'
      })),
      transition('collapsed <=> expanded', [
        animate('300ms ease-in-out')
      ])
    ])
  ]
})
export class HousePriceArticleComponent implements OnInit, AfterViewInit {
  @ViewChild('formulaContainer') formulaContainer!: ElementRef;
  @ViewChild('mainFormulaContainer') mainFormulaContainer!: ElementRef;
  @ViewChild('houseFormulaContainer') houseFormulaContainer!: ElementRef;
  @ViewChild('landFormulaContainer') landFormulaContainer!: ElementRef;
  @ViewChild('articleContainer') articleContainer!: ElementRef;
  @ViewChild('insightBox') insightBox!: ElementRef;
  @ViewChild('depreciation') depreciationSection!: ElementRef;

  showTechnicalDetails = false;

  constructor(private analyticsService: AnalyticsService) {}

  toggleTechnicalDetails() {
    this.showTechnicalDetails = !this.showTechnicalDetails;
    this.analyticsService.logTechnicalDetailsToggle(this.showTechnicalDetails);
    if (this.showTechnicalDetails) {
      // Wait for the animation to complete before initializing MathJax
      setTimeout(() => {
        // Load MathJax script if not already loaded
        if (!document.querySelector('script[src*="mathjax"]')) {
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
          script.async = true;
          script.onload = () => {
            if (window.MathJax) {
              window.MathJax.tex = {
                inlineMath: [['$', '$'], ['\\(', '\\)']],
                displayMath: [['$$', '$$'], ['\\[', '\\]']],
                processEscapes: true
              };
              window.MathJax.options = {
                skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre']
              };
              this.renderFormulas();
            }
          };
          document.head.appendChild(script);
        } else {
          // If MathJax is already loaded, just render the formulas
          this.renderFormulas();
        }
      }, 300);
    }
  }

  ngOnInit() {
    // Initialize MathJax
    if (!document.querySelector('script[src*="mathjax"]')) {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
      script.async = true;
      script.onload = () => {
        if (window.MathJax) {
          window.MathJax.tex = {
            inlineMath: [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']],
            processEscapes: true
          };
          window.MathJax.options = {
            skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre']
          };
          this.renderFormulas();
        }
      };
      document.head.appendChild(script);
    }
  }

  ngAfterViewInit() {
    // No need for positioning logic anymore
  }

  private renderFormulas() {
    if (!window.MathJax) return;

    // Render main formula
    if (this.formulaContainer) {
      this.formulaContainer.nativeElement.textContent = `$$
      \\begin{align}
      y =&  \\space \\text{P}(\\text{house}) + \\text{P}(\\text{land})
      \\end{align}
      $$`;
    }

    // Render main formula (simpler version)
    if (this.mainFormulaContainer) {
      this.mainFormulaContainer.nativeElement.textContent = `$$y = \\text{P}(\\text{house}) + \\text{P}(\\text{land})$$`;
    }

    // Render house price formula
    if (this.houseFormulaContainer) {
      this.houseFormulaContainer.nativeElement.textContent = `$$
      \\begin{align}
      \\text{P}(\\text{house}) =& \\Big[\\sum_{m \\in \\text{material}}\\Big(\\alpha^1_m - \\alpha_m^2 \\cdot \\text{age} \\Big) + \\sum_{y \\in \\text{year}}\\alpha_y \\Big] \\cdot m^2_h
      \\end{align}
      $$`;
    }

    // Render land price formula
    if (this.landFormulaContainer) {
      this.landFormulaContainer.nativeElement.textContent = `$$
      \\begin{align}
      \\text{P}(\\text{land}) =& \\Big[\\sum_{t\\in{\\text{type}}}\\beta_t + \\sum_{c \\in \\text{city}}\\beta_{c} + \\sum_{o \\in \\text{orient}}\\beta_o + \\sum_{s \\in \\text{shape}}\\beta_s + \\sum_{y \\in \\text{year}}\\beta_y \\Big] \\cdot m^2_l.
      \\end{align}
      $$`;
    }

    // Tell MathJax to typeset all formulas
    setTimeout(() => {
      if (window.MathJax?.typeset) {
        // Process all formula containers
        const formulaElements = [
          this.formulaContainer?.nativeElement,
          this.mainFormulaContainer?.nativeElement,
          this.houseFormulaContainer?.nativeElement,
          this.landFormulaContainer?.nativeElement
        ].filter(el => el != null);
        
        if (formulaElements.length > 0) {
          window.MathJax.typeset(formulaElements);
        }
        
        // Process all inline math elements
        const mathElements = document.querySelectorAll('.math');
        if (mathElements.length > 0) {
          window.MathJax.typeset(Array.from(mathElements));
        }
      }
    }, 100);
  }

  @HostListener('click', ['$event'])
  onAnchorClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const anchor = target.closest('a');
    
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href?.startsWith('#')) {
        event.preventDefault();
        const targetId = href.substring(1);
        const targetElement = document.getElementById(targetId);
        
        if (targetElement) {
          targetElement.scrollIntoView({ 
            behavior: 'smooth',
            block: 'start'
          });
        }
      }
    }
  }

  // Data for the depreciation graph
  readonly depreciationData = {
    wooden: [
      { age: 0, value: 100 },
      { age: 10, value: 70 },
      { age: 20, value: 50 },
      { age: 30, value: 35 },
      { age: 40, value: 25 },
      { age: 50, value: 15 }
    ],
    concrete: [
      { age: 0, value: 100 },
      { age: 10, value: 85 },
      { age: 20, value: 75 },
      { age: 30, value: 65 },
      { age: 40, value: 55 },
      { age: 50, value: 45 }
    ],
    steel: [
      { age: 0, value: 100 },
      { age: 10, value: 80 },
      { age: 20, value: 65 },
      { age: 30, value: 55 },
      { age: 40, value: 45 },
      { age: 50, value: 35 }
    ]
  };

  // Data for the location impact graph
  readonly locationImpactData = {
    labels: ['Central Tokyo', 'Suburban Tokyo', 'Outer Tokyo'],
    values: [150, 100, 70]
  };

  // Data for the land characteristics impact
  readonly landCharacteristicsData = {
    size: [
      { size: 50, value: 80 },
      { size: 100, value: 100 },
      { size: 150, value: 120 },
      { size: 200, value: 140 }
    ],
    orientation: {
      north: 90,
      east: 100,
      south: 110,
      west: 95
    }
  };
} 