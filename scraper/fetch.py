"""HTTP fetching with polite rate-limiting, retries, and a pluggable backend.

Default backend is a direct httpx request. To route through a commercial
anti-bot provider (recommended if you scale up), set:
    SUUMO_FETCH_PROVIDER=zenrows  and  ZENROWS_API_KEY=...
The rest of the pipeline is unaware of which backend is used.
"""
from __future__ import annotations

import os
import time
import random
import logging

import httpx

log = logging.getLogger("suumo.fetch")

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
}


class Fetcher:
    """Polite, retrying HTTP client. Reuse one instance across a crawl."""

    def __init__(self, min_delay: float = 2.0, max_delay: float = 4.0,
                 timeout: float = 30.0, max_retries: int = 3):
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.max_retries = max_retries
        self.provider = os.environ.get("SUUMO_FETCH_PROVIDER", "direct").lower()
        self._client = httpx.Client(headers=HEADERS, timeout=timeout,
                                    follow_redirects=True)
        self._last_request = 0.0

    def _throttle(self) -> None:
        elapsed = time.monotonic() - self._last_request
        wait = random.uniform(self.min_delay, self.max_delay) - elapsed
        if wait > 0:
            time.sleep(wait)

    def _wrap(self, url: str) -> str:
        """Rewrite the target URL for the configured provider."""
        if self.provider == "zenrows":
            key = os.environ["ZENROWS_API_KEY"]
            return f"https://api.zenrows.com/v1/?apikey={key}&url={httpx.QueryParams({'u': url})['u']}"
        return url  # direct

    def get(self, url: str) -> str:
        """Fetch a URL, returning HTML text. Raises on repeated failure."""
        last_exc: Exception | None = None
        for attempt in range(1, self.max_retries + 1):
            self._throttle()
            try:
                target = self._wrap(url)
                resp = self._client.get(target)
                self._last_request = time.monotonic()
                if resp.status_code == 200 and resp.text:
                    return resp.text
                log.warning("GET %s -> HTTP %s (attempt %d)", url, resp.status_code, attempt)
                last_exc = httpx.HTTPStatusError(
                    f"status {resp.status_code}", request=resp.request, response=resp)
            except httpx.HTTPError as exc:  # network/timeout
                self._last_request = time.monotonic()
                log.warning("GET %s failed: %s (attempt %d)", url, exc, attempt)
                last_exc = exc
            time.sleep(min(2 ** attempt, 15))  # backoff between retries
        raise RuntimeError(f"failed to fetch {url} after {self.max_retries} attempts") from last_exc

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Fetcher":
        return self

    def __exit__(self, *exc) -> None:
        self.close()
