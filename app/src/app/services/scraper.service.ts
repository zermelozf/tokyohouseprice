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
  // Present only for detail-enriched properties (null otherwise).
  lat?: number | null;
  lng?: number | null;
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
  source?: string | null;
}

// A recurring scheduled crawl. `mode` picks categories+wards or a pasted URL.
export interface ScheduledJob {
  id: string;
  name: string;
  mode: 'categories' | 'url';
  categories: string[];
  wards: string[];
  url: string;
  max_pages: number;
  min_delay: number;
  max_delay: number;
  interval_minutes: number;
  enabled: boolean;
  created: string | null;
  last_run: string | null;
  last_status: 'ok' | 'error' | null;
  last_summary: { category?: string; ward?: string; listings?: number }[] | null;
  last_error: string | null;
  last_listings: number | null;
  next_run: string | null;
}

// Editable fields sent when creating/updating a job.
export type JobInput = Pick<ScheduledJob,
  'name' | 'mode' | 'categories' | 'wards' | 'url' | 'max_pages' |
  'min_delay' | 'max_delay' | 'interval_minutes' | 'enabled'>;

export interface SchedulerState {
  jobs: ScheduledJob[];
  running_id: string | null;
  tick_seconds: number;
  jobs_path: string;
}

// On-demand detail-page enrichment for a single property (exact coordinates +
// the full spec table). Fetched when the user clicks a listing's details button.
export interface PropertyDetail {
  property_id: string | null;
  url: string;
  lat: number | null;
  lng: number | null;
  address: string | null;
  title?: string | null;
  specs?: Record<string, string>;
  n_specs?: number;
  fetched_at?: string;
  cached?: boolean;
  error?: string;
}

// A crawled listing that has an enriched exact location, for the Report map.
export interface MapPoint {
  property_id: string;
  lat: number;
  lng: number;
  market: string;
  category: string;
  ward: string;
  price_yen: number | null;
  price_raw: string | null;
  url: string;
  title: string | null;
  address: string | null;
  layout: string | null;
  building_m2: number | null;
  land_m2: number | null;
  nearest_walk_min: number | null;
  build_year: number | null;
  age_years: number | null;
  scrape_date: string;
  // Door-to-school commute, precomputed per station (scraper/commute.py).
  commute_min: number | null;
  commute_from: string | null;
  commute_walk_min: number | null;
  commute_transit_min: number | null;
  commute_via: string | null;
  commute_transfers: number | null;
  // 耐震基準 tier, attached server-side (scraper/query.py seismic_era).
  era: SeismicEra | null;
  build_year_est: number | null;   // stated year, else derived from 築N年
  era_approx: boolean;             // derived year, or a year on a revision boundary
}

export type SeismicEra = 'kyu' | 'shin' | 'y2000';

/** Mirrors query.ERAS. Colours double as the map legend. */
export const ERA_META: Record<SeismicEra, { label: string; short: string; color: string }> = {
  kyu:   { label: '旧耐震 (pre-1981)',   short: '旧耐震',    color: '#c2410c' },
  shin:  { label: '新耐震 (1982-2000)',  short: '新耐震',    color: '#ca8a04' },
  y2000: { label: '2000年基準 (2001-)',  short: '2000年基準', color: '#15803d' },
};

export interface CrawlDate {
  date: string;
  properties: number;
  started: string;
  finished: string;
}

/** One field that differs between the two crawls of the same property. */
export interface FieldChange {
  field: string;
  label: string;
  from: any;
  to: any;
}

export interface DiffListing {
  property_id: string;
  scrape_date: string;
  market: string;
  category: string;
  ward: string;
  url: string;
  title: string | null;
  address: string | null;
  station_raw: string | null;
  nearest_walk_min: number | null;
  price_yen: number | null;
  price_raw: string | null;
  layout: string | null;
  land_m2: number | null;
  building_m2: number | null;
  build_year: number | null;
  age_years: number | null;
  /** Only on `gone` rows: whether the later crawl actually covered this group. */
  scope?: 'covered' | 'partial' | 'absent';
  /** Only on `changed` rows. */
  changes?: FieldChange[];
}

export interface CrawlDiff {
  date_from: string;
  date_to: string;
  counts: {
    before: number; after: number; new: number;
    delisted: number; gone_partial: number; gone_absent: number;
    relisted: number; changed: number; unchanged: number;
  };
  new: DiffListing[];
  gone: DiffListing[];
  changed: DiffListing[];
  /** Same property re-posted under a fresh SUUMO id — not real churn. */
  relisted: { from: DiffListing; to: DiffListing }[];
  coverage: { category: string; ward: string; from: number; to: number }[];
  search_urls: { url: string; category: string;
                 from_pages: number; from_cards: number;
                 to_pages: number; to_cards: number }[];
  narrowed: { url: string; category: string;
              from_pages: number; from_cards: number;
              to_pages: number; to_cards: number }[];
}

export interface ScraperConfig {
  data_dir: string;
  db_path: string;
  jobs_path: string;
  default_min_delay: number;
  default_max_delay: number;
  wards: string[];
  categories: CategoryOption[];
}

// --- financial comparison of two listings (api/scraper_compare.py) ----------
export interface CompareAssumptions {
  loan_rate: number;
  loan_term: number;
  down_payment_pct: number;
  broker_fee_pct: number;
  maintenance_rate: number;
  land_spread_vs_rent: number;   // land growth ABOVE rent inflation; 0 = flat yields
  land_appreciation?: number;    // derived, echoed back by the server
  rent_inflation: number;
  renewal_fee_months: number;
  opportunity_cost_real: number;   // REAL return; nominal is derived from inflation
  opportunity_cost?: number;       // derived, echoed back by the server
  simulation_years: number;
  build_cost_per_m2: number;
  build_cost_per_m2_rc: number;
  cost_inflation: number | null;   // null -> tracks rent_inflation
  building_assessment_ratio: number;
  new_build_relief_years: number;
  maintenance_on_building_only: boolean;
  maintenance_age_slope: number;
  house_residual_ratio: number;
  acquisition_cost_pct: number;
  loan_upfront_fee_pct: number;
  mortgage_credit_rate: number;
  mortgage_credit_years: number;
  mortgage_credit_cap: number;
  cgt_short_rate: number;
  cgt_long_rate: number;
  cgt_short_years: number;
  cgt_exemption: number;
  sale_discount_pct: number;
  key_money_months: number;
  guarantee_months: number;
  moving_cost: number;
  move_every_years: number;
  property_tax_rate: number;
  city_planning_rate: number;
  land_build_m2: number;
  residential_land_relief: boolean;
  baseline_monthly_rent: number;
}

/** Whether the house you would build fits the plot's 建ぺい率 / 容積率. */
export interface Buildable {
  known: boolean;
  want_m2: number;
  land_m2: number | null;
  coverage_pct?: number;
  far_pct?: number;
  zoning_raw?: string;
  max_floor_m2?: number;
  max_footprint_m2?: number;
  fits?: boolean;
  storeys_needed?: number | null;
}

export interface ComparePoint {
  year: number;
  pv_cost: number;          // PV of housing cost if you exit at end of this year
  cum_cost_no_exit: number; // same, before crediting the sale
  exit_value_pv: number;    // PV of sale proceeds net of remaining debt
  exit_value: number;       // the same, undiscounted
}

export interface CompareOption {
  property_id: string;
  title: string | null;
  url: string;
  market: string;
  category: string;
  ward: string;
  layout: string | null;
  price_yen: number | null;
  price_raw: string | null;
  building_m2: number | null;
  land_m2: number | null;
  age_years: number | null;
  era: SeismicEra | null;
  build_year_est: number | null;
  era_approx: boolean;
  derived: Record<string, any>;
  commute_min: number | null;
  commute_from: string | null;
  commute_walk_min: number | null;
  commute_transit_min: number | null;
  commute_via: string | null;
  cashflows: number[];
  monthly_costs: number[];   // recurring monthly outgoings, per year
  exit_values: number[];     // equity if you sell in that year
  upfront_cash: number;      // day-one deposit + taxes + fees
  buildable: Buildable | null;
  series: ComparePoint[];
  pv_cost: number;
  pv_cost_per_m2: number | null;
  exit_value_pv: number;        // in today's money
  exit_value_nominal: number;   // cash in hand at the horizon
  monthly_equivalent: number;
}

export interface CompareResult {
  error?: string;
  assumptions: CompareAssumptions;
  options: CompareOption[];
  verdict: {
    cheaper_index: number;
    ranking: number[];           // option indices, cheapest first
    pv_advantage: number;        // best vs runner-up
    kind: 'rent_vs_buy' | 'buy_vs_buy' | 'rent_vs_rent';
    baseline_monthly_rent: number;
    baseline_note: string | null;
    baseline_source: string;
    // Defined per (buy, rent) pair, so present only when exactly one rent
    // listing anchors the comparison. Keyed by option index.
    buy_vs_rent_by_option?: Record<string, BuyVsRent>;
    buy_vs_rent?: BuyVsRent;     // the single-pair case, which the UI headlines
    // Options ordered by day-one capital, and the return on each step up.
    ladder: number[];
    hurdle_rate: number;
    steps: CompareStep[];
    anchor_index: number;
    best_by_irr: number | null;
    irr_anchor_valid: boolean;
    irr_anchor_note: string | null;
    irr_vs_anchor: Record<string, IrrVsAnchor>;
  };
}

export interface IrrVsAnchor {
  series: { year: number; irr: number | null; npv: number }[];
  peak_year: number | null;
  peak_irr: number | null;
  irr_at_horizon: number | null;
  shape: 'investing' | 'financing';
  t0_delta: number;
}

export interface CompareStep {
  from_index: number;
  to_index: number;
  extra_capital: number;
  incremental_irr: number | null;
  npv_delta: number;
  clears_hurdle: boolean | null;
}

export interface BuyVsRent {
  npv_at_horizon: number;
  irr_at_horizon: number | null;
  breakeven_year: number | null;
  irr_series: { year: number; irr: number | null }[];
  npv_series: { year: number; npv: number }[];
  peak_irr_year: number | null;
  peak_irr: number | null;
  peak_npv_year: number | null;
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
  eras?: string[];             // 耐震基準 tiers; empty = no era filter
  commute_max?: number | null; // door-to-school minutes
  // Total budget, applied here because SUUMO's own ceiling stops at 1億2千万.
  // Land is judged on the budget less the cost of the house you must build.
  budget_yen?: number | null;
  budget_build_m2?: number;
  budget_build_cost_m2?: number;
  date_from?: string | null;   // crawled-time window, 'YYYY-MM-DD' inclusive
  date_to?: string | null;
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

  // --- scraper config + scheduled recurring jobs ---
  config(): Observable<ScraperConfig> {
    return this.http.get<ScraperConfig>(`${this.base}/scraper/config`);
  }

  jobs(): Observable<SchedulerState> {
    return this.http.get<SchedulerState>(`${this.base}/scraper/jobs`);
  }

  createJob(body: JobInput): Observable<ScheduledJob> {
    return this.http.post<ScheduledJob>(`${this.base}/scraper/jobs`, body);
  }

  updateJob(id: string, body: JobInput): Observable<ScheduledJob> {
    return this.http.patch<ScheduledJob>(`${this.base}/scraper/jobs/${id}`, body);
  }

  deleteJob(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`${this.base}/scraper/jobs/${id}`);
  }

  runJob(id: string): Observable<ScheduledJob> {
    return this.http.post<ScheduledJob>(`${this.base}/scraper/jobs/${id}/run`, {});
  }

  // On-demand: fetch one property's detail page (exact location + full specs).
  detail(url: string): Observable<PropertyDetail> {
    return this.http.post<PropertyDetail>(`${this.base}/scraper/detail`, { url });
  }

  // Crawled listings with enriched coordinates, for the Map tab.
  mapData(f: Filters): Observable<{ points: MapPoint[]; mapped: number }> {
    return this.http.post<{ points: MapPoint[]; mapped: number }>(`${this.base}/scraper/map`, f);
  }

  // Rent-vs-buy / buy-vs-buy on two picked listings, through the same NPV
  // engine as the rent-or-buy article.
  compare(property_ids: string[], assumptions: CompareAssumptions,
          scrape_date?: string | null,
          anchor_index?: number | null): Observable<CompareResult> {
    return this.http.post<CompareResult>(`${this.base}/scraper/compare`,
      { property_ids, assumptions, scrape_date: scrape_date || null,
        anchor_index: anchor_index ?? null });
  }

  crawlDates(): Observable<{ dates: CrawlDate[] }> {
    return this.http.get<{ dates: CrawlDate[] }>(`${this.base}/scraper/crawl-dates`);
  }

  // What changed between two crawls, for the Report tab.
  diff(dateFrom: string, dateTo: string): Observable<CrawlDiff> {
    return this.http.get<CrawlDiff>(
      `${this.base}/scraper/diff?date_from=${dateFrom}&date_to=${dateTo}`);
  }
}
