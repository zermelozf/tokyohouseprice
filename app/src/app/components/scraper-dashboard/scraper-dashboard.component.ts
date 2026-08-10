import { Component, OnDestroy, OnInit, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  ScraperService, Listing, Stats, Summary, Filters,
  ScheduledJob, JobInput, SchedulerState, ScraperConfig, CrawlStatus, PropertyDetail, MapPoint,
  CrawlDate, CrawlDiff, DiffListing, FieldChange, SeismicEra, ERA_META,
  CompareAssumptions, CompareResult, CompareOption,
} from '../../services/scraper.service';

interface DetailState { loading?: boolean; open?: boolean; data?: PropertyDetail; error?: string; }

/**
 * 2020 census counts for one 町丁. `null` means e-Stat withheld the figure for
 * disclosure control (13 of the 3,039 blocks).
 */
interface BlockStats {
  pop: number | null; age_0_14: number | null; age_15_64: number | null;
  age_65: number | null; age_75: number | null;
  age_20_24: number | null; age_25_29: number | null;
  age_30_34: number | null; age_35_39: number | null;
  hh_general: number | null; hh_1person: number | null;
  hh_couple_kids: number | null; hh_under6: number | null; hh_under18: number | null;
  hh_housed: number | null; hh_owned: number | null; hh_priv_rent: number | null;
  hh_main: number | null; hh_detached: number | null;
  hh_apt_6_10: number | null; hh_apt_11plus: number | null;
  workers: number | null; work_managers: number | null; work_professional: number | null;
}

interface CensusLayer {
  key: string;
  group: string;
  label: string;
  title: string;
  legendTitle: string;
  /** `fixed` keeps hard-coded breaks; `quantile` derives six equal-count buckets. */
  mode: 'fixed' | 'quantile';
  breaks: number[];
  unit: 'yen' | 'int' | 'pct';
  value: (props: any) => number | null;
  palette?: string[];
  /** Filled in once the data is loaded, so the legend can drop empty classes. */
  bucketCounts?: number[];
  noDataCount?: number;
}

interface SuumoLink { label: string; sub: string; url: string; }
interface FreqPreset { label: string; minutes: number; }

// Scheduled jobs are URL-based only, to stay consistent with the rest of the
// dashboard (paste a SUUMO URL → preview → confirm → act). No separate
// category/ward pickers here.
function blankJob(): JobInput {
  return {
    name: '', mode: 'url', categories: [], wards: [], url: '',
    max_pages: 5, min_delay: 2, max_delay: 4, interval_minutes: 1440, enabled: true,
  };
}

@Component({
  selector: 'app-scraper-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './scraper-dashboard.component.html',
  styleUrls: ['./scraper-dashboard.component.css'],
})
export class ScraperDashboardComponent implements OnInit, OnDestroy {
  // Tokyo-wide SUUMO result pages to start from when creating a crawler — open
  // one, refine filters on SUUMO, then paste the URL into the crawler form.
  suumoLinks: SuumoLink[] = [
    { label: '中古一戸建て', sub: 'used houses',  url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=021&ta=13' },
    { label: '新築一戸建て', sub: 'new houses',   url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=020&ta=13' },
    { label: '中古マンション', sub: 'used condos', url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=011&ta=13' },
    { label: '土地', sub: 'land',                 url: 'https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=030&ta=13' },
    { label: '賃貸', sub: 'rentals',              url: 'https://suumo.jp/jj/chintai/ichiran/FR301FC001/?ar=030&bs=040&ta=13' },
  ];

  summary: Summary | null = null;
  apiError = '';

  // Live preview inside the crawler-create form (confirm a URL before saving it).
  urlPending = '';
  urlPreviewing = false;
  previewRows: Listing[] = [];
  previewStats: Stats | null = null;
  previewMeta = '';

  // Search over already-crawled data (the Search tab). Crawled-time window
  // defaults to yesterday→today (set in ngOnInit).
  searchForm = { category: '', ward: '', price_min: null as number | null,
                 price_max: null as number | null, limit: 300,
                 date_from: '', date_to: '' };
  searchRows: Listing[] = [];
  searchStats: Stats | null = null;
  searchMeta = '';
  searched = false;

  // On-demand detail enrichment per listing, keyed by property_id (a key that
  // hasn't been fetched yet is genuinely undefined).
  detailState: Record<string, DetailState | undefined> = {};

  // --- config + scheduled jobs ---
  config: ScraperConfig | null = null;

  sched: SchedulerState | null = null;
  liveStatus: CrawlStatus | null = null;

  form: JobInput = blankJob();
  editingId: string | null = null;
  jobMsg = '';
  showJobForm = false;

  // Which tab is visible. Crawlers (running/scheduled + status) is the default.
  activeTab: 'crawlers' | 'search' | 'report' | 'map' = 'crawlers';

  // --- Report tab: what changed between two crawls ---------------------------
  crawlDates: CrawlDate[] = [];
  diffFrom = '';
  diffTo = '';
  diff: CrawlDiff | null = null;
  diffLoading = false;
  diffError = '';
  /** property_id → whether its change list is expanded. */
  diffOpen: Record<string, boolean> = {};
  showCoverage = false;

  // Report tab: Leaflet map of crawled listings that have an exact location.
  // `date` empty means "latest snapshot of every property"; a specific crawl
  // date pins the map to what that day's crawl actually saw.
  mapForm: { category: string; ward: string; date: string; commuteMax: number | null } =
    { category: '', ward: '', date: '', commuteMax: null };
  // 耐震基準 tiers to show; empty = all (including listings with no known year).
  mapEras: SeismicEra[] = [];
  // What the dots encode. Era colouring answers "how much of this street is
  // 旧耐震" at a glance, which category colouring cannot.
  colorBy: 'category' | 'era' = 'category';
  eraList = Object.entries(ERA_META).map(([key, m]) => ({ key: key as SeismicEra, ...m }));
  mapPoints: MapPoint[] = [];
  private map: any = null;
  private L: any = null;
  private markerLayer: any = null;
  private mapLoaded = false;
  // category → marker colour (also drives the legend)
  catColors: { key: string; label: string; color: string }[] = [
    { key: 'used_mansion', label: '中古マンション', color: '#2563eb' },
    { key: 'new_house',    label: '新築一戸建て',   color: '#16a34a' },
    { key: 'used_house',   label: '中古一戸建て',   color: '#0d9488' },
    { key: 'land',         label: '土地',           color: '#f59e0b' },
    { key: 'rent',         label: '賃貸',           color: '#9333ea' },
  ];
  // --- compare tray: two listings, one financial verdict -------------------
  // Picked from either the map popups or the Search table, so the slots hold
  // just enough to render the tray; the model reads the rest server-side.
  // Up to 4: past that the crossover chart stops being readable and the cards
  // stop fitting side by side. Server enforces the same cap.
  readonly COMPARE_MAX = 4;
  readonly COMPARE_COLORS = ['#2563eb', '#ea580c', '#7c3aed', '#0d9488'];
  compareSel: { property_id: string; label: string; market: string;
                category: string; price_raw: string | null }[] = [];
  compareOpen = false;
  compareLoading = false;
  compareError = '';
  compareResult: CompareResult | null = null;
  compareAssumptionsOpen = false;
  // Which option every IRR is measured against. null -> server picks the
  // least-capital option, which is the only anchor that keeps every stream
  // investing-shaped and therefore rankable on one rule.
  compareAnchor: number | null = null;
  // Forced exit year. null -> each option shown at its own best-by-IRR year.
  compareSellYear: number | null = null;
  // The rent-or-buy article's own form defaults, so the two tools agree unless
  // you change something here.
  compareAssumptions: CompareAssumptions = {
    loan_rate: 0.015, loan_term: 35, down_payment_pct: 0.20, broker_fee_pct: 0.035,
    maintenance_rate: 0.005, land_spread_vs_rent: 0, rent_inflation: 0.01,
    renewal_fee_months: 1, opportunity_cost_real: 0.05, simulation_years: 40,
    build_cost_per_m2: 250_000, build_cost_per_m2_rc: 350_000,
    cost_inflation: null, property_tax_rate: 0.014, city_planning_rate: 0.003,
    building_assessment_ratio: 0.55, new_build_relief_years: 3,
    maintenance_on_building_only: true, maintenance_age_slope: 0.02,
    house_residual_ratio: 0.10, acquisition_cost_pct: 0.04, loan_upfront_fee_pct: 0.022,
    mortgage_credit_rate: 0.007, mortgage_credit_years: 13, mortgage_credit_cap: 315_000,
    cgt_short_rate: 0.3963, cgt_long_rate: 0.20315, cgt_short_years: 5,
    cgt_exemption: 30_000_000, sale_discount_pct: 0,
    key_money_months: 1, guarantee_months: 0.5, moving_cost: 300_000, move_every_years: 0,
    land_build_m2: 120, residential_land_relief: true, baseline_monthly_rent: 250_000,
  };
  // A plot needs a house before it can be compared with one, and the size is a
  // decision the user must make rather than inherit silently from a default.
  landSizeConfirmed = false;

  // Reference landmarks shown on the map. Coordinates are approximate — edit
  // freely / add more (e.g. other schools, stations, workplaces).
  pois: { name: string; lat: number; lng: number; icon: string }[] = [
    { name: 'Lycée Français Intl. de Tokyo', lat: 35.7501, lng: 139.7247, icon: '🎓' },
  ];
  private poiLayer: any = null;
  // Which stacked-marker group is currently fanned out, and the layer holding it.
  private spiderfied: string | null = null;
  private spiderLayer: any = null;
  // Reference landmark for the straight-line distance shown in popups.
  refPoiName = 'Lycée Français Intl. de Tokyo';
  // How the "route to <landmark>" links open in Google Maps. Transit is the
  // sensible default for a Tokyo school run.
  travelMode: 'transit' | 'walking' | 'bicycling' | 'driving' = 'transit';
  travelModes = [
    { key: 'transit',   label: '🚃 transit' },
    { key: 'walking',   label: '🚶 walking' },
    { key: 'bicycling', label: '🚲 cycling' },
    { key: 'driving',   label: '🚗 driving' },
  ];

  // Live OpenStreetMap POI layers (queried from Overpass for the current view).
  // Add categories here — each is one Overpass filter set + an emoji.
  osmCats: { key: string; label: string; icon: string; filters: string[]; enabled: boolean }[] = [
    { key: 'supermarket',  label: '🛒 Supermarket', icon: '🛒', enabled: true,
      filters: ['node["shop"="supermarket"]', 'way["shop"="supermarket"]'] },
    { key: 'convenience',  label: '🏪 Konbini', icon: '🏪', enabled: false,
      filters: ['node["shop"="convenience"]', 'way["shop"="convenience"]'] },
    { key: 'drugstore',    label: '💊 Drugstore', icon: '💊', enabled: false,
      filters: ['node["shop"="chemist"]', 'way["shop"="chemist"]',
                'node["amenity"="pharmacy"]', 'way["amenity"="pharmacy"]'] },
    { key: 'school',       label: '🏫 School', icon: '🏫', enabled: false,
      filters: ['node["amenity"="school"]', 'way["amenity"="school"]'] },
    { key: 'kindergarten', label: '🧸 Nursery/Kindergarten', icon: '🧸', enabled: false,
      filters: ['node["amenity"~"^(kindergarten|childcare)$"]',
                'way["amenity"~"^(kindergarten|childcare)$"]'] },
    { key: 'hospital',     label: '🏥 Hospital/Clinic', icon: '🏥', enabled: false,
      filters: ['node["amenity"~"^(hospital|clinic|doctors)$"]',
                'way["amenity"~"^(hospital|clinic|doctors)$"]'] },
    { key: 'post',         label: '📮 Post office', icon: '📮', enabled: false,
      filters: ['node["amenity"="post_office"]', 'way["amenity"="post_office"]'] },
    { key: 'library',      label: '📚 Library', icon: '📚', enabled: false,
      filters: ['node["amenity"="library"]', 'way["amenity"="library"]'] },
    { key: 'bank',         label: '🏦 Bank', icon: '🏦', enabled: false,
      filters: ['node["amenity"="bank"]', 'way["amenity"="bank"]'] },
    { key: 'station',      label: '🚉 Station', icon: '🚉', enabled: false,
      filters: ['node["railway"="station"]', 'node["railway"="halt"]'] },
  ];
  // --- hazard overlays (official Japanese government raster tiles) -----------
  // Flood/landslide layers come from MLIT's ハザードマップポータル (disaportal);
  // the ground/terrain layers come from 地理院タイル (GSI). Both are open data.
  // Tiles are only fetched while a layer is toggled on, and areas with no data
  // return HTTP 404 — Leaflet swaps those for a transparent pixel, so a layer
  // that doesn't cover the current view just looks empty rather than broken.
  hazardLayers: {
    key: string; label: string; title: string; urls: string[];
    legend: 'depth' | 'landslide' | 'ground' | 'gradient' | 'image';
    source: 'gsi' | 'disaportal';
    minZoom?: number; maxNativeZoom?: number; link?: string; legendImg?: string;
    enabled: boolean;
  }[] = [
    { key: 'flood', label: '🌊 Flood', enabled: false, legend: 'depth', source: 'disaportal',
      title: '洪水浸水想定区域（想定最大規模） — river flood depth, worst-case scenario',
      urls: ['https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png'],
      maxNativeZoom: 17 },
    { key: 'naisui', label: '🌧️ Inland flood', enabled: false, legend: 'depth', source: 'disaportal',
      title: '内水（雨水出水）浸水想定区域 — storm-drain / surface-water flooding',
      urls: ['https://disaportaldata.gsi.go.jp/raster/02_naisui_data/{z}/{x}/{y}.png'],
      maxNativeZoom: 17 },
    { key: 'hightide', label: '🌀 Storm surge', enabled: false, legend: 'depth', source: 'disaportal',
      title: '高潮浸水想定区域 — typhoon storm-surge inundation',
      urls: ['https://disaportaldata.gsi.go.jp/raster/03_hightide_l2_shinsuishin_data/{z}/{x}/{y}.png'],
      maxNativeZoom: 17 },
    { key: 'tsunami', label: '🌊 Tsunami', enabled: false, legend: 'depth', source: 'disaportal',
      title: '津波浸水想定 — tsunami inundation',
      urls: ['https://disaportaldata.gsi.go.jp/raster/04_tsunami_newlegend_data/{z}/{x}/{y}.png'],
      maxNativeZoom: 17 },
    { key: 'landslide', label: '⛰️ Landslide', enabled: false, legend: 'landslide', source: 'disaportal',
      title: '土砂災害警戒区域 — debris flow, steep-slope collapse and landslide zones',
      urls: [
        'https://disaportaldata.gsi.go.jp/raster/05_dosekiryukeikaikuiki/{z}/{x}/{y}.png',
        'https://disaportaldata.gsi.go.jp/raster/05_kyukeishakeikaikuiki/{z}/{x}/{y}.png',
        'https://disaportaldata.gsi.go.jp/raster/05_jisuberikeikaikuiki/{z}/{x}/{y}.png',
      ], maxNativeZoom: 17 },
    // Earthquake shaking isn't published as open XYZ tiles, so these two stand
    // in for it: shaking and liquefaction in Tokyo track the ground a building
    // sits on — soft alluvial lowland and reclaimed/filled land amplify, the
    // Musashino terrace does not.
    { key: 'ground', label: '🏚️ Ground type', enabled: false, legend: 'ground', source: 'gsi',
      title: '土地条件図 — landform classification (terrace / lowland / reclaimed land): ' +
             'the ground-shaking proxy for earthquakes',
      urls: ['https://cyberjapandata.gsi.go.jp/xyz/lcm25k_2012/{z}/{x}/{y}.png'],
      // Published at z14–16 only. minZoom hides the layer when zoomed further
      // out rather than letting Leaflet upscale (which would request thousands
      // of z14 tiles for one wide view).
      minZoom: 14, maxNativeZoom: 16,
      link: 'https://cyberjapandata.gsi.go.jp/legend/lcm25k_2012/lc_legend.pdf' },
    { key: 'fcterrain', label: '🏞️ River terrain', enabled: false, legend: 'image', source: 'gsi',
      // Unlike the other overlays this one is a fully opaque sheet (it paints
      // white/grey outside the surveyed river basins), so it hides the basemap
      // until you pull the opacity down.
      title: '治水地形分類図 — terrain along major rivers (natural levee, backswamp, ' +
             'former channel, fill). Opaque sheet — lower the opacity to see the streets.',
      urls: ['https://cyberjapandata.gsi.go.jp/xyz/lcmfc2/{z}/{x}/{y}.png'],
      minZoom: 11, maxNativeZoom: 16,
      legendImg: 'https://maps.gsi.go.jp/legend/lcmfc2_legend.jpg',
      link: 'https://www.gsi.go.jp/bousaichiri/fc_index.html' },
    { key: 'slope', label: '📐 Slope', enabled: false, legend: 'gradient', source: 'gsi',
      title: '傾斜量図 — terrain steepness (white = gentle, black = steep)',
      urls: ['https://cyberjapandata.gsi.go.jp/xyz/slopemap/{z}/{x}/{y}.png'],
      maxNativeZoom: 15,
      link: 'https://www.gsi.go.jp/bousaichiri/slopemap.html' },
  ];
  hazardOpacity = 0.6;
  mapZoom = 14;   // kept in sync with the map so we can flag zoom-limited layers
  // key → the Leaflet tile layers currently on the map for that hazard entry
  private hazardTiles: Record<string, any[]> = {};

  // --- census choropleth (令和2年国勢調査 小地域集計) -------------------------
  // Who actually lives on the block a listing sits on. Every layer below is
  // 2020 census data for the 3,039 町丁 of the 23 wards, joined to the boundary
  // polygons on KEY_CODE. Unlike the hazard tiles these are mutually exclusive —
  // a choropleth paints every polygon, so only one can be read at a time.
  censusLayers: CensusLayer[] = [
    { key: 'land_value', group: 'Price', label: '💴 Land value',
      title: 'Assessed land value per m² — the strongest single driver of price',
      legendTitle: 'Land value (JPY/m²)', mode: 'fixed',
      palette: ['#1a9850', '#91cf60', '#d9ef8b', '#fee08b', '#fc8d59', '#d73027'],
      breaks: [307454, 506038, 669145, 1001982, 1746500],
      unit: 'yen', value: p => p.land_value ?? null },

    { key: 'density', group: 'People', label: '👥 Density',
      title: 'Residents per km². Sparse blocks are parks, offices and industry',
      legendTitle: 'People per km²', mode: 'quantile', breaks: [], unit: 'int',
      value: p => p.AREA ? (p.JINKO || 0) / (p.AREA / 1e6) : null },
    { key: 'children', group: 'People', label: '🧒 Under 15',
      title: 'Share of residents under 15 — where families settle rather than pass through',
      legendTitle: 'Aged under 15', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.ageShare(p, 'age_0_14') },
    { key: 'young', group: 'People', label: '🎓 Aged 20–39',
      title: 'Share aged 20–39 — the cohort forming households, and the one that sets rents',
      legendTitle: 'Aged 20–39', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.ageShare(p, 'age_20_24', 'age_25_29', 'age_30_34', 'age_35_39') },
    { key: 'seniors', group: 'People', label: '👴 Over 65',
      title: 'Share aged 65+. Where this is high, the housing stock turns over within two decades',
      legendTitle: 'Aged 65+', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.ageShare(p, 'age_65') },

    { key: 'single', group: 'Households', label: '🚪 One-person',
      title: 'Share of one-person households — over half the 23 wards, but wildly uneven block to block',
      legendTitle: 'One-person households', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'hh_general', 'hh_1person') },
    { key: 'under6', group: 'Households', label: '👶 Child under 6',
      title: 'Households with a child under six — where people are choosing to start a family',
      legendTitle: 'Households with a child under 6', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'hh_general', 'hh_under6') },

    { key: 'owned', group: 'Housing stock', label: '🔑 Owner-occupied',
      title: 'Share that own rather than rent. Owner-heavy blocks turn over slowly and list rarely',
      legendTitle: 'Owner-occupied households', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'hh_housed', 'hh_owned') },
    { key: 'detached', group: 'Housing stock', label: '🏠 Detached',
      title: 'Share in a detached house — the low-rise Tokyo the zoning map protects',
      legendTitle: 'Households in detached houses', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'hh_main', 'hh_detached') },
    { key: 'highrise', group: 'Housing stock', label: '🏢 6F and up',
      title: 'Share living six floors up or higher — the tower belt and station redevelopments',
      legendTitle: 'Households in 6F+ buildings', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'hh_main', 'hh_apt_6_10', 'hh_apt_11plus') },

    { key: 'professionals', group: 'Work', label: '💼 Managers & pros',
      title: 'Share of workers in managerial/professional/technical jobs — the closest the census gets to an income map',
      legendTitle: 'Managers & professionals', mode: 'quantile', breaks: [], unit: 'pct',
      value: p => this.blockShare(p, 'workers', 'work_managers', 'work_professional') },
  ];

  /** Only one choropleth can be readable at a time, so this is single-select. */
  activeCensus: string | null = null;
  censusOpacity = 0.6;
  censusLoading = false;
  censusMsg = '';

  // Sequential blue ramp used by every layer except land value, which keeps the
  // green→red scale the article's map established.
  private readonly CENSUS_RAMP =
    ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#104281'];
  private readonly CENSUS_NO_DATA = '#e1e0d9';

  private censusGeo: any[] | null = null;            // plo.json features
  private censusStats: Record<string, BlockStats> | null = null;
  private censusMeta: any = null;
  private censusLayer: any = null;                   // the Leaflet GeoJSON layer

  // 浸水深 (inundation depth) palette, sampled from the disaportal tiles themselves.
  depthLegend = [
    { color: '#F7F5A9', label: '< 0.5 m' },
    { color: '#FFD8C0', label: '0.5–3 m' },
    { color: '#FFB7B7', label: '3–5 m' },
    { color: '#FF9191', label: '5–10 m' },
    { color: '#F285C9', label: '10–20 m' },
    { color: '#DC7ADC', label: '≥ 20 m' },
  ];
  landslideLegend = [
    { color: '#FAE600', label: '警戒区域 (warning)' },
    { color: '#FA2800', label: '特別警戒区域 (special)' },
  ];

  // 土地条件図 classes. Names + swatches come from GSI's own legend
  // (cyberjapandata.gsi.go.jp/legend/lcm25k_2012/lc_legend.pdf); the colours
  // below are what the tiles actually paint on a light basemap — GSI draws
  // these fills at ~61% alpha, so a raw #FF6600 terrace reads as #FFA163.
  // `firm` groups the classes you'd rather be buying on.
  groundLegend: { color: string; jp: string; en: string; firm?: boolean }[] = [
    { color: '#FFA163', jp: '台地・段丘',       en: 'terrace / plateau', firm: true },
    { color: '#FFC182', jp: '段丘（完新世）',   en: 'younger terrace', firm: true },
    { color: '#FFC1C1', jp: '台地・段丘（未区分）', en: 'terrace, undivided', firm: true },
    { color: '#63E063', jp: '山地斜面等',       en: 'mountain slope', firm: true },
    { color: '#C2C2A3', jp: '山麓堆積地形',     en: 'mountain-foot deposits' },
    { color: '#E0E085', jp: '扇状地',           en: 'alluvial fan' },
    { color: '#FFFF66', jp: '自然堤防',         en: 'natural levee — slightly higher', firm: true },
    { color: '#E0FF66', jp: '砂州・砂丘',       en: 'sand bar / dune' },
    { color: '#FFE0C2', jp: '天井川沿いの微高地', en: 'rise along a raised-bed river' },
    { color: '#EBD4B6', jp: '凹地・浅い谷',     en: 'hollow / shallow valley' },
    { color: '#C2FFE0', jp: '谷底平野・氾濫平野', en: 'valley floor / floodplain' },
    { color: '#C2FFFF', jp: '海岸平野・三角州', en: 'coastal plain / delta' },
    { color: '#85C2A3', jp: '後背低地・湿地',   en: 'backswamp — soft, poorly drained' },
    { color: '#85A385', jp: '旧河道',           en: 'former river channel — soft' },
    { color: '#A1C1E0', jp: '湿地',             en: 'marsh' },
    { color: '#A1A1C1', jp: '河川敷・浜',       en: 'riverbed / beach' },
    { color: '#A1E0FF', jp: '水部',             en: 'water' },
    { color: '#63A1FF', jp: '旧水部',           en: 'former water body, now land' },
    { color: '#C163E0', jp: '崖',               en: 'cliff' },
    { color: '#E082E0', jp: '地すべり（滑落崖）', en: 'landslide scarp' },
    { color: '#E0C1FF', jp: '地すべり（移動体）', en: 'landslide mass' },
  ];
  // GSI draws these as hatch patterns rather than flat colours, so they can't be
  // reproduced as swatches — named here so at least you know what they are.
  groundHatched = ['盛土地・埋立地 (fill / reclaimed)', '高い盛土地 2m以上 (deep fill)',
                   '干拓地 (drained land)', '切土地 (cut ground)',
                   '農耕平坦化地 (levelled farmland)', '改変工事中の区域 (under works)'];

  showRail = true;   // draw train/subway lines (polylines) under the markers
  private osmLayer: any = null;
  private railLayer: any = null;
  osmLoading = false;
  osmMsg = '';
  mapFull = false;   // CSS fullscreen (works on iOS, unlike the Fullscreen API)
  mapFabOpen = false;   // fullscreen-only floating controls panel

  /**
   * The map controls, as one list driving both layouts. Windowed these are a
   * chip row with the open section beneath; fullscreen the same chips sit in
   * the FAB and open the same body in a floating panel. One section at a time
   * in both, so the mental model does not change with the window size.
   */
  readonly controlSections = [
    { key: 'filters', icon: '🔍', label: 'Filters',
      hint: 'category, ward and crawl date' },
    { key: 'poi',     icon: '📍', label: 'Nearby',
      hint: 'landmarks, rail lines and OpenStreetMap points of interest' },
    { key: 'census',  icon: '👥', label: 'Census',
      hint: '2020 census by town block' },
    { key: 'hazard',  icon: '⚠️', label: 'Hazard',
      hint: 'flood, landslide and ground-condition overlays' },
  ];
  /** Which section is open, in both layouts. null = collapsed. */
  activeControl: string | null = 'filters';

  activeSection() {
    return this.controlSections.find(s => s.key === this.activeControl) || null;
  }

  openControl(key: string): void {
    // Clicking the open section closes it, so the map can have the full frame.
    this.activeControl = this.activeControl === key ? null : key;
  }

  toggleFab(): void {
    this.mapFabOpen = !this.mapFabOpen;
    if (this.mapFabOpen && !this.activeControl) this.activeControl = 'filters';
  }

  closeFab(): void {
    this.mapFabOpen = false;
  }

  toggleMapFull(): void {
    this.mapFull = !this.mapFull;
    // Leaving fullscreen returns the controls to the page, so a panel left open
    // would otherwise reappear the next time you go fullscreen.
    if (!this.mapFull) this.mapFabOpen = false;
    setTimeout(() => this.map?.invalidateSize(), 150);  // let the container resize first
  }

  freqPresets: FreqPreset[] = [
    { label: 'Hourly', minutes: 60 },
    { label: 'Every 6h', minutes: 360 },
    { label: 'Every 12h', minutes: 720 },
    { label: 'Daily', minutes: 1440 },
    { label: 'Weekly', minutes: 10080 },
  ];
  freqIsCustom = false;

  private pollTimer: any = null;

  constructor(private api: ScraperService, private http: HttpClient, private zone: NgZone) {}

  // Full-detail modal opened from a map popup's "See all details" button.
  detailModal: { loading?: boolean; point?: MapPoint; data?: PropertyDetail; error?: string } | null = null;

  ngOnInit(): void {
    this.api.summary().subscribe({
      next: s => { this.summary = s; this.apiError = ''; this.startPolling(); },
      error: () => this.apiError =
        `Scraper API offline at ${environment.scraperApiUrl} — start it:  ` +
        `cd api && ENABLE_SCRAPER=1 uvicorn api:app --reload --port 8000`,
    });
    this.api.config().subscribe({ next: c => this.config = c, error: () => {} });
    this.loadJobs();
    // Default the crawled-time window to yesterday → today.
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    this.searchForm.date_from = this.localDate(yesterday);
    this.searchForm.date_to = this.localDate(today);
    this.runSearch();  // preload crawled data for the Search tab
  }

  // Local 'YYYY-MM-DD' (not UTC) — scrape_date is stamped in the machine's local time.
  private localDate(d: Date): string {
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
  }

  ngOnDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.map) { this.map.remove(); this.map = null; }
  }

  // --- Report tab (crawl-to-crawl diff) ---

  /** Both the Report and Map tabs need the list of crawl dates; fetch it once. */
  private ensureCrawlDates(then?: () => void): void {
    if (this.crawlDates.length) { then?.(); return; }
    this.api.crawlDates().subscribe({
      next: res => { this.crawlDates = res.dates; then?.(); },
      error: () => this.diffError = 'could not reach the local API',
    });
  }

  openDiffReport(): void {
    this.activeTab = 'report';
    if (this.diff) return;
    this.ensureCrawlDates(() => {
      // Default to the two most recent crawls — the comparison people actually
      // want on opening the tab.
      if (this.crawlDates.length >= 2) {
        this.diffTo = this.crawlDates[0].date;
        this.diffFrom = this.crawlDates[1].date;
        this.loadDiff();
      } else if (this.crawlDates.length === 1) {
        this.diffTo = this.diffFrom = this.crawlDates[0].date;
        this.diffError = 'only one crawl on record — nothing to compare yet';
      }
    });
  }

  loadDiff(): void {
    if (!this.diffFrom || !this.diffTo) return;
    this.diffLoading = true;
    this.diffError = '';
    this.diffOpen = {};
    this.api.diff(this.diffFrom, this.diffTo).subscribe({
      next: d => { this.diff = d; this.diffLoading = false; },
      error: () => {
        this.diffLoading = false;
        this.diffError = 'diff request failed — is the local API running?';
      },
    });
  }

  toggleDiffRow(id: string): void {
    this.diffOpen[id] = !this.diffOpen[id];
  }

  /** `gone` rows the later crawl genuinely covered — a real delisting. */
  goneWithScope(scope: 'covered' | 'partial' | 'absent'): DiffListing[] {
    return (this.diff?.gone || []).filter(g => g.scope === scope);
  }

  /** `gone` rows the later crawl did not cover well enough to draw a conclusion. */
  goneNotCovered(): DiffListing[] {
    return (this.diff?.gone || []).filter(g => g.scope !== 'covered');
  }

  /** Render one side of a field change; money and areas get their units back. */
  changeValue(c: FieldChange, side: 'from' | 'to'): string {
    const v = c[side];
    if (v === null || v === undefined || v === '') return '—';
    if (c.field.endsWith('_yen')) return '¥' + Number(v).toLocaleString('en-US');
    if (c.field.endsWith('_m2')) return `${v} m²`;
    if (c.field === 'nearest_walk_min') return `${v} min`;
    return String(v);
  }

  /** Signed percentage move, for price changes only. */
  changeDelta(c: FieldChange): string {
    if (!c.field.endsWith('_yen') || !c.from || !c.to) return '';
    const pct = (Number(c.to) / Number(c.from) - 1) * 100;
    return `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
  }

  changeIsUp(c: FieldChange): boolean {
    return c.field.endsWith('_yen') && Number(c.to) > Number(c.from);
  }

  // --- Map tab (Leaflet map) ---
  async openMap(): Promise<void> {
    this.activeTab = 'map';
    this.ensureCrawlDates();
    // Let the (hidden) map container become visible, then init/refresh Leaflet.
    setTimeout(async () => {
      await this.ensureMap();
      this.map?.invalidateSize();
      if (!this.mapLoaded) this.loadMap();
    }, 0);
  }

  private async ensureMap(): Promise<void> {
    if (this.map) return;
    this.L = await import('leaflet');
    const ref = this.refPoi();  // center on the Lycée (reference landmark) by default
    // attributionControl off: this is a private local tool and the corner badge
    // collides with the fullscreen controls. The credit still ships wherever the
    // map leaves this machine — see the caption in scraper/mapimage.py, which is
    // what actually gets emailed.
    this.map = this.L.map('scraperMap', {
      center: [ref.lat, ref.lng], zoom: 14, maxZoom: 18, minZoom: 8,
      attributionControl: false,
    });
    // Light, low-clutter basemap (CartoDB Positron) so the listing dots stand out.
    this.L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 20,
    }).addTo(this.map);
    // Census choropleth sits directly on the basemap, below the hazard tiles —
    // it is background context for the listings, not something to read on top
    // of a flood layer.
    this.map.createPane('census');
    this.map.getPane('census').style.zIndex = '240';
    // Hazard tiles go in their own pane just above the basemap, so they cover
    // the streets but stay under every marker, label and rail line.
    this.map.createPane('hazard');
    this.map.getPane('hazard').style.zIndex = '250';
    // Dedicated pane above the marker/icon pane so listing dots always sit on top
    // of the OSM POI icons (SVG overlays otherwise render below marker icons).
    this.map.createPane('listings');
    this.map.getPane('listings').style.zIndex = '650';
    this.markerLayer = this.L.layerGroup().addTo(this.map);
    this.renderPois();
    // Some hazard layers only exist at high zoom — track zoom to warn about it.
    this.mapZoom = this.map.getZoom();
    this.map.on('zoomend', () => this.zone.run(() => {
      this.mapZoom = this.map.getZoom();
      // The fan is laid out in screen pixels, so it no longer lines up after a
      // zoom — drop it rather than leave legs pointing at the wrong places.
      this.collapseSpider();
    }));
    this.map.on('click', () => this.zone.run(() => this.collapseSpider()));
    this.hazardLayers.filter(h => h.enabled).forEach(h => this.applyHazard(h));
  }

  // --- hazard overlays ---
  toggleHazard(h: any): void {
    h.enabled = !h.enabled;
    this.applyHazard(h);
  }

  private applyHazard(h: any): void {
    if (!this.map || !this.L) return;
    if (h.enabled) {
      if (this.hazardTiles[h.key]) return;
      const attr = h.source === 'gsi'
        ? '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>'
        : '<a href="https://disaportal.gsi.go.jp/">ハザードマップポータル</a>';
      this.hazardTiles[h.key] = h.urls.map((u: string) => this.L.tileLayer(u, {
        pane: 'hazard', opacity: this.hazardOpacity, attribution: attr, maxZoom: 20,
        minZoom: h.minZoom || 0, maxNativeZoom: h.maxNativeZoom,
        // Uncovered areas 404 — draw nothing instead of a broken-image icon.
        errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      }).addTo(this.map));
    } else {
      (this.hazardTiles[h.key] || []).forEach((l: any) => this.map.removeLayer(l));
      delete this.hazardTiles[h.key];
    }
  }

  setHazardOpacity(): void {
    Object.values(this.hazardTiles).forEach(
      layers => layers.forEach((l: any) => l.setOpacity(this.hazardOpacity)));
  }

  activeHazards(): any[] {
    return this.hazardLayers.filter(h => h.enabled);
  }

  hasHazardLegend(kind: string): boolean {
    return this.hazardLayers.some(h => h.enabled && h.legend === kind);
  }

  // Layers published only at high zoom disappear when zoomed out — say so.
  hiddenHazards(): any[] {
    return this.hazardLayers.filter(h => h.enabled && h.minZoom && this.mapZoom < h.minZoom);
  }

  // Legends with too many classes to keep permanently open (土地条件図's 21
  // classes, 治水地形分類図's full legend sheet) start collapsed.
  openLegends: Record<string, boolean> = {};
  toggleLegend(key: string): void {
    this.openLegends[key] = !this.openLegends[key];
  }

  clearHazards(): void {
    this.hazardLayers.forEach(h => { h.enabled = false; this.applyHazard(h); });
  }

  // --- census choropleth ---

  private statsOf(props: any): BlockStats | null {
    return this.censusStats?.[props.KEY_CODE] ?? null;
  }

  /** Percentage of the summed `parts` out of `total`, or null if anything is withheld. */
  private blockShare(props: any, total: keyof BlockStats, ...parts: (keyof BlockStats)[]): number | null {
    const s = this.statsOf(props);
    if (!s) return null;
    const denom = s[total];
    if (!denom) return null;
    let sum = 0;
    for (const part of parts) {
      if (s[part] === null) return null;
      sum += s[part]!;
    }
    return (sum / denom) * 100;
  }

  /**
   * Age shares divide by the population of *known* age. Tokyo's 年齢不詳 count
   * is large, so dividing by the headline population would understate every
   * band by roughly three points.
   */
  private ageShare(props: any, ...bands: (keyof BlockStats)[]): number | null {
    const s = this.statsOf(props);
    if (!s) return null;
    if (s.age_0_14 === null || s.age_15_64 === null || s.age_65 === null) return null;
    const known = s.age_0_14 + s.age_15_64 + s.age_65;
    if (!known) return null;
    let sum = 0;
    for (const band of bands) {
      if (s[band] === null) return null;
      sum += s[band]!;
    }
    return (sum / known) * 100;
  }

  censusGroups(): string[] {
    return [...new Set(this.censusLayers.map(l => l.group))];
  }

  censusIn(group: string): CensusLayer[] {
    return this.censusLayers.filter(l => l.group === group);
  }

  activeCensusLayer(): CensusLayer | null {
    return this.censusLayers.find(l => l.key === this.activeCensus) || null;
  }

  formatCensus(layer: CensusLayer, v: number): string {
    if (layer.unit === 'yen') return '¥' + Math.round(v).toLocaleString('en-US');
    if (layer.unit === 'pct') return v.toFixed(1) + '%';
    return Math.round(v).toLocaleString('en-US');
  }

  /** Legend rows, highest bucket first, skipping classes nothing falls into. */
  censusLegendRows(layer: CensusLayer): { color: string; label: string }[] {
    const palette = layer.palette || this.CENSUS_RAMP;
    const rows: { color: string; label: string }[] = [];
    for (let i = palette.length - 1; i >= 0; i--) {
      if (layer.bucketCounts && !layer.bucketCounts[i]) continue;
      const label =
        i === 0 ? `< ${this.formatCensus(layer, layer.breaks[0])}`
        : i === layer.breaks.length ? `${this.formatCensus(layer, layer.breaks[i - 1])}+`
        : `${this.formatCensus(layer, layer.breaks[i - 1])} – ${this.formatCensus(layer, layer.breaks[i])}`;
      rows.push({ color: palette[i], label });
    }
    if (layer.noDataCount) rows.push({ color: this.CENSUS_NO_DATA, label: 'withheld / no residents' });
    return rows;
  }

  async toggleCensus(layer: CensusLayer): Promise<void> {
    if (this.activeCensus === layer.key) { this.clearCensus(); return; }
    this.activeCensus = layer.key;
    this.censusMsg = '';

    if (!this.censusGeo) {
      // ~11 MB of boundaries + counts, so it is only fetched once the user asks
      // for a census layer rather than on every visit to the Report tab.
      this.censusLoading = true;
      try {
        const [geo, stats] = await Promise.all([
          firstValueFrom(this.http.get<any[]>('plo.json')),
          firstValueFrom(this.http.get<any>('chome-stats.json')),
        ]);
        this.censusGeo = geo;
        this.censusStats = stats.blocks;
        this.censusMeta = stats.meta;
        this.computeCensusBreaks();
      } catch {
        this.censusLoading = false;
        this.activeCensus = null;
        this.censusMsg = 'could not load the census data (plo.json / chome-stats.json)';
        return;
      }
      this.censusLoading = false;
    }

    this.renderCensus();
  }

  clearCensus(): void {
    this.activeCensus = null;
    if (this.censusLayer && this.map) this.map.removeLayer(this.censusLayer);
    this.censusLayer = null;
  }

  setCensusOpacity(): void {
    this.censusLayer?.setStyle((f: any) => this.censusStyle(f));
  }

  private computeCensusBreaks(): void {
    const all = (this.censusGeo || []).map(f => f.properties);
    for (const layer of this.censusLayers) {
      const raw = all.map(p => layer.value(p));
      const values = raw
        .filter((v): v is number => v !== null && !isNaN(v))
        .sort((a, b) => a - b);
      if (!values.length) continue;

      if (layer.mode === 'quantile') {
        // Five cutoffs -> six equal-count buckets.
        layer.breaks = [1, 2, 3, 4, 5].map(i => values[Math.floor((i / 6) * (values.length - 1))]);
      }

      const palette = layer.palette || this.CENSUS_RAMP;
      const counts = new Array(palette.length).fill(0);
      for (const v of values) counts[this.censusBucket(layer, v)]++;
      layer.bucketCounts = counts;
      layer.noDataCount = raw.length - values.length;
    }
  }

  private censusBucket(layer: CensusLayer, value: number): number {
    for (let i = 0; i < layer.breaks.length; i++) {
      if (value <= layer.breaks[i]) return i;
    }
    return (layer.palette || this.CENSUS_RAMP).length - 1;
  }

  private censusStyle(feature: any): any {
    const layer = this.activeCensusLayer();
    if (!layer) return {};
    const value = layer.value(feature.properties);
    const palette = layer.palette || this.CENSUS_RAMP;
    return {
      fillColor: value === null || isNaN(value)
        ? this.CENSUS_NO_DATA : palette[this.censusBucket(layer, value)],
      fillOpacity: this.censusOpacity,
      color: '#fff', weight: 0.5, opacity: 0.6,
    };
  }

  private renderCensus(): void {
    if (!this.map || !this.L || !this.censusGeo) return;
    const layer = this.activeCensusLayer();
    if (!layer) return;

    if (this.censusLayer) {
      // Same geometry, different colours — restyle rather than rebuild 3,039
      // polygons every time the layer changes.
      this.censusLayer.setStyle((f: any) => this.censusStyle(f));
      this.censusLayer.eachLayer((l: any) => l.setTooltipContent(this.censusTooltip(l.feature.properties)));
      return;
    }

    this.censusLayer = this.L.geoJSON(this.censusGeo, {
      pane: 'census',
      style: (f: any) => this.censusStyle(f),
      onEachFeature: (feature: any, lyr: any) => {
        lyr.bindTooltip(this.censusTooltip(feature.properties), { sticky: true, className: 'census-tip' });
      },
    }).addTo(this.map);
  }

  private censusTooltip(props: any): string {
    const layer = this.activeCensusLayer();
    if (!layer) return '';
    const v = layer.value(props);
    const shown = v === null || isNaN(v) ? '—' : this.formatCensus(layer, v);
    return `<b>${props.S_NAME || ''}</b><br>${props.CITY_NAME || ''}` +
           `<br><span class="census-tip-v">${shown}</span>` +
           `<span class="census-tip-k"> ${layer.legendTitle}</span>`;
  }

  private renderPois(): void {
    if (!this.map || this.poiLayer) return;   // POIs are static → add once
    this.poiLayer = this.L.layerGroup().addTo(this.map);
    for (const p of this.pois) {
      this.L.marker([p.lat, p.lng], {
        icon: this.L.divIcon({ className: 'poi-icon', html: p.icon, iconSize: [22, 22] }),
        zIndexOffset: 1000, interactive: true,
      }).bindTooltip(p.name, { permanent: true, direction: 'right', className: 'poi-label', offset: [12, 0] })
        .addTo(this.poiLayer);
    }
  }

  loadMap(): void {
    const f: Filters = {
      categories: this.mapForm.category ? [this.mapForm.category] : [],
      wards: this.mapForm.ward ? [this.mapForm.ward] : [],
      eras: [...this.mapEras],
      commute_max: this.mapForm.commuteMax,
      limit: 5000,
    };
    // Pinning both bounds to one day narrows "latest snapshot per property" to
    // that single crawl, so the map shows what was on the market that morning.
    if (this.mapForm.date) {
      f.date_from = this.mapForm.date;
      f.date_to = this.mapForm.date;
    }
    this.api.mapData(f).subscribe({
      next: res => { this.mapPoints = res.points; this.mapLoaded = true; this.renderMarkers(); },
      error: () => {},
    });
  }

  // --- export search results for Google My Maps -----------------------------
  // Google Maps proper can't bulk-import points; My Maps (mymaps.google.com)
  // imports CSV and KML. Both export exactly the rows the Search tab is showing.
  // KML needs coordinates, so it covers the detail-enriched subset only; CSV
  // takes every row and leans on `address` for My Maps to geocode.
  exportMsg = '';

  private download(filename: string, mime: string, text: string): void {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Filename stem describing the current search filters (kanji wards kept). */
  private exportStem(): string {
    const f = this.searchForm;
    return ['listings', f.category, f.ward, f.date_to || 'latest']
      .filter(Boolean).join('-').replace(/[\\/:*?"<>|\s]+/g, '_');
  }

  /** How many search rows carry coordinates — i.e. how many KML can plot. */
  geocodedCount(): number {
    return this.searchRows.filter(r => r.lat != null && r.lng != null).length;
  }

  private ppm2Num(r: Listing): number | null {
    const a = this.area(r);
    return (r.price_yen && a) ? Math.round(r.price_yen / a) : null;
  }

  private csvName(r: Listing): string {
    return `${r.price_raw || this.fmtYen(r.price_yen)}${r.layout ? ' ' + r.layout : ''}`;
  }

  exportCsv(): void {
    const rows = this.searchRows;
    if (!rows.length) { this.exportMsg = 'nothing to export — run a search first'; return; }
    const cols: [string, (r: Listing) => any][] = [
      ['name', r => this.csvName(r)],
      ['lat', r => r.lat],
      ['lng', r => r.lng],
      ['address', r => r.address],
      ['ward', r => r.ward],
      ['category', r => r.category],
      ['price_yen', r => r.price_yen],
      ['price', r => r.price_raw || this.fmtYen(r.price_yen)],
      ['layout', r => r.layout],
      ['building_m2', r => r.building_m2],
      ['land_m2', r => r.land_m2],
      ['yen_per_m2', r => this.ppm2Num(r)],
      ['walk_min', r => r.nearest_walk_min],
      ['age_years', r => r.age_years],
      ['station', r => r.station_raw],
      ['km_to_ref', r => (r.lat != null && r.lng != null)
        ? this.distanceToRef(r.lat, r.lng).toFixed(2) : null],
      ['title', r => r.title],
      ['url', r => r.url],
      ['route_url', r => (r.lat != null && r.lng != null) ? this.routeUrl(r) : null],
    ];
    // RFC 4180 quoting; My Maps reads UTF-8 without a BOM.
    const q = (v: any) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.map(c => c[0]).join(',')]
      .concat(rows.map(r => cols.map(c => q(c[1](r))).join(',')))
      .join('\r\n');
    this.download(`${this.exportStem()}.csv`, 'text/csv;charset=utf-8', csv);
    const geo = this.geocodedCount();
    this.exportMsg = `${rows.length} row(s) → CSV. In My Maps: Import, then pick ` +
      (geo === rows.length ? 'lat/lng as the position columns' :
        `lat/lng as the position columns (${rows.length - geo} row(s) have none — ` +
        'use address instead to let Google geocode them)') + ' and name as the title.';
  }

  /** #rrggbb → KML's aabbggrr. */
  private kmlColor(hex: string): string {
    const h = hex.replace('#', '');
    return 'ff' + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
  }

  exportKml(): void {
    const rows = this.searchRows.filter(r => r.lat != null && r.lng != null);
    if (!rows.length) {
      this.exportMsg = this.searchRows.length
        ? 'no coordinates in these results — KML needs them. Fetch 📍 details on the ' +
          'rows you want (or export CSV and let My Maps geocode the addresses).'
        : 'nothing to export — run a search first';
      return;
    }
    const x = (s: any) => this.esc(s).replace(/'/g, '&apos;');
    // CDATA can't contain its own terminator; nothing else needs escaping there.
    const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]&gt;')}]]>`;
    const ref = this.refPoi();

    // One folder per category: My Maps turns each into its own layer, which also
    // keeps big exports under its 2,000-features-per-layer ceiling.
    const byCat = new Map<string, Listing[]>();
    for (const r of rows) (byCat.get(r.category) || byCat.set(r.category, []).get(r.category)!).push(r);

    const styles = this.catColors.map(c =>
      `<Style id="cat-${x(c.key)}"><IconStyle><color>${this.kmlColor(c.color)}</color>` +
      `<scale>1.1</scale><Icon><href>https://maps.google.com/mapfiles/kml/shapes/placemark_circle.png` +
      `</href></Icon></IconStyle></Style>`).join('\n');

    const placemark = (r: Listing) => {
      const ppm2 = this.ppm2Num(r);
      const facts: [string, any][] = [
        ['price', r.price_raw || this.fmtYen(r.price_yen)],
        ['layout', r.layout], ['building m²', r.building_m2], ['land m²', r.land_m2],
        ['¥/m²', ppm2 ? ppm2.toLocaleString() : null],
        ['walk to station', r.nearest_walk_min != null ? `${r.nearest_walk_min} min` : null],
        ['age', r.age_years != null ? `${r.age_years} yr` : null],
        ['km to ' + ref.name, this.distanceToRef(r.lat!, r.lng!).toFixed(1)],
        ['ward', r.ward], ['address', r.address],
      ];
      const html =
        facts.filter(e => e[1] != null && e[1] !== '')
          .map(e => `<b>${this.esc(e[0])}:</b> ${this.esc(e[1])}<br>`).join('') +
        `<a href="${this.esc(r.url)}">open on SUUMO</a> · ` +
        `<a href="${this.esc(this.routeUrl(r))}">route to ${this.esc(ref.name)}</a>`;
      return `<Placemark>
  <name>${x(this.csvName(r))}</name>
  <styleUrl>#cat-${x(r.category)}</styleUrl>
  <description>${cdata(html)}</description>
  <Point><coordinates>${r.lng},${r.lat},0</coordinates></Point>
</Placemark>`;
    };

    const folders = [...byCat.entries()].map(([cat, pts]) => {
      const label = this.catColors.find(c => c.key === cat)?.label || cat;
      return `<Folder><name>${x(label)} (${pts.length})</name>\n${pts.map(placemark).join('\n')}\n</Folder>`;
    }).join('\n');

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
<name>${x(this.exportStem())}</name>
<description>${cdata(`${rows.length} SUUMO listings`)}</description>
${styles}
<Folder><name>${x(ref.icon + ' ' + ref.name)}</name>
  <Placemark><name>${x(ref.name)}</name>
    <Point><coordinates>${ref.lng},${ref.lat},0</coordinates></Point></Placemark>
</Folder>
${folders}
</Document>
</kml>`;
    this.download(`${this.exportStem()}.kml`, 'application/vnd.google-earth.kml+xml', kml);
    const skipped = this.searchRows.length - rows.length;
    const over = [...byCat.values()].filter(v => v.length > 2000).length;
    this.exportMsg = `${rows.length} listing(s) in ${byCat.size} layer(s) → KML` +
      (skipped ? `, ${skipped} skipped for having no coordinates` : '') + '. ' +
      (over ? `⚠️ ${over} category exceeds My Maps' 2,000-per-layer limit and will be truncated on import. ` : '') +
      'Import it into My Maps and the colours and popups come across as-is.';
  }
  refPoi(): { name: string; lat: number; lng: number; icon: string } {
    return this.pois.find(p => p.name === this.refPoiName) || this.pois[0];
  }

  // Straight-line (haversine) km from a point to the current reference landmark.
  // Approximate by design — most SUUMO coords are only chome-accurate.
  distanceToRef(lat: number, lng: number): number {
    const ref = this.refPoi();
    const R = 6371, rad = (d: number) => d * Math.PI / 180;
    const dLat = rad(ref.lat - lat), dLng = rad(ref.lng - lng);
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(lat)) * Math.cos(rad(ref.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  renderMarkers(): void {
    if (!this.map || !this.markerLayer) return;
    this.markerLayer.clearLayers();
    this.spiderfied = null;

    // Agents routinely list the same property, so a single set of coordinates
    // can carry half a dozen listings — drawn naively they stack and all but
    // the top one become unclickable. Group by exact position instead.
    const groups = new Map<string, MapPoint[]>();
    for (const p of this.mapPoints) {
      if (p.lat == null || p.lng == null) continue;
      const key = `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
      (groups.get(key) || groups.set(key, []).get(key)!).push(p);
    }

    for (const points of groups.values()) {
      if (points.length === 1) {
        this.listingMarker(points[0]).addTo(this.markerLayer);
      } else {
        this.clusterMarker(points).addTo(this.markerLayer);
      }
    }
    // Stays centered on the Lycée (set at map init) rather than fitting to all listings.
  }

  /** One listing: a coloured dot with its detail popup. */
  private listingMarker(p: MapPoint, radius = 7): any {
    const marker = this.L.circleMarker([p.lat, p.lng], {
      pane: 'listings', radius, weight: 2.5, color: '#ffffff', opacity: 1,
      fillColor: this.pointColor(p), fillOpacity: 1, className: 'listing-dot',
    }).bindPopup(this.popupHtml(p));
    // Wire the popup's "See all details" button back into Angular.
    marker.on('popupopen', (e: any) => {
      const root = e.popup.getElement();
      const btn = root?.querySelector('.allbtn');
      if (btn) btn.onclick = () => this.zone.run(() => this.openDetails(p));
      const cmp = root?.querySelector('.cmpbtn');
      if (cmp) cmp.onclick = () => this.zone.run(() => {
        this.toggleCompare(p);
        this.map?.closePopup();
      });
    });
    return marker;
  }

  /**
   * Several listings at one position: a badge showing how many, which fans them
   * out into a ring on click ("spiderfy") so each becomes individually
   * clickable. Clicking the badge again — or opening another one — collapses it.
   */
  private clusterMarker(points: MapPoint[]): any {
    const [lat, lng] = [points[0].lat, points[0].lng];
    // Mixed groups read as grey; a uniform one keeps its colour — under
    // whichever dimension the dots are currently coloured by.
    const shades = new Set(points.map(p => this.pointColor(p)));
    const color = shades.size === 1 ? this.pointColor(points[0]) : '#6b7280';

    const badge = this.L.marker([lat, lng], {
      pane: 'listings',
      icon: this.L.divIcon({
        className: 'cluster-dot',
        html: `<span style="background:${color}">${points.length}</span>`,
        iconSize: [26, 26], iconAnchor: [13, 13],
      }),
    });
    badge.on('click', () => this.zone.run(() => this.toggleSpider(points)));
    return badge;
  }

  private toggleSpider(points: MapPoint[]): void {
    const key = `${points[0].lat},${points[0].lng}`;
    // Note the state has to be read *before* collapsing, which resets it —
    // otherwise a second click on the same badge reopens instead of closing.
    const wasOpen = this.spiderfied === key;
    this.collapseSpider();
    if (wasOpen) return;

    this.spiderfied = key;
    this.spiderLayer = this.L.layerGroup().addTo(this.map);

    // Radius in pixels, converted to a lat/lng offset at the current zoom so
    // the ring keeps its on-screen size however far you are zoomed in.
    const centre = this.map.latLngToLayerPoint([points[0].lat, points[0].lng]);
    const radius = 18 + points.length * 4;

    points.forEach((p, i) => {
      const angle = (2 * Math.PI * i) / points.length - Math.PI / 2;
      const offset = this.L.point(centre.x + radius * Math.cos(angle),
                                  centre.y + radius * Math.sin(angle));
      const latlng = this.map.layerPointToLatLng(offset);

      this.L.polyline([[p.lat, p.lng], latlng], {
        pane: 'listings', color: '#94a3b8', weight: 1.5, opacity: 0.8,
      }).addTo(this.spiderLayer);

      const leg = this.listingMarker({ ...p, lat: latlng.lat, lng: latlng.lng }, 8);
      leg.addTo(this.spiderLayer);
    });
  }

  private collapseSpider(): void {
    if (this.spiderLayer) {
      this.map.removeLayer(this.spiderLayer);
      this.spiderLayer = null;
    }
    this.spiderfied = null;
  }

  /** 中古一戸建て rather than used_house — the diff tables are read at a glance. */
  catLabel(category: string): string {
    return (this.config?.categories || []).find(c => c.key === category)?.label
        || this.catColors.find(c => c.key === category)?.label
        || category;
  }

  catColor(category: string): string {
    return this.catColors.find(c => c.key === category)?.color || '#6b7280';
  }

  /** Dot colour under the active `colorBy` mode. Grey = unknown era. */
  pointColor(p: MapPoint): string {
    if (this.colorBy === 'era') return p.era ? ERA_META[p.era].color : '#9ca3af';
    return this.catColor(p.category);
  }

  // --- compare -------------------------------------------------------------

  isCompared(id: string): boolean {
    return this.compareSel.some(s => s.property_id === id);
  }

  /** A comparison is being assembled — the map turns into a picker. */
  compareMode(): boolean {
    return this.compareSel.length > 0;
  }

  /** Add/remove a listing from the tray. Picking a third replaces the oldest,
   * which beats making the user hunt for the deselect. */
  toggleCompare(r: { property_id: string; title?: string | null; category?: string;
                     market?: string; price_raw?: string | null }): void {
    if (this.isCompared(r.property_id)) {
      this.compareSel = this.compareSel.filter(s => s.property_id !== r.property_id);
    } else {
      const slot = {
        property_id: r.property_id,
        label: (r.title || r.category || r.property_id).slice(0, 40),
        market: r.market || '',
        category: r.category || '',
        price_raw: r.price_raw ?? null,
      };
      this.compareSel = [...this.compareSel, slot].slice(-this.COMPARE_MAX);
    }
    this.compareResult = null;
    this.compareError = '';
    this.landSizeConfirmed = false;
    if (this.map) this.renderMarkers();   // refresh the ✓ state in open popups
  }

  /** True while a picked plot still needs its build size confirmed. */
  hasLandPick(): boolean {
    return this.compareSel.some(s => s.category === 'land');
  }

  compareReady(): boolean {
    return this.compareSel.length >= 2 && (!this.hasLandPick() || this.landSizeConfirmed);
  }

  confirmLandSize(): void {
    this.landSizeConfirmed = true;
    this.runCompare();
  }

  /** Years offered in the sell-at dropdown. */
  sellYears(): number[] {
    const n = this.compareResult?.options?.[0]?.series?.length ?? 0;
    return Array.from({ length: Math.max(0, n - 1) }, (_, k) => k + 1);
  }

  /** The exit year used for option `i`: the forced one, else its own peak. */
  exitYear(i: number): number {
    if (this.compareSellYear != null) return this.compareSellYear;
    const d = this.compareResult?.verdict?.irr_vs_anchor?.[i];
    return d?.peak_year ?? (this.compareResult?.assumptions?.simulation_years ?? 0);
  }

  /** IRR / NPV against the anchor at that option's exit year. */
  atExit(i: number): { irr: number | null; npv: number } | null {
    const d = this.compareResult?.verdict?.irr_vs_anchor?.[i];
    if (!d) return null;
    const y = this.exitYear(i);
    return d.series.find(p => p.year === y) ?? null;
  }

  /** Recurring monthly cash, and how it compares with the anchor's. */
  monthlyAt(i: number): { own: number; anchor: number; delta: number } | null {
    const res = this.compareResult;
    if (!res) return null;
    const a = res.verdict.anchor_index;
    // Year 1 is the first full year on the steady footing (year 0 carries the
    // move-in / purchase one-offs, reported separately).
    const y = Math.min(1, res.options[i].monthly_costs.length - 1);
    const own = res.options[i].monthly_costs[y];
    const anchor = res.options[a].monthly_costs[y];
    return { own, anchor, delta: own - anchor };
  }

  equityAt(i: number): number {
    const o = this.compareResult?.options?.[i];
    return o ? (o.exit_values[this.exitYear(i)] ?? 0) : 0;
  }

  setAnchor(i: number | null): void {
    this.compareAnchor = i;
    this.runCompare();
  }

  clearCompare(): void {
    this.compareSel = [];
    this.compareAnchor = null;
    this.landSizeConfirmed = false;
    this.compareResult = null;
    this.compareOpen = false;
    if (this.map) this.renderMarkers();
  }

  runCompare(): void {
    if (this.compareSel.length < 2) return;
    if (this.hasLandPick() && !this.landSizeConfirmed) return;
    this.compareOpen = true;
    this.compareLoading = true;
    this.compareError = '';
    this.api.compare(this.compareSel.map(s => s.property_id), this.compareAssumptions,
                     this.mapForm.date || null, this.compareAnchor).subscribe({
      next: res => {
        this.compareLoading = false;
        if (res.error) { this.compareError = res.error; this.compareResult = null; }
        else { this.compareResult = res; }
      },
      error: err => {
        this.compareLoading = false;
        this.compareError = `Comparison failed: ${err.message || err.status || 'unknown error'}`;
      },
    });
  }

  /** The two PV-cost curves as SVG polyline points, plus where they cross. */
  compareChart(): {
    lines: { pts: string; color: string; label: string }[];
    cross: { x: number; y: number; year: number } | null;
    yTicks: { y: number; label: string }[];
    xTicks: { x: number; label: string }[];
    w: number; h: number;
  } | null {
    const opts = this.compareResult?.options;
    if (!opts || opts.length < 2) return null;
    const w = 560, h = 240, padL = 62, padB = 26, padT = 10, padR = 10;
    const years = Math.max(...opts.map(o => o.series.length - 1));
    const vals = opts.flatMap(o => o.series.map(p => p.pv_cost));
    const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0);
    const span = (hi - lo) || 1;
    const X = (t: number) => padL + (t / years) * (w - padL - padR);
    const Y = (v: number) => padT + (1 - (v - lo) / span) * (h - padT - padB);

    const lines = opts.map((o, i) => ({
      pts: o.series.map(p => `${X(p.year).toFixed(1)},${Y(p.pv_cost).toFixed(1)}`).join(' '),
      color: this.COMPARE_COLORS[i % this.COMPARE_COLORS.length],
      label: this.compareShort(o),
    }));

    // Crossover: the first year the option that is currently cheapest changes
    // hands — the answer to "how long do I have to stay for this to pay off".
    // With more than two options that is a lead change anywhere in the field,
    // which is still the same question.
    let cross: { x: number; y: number; year: number } | null = null;
    const leaderAt = (t: number) => {
      let best = 0;
      for (let i = 1; i < opts.length; i++) {
        if ((opts[i].series[t]?.pv_cost ?? -Infinity) > (opts[best].series[t]?.pv_cost ?? -Infinity)) best = i;
      }
      return best;
    };
    const len = Math.min(...opts.map(o => o.series.length));
    for (let t = 1; t < len; t++) {
      if (leaderAt(t) !== leaderAt(t - 1)) {
        cross = { x: X(t), y: Y(opts[leaderAt(t)].series[t].pv_cost), year: t };
        break;
      }
    }
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = lo + f * span;
      return { y: Y(v), label: this.fmtYen(Math.round(v)) };
    });
    const step = years <= 10 ? 2 : years <= 25 ? 5 : 10;
    const xTicks = [];
    for (let t = 0; t <= years; t += step) xTicks.push({ x: X(t), label: String(t) });
    return { lines, cross, yTicks, xTicks, w, h };
  }

  /** Maintenance is charged on land+building, so the headline rate understates
   * what it means for the building — the only part that actually wears out.
   * Show both bases, since the gap between them is entirely the land share. */
  private maintenanceLabel(d: Record<string, any>): string {
    const m = Number(d['maintenance_y1'] || 0);
    const bld = Number(d['house_value'] || 0);
    const total = Number(d['price_yen'] || 0);
    const ofTotal = total ? ` — ${(m / total * 100).toFixed(2)}% of land+building` : '';
    const ofBld = bld ? `, ${(m / bld * 100).toFixed(2)}% of the building` : '';
    return `${this.fmtYen(m)}/yr${ofTotal}${ofBld}`;
  }

  eraColor(e: SeismicEra): string { return ERA_META[e].color; }
  eraShort(e: SeismicEra): string { return ERA_META[e].short; }

  /** The model's own view of a listing, so the numbers are auditable rather
   * than arriving out of a black box. */
  derivedList(o: CompareOption): { k: string; v: string }[] {
    const d = o.derived || {};
    const yen = (v: any) => (v == null ? '—' : this.fmtYen(Number(v)));
    if (d['mode'] === 'rent') {
      return [
        { k: 'monthly rent + 管理費', v: yen(d['monthly_rent']) },
        { k: 'deposit (敷金)', v: yen(d['deposit_yen']) + ' — not charged in the model' },
        { k: 'key money (礼金)', v: yen(d['key_money_yen']) + ' — not charged in the model' },
      ];
    }
    const out = [
      { k: 'asking price', v: yen(d['price_yen']) },
      { k: 'building, as new', v: yen(d['house_value']) },
      { k: 'building, today', v: yen(d['building_now']) },
      { k: 'land (residual)', v: yen(d['land_value']) },
      { k: 'building age', v: `${d['house_age'] ?? '—'} yr of ${d['fully_amortized_age'] ?? '—'} yr useful life` },
      { k: 'down payment', v: yen(d['down_payment']) },
      { k: 'loan principal', v: yen(d['principal']) },
      { k: 'assessed value yr 1 (課税標準)', v: yen(d['assessed_y1']) + ' — 70% of market' },
      { k: 'property tax yr 1', v: yen(d['property_tax_y1']) + '/yr — 固定資産税 1.4% + 都市計画税 0.3%' },
      { k: 'maintenance yr 1', v: this.maintenanceLabel(d) },
      { k: 'acquisition costs', v: yen(d['acquisition_cost']) + ' — 取得税・登記・司法書士' },
      { k: 'loan up-front fee', v: yen(d['loan_upfront_fee']) + ' — 融資手数料/保証料' },
    ];
    if (d['price_was_range']) {
      out.push({ k: '⚠ price', v: 'listing quotes a range — modelled at the midpoint' });
    }
    if (d['age_assumed']) {
      out.push({ k: '⚠ age', v: 'not stated by the listing — modelled as brand new' });
    }
    if (d['note']) out.push({ k: '⚠ note', v: String(d['note']) });
    return out;
  }

  /** IRR of every option against the anchor, year by year. Financing-shaped
   * streams are drawn dashed: their rate is a borrowing cost, so they cannot
   * be read on the same scale as the rest. */
  irrChart(): {
    lines: { pts: string; color: string; label: string; dashed: boolean;
             peak: { x: number; y: number; year: number; irr: number } | null }[];
    zeroY: number; hurdleY: number; hurdlePct: string;
    yTicks: { y: number; label: string }[];
    xTicks: { x: number; label: string }[];
    w: number; h: number;
  } | null {
    const res = this.compareResult;
    if (!res?.verdict?.irr_vs_anchor) return null;
    const entries = Object.entries(res.verdict.irr_vs_anchor)
      .map(([k, v]) => ({ i: +k, d: v }))
      .filter(e => e.d.series.some(p => p.irr != null));
    if (!entries.length) return null;

    const w = 560, h = 240, padL = 52, padB = 26, padT = 12, padR = 10;
    const years = Math.max(...entries.map(e => e.d.series.length - 1));
    const hurdle = res.verdict.hurdle_rate;
    // Early years can be wildly negative; clamp the floor so the useful part
    // of the curve is not squashed into the top pixel row.
    const all = entries.flatMap(e => e.d.series.map(p => p.irr).filter((v): v is number => v != null));
    const hi = Math.max(...all, hurdle, 0);
    const lo = Math.max(Math.min(...all, 0), -Math.max(hi, 0.5));
    const span = (hi - lo) || 1;
    const X = (t: number) => padL + (t / years) * (w - padL - padR);
    const Y = (v: number) => padT + (1 - (Math.min(Math.max(v, lo), hi) - lo) / span) * (h - padT - padB);

    const lines = entries.map(e => {
      const pts = e.d.series.filter(p => p.irr != null)
        .map(p => `${X(p.year).toFixed(1)},${Y(p.irr as number).toFixed(1)}`).join(' ');
      const peak = e.d.peak_year != null && e.d.peak_irr != null
        ? { x: X(e.d.peak_year), y: Y(e.d.peak_irr), year: e.d.peak_year, irr: e.d.peak_irr }
        : null;
      return {
        pts, color: this.COMPARE_COLORS[e.i % this.COMPARE_COLORS.length],
        label: this.compareShort(res.options[e.i]) + (e.d.shape === 'financing' ? ' (financing)' : ''),
        dashed: e.d.shape === 'financing', peak,
      };
    });
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => {
      const v = lo + f * span;
      return { y: Y(v), label: (v * 100).toFixed(0) + '%' };
    });
    const step = years <= 10 ? 2 : years <= 25 ? 5 : 10;
    const xTicks = [];
    for (let t = 0; t <= years; t += step) xTicks.push({ x: X(t), label: String(t) });
    return { lines, zeroY: Y(0), hurdleY: Y(hurdle),
             hurdlePct: (hurdle * 100).toFixed(2), yTicks, xTicks, w, h };
  }

  /** Break down the school commute for a tooltip. */
  commuteTip(r: any): string {
    if (r?.commute_min == null) return 'no cached commute for this listing\u2019s stations';
    const t = r.commute_transfers;
    return `${r.commute_walk_min}′ walk to ${r.commute_from} · ${r.commute_transit_min}′ train`
         + ` · arrive ${r.commute_via}` + (t ? ` · ${t} change${t > 1 ? 's' : ''}` : ' · direct');
  }

  compareShort(o: CompareOption): string {
    return `${o.market === 'rent' ? 'rent' : 'buy'} · ${o.price_raw || this.fmtYen(o.price_yen)}`;
  }

  /** Percent-typed assumption fields, edited as percents but stored as rates. */
  asPct(v: number): number { return Math.round(v * 1000) / 10; }
  setPct(key: keyof CompareAssumptions, pct: any): void {
    (this.compareAssumptions[key] as number) = (Number(pct) || 0) / 100;
  }

  toggleEra(key: SeismicEra): void {
    this.mapEras = this.mapEras.includes(key)
      ? this.mapEras.filter(e => e !== key)
      : [...this.mapEras, key];
    this.loadMap();
  }

  // --- live OSM POIs (supermarkets, clinics) via Overpass, for current view ---
  loadOsmPois(): void {
    if (!this.map) return;
    const b = this.map.getBounds();
    const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    const active = this.osmCats.filter(c => c.enabled);
    if (this.showRail) this.loadRailLines(bbox);
    if (!active.length) {
      this.osmMsg = this.showRail ? 'loading rail lines…' : 'select at least one category';
      if (this.osmLayer) this.osmLayer.clearLayers();
      return;
    }
    const parts = active.flatMap(c => c.filters.map(f => `${f}(${bbox});`)).join('');
    const query = `[out:json][timeout:25];(${parts});out center 800;`;

    this.osmLoading = true;
    this.osmMsg = 'loading from OpenStreetMap…';
    this.http.post<any>('https://overpass-api.de/api/interpreter', query, { responseType: 'json' })
      .subscribe({
        next: res => { this.osmLoading = false; this.renderOsm(res?.elements || []); },
        error: () => { this.osmLoading = false;
          this.osmMsg = 'OSM request failed — the public Overpass endpoint may be busy; try again.'; },
      });
  }

  // Train/subway lines as polylines (line geometry, not points). Excludes yard/
  // siding service tracks. Drawn under the POI icons + listing dots.
  private loadRailLines(bbox: string): void {
    const q = `[out:json][timeout:25];(way["railway"~"^(rail|subway|light_rail|monorail)$"]["service"!~"."](${bbox}););out geom 2500;`;
    this.http.post<any>('https://overpass-api.de/api/interpreter', q, { responseType: 'json' })
      .subscribe({ next: res => this.renderRail(res?.elements || []), error: () => {} });
  }

  private renderRail(ways: any[]): void {
    if (!this.railLayer) this.railLayer = this.L.layerGroup().addTo(this.map);
    this.railLayer.clearLayers();
    for (const w of ways) {
      if (!w.geometry) continue;
      const latlngs = w.geometry.map((g: any) => [g.lat, g.lon]);
      const subway = w.tags?.railway === 'subway';
      const name = w.tags?.name || w.tags?.['name:en'] || (subway ? 'Subway line' : 'Rail line');
      const operator = w.tags?.operator || w.tags?.['operator:en'] || '';
      const popup = `<div class="mappop"><strong>🚃 ${this.esc(name)}</strong>` +
        (operator ? `<br><span style="color:#666">${this.esc(operator)}</span>` : '') + `</div>`;
      // wide transparent hit-line so the thin rail is easy to click…
      this.L.polyline(latlngs, { color: '#000', weight: 12, opacity: 0, interactive: true })
        .bindPopup(popup).addTo(this.railLayer);
      // …with the visible thin line drawn on top (clicks pass through to the hit-line)
      this.L.polyline(latlngs, {
        color: subway ? '#2563eb' : '#7c8698', weight: 2.5, opacity: 0.55, interactive: false,
      }).addTo(this.railLayer);
    }
  }

  // Map an OSM element's tags to one of our categories (for icon + label).
  private osmCatForTags(t: any): { icon: string; label: string } {
    const shop = t?.shop, am = t?.amenity;
    if (shop === 'supermarket') return this.osmCatByKey('supermarket');
    if (shop === 'convenience') return this.osmCatByKey('convenience');
    if (shop === 'chemist' || am === 'pharmacy') return this.osmCatByKey('drugstore');
    if (am === 'school') return this.osmCatByKey('school');
    if (am === 'kindergarten' || am === 'childcare') return this.osmCatByKey('kindergarten');
    if (am === 'hospital' || am === 'clinic' || am === 'doctors') return this.osmCatByKey('hospital');
    if (am === 'post_office') return this.osmCatByKey('post');
    if (am === 'library') return this.osmCatByKey('library');
    if (am === 'bank') return this.osmCatByKey('bank');
    if (t?.railway === 'station' || t?.railway === 'halt') return this.osmCatByKey('station');
    return { icon: '📍', label: 'POI' };
  }
  private osmCatByKey(key: string) {
    return this.osmCats.find(c => c.key === key) || { icon: '📍', label: 'POI' };
  }

  private renderOsm(elements: any[]): void {
    if (!this.osmLayer) this.osmLayer = this.L.layerGroup().addTo(this.map);
    this.osmLayer.clearLayers();
    let n = 0;
    for (const el of elements) {
      const lat = el.lat ?? el.center?.lat;
      const lng = el.lon ?? el.center?.lon;
      if (lat == null || lng == null) continue;
      const cat = this.osmCatForTags(el.tags);
      const name = el.tags?.name || el.tags?.['name:en'] || cat.label;
      const tagAddr = this.osmAddress(el.tags);
      const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
      const gmaps = this.mapsUrl({ lat, lng });
      const html = `<div class="mappop"><strong>${cat.icon} ${this.esc(name)}</strong>` +
        `<br><span class="osm-addr" style="color:#666">${tagAddr ? this.esc(tagAddr) : 'looking up address…'}</span>` +
        `<br><a href="${gmaps}" target="_blank" rel="noopener">open in Google Maps ↗</a></div>`;
      const marker = this.L.marker([lat, lng], {
        icon: this.L.divIcon({ className: 'osm-icon', html: cat.icon, iconSize: [18, 18] }),
      }).bindPopup(html);
      if (!tagAddr) marker.on('popupopen', (e: any) => this.fillOsmAddress(e, lat, lng, key));
      marker.addTo(this.osmLayer);
      n++;
    }
    this.osmMsg = `${n} place${n === 1 ? '' : 's'} in view`;
  }

  // Compose an address from OSM addr:* tags (rare in Japan — usually empty).
  private osmAddress(t: any): string {
    if (!t) return '';
    if (t['addr:full']) return t['addr:full'];
    return ['addr:province', 'addr:city', 'addr:ward', 'addr:quarter',
            'addr:neighbourhood', 'addr:block_number', 'addr:housenumber']
      .map(k => t[k]).filter(Boolean).join('');
  }

  // Lazily reverse-geocode a POI (Nominatim) when its popup opens; cached.
  private geoCache = new Map<string, string>();
  private fillOsmAddress(e: any, lat: number, lng: number, key: string): void {
    const span = e.popup.getElement()?.querySelector('.osm-addr') as HTMLElement | null;
    if (!span || span.dataset['done']) return;
    const set = (t: string) => { span.textContent = t || 'address unavailable'; span.dataset['done'] = '1'; };
    if (this.geoCache.has(key)) { set(this.geoCache.get(key)!); return; }
    this.http.get<any>(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ja`)
      .subscribe({
        next: r => { const a = this.formatNominatim(r); this.geoCache.set(key, a); set(a); },
        error: () => set(''),
      });
  }
  private formatNominatim(r: any): string {
    const a = r?.address || {};
    const parts = [a.state || a.province, a.city || a.town || a.county, a.city_district,
                   a.suburb, a.neighbourhood || a.quarter, a.block_number, a.house_number]
      .filter(Boolean);
    return parts.length ? parts.join('') : String(r?.display_name || '').replace(/,\s*日本$/, '');
  }

  clearOsmPois(): void {
    if (this.osmLayer) this.osmLayer.clearLayers();
    if (this.railLayer) this.railLayer.clearLayers();
    this.osmMsg = '';
  }

  private esc(s: any): string {
    return String(s ?? '').replace(/[&<>"]/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as any)[c]);
  }

  /**
   * "built 1998" when the listing states a build date. Rent cards only ever
   * give an age ("築12年"), so there the year is derived and marked with ~.
   * The year itself comes from the server (build_year_est), so the map and the
   * era filter can never disagree about which side of a revision a listing is.
   */
  private builtLabel(p: MapPoint): string | null {
    if (p.build_year_est == null) return null;
    const tilde = p.build_year == null ? '~' : '';
    const age = p.age_years != null ? ` <span style="color:#999">(築${this.esc(p.age_years)}年)</span>` : '';
    return `built ${tilde}${this.esc(p.build_year_est)}${age}`;
  }

  /** Coloured 耐震基準 chip, with a caveat when the tier isn't certain. */
  private eraBadge(p: MapPoint): string {
    if (!p.era) return '';
    const meta = ERA_META[p.era];
    const why = p.build_year == null
      ? 'year derived from 築N年, so the tier is approximate'
      : 'built on a revision boundary year — the 建築確認 date decides, and listings do not state it';
    const mark = p.era_approx
      ? `<span title="${this.esc(why)}" style="cursor:help"> ≈</span>` : '';
    return `<span style="background:${meta.color};color:#fff;padding:1px 6px;` +
           `border-radius:9px;font-size:11px">${this.esc(meta.short)}${mark}</span> `;
  }

  private popupHtml(p: MapPoint): string {
    const esc = (s: any) => this.esc(s);
    const area = (p.building_m2 || 0) || p.land_m2;
    const ppm2 = (p.price_yen && area) ? Math.round(p.price_yen / area).toLocaleString() + ' ¥/m²' : null;
    const price = esc(p.price_raw || this.fmtYen(p.price_yen));
    // Always surface price + house (building) size + land size when available.
    const bits = [
      p.layout ? esc(p.layout) : null,
      p.building_m2 != null ? `house ${esc(p.building_m2)} m²` : null,
      p.land_m2 != null ? `land ${esc(p.land_m2)} m²` : null,
      p.nearest_walk_min != null ? `${esc(p.nearest_walk_min)} min walk to stn` : null,
      (p as any).commute_min != null
        ? `🎓 ${esc((p as any).commute_min)} min to LFIT` : null,
      this.builtLabel(p),
      ppm2 ? esc(ppm2) : null,
    ].filter(Boolean).join(' · ');
    const ref = this.refPoi();
    const dist = `${ref.icon} ${this.distanceToRef(p.lat, p.lng).toFixed(1)} km to ${esc(ref.name)} <span style="color:#999">(approx.)</span>`;
    const picked = this.isCompared(p.property_id);

    // While a comparison is being assembled the popup is a picker: everything
    // that navigates away from the map would lose the selection in progress,
    // so only the pick/unpick action is offered.
    const actions = this.compareMode()
      ? `<button class="cmpbtn${picked ? ' on' : ''}" type="button">${
           picked ? '✓ picked — click to remove' : '⚖️ Add to comparison'}</button>`
      : `<a href="${esc(p.url)}" target="_blank" rel="noopener">open on SUUMO ↗</a>
         · <a href="${esc(this.routeUrl(p))}" target="_blank" rel="noopener"
              title="Google Maps route from this listing to ${esc(ref.name)} (${esc(this.travelMode)})"
           >🗺️ route to ${esc(ref.name.split(' ')[0])} ↗</a>
         <button class="allbtn" type="button">📋 See all details</button>
         <button class="cmpbtn" type="button">⚖️ Compare</button>`;

    return `<div class="mappop">
      ${this.eraBadge(p)}<strong>${price}</strong> · ${esc(p.category)}<br>
      ${bits}<br>
      <span style="color:#1e5b96">${dist}</span><br>
      <span style="color:#666">${esc(p.address || '')}</span><br>
      ${actions}
    </div>`;
  }

  // Open the full detail sheet for a listing (cached today's snapshot, else fetch).
  openDetails(p: MapPoint): void {
    this.detailModal = { loading: true, point: p };
    this.api.detail(p.url).subscribe({
      next: d => this.detailModal = { point: p, data: d, error: d.error },
      error: () => this.detailModal = { point: p, error: 'request failed — is the local API running?' },
    });
  }

  closeDetails(): void { this.detailModal = null; }

  // Poll jobs + live crawl status every 5s while the dashboard is open, so a
  // running scheduled crawl and its result show up without a manual refresh.
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.loadJobs();
      this.api.crawlStatus().subscribe({ next: s => this.liveStatus = s, error: () => {} });
    }, 5000);
  }

  loadJobs(): void {
    this.api.jobs().subscribe({ next: s => this.sched = s, error: () => {} });
  }

  // --- job form (URL-based) ---
  // Open an empty scheduled-scraper form.
  newJob(): void {
    this.openJobForm(blankJob(), null);
  }

  editJob(j: ScheduledJob): void {
    this.openJobForm({
      name: j.name, mode: 'url', categories: [], wards: [], url: j.url,
      max_pages: j.max_pages, min_delay: j.min_delay, max_delay: j.max_delay,
      interval_minutes: j.interval_minutes, enabled: j.enabled,
    }, j.id);
  }

  private openJobForm(form: JobInput, editingId: string | null): void {
    this.form = form;
    this.editingId = editingId;
    this.freqIsCustom = !this.freqPresets.some(p => p.minutes === form.interval_minutes);
    this.jobMsg = '';
    this.showJobForm = true;
    // reset any prior preview so the form starts clean
    this.previewRows = []; this.previewStats = null; this.previewMeta = ''; this.urlPending = '';
  }

  cancelJob(): void { this.showJobForm = false; this.jobMsg = ''; }

  // Put a starter SUUMO URL into the crawler form (from the quick-link tiles).
  useStarterUrl(url: string): void { this.form.url = url; }

  setFreq(minutes: number): void { this.form.interval_minutes = minutes; this.freqIsCustom = false; }
  setCustomFreq(): void { this.freqIsCustom = true; }

  saveJob(): void {
    if (!this.form.url.trim()) {
      this.jobMsg = 'paste a SUUMO search-results URL'; return;
    }
    this.form.mode = 'url';
    const done = () => { this.showJobForm = false; this.jobMsg = ''; this.loadJobs(); };
    if (this.editingId) {
      this.api.updateJob(this.editingId, this.form).subscribe({ next: done, error: e => this.jobMsg = 'save failed: ' + (e?.message || '') });
    } else {
      this.api.createJob(this.form).subscribe({ next: done, error: e => this.jobMsg = 'save failed: ' + (e?.message || '') });
    }
  }

  runJobNow(j: ScheduledJob): void {
    this.api.runJob(j.id).subscribe({ next: () => this.loadJobs(), error: () => {} });
  }

  toggleJobEnabled(j: ScheduledJob): void {
    this.api.updateJob(j.id, {
      name: j.name, mode: j.mode, categories: j.categories, wards: j.wards, url: j.url,
      max_pages: j.max_pages, min_delay: j.min_delay, max_delay: j.max_delay,
      interval_minutes: j.interval_minutes, enabled: !j.enabled,
    }).subscribe({ next: () => this.loadJobs(), error: () => {} });
  }

  deleteJob(j: ScheduledJob): void {
    if (!confirm(`Delete scheduled scraper “${j.name || j.id}”?`)) return;
    this.api.deleteJob(j.id).subscribe({ next: () => this.loadJobs(), error: () => {} });
  }

  // --- job display helpers ---
  isRunning(j: ScheduledJob): boolean { return this.sched?.running_id === j.id; }

  fmtInterval(mins: number): string {
    const p = this.freqPresets.find(x => x.minutes === mins);
    if (p) return p.label.toLowerCase();
    if (mins % 1440 === 0) return `every ${mins / 1440}d`;
    if (mins % 60 === 0) return `every ${mins / 60}h`;
    return `every ${mins}m`;
  }

  // Shorten a SUUMO URL for display (drop protocol; keep host + key params).
  shortUrl(u: string): string {
    if (!u) return '—';
    return u.replace(/^https?:\/\//, '').replace(/^www\./, '');
  }

  fmtWhen(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // Live-preview the crawler's URL (inside the create/edit form) so you can
  // confirm it returns sensible listings before saving the crawler.
  previewCrawler(): void {
    const url = (this.form.url || '').trim();
    if (!url) { this.urlPending = 'paste a SUUMO search URL to preview'; return; }
    this.urlPreviewing = true;
    this.urlPending = 'fetching live from SUUMO (polite delay)…';
    this.api.previewUrl({ categories: [], wards: [], limit: 300,
                          url, max_pages: 1, persist: false })
      .subscribe({
        next: res => {
          this.urlPreviewing = false;
          if (res.error) { this.urlPending = res.error; return; }
          this.urlPending = '';
          const m = res.meta;
          this.previewMeta = `preview${m ? ' · ' + m.category + '/' + m.ward_label : ''} · ${res.fetched} listings`;
          this.previewStats = res.stats; this.previewRows = res.rows;
        },
        error: err => { this.urlPreviewing = false; this.urlPending = 'request failed — is the local API running? ' + (err?.message || ''); },
      });
  }

  // Search already-crawled listings in the local DB (the Search tab).
  runSearch(): void {
    const s = this.searchForm;
    const f: Filters = {
      categories: s.category ? [s.category] : [],
      wards: s.ward ? [s.ward] : [],
      price_min: s.price_min ?? null,
      price_max: s.price_max ?? null,
      date_from: s.date_from || null,
      date_to: s.date_to || null,
      limit: s.limit || 300,
    };
    this.api.search(f).subscribe({
      next: res => { this.searched = true; this.searchMeta = 'crawled data';
                     this.searchStats = res.stats; this.searchRows = res.rows; },
      error: () => {},
    });
  }

  // --- on-demand property detail (exact location + full specs) ---
  getDetail(r: Listing): void {
    const key = r.property_id;
    const st = this.detailState[key];
    if (st?.data) { st.open = !st.open; return; }   // already fetched → just toggle
    this.detailState[key] = { loading: true, open: true };
    this.api.detail(r.url).subscribe({
      next: d => this.detailState[key] = { loading: false, open: true, data: d, error: d.error },
      error: () => this.detailState[key] = {
        loading: false, open: true, error: 'request failed — is the local API running?' },
    });
  }

  // Takes anything carrying coordinates (PropertyDetail, MapPoint, a POI) so
  // every "open in Google Maps" link on the page is built the same way.
  mapsUrl(d: { lat?: number | null; lng?: number | null }): string {
    return `https://www.google.com/maps/search/?api=1&query=${d.lat},${d.lng}`;
  }

  /**
   * Google Maps directions from a listing to the current reference landmark
   * (the Lycée by default). Coordinates on both ends rather than a place name,
   * so the route matches the pin and the km figure shown in the popup.
   */
  routeUrl(from: { lat?: number | null; lng?: number | null }): string {
    const ref = this.refPoi();
    return 'https://www.google.com/maps/dir/?api=1' +
      `&origin=${from.lat},${from.lng}&destination=${ref.lat},${ref.lng}` +
      `&travelmode=${this.travelMode}`;
  }

  // --- spec-sheet cleaning + curation ---
  // Older enriched rows still have "… ヒント" tooltip text baked into the key
  // (the extractor now strips it at source); clean it here too for those.
  private cleanKey(k: string): string {
    return k.replace(/\s*ヒント\s*$/, '').replace(/[:：]\s*$/, '').trim();
  }
  private normKey(k: string): string {
    return this.cleanKey(k).replace(/[（）()\s・]/g, '');
  }
  private emptyVal(v: string): boolean {
    const t = (v || '').trim();
    return !t || t === '-' || t === '−' || t === 'ー' || t === '—';
  }

  // Important fields, surfaced first: [key matcher, display label].
  private keyFactDefs: [string, string][] = [
    ['所在地', 'Address'], ['交通', 'Access'], ['間取り', 'Layout'],
    ['土地面積', 'Land area'], ['建物面積', 'Building area'],
    ['建ぺい率・容積率', 'Coverage / FAR (建ぺい率・容積率)'], ['用途地域', 'Zoning (用途地域)'],
    ['地目', 'Land category (地目)'], ['土地の権利形態', 'Land rights (権利形態)'],
    ['私道負担・道路', 'Road / private road'], ['接道', 'Frontage road'],
    ['構造・工法', 'Structure (構造)'], ['完成時期', 'Built / completion'],
    ['引渡可能時期', 'Handover'], ['総戸数', 'Total units'], ['取引態様', 'Transaction type'],
  ];
  // Nav / contact-form / company boilerplate to hide from the sheet.
  private specJunk = [
    'お名前', 'メールアドレス', '電話番号', 'ご住所', 'お問い合わせ', 'お問い合せ', '必須',
    'を買う', '借りる', '建てる', '売る', 'リフォームする', '住まいの相談', 'サポート',
    '会社概要', '問い合わせ先', '免許番号', '情報提供日', '次回更新予定日', '取引条件有効期限',
    'イベント情報', '販売スケジュール', '関連リンク', '担当者', '半角', '物件名',
  ];

  // Curated important fields (ordered), only those present with a real value.
  keyFacts(d?: PropertyDetail): { label: string; value: string }[] {
    if (!d?.specs) return [];
    const entries = Object.entries(d.specs);
    const out: { label: string; value: string }[] = [];
    for (const [matcher, label] of this.keyFactDefs) {
      const nm = matcher.replace(/[（）()\s・]/g, '');
      const hit = entries.find(([k, v]) => this.normKey(k).includes(nm) && !this.emptyVal(v));
      if (hit) out.push({ label, value: hit[1] });
    }
    return out;
  }

  private isKeyFact(k: string): boolean {
    const nk = this.normKey(k);
    return this.keyFactDefs.some(([m]) => nk.includes(m.replace(/[（）()\s・]/g, '')));
  }

  // Remaining real fields (cleaned, non-empty, junk-free, not already a key fact).
  otherSpecs(d?: PropertyDetail): { k: string; v: string }[] {
    return this.cleanedSpecs(d).filter(e => !this.isKeyFact(e.k));
  }

  // Cleaned full list (used by the search-results expansion).
  specList(d?: PropertyDetail): { k: string; v: string }[] {
    return this.cleanedSpecs(d);
  }

  private cleanedSpecs(d?: PropertyDetail): { k: string; v: string }[] {
    if (!d?.specs) return [];
    const seen = new Set<string>();
    const out: { k: string; v: string }[] = [];
    for (const [k, v] of Object.entries(d.specs)) {
      if (this.emptyVal(v)) continue;
      const ck = this.cleanKey(k);
      if (!ck || seen.has(ck) || this.specJunk.some(j => ck.includes(j))) continue;
      seen.add(ck);
      out.push({ k: ck, v });
    }
    return out;
  }

  // --- results table sorting (numeric columns) ------------------------------
  // Shared by the Search tab and the crawler preview — only one of those two
  // tables is on screen at a time. A null key means "keep the server's order".
  sortKey: string | null = null;
  sortDir: 1 | -1 = 1;

  /** Value a sortable column compares on; null = blank cell (sinks to bottom). */
  private sortVal(r: Listing, key: string): number | null {
    switch (key) {
      case 'price': return r.price_yen;
      case 'ppm2': {
        const a = this.area(r);
        return (r.price_yen && a) ? r.price_yen / a : null;
      }
      case 'building_m2': return r.building_m2;
      case 'land_m2': return r.land_m2;
      case 'age_years': return r.age_years;
      case 'walk': return r.nearest_walk_min;
      default: return null;
    }
  }

  /** Click cycle on a header: ascending → descending → back to unsorted. */
  toggleSort(key: string): void {
    if (this.sortKey !== key) { this.sortKey = key; this.sortDir = 1; }
    else if (this.sortDir === 1) { this.sortDir = -1; }
    else { this.sortKey = null; this.sortDir = 1; }
  }

  // Memoised so the template gets a stable array reference between change
  // detection passes (a fresh array every check trips *ngFor's dev-mode check).
  private sortCache: { src: Listing[]; key: string; dir: number; out: Listing[] } | null = null;

  sortRows(rows: Listing[]): Listing[] {
    const key = this.sortKey;
    if (!key || !rows || rows.length < 2) return rows;
    const c = this.sortCache;
    if (c && c.src === rows && c.key === key && c.dir === this.sortDir) return c.out;
    const out = [...rows].sort((a, b) => {
      const x = this.sortVal(a, key), y = this.sortVal(b, key);
      if (x == null) return y == null ? 0 : 1;   // blanks last, both directions
      if (y == null) return -1;
      return (x - y) * this.sortDir;
    });
    this.sortCache = { src: rows, key, dir: this.sortDir, out };
    return out;
  }

  /** Arrow shown in a sortable header ('' when that column isn't the sort key). */
  sortArrow(key: string): string {
    if (this.sortKey !== key) return '';
    return this.sortDir === 1 ? '▲' : '▼';
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
}
