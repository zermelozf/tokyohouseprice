"""Render a static PNG of crawled listings, for the daily report email.

Deliberately browser-free: the daily job runs from cron and cannot depend on a
headless Chromium, the Angular dev server or the API being up. This fetches the
same CartoDB Positron basemap the dashboard uses, stitches the tiles covering
the listings and draws the markers on top, with the same per-category colours.

The trade-off versus a real screenshot is that the hazard and census overlays
are not included — this is the listings layer only.
"""

from __future__ import annotations

import io
import math
from concurrent.futures import ThreadPoolExecutor

import httpx
from PIL import Image, ImageDraw, ImageFont

TILE_SIZE = 256
TILE_URL = "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png"
ATTRIBUTION = "© OpenStreetMap © CARTO"

# Same palette as the dashboard's catColors, so the email matches the Map tab.
CATEGORY_COLORS = {
    "used_mansion": (37, 99, 235),
    "new_house": (22, 163, 74),
    "used_house": (13, 148, 136),
    "land": (245, 158, 11),
    "rent": (147, 51, 234),
}
DEFAULT_COLOR = (107, 114, 128)


def _to_pixels(lat: float, lng: float, zoom: int) -> tuple[float, float]:
    """Web-Mercator lat/lng -> global pixel coordinates at `zoom`."""
    n = TILE_SIZE * (2 ** zoom)
    x = (lng + 180.0) / 360.0 * n
    sin_lat = math.sin(math.radians(lat))
    y = (0.5 - math.log((1 + sin_lat) / (1 - sin_lat)) / (4 * math.pi)) * n
    return x, y


def _pick_zoom(bounds: tuple[float, float, float, float],
               width: int, height: int, max_zoom: int = 16) -> int:
    """Largest zoom at which the bounding box still fits the requested canvas."""
    min_lat, min_lng, max_lat, max_lng = bounds
    for zoom in range(max_zoom, 0, -1):
        x0, y0 = _to_pixels(max_lat, min_lng, zoom)
        x1, y1 = _to_pixels(min_lat, max_lng, zoom)
        if (x1 - x0) <= width and (y1 - y0) <= height:
            return zoom
    return 1


def _fetch_tile(client: httpx.Client, zoom: int, x: int, y: int) -> Image.Image | None:
    try:
        r = client.get(TILE_URL.format(z=zoom, x=x, y=y), timeout=20)
        if r.status_code != 200:
            return None
        return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        return None


def render(points: list[dict], width: int = 1000, height: int = 700,
           padding: float = 0.12, title: str | None = None) -> bytes | None:
    """PNG bytes for `points` (dicts with lat/lng and optionally category).

    Returns None when there is nothing to draw, so the caller can send the
    report without an image rather than failing the whole job.
    """
    located = [p for p in points if p.get("lat") is not None and p.get("lng") is not None]
    if not located:
        return None

    lats = [float(p["lat"]) for p in located]
    lngs = [float(p["lng"]) for p in located]
    # Pad the extent so markers never sit against the edge; the fallback span
    # keeps a single-point map from zooming to street level.
    span_lat = (max(lats) - min(lats)) or 0.01
    span_lng = (max(lngs) - min(lngs)) or 0.01
    bounds = (min(lats) - span_lat * padding, min(lngs) - span_lng * padding,
              max(lats) + span_lat * padding, max(lngs) + span_lng * padding)

    zoom = _pick_zoom(bounds, width, height)
    centre_lat = (bounds[0] + bounds[2]) / 2
    centre_lng = (bounds[1] + bounds[3]) / 2
    cx, cy = _to_pixels(centre_lat, centre_lng, zoom)

    # Top-left of the canvas in global pixel space (retina tiles are 2x).
    scale = 2
    left = cx - width / 2
    top = cy - height / 2

    x0, x1 = int(left // TILE_SIZE), int((left + width) // TILE_SIZE)
    y0, y1 = int(top // TILE_SIZE), int((top + height) // TILE_SIZE)

    canvas = Image.new("RGB", (width * scale, height * scale), (248, 249, 250))
    coords = [(x, y) for x in range(x0, x1 + 1) for y in range(y0, y1 + 1)]

    with httpx.Client(headers={"User-Agent": "tokyohouseprice-daily-report"}) as client:
        with ThreadPoolExecutor(max_workers=8) as pool:
            tiles = list(pool.map(lambda c: _fetch_tile(client, zoom, c[0], c[1]), coords))

    for (tx, ty), tile in zip(coords, tiles):
        if tile is None:      # missing tile: leave the background showing
            continue
        px = int((tx * TILE_SIZE - left) * scale)
        py = int((ty * TILE_SIZE - top) * scale)
        canvas.paste(tile, (px, py))

    # Agents relist the same property, so several listings often share one set
    # of coordinates. Drawn one on top of another the map silently under-reports
    # itself, so stacked points become a single badge carrying the count.
    groups: dict[tuple, list[dict]] = {}
    for p in located:
        groups.setdefault((round(float(p["lat"]), 6), round(float(p["lng"]), 6)), []).append(p)

    draw = ImageDraw.Draw(canvas, "RGBA")
    try:
        badge_font = ImageFont.load_default(size=11 * scale)
    except TypeError:
        badge_font = ImageFont.load_default()

    for (lat, lng), stack in groups.items():
        gx, gy = _to_pixels(lat, lng, zoom)
        px, py = (gx - left) * scale, (gy - top) * scale
        cats = {p.get("category") for p in stack}
        color = CATEGORY_COLORS.get(next(iter(cats)), DEFAULT_COLOR) if len(cats) == 1 else DEFAULT_COLOR
        radius = (7 if len(stack) == 1 else 10) * scale

        draw.ellipse([px - radius, py - radius, px + radius, py + radius],
                     fill=color + (215,), outline=(255, 255, 255, 255), width=2 * scale)
        if len(stack) > 1:
            label = str(len(stack))
            box = draw.textbbox((0, 0), label, font=badge_font)
            draw.text((px - (box[2] - box[0]) / 2, py - (box[3] - box[1]) / 2 - box[1]),
                      label, fill=(255, 255, 255, 255), font=badge_font)

    stacked = sum(len(s) for s in groups.values() if len(s) > 1)
    caption = title or f"{len(located)} listings"
    if stacked:
        caption += f" · {len(groups)} pins ({stacked} share an address)"
    _draw_caption(draw, caption, scale, width, height)

    out = io.BytesIO()
    canvas.resize((width, height), Image.LANCZOS).save(out, format="PNG", optimize=True)
    return out.getvalue()


def _draw_caption(draw: ImageDraw.ImageDraw, caption: str, scale: int,
                  width: int, height: int) -> None:
    # The canvas is drawn at 2x and downscaled, so the caption has to be sized
    # up to survive it — the default bitmap font would end up unreadable.
    try:
        font = ImageFont.load_default(size=13 * scale)
    except TypeError:      # Pillow < 10 has no size argument
        font = ImageFont.load_default()

    pad = 8 * scale
    # The default bitmap font has no dashes beyond ASCII; swap them so the
    # caption never renders a tofu box.
    caption = caption.replace("—", "-").replace("–", "-")
    text = f"{caption}   ·   {ATTRIBUTION}"
    box = draw.textbbox((0, 0), text, font=font)
    w, h = box[2] - box[0], box[3] - box[1]
    y = height * scale - h - pad * 2
    draw.rectangle([0, y - pad, w + pad * 2, height * scale], fill=(255, 255, 255, 225))
    draw.text((pad, y), text, fill=(50, 50, 50), font=font)
