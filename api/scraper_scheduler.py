"""Local-only persistent scheduler for recurring SUUMO crawls.

Jobs are stored as JSON under the scraper data dir and run by a single
background thread — one crawl at a time. This is a LOCAL DEV tool, mounted only
when ENABLE_SCRAPER=1 (see scraper_routes / api.py); it never ships to Cloud Run.

The actual crawl is done by a `runner(job) -> summary` callback injected by
scraper_routes, so this module stays decoupled from the scraper pipeline and
reuses the same crawl code (and status/lock) as the manual crawl buttons.
"""
from __future__ import annotations

import json
import threading
import uuid
from datetime import datetime, timedelta
from typing import Callable, Optional

from scraper.config import DATA_DIR

JOBS_PATH = DATA_DIR / "scheduler.json"
TICK_SECONDS = 15  # how often the loop wakes to look for a due job

_lock = threading.RLock()           # guards _jobs and the JSON file
_jobs: list[dict] = []
_running_id: Optional[str] = None   # id of the job the loop is crawling right now
_thread: Optional[threading.Thread] = None
_stop = threading.Event()
_runner: Optional[Callable[[dict], list]] = None

# Persisted, editable fields with their defaults (used to sanitise input).
_DEFAULTS = {
    "name": "",
    "mode": "categories",   # "categories" | "url"
    "categories": [],       # for mode=categories (empty -> all)
    "wards": [],            # for mode=categories
    "url": "",             # for mode=url
    "max_pages": 5,
    "min_delay": 2.0,
    "max_delay": 4.0,
    "interval_minutes": 1440,   # daily
    "enabled": True,
}
# Runtime/result fields the API reports but the client does not set directly.
_RESULT_FIELDS = {
    "created": None, "last_run": None, "last_status": None,
    "last_summary": None, "last_error": None, "last_listings": None,
    "next_run": None,
}


def _now() -> datetime:
    return datetime.now()


def _load() -> None:
    global _jobs
    with _lock:
        if JOBS_PATH.exists():
            try:
                _jobs = json.loads(JOBS_PATH.read_text())
            except Exception:
                _jobs = []
        else:
            _jobs = []


def _save() -> None:
    with _lock:
        JOBS_PATH.parent.mkdir(parents=True, exist_ok=True)
        JOBS_PATH.write_text(json.dumps(_jobs, ensure_ascii=False, indent=2))


def _find(job_id: str) -> Optional[dict]:
    return next((j for j in _jobs if j["id"] == job_id), None)


def _clean(payload: dict) -> dict:
    """Keep only editable fields, coercing to the right types with defaults."""
    out: dict = {}
    for key, default in _DEFAULTS.items():
        val = payload.get(key, default)
        if isinstance(default, bool):
            out[key] = bool(val)
        elif isinstance(default, int):
            try:
                out[key] = max(1, int(val))
            except (TypeError, ValueError):
                out[key] = default
        elif isinstance(default, float):
            try:
                out[key] = float(val)
            except (TypeError, ValueError):
                out[key] = default
        elif isinstance(default, list):
            out[key] = list(val) if isinstance(val, list) else default
        else:
            out[key] = str(val or "").strip()
    return out


def _schedule_next(job: dict, base: Optional[datetime] = None) -> None:
    base = base or _now()
    job["next_run"] = (base + timedelta(minutes=job["interval_minutes"])).isoformat()


# --- public API used by scraper_routes -------------------------------------

def start(runner: Callable[[dict], list]) -> None:
    """Load persisted jobs and start the background loop (idempotent)."""
    global _thread, _runner
    _runner = runner
    _load()
    with _lock:
        if _thread and _thread.is_alive():
            return
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True, name="suumo-scheduler")
        _thread.start()


def state() -> dict:
    """Full scheduler state for the dashboard: all jobs + which is running."""
    with _lock:
        return {
            "jobs": [dict(j) for j in _jobs],
            "running_id": _running_id,
            "tick_seconds": TICK_SECONDS,
            "jobs_path": str(JOBS_PATH),
        }


def create(payload: dict) -> dict:
    job = _clean(payload)
    job["id"] = uuid.uuid4().hex[:12]
    job.update({k: v for k, v in _RESULT_FIELDS.items()})
    job["created"] = _now().isoformat()
    if job["enabled"]:
        _schedule_next(job)
    with _lock:
        _jobs.append(job)
        _save()
    return job


def update(job_id: str, payload: dict) -> Optional[dict]:
    with _lock:
        job = _find(job_id)
        if job is None:
            return None
        was_enabled = job.get("enabled")
        job.update(_clean({**job, **payload}))
        # (Re)schedule when it becomes enabled or the interval changes.
        if job["enabled"] and (not was_enabled or not job.get("next_run")):
            _schedule_next(job)
        elif not job["enabled"]:
            job["next_run"] = None
        _save()
        return dict(job)


def delete(job_id: str) -> bool:
    global _jobs
    with _lock:
        before = len(_jobs)
        _jobs = [j for j in _jobs if j["id"] != job_id]
        _save()
        return len(_jobs) < before


def trigger(job_id: str) -> Optional[dict]:
    """Run-now: mark the job due immediately; the loop picks it up next tick."""
    with _lock:
        job = _find(job_id)
        if job is None:
            return None
        job["next_run"] = _now().isoformat()
        _save()
        return dict(job)


# --- background loop --------------------------------------------------------

def _due_job() -> Optional[dict]:
    now = _now()
    with _lock:
        for job in _jobs:
            if not job.get("enabled") or job["id"] == _running_id:
                continue
            nxt = job.get("next_run")
            if nxt and datetime.fromisoformat(nxt) <= now:
                return dict(job)
    return None


def _finish(job_id: str, status: str, *, summary=None, error=None) -> None:
    with _lock:
        job = _find(job_id)
        if job is None:
            return
        job["last_run"] = _now().isoformat()
        job["last_status"] = status
        job["last_summary"] = summary
        job["last_error"] = error
        job["last_listings"] = (
            sum((s.get("listings") or 0) for s in summary) if summary else 0
        )
        if job.get("enabled"):
            _schedule_next(job)  # from completion time, so runs don't pile up
        _save()


def _loop() -> None:
    while not _stop.wait(TICK_SECONDS):
        job = _due_job()
        if job is None or _runner is None:
            continue
        global _running_id
        _running_id = job["id"]
        try:
            summary = _runner(job)  # blocking crawl; may raise
            _finish(job["id"], "ok", summary=summary or [])
        except Exception as exc:  # keep the loop alive on any failure
            _finish(job["id"], "error", error=str(exc))
        finally:
            _running_id = None
