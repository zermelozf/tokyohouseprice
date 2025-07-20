import { Injectable } from '@angular/core';
import { Analytics, logEvent } from '@angular/fire/analytics';

@Injectable({
  providedIn: 'root'
})
export class AnalyticsService {
  constructor(private analytics: Analytics) {}

  logTechnicalDetailsToggle(showTechnicalDetails: boolean) {
    logEvent(this.analytics, 'technical_details_toggle', {
      show_technical_details: showTechnicalDetails
    });
  }

  logPriceCalculation(propertyType: string, ward: string, totalPrice: number) {
    logEvent(this.analytics, 'price_calculation', {
      property_type: propertyType,
      ward: ward,
      total_price: totalPrice
    });
  }

  logPageView(pageName: string) {
    logEvent(this.analytics, 'page_view', {
      page_name: pageName
    });
  }

  logShareFromAdviceBox() {
    logEvent(this.analytics, 'share_from_advice_box', {
      source: 'optimal_strategy_header'
    });
  }

  logShareFromShareBox() {
    logEvent(this.analytics, 'share_from_share_box', {
      source: 'dedicated_share_section'
    });
  }

  logInputChange(inputName: string, inputValue: string | number) {
    logEvent(this.analytics, 'input_changed', {
      input_name: inputName,
      input_value: inputValue.toString(),
      timestamp: new Date().toISOString()
    });
  }

  logPriceCalculatorShare() {
    logEvent(this.analytics, 'share_price_calculator', {
      source: 'price_calculator_results'
    });
  }
} 