import { Routes } from '@angular/router';
import { PriceCalculatorComponent } from './components/price-calculator/price-calculator.component';
import { TokyoMapComponent } from './components/tokyo-map/tokyo-map.component';
import { HousePriceArticleComponent } from './components/house-price-article/house-price-article.component';
import { NakanoMapComponent } from './components/nakano-map/nakano-map.component';
import { RentOrBuyComponent } from './components/rent-or-buy/rent-or-buy.component';

// Define shared routes that will be used for both languages
const sharedRoutes: Routes = [
  { path: '', component: PriceCalculatorComponent },
  { path: 'map', component: TokyoMapComponent },
  { path: 'nakano', component: NakanoMapComponent },
  { path: 'article', component: HousePriceArticleComponent },
  { path: 'story', component: HousePriceArticleComponent },
  { path: 'rentorbuy', component: RentOrBuyComponent },
];

export const routes: Routes = [
  // Default routes (English)
  ...sharedRoutes,
  
  // Japanese localized routes
  {
    path: 'ja',
    children: sharedRoutes
  },
  
  // English localized routes (explicit)
  {
    path: 'en-US',
    children: sharedRoutes
  },
  
  // Wildcard route
  { path: '**', redirectTo: '' }
]; 