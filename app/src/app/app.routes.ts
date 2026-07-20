import { Routes } from '@angular/router';
import { PriceCalculatorComponent } from './components/price-calculator/price-calculator.component';
import { TokyoMapComponent } from './components/tokyo-map/tokyo-map.component';
import { HousePriceArticleComponent } from './components/house-price-article/house-price-article.component';
import { NakanoMapComponent } from './components/nakano-map/nakano-map.component';
import { RentOrBuyComponent } from './components/rent-or-buy/rent-or-buy.component';
import { RentOrBuyArticleComponent } from './components/rent-or-buy-article/rent-or-buy-article.component';
// Local-only SUUMO scraper route. Replaced with an empty array in deploy builds
// via angular.json `fileReplacements` (see dev-routes.prod.ts).
import { devRoutes } from './dev-routes';

// Define shared routes that will be used for both languages
const sharedRoutes: Routes = [
  { path: '', component: PriceCalculatorComponent },
  { path: 'calculator', component: PriceCalculatorComponent },
  { path: 'map', component: TokyoMapComponent },
  { path: 'nakano', component: NakanoMapComponent },
  { path: 'article', component: HousePriceArticleComponent },
  { path: 'story', component: HousePriceArticleComponent },
  { path: 'rentorbuy', component: RentOrBuyComponent },
  { path: 'rent-or-buy-analysis', component: RentOrBuyArticleComponent },
];

export const routes: Routes = [
  // Default routes (English)
  ...sharedRoutes,

  // Local-only dev tool (empty in production)
  ...devRoutes,

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