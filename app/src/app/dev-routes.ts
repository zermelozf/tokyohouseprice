import { Routes } from '@angular/router';

// Local-only SUUMO scraper dashboard. This file is swapped for dev-routes.prod.ts
// via angular.json `fileReplacements` in the deploy configs, so the scraper page
// and its code are excluded from the production/localized builds entirely.
export const devRoutes: Routes = [
  {
    path: 'scraper',
    loadComponent: () => import('./components/scraper-dashboard/scraper-dashboard.component')
      .then(m => m.ScraperDashboardComponent),
  },
];
