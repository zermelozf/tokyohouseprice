import { Routes } from '@angular/router';

import { authGuard } from './services/auth.guard';

// Local-only SUUMO scraper dashboard. This file is swapped for dev-routes.prod.ts
// via angular.json `fileReplacements` in the deploy configs, so the scraper page
// and its code are excluded from the production/localized builds entirely.
export const devRoutes: Routes = [
  {
    path: 'scraper',
    // The API verifies the token on every call, so this only avoids rendering
    // a dashboard that would answer everything with 401.
    canActivate: [authGuard],
    loadComponent: () => import('./components/scraper-dashboard/scraper-dashboard.component')
      .then(m => m.ScraperDashboardComponent),
  },
];
