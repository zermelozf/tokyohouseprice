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

## Daily report email

`daily-report` mails the morning summary: which crawlers ran, the diff against
the previous crawl (new / delisted / changed), and a PNG of that day's listings
on a map. It reads the SQLite DB directly, so it needs neither the API nor the
dev server running, and it renders the map without a browser (basemap tiles +
Pillow) so it is safe to run from cron.

```bash
# Are the credentials visible and the sender verified? Sends nothing.
python -m scraper daily-report --check

# Build it without sending — writes the HTML and the map PNG for inspection.
python -m scraper daily-report --dry-run --out /tmp/report.html

# Send it.
python -m scraper daily-report
```

### Where the credentials go

In a project-local `.env` at the repo root — git-ignored, so nothing machine-wide
and nothing committed:

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env          # fill in AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
python -m scraper daily-report --check
```

`scraper/config.py` loads it into `os.environ` before anything reads a variable,
so boto3 and every other consumer pick it up with no extra wiring. Real
environment variables always win over the file, which keeps one-off overrides
working:

```bash
REPORT_TO_EMAIL=someone@else.com python -m scraper daily-report
```

`.env.example` is tracked and documents every variable — keep real values out of
it. Point somewhere else with `SUUMO_ENV_FILE=/path/to/other.env` if needed.

The IAM user needs `ses:SendRawEmail`, plus the read-only `ses:GetIdentity*`,
`ses:GetSendQuota` and `ses:GetAccountSendingEnabled` that `--check` uses.

Delivery is AWS SES in **eu-west-1** — the same account and region datakokoro's
Firebase Trigger Email extension already delivers through
(`email-smtp.eu-west-1.amazonaws.com`). Two transports, because SES API and SES
SMTP take different credentials and you may only hold one of them:

| variable | default | notes |
|---|---|---|
| `REPORT_TO_EMAIL` | `arnaud.rachez@…,ms.estelle.dumas@…` | recipients, comma-separated |
| `REPORT_FROM_EMAIL` | `contact@linalgo.com` | must be a **verified** SES identity in this region |
| `REPORT_DASHBOARD_URL` | `http://stellar-dev/tokyohouseprice/scraper` | where the map image links |
| `SUUMO_ENV_FILE` | `<repo>/.env` | project-local config file |
| `AWS_SES_REGION_NAME` | `eu-west-1` | verification is per-region |
| `REPORT_TRANSPORT` | `ses` | `ses` = boto3 API, `smtp` = SES SMTP endpoint |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | boto3 chain | for `REPORT_TRANSPORT=ses` |
| `SMTP_USER` / `SMTP_PASSWORD` | — | for `REPORT_TRANSPORT=smtp` |
| `SMTP_HOST` / `SMTP_PORT` | `email-smtp.<region>.amazonaws.com` / `465` | |

An SES **SMTP password is derived from** an IAM secret key — they are not the
same string, and having one does not give you the other. Use `smtp` when what
you have is the credential pair the Trigger Email extension was configured with;
use `ses` when you have the IAM access key and secret.

SES rejects any sender that is not a verified identity, and verification is
per-region — an address verified in `us-east-1` will not send from `eu-west-1`.
`--check` reports exactly that, along with whether the account is still in the
SES sandbox (where the *recipient* must be verified too).


```
# cron — daily 08:00. No env vars on the line: `cd` into the repo and .env is
# picked up from there.
0 8 * * * ./.venv/bin/python -m scraper daily-report >> scraper/data/report.log 2>&1
```

Note the ordering: the crawlers currently run at ~12:15–12:35, so an 08:00
report covers **the previous day's** crawl (it always reports the newest crawl
in the DB). To have the morning mail describe that same morning, move the
crawler jobs earlier than 08:00 in the dashboard's Crawlers tab.

If SES is still in sandbox mode the recipient must also be a verified identity;
sending to arbitrary addresses needs production access on the account.

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
