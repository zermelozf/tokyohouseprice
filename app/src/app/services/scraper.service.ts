import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface CategoryOption { key: string; market: string; label: string; }
export interface OptionsResponse { wards: string[]; categories: CategoryOption[]; }

// Static catalog mirroring scraper/config.py, so the criteria UI always renders
// even when the local API is offline. options() refreshes these if it succeeds.
export const WARD_KEYS: string[] = [
  'chiyoda', 'chuo', 'minato', 'shinjuku', 'bunkyo', 'taito', 'sumida', 'koto',
  'shinagawa', 'meguro', 'ota', 'setagaya', 'shibuya', 'nakano', 'suginami',
  'toshima', 'kita', 'arakawa', 'itabashi', 'nerima', 'adachi', 'katsushika', 'edogawa',
];
export const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: 'used_mansion', market: 'sale', label: '中古マンション' },
  { key: 'new_house',    market: 'sale', label: '新築一戸建て' },
  { key: 'used_house',   market: 'sale', label: '中古一戸建て' },
  { key: 'land',         market: 'sale', label: '土地' },
  { key: 'rent',         market: 'rent', label: '賃貸' },
];

export interface Stats {
  count: number;
  median_price_yen: number | null;
  min_price_yen: number | null;
  max_price_yen: number | null;
  median_price_per_m2: number | null;
}

export interface Listing {
  property_id: string;
  market: string;
  category: string;
  ward: string;
  url: string;
  title: string;
  address: string;
  station_raw: string;
  nearest_walk_min: number | null;
  price_yen: number | null;
  price_raw: string;
  layout: string | null;
  land_m2: number | null;
  building_m2: number | null;
  age_years: number | null;
  [key: string]: any;
}

export interface SearchResult { stats: Stats; rows: Listing[]; }
export interface UrlMeta { market: string; category: string; ward_label: string; wards: string[]; }
export interface PreviewResult extends SearchResult {
  fetched: number; matched: number; pages_fetched: number;
  persisted: boolean; error?: string; meta?: UrlMeta;
}

export interface Summary {
  total_rows: number;
  distinct_properties: number;
  by_category: { market: string; category: string; n: number }[];
  first_scrape: string | null;
  last_scrape: string | null;
}

export interface CrawlStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  started: string | null;
  finished: string | null;
  summary: { category: string; ward: string; listings: number }[] | null;
  error: string | null;
}

export interface Filters {
  markets?: string[];
  categories: string[];
  wards: string[];
  price_min?: number | null;
  price_max?: number | null;
  bld_min?: number | null;
  bld_max?: number | null;
  land_min?: number | null;
  land_max?: number | null;
  layout?: string | null;
  walk_max?: number | null;
  age_max?: number | null;
  sort?: string | null;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class ScraperService {
  private base = environment.scraperApiUrl;

  constructor(private http: HttpClient) {}

  options(): Observable<OptionsResponse> {
    return this.http.get<OptionsResponse>(`${this.base}/scraper/options`);
  }

  summary(): Observable<Summary> {
    return this.http.get<Summary>(`${this.base}/scraper/summary`);
  }

  search(filters: Filters): Observable<SearchResult> {
    return this.http.post<SearchResult>(`${this.base}/scraper/search`, filters);
  }

  preview(body: Filters & { max_pages: number; persist: boolean }): Observable<PreviewResult> {
    return this.http.post<PreviewResult>(`${this.base}/scraper/preview`, body);
  }

  previewUrl(body: Filters & { url: string; max_pages: number; persist: boolean }): Observable<PreviewResult> {
    return this.http.post<PreviewResult>(`${this.base}/scraper/preview-url`, body);
  }

  crawlUrl(body: { url: string; max_pages: number }): Observable<any> {
    return this.http.post<any>(`${this.base}/scraper/crawl-url`, body);
  }

  trends(q: { market?: string; category?: string; ward?: string } = {}): Observable<any[]> {
    let params = new HttpParams();
    if (q.market) params = params.set('market', q.market);
    if (q.category) params = params.set('category', q.category);
    if (q.ward) params = params.set('ward', q.ward);
    return this.http.get<any[]>(`${this.base}/scraper/trends`, { params });
  }

  startCrawl(body: { categories: string[]; wards: string[]; max_pages: number }): Observable<any> {
    return this.http.post<any>(`${this.base}/scraper/crawl`, body);
  }

  crawlStatus(): Observable<CrawlStatus> {
    return this.http.get<CrawlStatus>(`${this.base}/scraper/crawl/status`);
  }
}
