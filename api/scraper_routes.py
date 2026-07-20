"""FastAPI router exposing the local SUUMO scraper to the Angular dashboard.

This is LOCAL-ONLY. It is mounted by api.py only when ENABLE_SCRAPER=1, so it
never ships in the Cloud Run deploy. Requires the scraper deps (see
scraper/requirements.txt) installed in the local environment.
"""
from __future__ import annotations

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

from scraper import gold, preview, query  # noqa: E402
from scraper.config import ALL_CATEGORIES, CATEGORIES, WARDS  # noqa: E402
from scraper.pipeline import crawl, crawl_url  # noqa: E402

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
    }


@router.get("/summary")
def summary():
    return query.db_summary()


@router.post("/search")
def search(f: Filters):
    rows = query.search_db(f.model_dump())
    return {"stats": _stats(rows), "rows": rows}


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


# --- background crawl launcher (interactive use only) -----------------------
_job = {"state": "idle", "started": None, "finished": None,
        "summary": None, "error": None}


def _run_crawl(cats: list[str], wards: list[str], max_pages: int) -> None:
    _job.update(state="running", started=datetime.now().isoformat(),
                finished=None, summary=None, error=None)
    try:
        summaries = crawl(cats, wards, max_pages=max_pages)
        _job.update(state="done", finished=datetime.now().isoformat(), summary=summaries)
    except Exception as exc:  # surface, don't crash the server
        _job.update(state="error", finished=datetime.now().isoformat(), error=str(exc))


def _run_crawl_url(url: str, max_pages: int) -> None:
    _job.update(state="running", started=datetime.now().isoformat(),
                finished=None, summary=None, error=None)
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
