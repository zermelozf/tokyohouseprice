"""The same house, listed several times.

Agents post the same property independently, so one house arrives as up to
eight listings with different ids, different photos and slightly different
prose. SUUMO says so itself on its result pages — 583 agency postings behind 99
cards — but the detail pages carry no shared identifier, so the grouping has to
be inferred.

Two listings are candidates when they share a place — the same address, or the
same pin to four decimals — within one category. Coordinates alone are not
enough: a plot and the house built on it share a position, and a building can
have several flats for sale. Sizes and price split those apart:

    dup_key    same place · same sizes · price to the yen      -> one advert
    house_key  same place · same sizes · price within 15%      -> one home

Both are needed, because "the same" means two things. The table folds adverts,
where the price is the fact on the row and must not be swapped for a near one.
Reviewing judges homes: the rent on a flat is cut, or the next agent quotes it
differently, and being asked a second time about the same rooms because of
¥20,000 is exactly what this module exists to prevent.

What agents *do* vary — the layout string (3LDK+S vs 4LDK), the price separator
(6980万円・7280万円 vs 6980万円～7280万円), the title, the photos — is deliberately
in neither key.

This is inference, not fact, so it never merges rows or hides anything: it
attaches group ids, and the app uses them to avoid asking you about the same
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

# How far the *price* of two adverts for one home may differ before they stop
# being the same home. A re-post is not a re-print: the rent on a flat is cut
# between one agent's advert and the next, and the same unit shows up at
# ¥370k, ¥371k and ¥420k in one week. Exact equality was the first rule, and it
# split those into three houses to judge — which is the thing this module
# exists to prevent. Sizes still have to agree to the decimetre, and the two
# have to sit at the same address or pin, so the price is the loosest test of
# the three and not the one carrying the grouping.
PRICE_TOL_PCT = 0.15


def _place_keys(row: dict) -> list[tuple]:
    """Coarse buckets a property might share with its re-posts.

    Two of them, because either can fail alone: an address is what two agents
    copy verbatim from the same source, but they write it differently often
    enough; a pin is precise until one listing is geocoded to the 丁目 centre,
    60 m from its twin. Membership of either bucket only makes two listings
    *candidates* — the sizes and the price still have to agree.

    Price used to be part of the bucket, which meant a listing with no price
    (新築 marked 未定) fell into no bucket at all and was never anyone's copy.
    It is a pairwise test now, so those group on place and size like the rest.
    """
    out = []
    addr = (row.get("address") or "").strip()
    cat = row.get("category") or ""
    if addr:
        out.append(("a", cat, addr))
    lat, lng = row.get("lat"), row.get("lng")
    if lat is not None and lng is not None:
        out.append(("c", cat, f"{lat:.4f}", f"{lng:.4f}"))
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


def _same_price(a: dict, b: dict) -> bool:
    """The same advert: to the yen. Two prices that are merely close are two
    adverts, and the table has to keep saying so — a row folded under another
    shows the price of the one that survives."""
    return a.get("price_yen") == b.get("price_yen")


def _near_price(a: dict, b: dict) -> bool:
    """The same home: prices within PRICE_TOL_PCT. Both unpriced counts as
    agreeing; one priced and one not does not, since nothing was compared."""
    x, y = a.get("price_yen"), b.get("price_yen")
    if x is None or y is None:
        return x is None and y is None
    x, y = float(x), float(y)
    return abs(x - y) <= PRICE_TOL_PCT * max(x, y)


def key(row: dict) -> str | None:
    """A single signature, for callers that want one. Grouping uses more."""
    ks = _place_keys(row)
    return "|".join(str(x) for x in ks[0]) if ks else None


def _group(rows: list[dict], match) -> list[list[int]]:
    """Row indices grouped by `match`, a pairwise "these are the same" test.

    Union-find over the place buckets rather than a sweep over every pair: two
    adverts that share neither an address nor a pin are never candidates, and
    at a few thousand rows that is the difference between instant and not.
    """
    parent: dict[int, int] = {i: i for i in range(len(rows))}

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[max(ri, rj)] = min(ri, rj)

    buckets: dict[tuple, list[int]] = {}
    for i, r in enumerate(rows):
        for k in _place_keys(r):
            buckets.setdefault(k, []).append(i)
    for members in buckets.values():
        for a in range(len(members)):
            for b in range(a + 1, len(members)):
                if match(rows[members[a]], rows[members[b]]):
                    union(members[a], members[b])

    out: dict[int, list[int]] = {}
    for i in range(len(rows)):
        out.setdefault(find(i), []).append(i)
    return list(out.values())


def _name(rows: list[dict], members: list[int]) -> str:
    """Name a group after the earliest listing in it, not after whichever row
    the union happened to settle on: the id then depends only on the members,
    so the same house keeps the same key between one query and the next."""
    oldest = min((rows[i].get("property_id") or "") for i in members)
    return hashlib.sha1(oldest.encode()).hexdigest()[:12]


def _label(rows: list[dict], match, prefix: str) -> None:
    """Group by `match` and write `<prefix>_key/_count/_first/_ids` on each row."""
    for members in _group(rows, match):
        k = _name(rows, members)
        # Oldest first by property id: SUUMO ids increase over time, so the
        # smallest is the earliest posting.
        group = sorted((rows[i] for i in members),
                       key=lambda r: r.get("property_id") or "")
        ids = [r.get("property_id") for r in group]
        for i, r in enumerate(group):
            r[f"{prefix}_key"] = k
            r[f"{prefix}_count"] = len(group)
            r[f"{prefix}_first"] = (i == 0)
            r[f"{prefix}_ids"] = ids


def annotate(rows: list[dict]) -> list[dict]:
    """Attach two groupings, because "the same" means two things here.

    `dup_key` is the same *advert*: place, size and price to the yen. It is
    what the table folds on — eight agents selling one house at one price is
    one row, and the ×N says how many. `dup_count`, `dup_first` (the oldest
    id, so a caller wanting one row per group can filter without choosing) and
    `dup_ids` describe that group.

    `house_key` is the same *home*, whatever it is being advertised at today:
    the same rooms re-listed after a price cut, or by an agent quoting a
    different fee. It is what a verdict travels along and what the review
    queue counts, because judging a home is judging the home — you should not
    be asked again because ¥300,000 became ¥282,000. It is the looser of the
    two, so every advert group sits inside exactly one home group.
    """
    _label(rows, lambda a, b: _same_size(a, b) and _same_price(a, b), "dup")
    _label(rows, lambda a, b: _same_size(a, b) and _near_price(a, b), "house")
    return rows


def spread_verdicts(rows: list[dict]) -> list[dict]:
    """Let a verdict on one posting stand for the home.

    Judging a house is judging the house, not the advert. Without this you meet
    the same property up to eight times in the queue and have to remember what
    you decided the first time.

    It travels along `house_key`, not `dup_key`: an agent who re-posts the same
    flat ¥20,000 cheaper has not built a new one, and the whole point is not to
    be asked twice.

    The copy keeps its own `verdict` empty so nothing is written in your name
    that you did not write; `verdict_via` says which listing the judgement came
    from, and the UI shows it as inherited.
    """
    by_group: dict[str, dict] = {}
    for r in rows:
        k = r.get("house_key") or r.get("dup_key")
        if k and r.get("verdict") and k not in by_group:
            by_group[k] = r
    for r in rows:
        k = r.get("house_key") or r.get("dup_key")
        src = by_group.get(k) if k else None
        if src is not None and src is not r and not r.get("verdict"):
            r["verdict_via"] = {"property_id": src.get("property_id"),
                                "verdict": src.get("verdict")}
            r["effective_verdict"] = src.get("verdict")
        else:
            r["effective_verdict"] = r.get("verdict")
    return rows
