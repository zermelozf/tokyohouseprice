import { Component, OnInit, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { NavbarComponent } from './components/navbar/navbar.component';
import { filter } from 'rxjs';
import { AnalyticsService } from './services/analytics.service';
import { PropertyPreviewComponent, PreviewListing } from './components/property-preview/property-preview.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, NavbarComponent, PropertyPreviewComponent],
  template: `
    <app-navbar></app-navbar>
    <main class="main-content">
      @if (preview(); as p) {
        <app-property-preview [listing]="p" (close)="preview.set(null)" />
      } @else {
        <router-outlet></router-outlet>
      }
    </main>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 100vh;
    }
  `]
})
export class AppComponent implements OnInit {
  constructor(
    private router: Router,
    private analyticsService: AnalyticsService
  ) {}

  /** A link from outside (e.g. finance's "Fill from a reviewed listing") can only ever land on the root
   *  path - the dev server has no history-API fallback, so a fresh request for any deeper path (/scraper,
   *  /map, ...) 404s before Angular gets a chance to run. Rather than hand off to the (guarded, lazy-loaded)
   *  scraper route client-side - which needs a sign-in and turned out to race the router's own initial
   *  navigation unreliably - render a dedicated, always-works preview right here from the query string
   *  itself: finance already sends every field needed, so no API call or auth is needed to show it. */
  protected preview = signal<PreviewListing | null>(null);

  ngOnInit() {
    let handledDeepLink = false;
    // Track all route changes
    this.router.events.pipe(
      filter(event => event instanceof NavigationEnd)
    ).subscribe((event: any) => {
      // The first NavigationEnd is the one place the query string shows up reliably: ActivatedRoute's own
      // param observables can emit an empty default before the router's initial navigation has actually
      // resolved, so reading them directly (snapshot or observable, take(1) or not) can silently miss the
      // real query params. urlAfterRedirects is the router's own resolved URL, no such race.
      if (!handledDeepLink) {
        handledDeepLink = true;
        const [, qs] = event.urlAfterRedirects.split('?');
        const q = new URLSearchParams(qs ?? '');
        const property_id = q.get('property_id'), listingUrl = q.get('url');
        if (property_id && listingUrl) {
          const num = (k: string) => { const v = q.get(k); return v === null ? null : Number(v); };
          this.preview.set({
            property_id, url: listingUrl,
            market: q.get('market') || 'sale', category: q.get('category') || '',
            ward: q.get('ward') || '', title: q.get('title') || '',
            image_url: q.get('image_url'), layout: q.get('layout'),
            price_yen: num('price_yen'), building_m2: num('building_m2'), land_m2: num('land_m2'),
            down_payment_pct: num('down_payment_pct'), loan_term: num('loan_term'),
          });
        }
      }

      // Get page name from URL
      const url = event.urlAfterRedirects;
      let pageName = url.split('/').pop() || 'home';
      if (pageName === '') pageName = 'home';
      this.analyticsService.logPageView(pageName);
    });
  }
}
