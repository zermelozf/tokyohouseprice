# SUUMO Scraper

A personal house-hunting data platform: crawl SUUMO listings on a schedule,
store everything, and track price/inventory trends by neighborhood and criteria
over time.

## Medallion architecture

| Layer | What | Where |
|-------|------|-------|
| **Bronze** | Every raw HTML page fetched, gzipped, nothing lost. Plus a fetch manifest (url, time, size, sha256, #cards). | `data/bronze/<source>/<market>/<category>/<ward>/<date>/page_NNN.html.gz` + `fetch_manifest` table |
| **Silver** | Parsed, normalized, typed listings. One row per `(property_id, scrape_date)` → re-scraping a new day appends a snapshot, building a time series. Full raw field map kept in `raw_json`. | `listings_snapshot` table in `data/suumo.db` |
| **Gold** | Trend aggregates (inventory, mean/min/max price, ¥/m²) and price-change detection — plain queries over silver, so they update as snapshots accumulate. | `scraper/gold.py` |

## Coverage

- **Sale**: `used_house` (中古一戸建て), `new_house` (新築一戸建て), `used_mansion` (中古マンション), `land` (土地)
- **Rent**: `rent` (賃貸 — one listing per room)
- **Geography**: all 23 Tokyo special wards (see `config.WARDS`)
- **Known gap**: 新築マンション (new mansion, `bs=010`) is served from a different
  endpoint (`/ms/shinchiku/`) and is not yet wired up.

## Setup

```bash
python3 -m venv .venv
./.venv/bin/pip install -r scraper/requirements.txt
```

## Usage

Run from the repo root so `python -m scraper` resolves.

```bash
# Crawl everything (all sale types + rent) for two wards, 5 pages each
./.venv/bin/python -m scraper crawl --ward setagaya,meguro --max-pages 5

# Just used houses, all 23 wards
./.venv/bin/python -m scraper crawl --category used_house --ward all --max-pages 3

# Sale types only
./.venv/bin/python -m scraper crawl --category sale --ward setagaya

# Crawl a pasted SUUMO search URL — build any search on suumo.jp, copy the
# results-list URL (contains /ichiran/), and crawl it. All filters ride along;
# market/type/ward are read from the URL, ward is refined per-listing by address.
./.venv/bin/python -m scraper crawl-url "https://suumo.jp/jj/bukken/ichiran/JJ012FC001/?ar=030&bs=021&ta=13&sc=13112&et=15" --max-pages 5

# One property, all specs (feature: "scrape a specific property")
./.venv/bin/python -m scraper property https://suumo.jp/chukoikkodate/tokyo/sc_setagaya/nc_20933882/

# Trends and price changes over time (gold)
./.venv/bin/python -m scraper trends --market sale --ward setagaya
./.venv/bin/python -m scraper changes --ward setagaya
```

Categories: `used_house, new_house, used_mansion, land, rent` (or `all` / `sale`).
Wards: keys of `config.WARDS` (or `all`).

## Dashboard (local, on-stack)

The dashboard is **not** a separate app — it's your existing stack, run locally:
- **Backend:** a scraper router mounted into the existing `api/` FastAPI app, enabled
  only when `ENABLE_SCRAPER=1` (kept out of the Cloud Run deploy).
- **Frontend:** an Angular page at `/scraper` in `app/`, registered only in dev
  builds (swapped out of production/localized builds via `angular.json`
  `fileReplacements` → `dev-routes.prod.ts`).

Run it locally on the Mac Studio (two terminals):

```bash
# 1) API — needs both api and scraper deps in one env, plus the flag
pip install -r api/requirements.txt -r scraper/requirements.txt
cd api && ENABLE_SCRAPER=1 uvicorn api:app --reload --port 8000

# 2) Angular dev server
cd app && npm install && npm start        # http://localhost:4200/scraper
```

The page talks to `environment.scraperApiUrl` (`http://localhost:8000`). Use it to
test filter criteria against live SUUMO (**Live preview**), browse already-collected
data (**Search local data**), kick off a full crawl (**Run crawl now**), and view
**Trends**. Endpoints live in `api/scraper_routes.py`.

## Scheduling (build the time series)

Trends need repeated snapshots. The scheduled job runs the **CLI directly** (it does
not depend on the API/dashboard being up). On macOS use `launchd` (native) or cron:

```cron
# cron — daily 06:00
0 6 * * *  cd /path/to/tokyohouseprice && ./.venv/bin/python -m scraper crawl --ward all --max-pages 10 >> scraper/data/crawl.log 2>&1
```

For `launchd`, create a `~/Library/LaunchAgents/com.suumo.crawl.plist` with a
`StartCalendarInterval` that runs the same `python -m scraper crawl …` command.

## Fetching backend (anti-bot)

Default is a direct, polite (2–4s delay, retries/backoff) `httpx` request. If you
scale up and hit blocking, route through a commercial provider without touching
the rest of the pipeline:

```bash
export SUUMO_FETCH_PROVIDER=zenrows
export ZENROWS_API_KEY=...
```

## Notes / caveats

- Scraping SUUMO is against its ToS; keep volume modest and personal. The polite
  delay and single-threaded crawl are intentional.
- Selectors target SUUMO's current markup (`property_unit` for sale,
  `cassetteitem` for rent). If SUUMO changes layout, update `parse_sale.py` /
  `parse_rent.py` — bronze HTML is retained so you can re-parse history.
- `data/` is git-ignored.
