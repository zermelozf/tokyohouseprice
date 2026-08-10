"""Parse a pasted SUUMO search-results URL and paginate it.

The whole point: the user builds a search on SUUMO (any filters — price, area,
walk time, layout, age, keywords, multiple wards…) and pastes the results URL.
We pass every query param through verbatim and only append `&page=N`, so we
never need to understand SUUMO's filter params. We only read the URL to *label*
the data (market / category / ward) for the medallion store.
"""
from __future__ import annotations

from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from .config import WARDS, CATEGORIES

_SC2WARD = {code: key for key, code in WARDS.items()}
_BS2CAT = {v["bs"]: k for k, v in CATEGORIES.items() if v["market"] == "sale"}


def parse_suumo_url(url: str) -> dict:
    """Derive {market, category, parser, wards, ward_label} from a SUUMO URL."""
    p = urlparse(url)
    if "suumo.jp" not in p.netloc or "/ichiran/" not in p.path:
        raise ValueError(
            "Not a SUUMO search-results URL. Open a search on suumo.jp, then copy "
            "the results-list URL (it contains '/ichiran/').")
    q = parse_qs(p.query)
    market = "rent" if "/chintai/" in p.path else "sale"
    parser = "rent" if market == "rent" else "sale"
    bs = (q.get("bs") or [""])[0]
    category = "rent" if market == "rent" else _BS2CAT.get(bs, f"sale_bs{bs or 'na'}")
    wards = [_SC2WARD.get(sc, sc) for sc in q.get("sc", [])]
    ward_label = wards[0] if len(wards) == 1 else ("mixed" if wards else "url")
    return {"market": market, "category": category, "parser": parser,
            "wards": wards, "ward_label": ward_label}


def page_url(url: str, page: int) -> str:
    """Return `url` with `page` set (preserving all other params, incl. repeated sc)."""
    p = urlparse(url)
    q = parse_qs(p.query)
    q.pop("page", None)
    if page > 1:
        q["page"] = [str(page)]
    query = urlencode(q, doseq=True)
    return urlunparse(p._replace(query=query))
