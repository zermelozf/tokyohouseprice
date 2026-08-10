"""FastAPI router exposing the local SUUMO scraper to the Angular dashboard.

This is LOCAL-ONLY. It is mounted by api.py only when ENABLE_SCRAPER=1, so it
never ships in the Cloud Run deploy. Requires the scraper deps (see
scraper/requirements.txt) installed in the local environment.
"""
from __future__ import annotations

import re
import sys
import threading
from datetime import datetime
from pathlib import Path
from statistics import median
from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

# The scraper package lives at the repo root; make it importable from api/.
REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scraper import detail, gold, preview, query  # noqa: E402
from scraper.config import (  # noqa: E402
    ALL_CATEGORIES, CATEGORIES, DATA_DIR, DB_PATH, WARDS,
)
from scraper.db import init_db  # noqa: E402
from scraper.pipeline import crawl, crawl_url  # noqa: E402
import scraper_scheduler as scheduler  # noqa: E402
from scraper_compare import CompareRequest, compare  # noqa: E402

# Ensure all tables (incl. the on-demand property_detail cache added later)
# exist on an already-created DB, before any endpoint touches them.
init_db().close()

router = APIRouter(prefix="/scraper", tags=["scraper"])


class Filters(BaseModel):
    markets: list[str] = []
    categories: list[str] = []
    wards: list[str] = []
    price_min: Optional[int] = None
    price_max: Optional[int] = None
    bld_min: Optional[float] = None
    bld_max: Optional[float] = None
    land_min: Optional[float] = None
    land_max: Optional[float] = None
    layout: Optional[str] = None
    walk_max: Optional[int] = None
    age_max: Optional[int] = None
    eras: list[str] = []              # 耐震基準 tiers; see query.ERAS
    commute_max: Optional[int] = None # door-to-school minutes; see scraper.commute
    # Total budget. Applied here because SUUMO's own ceiling stops at 1億2千万.
    # For land it is reduced by the cost of the house you would have to build.
    budget_yen: Optional[int] = None
    budget_build_m2: int = 130
    budget_build_cost_m2: int = 250_000
    # Market-specific floors. chintai's own area filter stops at 100m², and a
    # global bld_min would drop every land listing, so these are applied here.
    bld_min_buy: Optional[float] = None
    bld_min_rent: Optional[float] = None        # rental flats
    bld_min_rent_house: Optional[float] = None  # rental houses
    rent_max_yen: Optional[int] = None          # monthly rent ceiling
    # Manual verdicts to keep. 'none' selects the not-yet-reviewed, which is
    # what the review queue asks for.
    verdicts: list[str] = []
    age_max_known: Optional[int] = None   # rows with no stated age are kept
    date_from: Optional[str] = None   # crawled-time window, 'YYYY-MM-DD' inclusive
    date_to: Optional[str] = None
    sort: Optional[str] = None
    limit: int = 300


class PreviewBody(Filters):
    max_pages: int = 1
    persist: bool = False


class CrawlBody(BaseModel):
    categories: list[str] = ALL_CATEGORIES
    wards: list[str]
    max_pages: int = 5


class PreviewUrlBody(Filters):
    url: str
    max_pages: int = 1
    persist: bool = False


class CrawlUrlBody(BaseModel):
    url: str
    max_pages: int = 5


class JobBody(BaseModel):
    """A recurring scheduled crawl. `mode` picks categories+wards or a pasted URL."""
    name: str = ""
    mode: str = "categories"          # "categories" | "url"
    categories: list[str] = []        # empty -> all categories
    wards: list[str] = []
    url: str = ""
    max_pages: int = 5
    min_delay: float = 2.0
    max_delay: float = 4.0
    interval_minutes: int = 1440      # daily
    enabled: bool = True


def _stats(rows: list[dict]) -> dict:
    prices = [r["price_yen"] for r in rows if r.get("price_yen")]
    ppm2 = []
    for r in rows:
        area = (r.get("building_m2") or 0) or r.get("land_m2")
        if r.get("price_yen") and area:
            ppm2.append(r["price_yen"] / area)
    return {
        "count": len(rows),
        "median_price_yen": int(median(prices)) if prices else None,
        "min_price_yen": min(prices) if prices else None,
        "max_price_yen": max(prices) if prices else None,
        "median_price_per_m2": int(median(ppm2)) if ppm2 else None,
    }


@router.get("/options")
def options():
    return {
        "wards": list(WARDS),
        "categories": [{"key": k, "market": v["market"], "label": v["label"]}
                       for k, v in CATEGORIES.items()],
        "eras": [{"key": k, "label": v["label"]} for k, v in query.ERAS.items()],
    }


@router.post("/commute/refresh")
def commute_refresh(only_missing: bool = True):
    """Fetch and cache the school commute for every station seen in the crawl."""
    from scraper import commute
    return {"added": commute.refresh(only_missing=only_missing),
            "table": list(commute.table().values())}


@router.get("/commute")
def commute_table():
    from scraper import commute
    return {"destination": commute.LFIT,
            "walkable_stations": commute.DESTINATIONS,
            "stations": sorted(commute.table().values(), key=lambda r: r["total_min"])}


@router.post("/compare")
def compare_listings(body: CompareRequest):
    """Rent-vs-buy / buy-vs-buy on two picked listings, through the same NPV
    engine as the rent-or-buy article (see scraper_compare)."""
    return compare(body)


class ReviewBody(BaseModel):
    property_id: str
    verdict: Optional[str] = None     # good | maybe | bad; null clears it
    tags: list[str] = []
    note: str = ""


@router.post("/review")
def save_review(body: ReviewBody):
    """Record a manual verdict on one listing."""
    if body.verdict not in (None, "good", "maybe", "bad"):
        return {"error": f"unknown verdict {body.verdict!r}"}
    return query.save_review(body.property_id, body.verdict, body.tags, body.note)


@router.get("/reviews")
def list_reviews():
    rows = list(query.reviews().values())
    counts: dict[str, int] = {}
    for r in rows:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    tags: dict[str, int] = {}
    for r in rows:
        for t in (r["tags"] or "").split(","):
            if t:
                tags[t] = tags.get(t, 0) + 1
    return {"reviews": rows, "counts": counts, "tags": tags}


class SavedFilterBody(BaseModel):
    name: str
    filters: dict


@router.get("/filters")
def list_filters():
    conn = init_db()
    try:
        import json as _json
        return {"filters": [
            {"name": r["name"], "filters": _json.loads(r["filters"] or "{}"),
             "created": r["created"]}
            for r in conn.execute("SELECT * FROM saved_filter ORDER BY created DESC")]}
    finally:
        conn.close()


@router.post("/filters")
def save_filter(body: SavedFilterBody):
    """Store a named preset. The blob is opaque here — the dashboard owns its
    own shape, so adding a control never needs a migration."""
    import json as _json
    from datetime import datetime as _dt
    name = body.name.strip()
    if not name:
        return {"error": "name required"}
    conn = init_db()
    try:
        conn.execute("INSERT OR REPLACE INTO saved_filter (name, filters, created) "
                     "VALUES (?,?,?)",
                     (name, _json.dumps(body.filters, ensure_ascii=False),
                      _dt.now().isoformat()))
        conn.commit()
    finally:
        conn.close()
    return {"saved": name}


@router.delete("/filters/{name}")
def delete_filter(name: str):
    conn = init_db()
    try:
        n = conn.execute("DELETE FROM saved_filter WHERE name = ?", (name,)).rowcount
        conn.commit()
    finally:
        conn.close()
    return {"deleted": n > 0}


@router.get("/summary")
def summary():
    return query.db_summary()


@router.get("/crawl-dates")
def crawl_dates():
    """Every crawl date on record, newest first — the Report tab's date pickers."""
    return {"dates": query.crawl_dates()}


@router.get("/diff")
def crawl_diff(date_from: str, date_to: str):
    """What changed between two crawls: new, gone and edited listings."""
    return query.crawl_diff(date_from, date_to)


@router.post("/search")
def search(f: Filters):
    rows = query.search_db(f.model_dump())
    return {"stats": _stats(rows), "rows": rows}


@router.post("/map")
def map_points(f: Filters):
    """Crawled listings that have an enriched exact location, for the Report map."""
    points = query.map_points(f.model_dump())
    return {"points": points, "mapped": len(points)}


@router.post("/preview")
def preview_endpoint(body: PreviewBody):
    if not body.wards:
        return {"error": "select at least one ward for a live preview"}
    cats = body.categories or ALL_CATEGORIES
    result = preview.run(cats, body.wards, body.model_dump(),
                         max_pages=body.max_pages, persist=body.persist)
    result["stats"] = _stats(result["rows"])
    return result


@router.post("/preview-url")
def preview_url_endpoint(body: PreviewUrlBody):
    if not body.url.strip():
        return {"error": "paste a SUUMO search-results URL"}
    try:
        result = preview.run_url(body.url.strip(), body.model_dump(),
                                 max_pages=body.max_pages, persist=body.persist)
    except ValueError as exc:
        return {"error": str(exc)}
    result["stats"] = _stats(result["rows"])
    return result


@router.get("/trends")
def trends(market: Optional[str] = None, category: Optional[str] = None,
           ward: Optional[str] = None):
    return gold.trends(market, category, ward)


class DetailBody(BaseModel):
    url: str


@router.post("/detail")
def detail_endpoint(body: DetailBody):
    """On-demand: fetch one property's detail page for its exact coordinates.

    Cached in property_detail so each property is fetched at most once. A single
    lightweight GET — runs independently of the (serialised) crawlers.
    """
    url = body.url.strip()
    if not url:
        return {"error": "no url"}
    m = re.search(r"/((?:nc|jnc)_[0-9]+)/", url)
    pid = m.group(1) if m else None
    today = datetime.now().strftime("%Y-%m-%d")
    cached = query.get_detail(pid, today) if pid else None  # today's snapshot
    if cached and cached.get("lat") is not None:
        return {**cached, "cached": True}
    try:
        res = detail.scrape_detail(url)
    except Exception as exc:
        return {"error": f"fetch failed: {exc}"}
    if res.get("lat") is None and not res.get("specs"):
        return {**res, "error": "no data found on the detail page", "cached": False}
    query.save_detail(res, scrape_date=today)  # cache coords + full spec map for today
    out = {**res, "cached": False}
    if res.get("lat") is None:
        out["error"] = "coordinates not found (specs captured)"
    return out


# --- background crawl launcher ---------------------------------------------
# A single lock serialises ALL crawling (manual buttons + scheduled jobs) so we
# never hammer SUUMO with two crawls at once. `_job` mirrors whatever crawl is
# currently running for the dashboard's live status panel.
_crawl_lock = threading.Lock()
_job = {"state": "idle", "started": None, "finished": None,
        "summary": None, "error": None, "source": None}


def _run_crawl(cats: list[str], wards: list[str], max_pages: int) -> None:
    with _crawl_lock:
        _job.update(state="running", started=datetime.now().isoformat(),
                    finished=None, summary=None, error=None, source="manual")
        try:
            summaries = crawl(cats, wards, max_pages=max_pages)
            _job.update(state="done", finished=datetime.now().isoformat(), summary=summaries)
        except Exception as exc:  # surface, don't crash the server
            _job.update(state="error", finished=datetime.now().isoformat(), error=str(exc))


def _run_crawl_url(url: str, max_pages: int) -> None:
    with _crawl_lock:
        _job.update(state="running", started=datetime.now().isoformat(),
                    finished=None, summary=None, error=None, source="manual")
        try:
            summary = crawl_url(url, max_pages=max_pages)
            _job.update(state="done", finished=datetime.now().isoformat(),
                        summary=[summary])
        except Exception as exc:
            _job.update(state="error", finished=datetime.now().isoformat(), error=str(exc))


@router.post("/crawl")
def start_crawl(body: CrawlBody):
    if _job["state"] == "running":
        return {"error": "a crawl is already running", "job": _job}
    cats = body.categories or ALL_CATEGORIES
    threading.Thread(target=_run_crawl, args=(cats, body.wards, body.max_pages),
                     daemon=True).start()
    return {"started": True, "categories": cats, "wards": body.wards,
            "max_pages": body.max_pages}


@router.post("/crawl-url")
def start_crawl_url(body: CrawlUrlBody):
    if _job["state"] == "running":
        return {"error": "a crawl is already running", "job": _job}
    if not body.url.strip():
        return {"error": "paste a SUUMO search-results URL"}
    threading.Thread(target=_run_crawl_url, args=(body.url.strip(), body.max_pages),
                     daemon=True).start()
    return {"started": True, "url": body.url.strip(), "max_pages": body.max_pages}


@router.get("/crawl/status")
def crawl_status():
    return _job


@router.get("/config")
def config():
    """Static scraper configuration shown on the dashboard's Config panel."""
    return {
        "data_dir": str(DATA_DIR),
        "db_path": str(DB_PATH),
        "jobs_path": scheduler.state()["jobs_path"],
        "default_min_delay": 2.0,
        "default_max_delay": 4.0,
        "wards": list(WARDS),
        "categories": [{"key": k, "market": v["market"], "label": v["label"]}
                       for k, v in CATEGORIES.items()],
    }


# --- scheduled recurring crawls --------------------------------------------

def _run_scheduled(job: dict) -> list[dict]:
    """Runner injected into the scheduler. Serialised with manual crawls via the
    shared lock, and mirrored into `_job` so the live status panel shows it too."""
    with _crawl_lock:
        _job.update(state="running", started=datetime.now().isoformat(),
                    finished=None, summary=None, error=None,
                    source=f"schedule:{job.get('name') or job['id']}")
        try:
            if job.get("mode") == "url":
                if not (job.get("url") or "").strip():
                    raise ValueError("job has no URL")
                summary = [crawl_url(job["url"].strip(), max_pages=job["max_pages"],
                                     min_delay=job["min_delay"], max_delay=job["max_delay"])]
            else:
                cats = job.get("categories") or ALL_CATEGORIES
                if not job.get("wards"):
                    raise ValueError("job has no wards")
                summary = crawl(cats, job["wards"], max_pages=job["max_pages"],
                                min_delay=job["min_delay"], max_delay=job["max_delay"])
            _job.update(state="done", finished=datetime.now().isoformat(), summary=summary)
            return summary
        except Exception as exc:
            _job.update(state="error", finished=datetime.now().isoformat(), error=str(exc))
            raise


@router.get("/jobs")
def list_jobs():
    return scheduler.state()


@router.post("/jobs")
def create_job(body: JobBody):
    return scheduler.create(body.model_dump())


@router.patch("/jobs/{job_id}")
def update_job(job_id: str, body: JobBody):
    job = scheduler.update(job_id, body.model_dump())
    return job if job is not None else {"error": "job not found"}


@router.delete("/jobs/{job_id}")
def delete_job(job_id: str):
    return {"deleted": scheduler.delete(job_id)}


@router.post("/jobs/{job_id}/run")
def run_job(job_id: str):
    job = scheduler.trigger(job_id)
    return job if job is not None else {"error": "job not found"}


# Load persisted jobs and start the background scheduler loop as soon as the
# router is imported (i.e. only when ENABLE_SCRAPER=1).
scheduler.start(_run_scheduled)
