"""Ground and earthquake risk for a listing's exact location.

The hazard map the user works from renders GSI tiles and exposes no query API,
so the numbers behind it come from the authoritative sources directly:

    J-SHIS (防災科学技術研究所)  表層地盤 — 増幅率 (ARV), AVS30, 微地形分類
                                地震動予測 — probability of 震度6弱 in 30 years
    GSI                          elevation, which is the cheapest flood proxy

揺れやすさ is ARV: how much the surface soil amplifies shaking relative to
bedrock. 液状化 has no national point service, but J-SHIS's 微地形分類 is the
input every liquefaction assessment starts from — reclaimed land and valley
floors liquefy, terraces and hills do not — so it is reported as a band with
the landform named, rather than invented as a number.

浸水 and 土砂災害 are NOT computed. Their polygons are municipal and the
national datasets are downloads rather than services, so each listing carries a
deep link to the hazard map at its own coordinates instead.

Results are cached per 250 m mesh, which is the resolution J-SHIS publishes at —
listings in the same mesh genuinely share a value, so this is a cache key rather
than an approximation.
"""
from __future__ import annotations

import json
import logging
import urllib.request
from datetime import datetime

from .db import connect, init_db

log = logging.getLogger("suumo.hazard")

JSHIS_SOIL = ("https://www.j-shis.bosai.go.jp/map/api/sstrct/V2/"
              "meshinfo.geojson?position={lng},{lat}&epsg=4326")
JSHIS_PSHM = ("https://www.j-shis.bosai.go.jp/map/api/pshm/Y2020/AVR/TTL_MTTL/"
              "meshinfo.geojson?position={lng},{lat}&epsg=4326")
GSI_ELEV = ("https://cyberjapandata2.gsi.go.jp/general/dem/scripts/"
            "getelevation.php?lon={lng}&lat={lat}&outtype=JSON")
# The map the user reads, deep-linked by coordinate: #zoom,lat,lng
HAZARD_MAP = "https://sumaken.j-shield.co.jp/supportmap/#17,{lat},{lng}"

# 微地形分類 -> liquefaction susceptibility. Standard groupings: loose saturated
# young sediment liquefies, consolidated upland does not.
LIQUEFACTION = {
    "high": ("埋立地", "干拓地", "旧河道", "三角州", "海岸低地", "砂州", "砂丘",
             "後背湿地", "谷底低地", "湿地"),
    "medium": ("扇状地", "自然堤防", "河原", "デルタ"),
    "low": ("台地", "段丘", "山地", "丘陵", "火山", "岩石"),
}


def liquefaction_band(landform: str | None) -> str | None:
    if not landform:
        return None
    for band, keys in LIQUEFACTION.items():
        if any(k in landform for k in keys):
            return band
    return None


def shaking_band(arv: float | None) -> str | None:
    """揺れやすさ from the amplification factor. The usual reading: under 1.4 is
    firm, over 1.8 is soft ground that markedly amplifies shaking."""
    if arv is None:
        return None
    return "low" if arv < 1.4 else ("high" if arv >= 1.8 else "medium")


def _get(url: str, timeout: int = 25):
    req = urllib.request.Request(url, headers={"User-Agent": "tokyohouseprice/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _props(doc) -> dict:
    feats = (doc or {}).get("features") or []
    return feats[0].get("properties", {}) if feats else {}


def fetch(lat: float, lng: float) -> dict | None:
    """Everything computable for one point. Partial results are kept: the soil
    layer is the important one, and a failed elevation lookup should not lose it."""
    try:
        soil = _props(_get(JSHIS_SOIL.format(lat=lat, lng=lng)))
    except Exception as exc:
        log.warning("j-shis soil %s,%s failed: %s", lat, lng, exc)
        return None
    if not soil:
        return None
    # J-SHIS returns every value as a string, including the numeric ones.
    def num(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    out = {
        "meshcode": soil.get("meshcode"),
        "arv": num(soil.get("ARV")),
        "avs30": num(soil.get("AVS")),
        "landform": soil.get("JNAME"),
        "elevation_m": None,
        "quake6_30yr": None,
    }
    try:
        out["quake6_30yr"] = num(_props(_get(JSHIS_PSHM.format(lat=lat, lng=lng))).get("T30_I60_PS"))
    except Exception as exc:
        log.warning("j-shis pshm %s,%s failed: %s", lat, lng, exc)
    try:
        out["elevation_m"] = num(_get(GSI_ELEV.format(lat=lat, lng=lng)).get("elevation"))
    except Exception as exc:
        log.warning("gsi elevation %s,%s failed: %s", lat, lng, exc)
    return out


def _key(lat: float, lng: float) -> str:
    """250 m mesh, which is the resolution J-SHIS publishes at."""
    return f"{round(lat, 3)},{round(lng, 3)}"


def table() -> dict[str, dict]:
    conn = connect()
    try:
        return {r["mesh_key"]: dict(r) for r in conn.execute("SELECT * FROM hazard_cache")}
    finally:
        conn.close()


def save(mesh_key: str, d: dict) -> None:
    conn = init_db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO hazard_cache "
            "(mesh_key, meshcode, arv, avs30, landform, elevation_m, quake6_30yr, fetched_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (mesh_key, d.get("meshcode"), d.get("arv"), d.get("avs30"),
             d.get("landform"), d.get("elevation_m"), d.get("quake6_30yr"),
             datetime.now().isoformat()))
        conn.commit()
    finally:
        conn.close()


def annotate(rows: list[dict]) -> list[dict]:
    """Attach cached hazard to each row that has coordinates."""
    cache = table()
    for r in rows:
        lat, lng = r.get("lat"), r.get("lng")
        hit = cache.get(_key(lat, lng)) if (lat and lng) else None
        r["hazard"] = ({
            "arv": hit["arv"],
            "shaking": shaking_band(hit["arv"]),
            "avs30": hit["avs30"],
            "landform": hit["landform"],
            "liquefaction": liquefaction_band(hit["landform"]),
            "elevation_m": hit["elevation_m"],
            "quake6_30yr": hit["quake6_30yr"],
        } if hit else None)
        r["hazard_map_url"] = (HAZARD_MAP.format(lat=lat, lng=lng)
                               if (lat and lng) else None)
    return rows


def refresh(points: list[tuple[float, float]], delay: float = 0.4) -> int:
    """Fill the cache for the given coordinates. One call per unfilled mesh."""
    import time
    have = table()
    todo = []
    for lat, lng in points:
        if not lat or not lng:
            continue
        k = _key(lat, lng)
        if k not in have and k not in [t[0] for t in todo]:
            todo.append((k, lat, lng))
    done = 0
    for k, lat, lng in todo:
        d = fetch(lat, lng)
        if d:
            save(k, d)
            done += 1
        time.sleep(delay)
    return done
