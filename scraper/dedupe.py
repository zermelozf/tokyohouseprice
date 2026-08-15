"""The same house, listed several times.

Agents post the same property independently, so one house arrives as up to
eight listings with different ids, different photos and slightly different
prose. SUUMO says so itself on its result pages — 583 agency postings behind 99
cards — but the detail pages carry no shared identifier, so the grouping has to
be inferred.

The key is what cannot differ between two postings of one house:

    category · exact coordinates · price · building area · land area

Coordinates alone are not enough: a plot and the house built on it share a
position, and a building can have several flats for sale. Price and area split
those apart. What agents *do* vary — the layout string (3LDK+S vs 4LDK), the
price separator (6980万円・7280万円 vs 6980万円～7280万円), the title, the photos —
is deliberately not in the key.

This is inference, not fact, so it never merges rows or hides anything: it
attaches a group id, and the app uses it to avoid asking you about the same
house twice. A wrong grouping costs one listing shown as a copy of another,
which is visible and recoverable; the alternative — reviewing eight postings of
one house — is the thing worth avoiding.
"""
from __future__ import annotations

import hashlib


def key(row: dict) -> str | None:
    """A stable id for the property behind a listing, or None when it cannot be
    told — an un-enriched row with no coordinates is not grouped with anything,
    since guessing from an address alone merges neighbours."""
    lat, lng = row.get("lat"), row.get("lng")
    if lat is None or lng is None:
        return None
    # 4 decimals, about 11 m. Six was too strict: the same building posted by
    # two agents comes back with pins a fraction of a metre apart — 35.7338516
    # against 35.7338544 — and matched on nothing. Combined with price, area and
    # category, 11 m cannot merge two different properties: they would have to
    # be the same size, at the same price, next door to each other.
    parts = (row.get("category") or "", f"{lat:.4f}", f"{lng:.4f}",
             str(row.get("price_yen") or ""), str(row.get("building_m2") or ""),
             str(row.get("land_m2") or ""))
    return hashlib.sha1("|".join(parts).encode()).hexdigest()[:12]


def annotate(rows: list[dict]) -> list[dict]:
    """Attach `dup_key`, `dup_count` and `dup_first`.

    `dup_first` marks one listing per group — the oldest id, which is the one
    that has been on the market longest and so the least likely to vanish — so
    a caller wanting one row per house can filter on it without deciding which.
    """
    groups: dict[str, list[dict]] = {}
    for r in rows:
        k = key(r)
        r["dup_key"] = k
        if k:
            groups.setdefault(k, []).append(r)
    for k, members in groups.items():
        # Oldest first by property id: SUUMO ids increase over time, so the
        # smallest is the earliest posting.
        members.sort(key=lambda r: r.get("property_id") or "")
        for i, r in enumerate(members):
            r["dup_count"] = len(members)
            r["dup_first"] = (i == 0)
            r["dup_ids"] = [m.get("property_id") for m in members]
    for r in rows:
        r.setdefault("dup_count", 1)
        r.setdefault("dup_first", True)
        r.setdefault("dup_ids", [])
    return rows


def spread_verdicts(rows: list[dict]) -> list[dict]:
    """Let a verdict on one posting stand for the house.

    Judging a house is judging the house, not the advert. Without this you meet
    the same property up to eight times in the queue and have to remember what
    you decided the first time.

    The copy keeps its own `verdict` empty so nothing is written in your name
    that you did not write; `verdict_via` says which listing the judgement came
    from, and the UI shows it as inherited.
    """
    by_group: dict[str, dict] = {}
    for r in rows:
        k = r.get("dup_key")
        if k and r.get("verdict") and k not in by_group:
            by_group[k] = r
    for r in rows:
        k = r.get("dup_key")
        src = by_group.get(k) if k else None
        if src is not None and src is not r and not r.get("verdict"):
            r["verdict_via"] = {"property_id": src.get("property_id"),
                                "verdict": src.get("verdict")}
            r["effective_verdict"] = src.get("verdict")
        else:
            r["effective_verdict"] = r.get("verdict")
    return rows
