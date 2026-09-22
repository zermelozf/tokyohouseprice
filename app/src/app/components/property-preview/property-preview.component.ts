import { Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';

/** What a linker (finance's "Fill from a reviewed listing") passes in the query string: enough to
 *  show something useful without any API call. Every field but property_id and url is cosmetic. */
export interface PreviewListing {
  property_id: string;
  url: string;
  market: string;
  category: string;
  ward: string;
  title: string;
  image_url: string | null;
  price_yen: number | null;
  layout: string | null;
  building_m2: number | null;
  land_m2: number | null;
  // The actual loan being planned (finance's "Fill from a reviewed listing" only sends these for a purchase),
  // so the comparison this links onward to prices the real purchase instead of a generic 20%-down/35-year one.
  down_payment_pct: number | null;
  loan_term: number | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  rent: 'Rental', land: 'Land', new_house: 'New house', used_house: 'Used house', used_mansion: 'Resale flat',
};

/**
 * A dedicated, no-sign-in-required view of one listing, reached by a link from outside (currently
 * just finance's housing picker). It renders straight from the query string - no scraper API call,
 * so no auth guard and no dependency on the scraper dashboard's own routing - which makes it the
 * one thing in this app guaranteed to work for a fresh, unauthenticated, single-shot page load.
 *
 * It intentionally does not replace the scraper dashboard's own detail sheet (`?property_id=...`
 * still opens that too, for a signed-in reviewer with the full toolset); this is a simpler, always-
 * reachable page for "someone just clicked a link and wants to see the listing".
 */
@Component({
  selector: 'app-property-preview',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="wrap">
      <button type="button" class="back" (click)="close.emit()">← Back</button>
      <div class="card">
        <div class="thumb">
          @if (listing().image_url) { <img [src]="listing().image_url" [alt]="listing().title"> }
          @else { <span class="noimg">No photo</span> }
          <span class="cat">{{ categoryLabel(listing().category) }}</span>
        </div>
        <div class="body">
          <h1>{{ listing().title || 'Listing' }}</h1>
          <div class="price">{{ price() }}</div>
          <dl>
            @if (listing().ward) { <div><dt>Ward</dt><dd>{{ listing().ward }}</dd></div> }
            @if (listing().layout) { <div><dt>Layout</dt><dd>{{ listing().layout }}</dd></div> }
            @if (listing().building_m2 != null) { <div><dt>Building</dt><dd>{{ listing().building_m2 }}m²</dd></div> }
            @if (listing().land_m2 != null) { <div><dt>Land</dt><dd>{{ listing().land_m2 }}m²</dd></div> }
          </dl>
          <div class="actions">
            <a [href]="listing().url" target="_blank" rel="noopener noreferrer" class="primary">View original listing ↗</a>
            <a [routerLink]="['/scraper']" [queryParams]="dashboardParams()" class="ghost">Open in scraper dashboard (sign in for the full review tools)</a>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: `
    .wrap { max-width: 720px; margin: 24px auto; padding: 0 16px; }
    .back { background: none; border: 0; color: #2B4C7E; font: inherit; cursor: pointer; padding: 4px 0; margin-bottom: 12px; }
    .card { border: 1px solid #D3DAE2; border-radius: 12px; overflow: hidden; background: #fff; }
    .thumb { position: relative; aspect-ratio: 16 / 9; background: #EEF2F5; display: flex; align-items: center; justify-content: center; }
    .thumb img { width: 100%; height: 100%; object-fit: cover; }
    .noimg { color: #5A6676; }
    .cat { position: absolute; top: 10px; left: 10px; background: rgba(10,16,24,.65); color: #fff; font-size: .78rem; padding: 3px 10px; border-radius: 999px; }
    .body { padding: 18px 22px 22px; }
    h1 { margin: 0 0 6px; font-size: 1.3rem; }
    .price { font-weight: 700; font-size: 1.4rem; color: #17212E; margin-bottom: 12px; }
    dl { display: flex; flex-wrap: wrap; gap: 18px; margin: 0 0 18px; padding: 0; }
    dl > div { display: flex; flex-direction: column; }
    dt { font-size: .74rem; color: #5A6676; margin-bottom: 2px; }
    dd { margin: 0; font-weight: 600; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    a.primary { background: #2B4C7E; color: #fff; padding: 9px 16px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    a.ghost { border: 1px solid #2B4C7E; color: #2B4C7E; padding: 8px 15px; border-radius: 8px; text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      .card { background: #1A2230; border-color: #2C3747; }
      .thumb { background: #121821; }
      .noimg, dt { color: #98A4B4; }
      .price, h1 { color: #E4E9F0; }
      .back, a.ghost { color: #8FB0E3; border-color: #8FB0E3; }
      a.primary { background: #8FB0E3; color: #121821; }
    }
  `,
})
export class PropertyPreviewComponent {
  listing = input.required<PreviewListing>();
  close = output<void>();

  protected categoryLabel(c: string) { return CATEGORY_LABEL[c] ?? c; }
  protected price(): string {
    const l = this.listing();
    const y = l.price_yen;
    if (y == null) return '';
    const suffix = l.market === 'rent' ? ' / month' : '';
    return y >= 1_0000_0000
      ? `¥${(y / 1_0000_0000).toFixed(2)}億${suffix}`
      : `¥${Math.round(y / 10000).toLocaleString()}万${suffix}`;
  }
  protected dashboardParams(): Record<string, string> {
    const l = this.listing();
    const p: Record<string, string> = { property_id: l.property_id, url: l.url, market: l.market, category: l.category };
    if (l.ward) p['ward'] = l.ward;
    if (l.title) p['title'] = l.title;
    if (l.image_url) p['image_url'] = l.image_url;
    if (l.layout) p['layout'] = l.layout;
    if (l.building_m2 != null) p['building_m2'] = String(l.building_m2);
    if (l.land_m2 != null) p['land_m2'] = String(l.land_m2);
    if (l.price_yen != null) p['price_yen'] = String(l.price_yen);
    if (l.down_payment_pct != null) p['down_payment_pct'] = String(l.down_payment_pct);
    if (l.loan_term != null) p['loan_term'] = String(l.loan_term);
    return p;
  }
}
