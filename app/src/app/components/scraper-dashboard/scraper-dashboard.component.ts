import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { environment } from '../../../environments/environment';
import { ScraperService, Listing, Stats, Summary } from '../../services/scraper.service';

interface SuumoLink { label: string; sub: string; url: string; }

@Component({
  selector: 'app-scraper-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scraper-dashboard.component.html',
  styleUrls: ['./scraper-dashboard.component.css'],
})
export class ScraperDashboardComponent implements OnInit {
  // Tokyo-wide SUUMO result pages to start from — refine filters there, then
  // copy the URL back into the box below.
  suumoLinks: SuumoLink[] = [
    { label: '中古一戸建て', sub: 'used houses',  url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=021&ta=13' },
    { label: '新築一戸建て', sub: 'new houses',   url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=020&ta=13' },
    { label: '中古マンション', sub: 'used condos', url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=011&ta=13' },
    { label: '土地', sub: 'land',                 url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=030&ta=13' },
    { label: '賃貸', sub: 'rentals',              url: 'https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&bs=040&ta=13' },
  ];

  summary: Summary | null = null;
  apiError = '';

  urlInput = '';
  urlPending = '';
  urlPreviewing = false;
  urlCrawlMsg = '';
  crawlPages = 5;

  rows: Listing[] = [];
  stats: Stats | null = null;
  resMeta = '';

  trendRows: any[] = [];
  trendCols = ['scrape_date', 'market', 'category', 'ward', 'n_listings',
               'mean_price_yen', 'mean_price_per_m2'];

  constructor(private api: ScraperService) {}

  ngOnInit(): void {
    this.api.summary().subscribe({
      next: s => { this.summary = s; this.apiError = ''; },
      error: () => this.apiError =
        `Scraper API offline at ${environment.scraperApiUrl} — start it:  ` +
        `cd api && ENABLE_SCRAPER=1 uvicorn api:app --reload --port 8000`,
    });
  }

  refreshSummary(): void {
    this.api.summary().subscribe({ next: s => this.summary = s, error: () => {} });
  }

  previewFromUrl(): void {
    if (!this.urlInput.trim()) { this.urlPending = 'paste a SUUMO search-results URL'; return; }
    this.urlPreviewing = true;
    this.urlPending = 'fetching live from SUUMO (polite delay)…';
    this.api.previewUrl({ categories: [], wards: [], limit: 300,
                          url: this.urlInput.trim(), max_pages: 1, persist: false })
      .subscribe({
        next: res => {
          this.urlPreviewing = false;
          if (res.error) { this.urlPending = res.error; return; }
          this.urlPending = '';
          const m = res.meta;
          this.resMeta = `preview${m ? ' · ' + m.category + '/' + m.ward_label : ''} · ${res.fetched} listings`;
          this.stats = res.stats; this.rows = res.rows; this.refreshSummary();
        },
        error: err => { this.urlPreviewing = false; this.urlPending = 'request failed — is the local API running? ' + (err?.message || ''); },
      });
  }

  crawlFromUrl(): void {
    if (!this.urlInput.trim()) { this.urlCrawlMsg = 'paste a SUUMO search-results URL'; return; }
    this.api.crawlUrl({ url: this.urlInput.trim(), max_pages: this.crawlPages }).subscribe({
      next: r => { if (r?.error) { this.urlCrawlMsg = r.error; return; } this.pollCrawl(); },
      error: err => this.urlCrawlMsg = 'request failed — is the local API running? ' + (err?.message || ''),
    });
  }

  showCollected(): void {
    this.api.search({ categories: [], wards: [], limit: 300 }).subscribe({
      next: res => { this.resMeta = 'local DB'; this.stats = res.stats; this.rows = res.rows; },
      error: err => this.urlPending = 'request failed — is the local API running? ' + (err?.message || ''),
    });
  }

  private pollCrawl(): void {
    this.api.crawlStatus().subscribe(s => {
      if (s.state === 'running') { this.urlCrawlMsg = '⏳ crawling…'; setTimeout(() => this.pollCrawl(), 2500); }
      else if (s.state === 'done') {
        const n = (s.summary || []).reduce((a, x) => a + (x.listings || 0), 0);
        this.urlCrawlMsg = `✅ done · ${n} listings saved`; this.refreshSummary();
      } else if (s.state === 'error') { this.urlCrawlMsg = '⚠ ' + s.error; }
    });
  }

  loadTrends(): void {
    this.api.trends().subscribe(rows => this.trendRows = rows);
  }

  // --- formatting helpers ---
  fmtYen(y: number | null | undefined): string {
    if (y == null) return '—';
    if (y >= 1e8) return (y / 1e8).toFixed(2).replace(/\.00$/, '') + '億';
    return Math.round(y / 1e4).toLocaleString() + '万';
  }
  area(r: Listing): number | null { return (r.building_m2 || 0) || r.land_m2; }
  ppm2(r: Listing): string {
    const a = this.area(r);
    return (r.price_yen && a) ? Math.round(r.price_yen / a).toLocaleString() : '—';
  }
  trendCell(r: any, c: string): string {
    let v = r[c];
    if (v == null) return '—';
    if (c === 'mean_price_yen') return this.fmtYen(v);
    if (c === 'mean_price_per_m2') return Number(v).toLocaleString();
    return String(v);
  }
}
