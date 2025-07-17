import { Component, OnInit, HostListener, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RentVsBuyChartComponent } from '../rent-vs-buy-chart/rent-vs-buy-chart.component';
import { PvBuyChartComponent } from '../pv-buy-chart/pv-buy-chart.component';
import { CashflowChartComponent } from '../cashflow-chart/cashflow-chart.component';
import { CumulativeDifferenceChartComponent } from '../cumulative-difference-chart/cumulative-difference-chart.component';
import { IrrChartComponent } from '../irr-chart/irr-chart.component';
import { RentBuyCalculatorService } from '../../services/rent-buy-calculator.service';
import { NewsletterService } from '../../services/newsletter.service';

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
  selector: 'app-rent-or-buy-article',
  standalone: true,
  imports: [CommonModule, FormsModule, RentVsBuyChartComponent, PvBuyChartComponent, CashflowChartComponent, CumulativeDifferenceChartComponent, IrrChartComponent],
  templateUrl: './rent-or-buy-article.component.html',
  styleUrls: ['./rent-or-buy-article.component.scss']
})
export class RentOrBuyArticleComponent implements OnInit, AfterViewInit {
  breakevenYear: number = 11; // Default fallback
  simulationYears: number = 25;
  costs: number = 0.02;
  fees: number = 0.10;
  mortgageRate: number = 0.0125;
  downPaymentRatio: number = 0.2;
  loanYears: number = 20;
  opportunityCost: number = 0.045;
  rentYield: number = 0.01;
  isNewsletterClosed: boolean = false;
  
  // Newsletter form properties
  newsletterEmail: string = '';
  isNewsletterSubmitting: boolean = false;
  newsletterMessage: string = '';
  newsletterMessageType: 'success' | 'error' | '' = '';

  constructor(
    private calculator: RentBuyCalculatorService,
    private newsletterService: NewsletterService
  ) {
    this.simulationYears = this.calculator.simumlationYears;
    this.costs = this.calculator.maintenanceCost + this.calculator.propertyTaxRate * 0.7;
    this.fees = this.calculator.transactionCosts * 2;
    this.mortgageRate = this.calculator.mortgageRate;
    this.downPaymentRatio = this.calculator.downPaymentRatio;
    this.loanYears = this.calculator.mortgageYears;
    this.opportunityCost = this.calculator.opportunityCost;
    this.rentYield = this.calculator.monthlyRent / this.calculator.buyPrice * 12;
  }

  ngOnInit() {
    this.breakevenYear = this.calculateBreakevenYear();
    
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
    } else {
      // MathJax is already loaded, just render formulas
      setTimeout(() => this.renderFormulas(), 100);
    }
  }

  ngAfterViewInit() {
    // Ensure MathJax renders after the view is initialized
    setTimeout(() => this.renderFormulas(), 200);
  }

  private renderFormulas() {
    if (!window.MathJax) return;

    // Tell MathJax to typeset all formulas in the document
    setTimeout(() => {
      if (window.MathJax?.typeset) {
        // Process all math elements in the component
        const articleElement = document.querySelector('app-rent-or-buy-article');
        if (articleElement) {
          window.MathJax.typeset([articleElement]);
        } else {
          // Fallback: process all math elements in document
          const mathElements = document.querySelectorAll('.math, [class*="formula"], mjx-container');
          if (mathElements.length > 0) {
            window.MathJax.typeset(Array.from(mathElements));
          } else {
            // Last resort: process body element
            window.MathJax.typeset([document.body]);
          }
        }
      }
    }, 100);
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

  closeNewsletter() {
    this.isNewsletterClosed = true;
  }

  onNewsletterSubmit() {
    if (!this.newsletterEmail || this.isNewsletterSubmitting) {
      return;
    }

    this.isNewsletterSubmitting = true;
    this.newsletterMessage = '';
    this.newsletterMessageType = '';

    this.newsletterService.subscribe(this.newsletterEmail, 'rent-or-buy-article').subscribe({
      next: (message) => {
        this.newsletterMessage = message;
        this.newsletterMessageType = 'success';
        this.newsletterEmail = ''; // Clear the form
        this.isNewsletterSubmitting = false;
        
        // Auto-hide success message after 5 seconds
        setTimeout(() => {
          this.newsletterMessage = '';
          this.newsletterMessageType = '';
        }, 5000);
      },
      error: (error) => {
        this.newsletterMessage = error.message;
        this.newsletterMessageType = 'error';
        this.isNewsletterSubmitting = false;
        
        // Auto-hide error message after 8 seconds
        setTimeout(() => {
          this.newsletterMessage = '';
          this.newsletterMessageType = '';
        }, 8000);
      }
    });
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
} 