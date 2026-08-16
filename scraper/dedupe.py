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


# How far two adverts for one property may differ on floor area. Agents
# transcribe from the same sheet and disagree in the decimals — 102.08 against
# 102.8 for one flat in ジョイナス — while genuinely different units in a
# building differ by several square metres. A tolerance, not a rounding: buckets
# split neighbours that happen to straddle a boundary, which is the mistake the
# coordinate key already made once.
AREA_TOL_M2 = 1.5


def _place_keys(row: dict) -> list[tuple]:
    """Coarse buckets a property might share with its re-posts.

    Two of them, because either can fail alone: an address is what two agents
    copy verbatim from the same source, but they write it differently often
    enough; a pin is precise until one listing is geocoded to the 丁目 centre,
    60 m from its twin. Membership of either bucket only makes two listings
    *candidates* — the areas still have to agree.
    """
    out = []
    addr = (row.get("address") or "").strip()
    price = row.get("price_yen")
    cat = row.get("category") or ""
    if addr and price:
        out.append(("a", cat, addr, price))
    lat, lng = row.get("lat"), row.get("lng")
    if lat is not None and lng is not None and price:
        out.append(("c", cat, f"{lat:.4f}", f"{lng:.4f}", price))
    return out


def _same_size(a: dict, b: dict) -> bool:
    for field in ("building_m2", "land_m2"):
        x, y = a.get(field), b.get(field)
        if x is None and y is None:
            continue
        if x is None or y is None:
            return False
        if abs(float(x) - float(y)) > AREA_TOL_M2:
            return False
    return True


def key(row: dict) -> str | None:
    """A single signature, for callers that want one. Grouping uses more."""
    ks = _place_keys(row)
    return "|".join(str(x) for x in ks[0]) if ks else None


def annotate(rows: list[dict]) -> list[dict]:
    """Attach `dup_key`, `dup_count` and `dup_first`.

    `dup_first` marks one listing per group — the oldest id, which is the one
    that has been on the market longest and so the least likely to vanish — so
    a caller wanting one row per house can filter on it without deciding which.
    """
    # Same place, same price, and sizes that agree within a tolerance.
    parent: dict[int, int] = {}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    for i in range(len(rows)):
        parent[i] = i
    buckets: dict[tuple, list[int]] = {}
    for i, r in enumerate(rows):
        for k in _place_keys(r):
            buckets.setdefault(k, []).append(i)
    for members in buckets.values():
        for a in range(len(members)):
            for b in range(a + 1, len(members)):
                if _same_size(rows[members[a]], rows[members[b]]):
                    union(members[a], members[b])

    # Name each group after the earliest listing in it, not after whichever row
    # the union happened to settle on: the id then depends only on the members,
    # so the same house keeps the same key between one query and the next.
    members_by_root: dict[int, list[int]] = {}
    for i in range(len(rows)):
        members_by_root.setdefault(find(i), []).append(i)
    groups: dict[str, list[dict]] = {}
    for root, members in members_by_root.items():
        oldest = min((rows[i].get("property_id") or "") for i in members)
        k = hashlib.sha1(oldest.encode()).hexdigest()[:12]
        for i in members:
            rows[i]["dup_key"] = k
        groups[k] = [rows[i] for i in members]

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
