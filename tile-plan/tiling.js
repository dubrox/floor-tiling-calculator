import polygonClipping from 'polygon-clipping';
import { polygonArea, polygonBounds } from './floorPlan.js';

export function defaultTiling() {
  return {
    color: '#8a8a8a',
    imageDataUrl: null,
    widthCm: 30,
    lengthCm: 60,
    spacingCm: 0.3,
    offsetXCm: 0,
    offsetYCm: 0,
    orientationDeg: 0,
  };
}

/** Normalize tiling fields; drop invalid image payloads. */
export function normalizeTiling(raw) {
  const base = defaultTiling();
  if (!raw || typeof raw !== 'object') return base;
  const imageDataUrl =
    typeof raw.imageDataUrl === 'string' && raw.imageDataUrl.startsWith('data:image/')
      ? raw.imageDataUrl
      : null;
  return {
    ...base,
    ...raw,
    color: typeof raw.color === 'string' && raw.color ? raw.color : base.color,
    imageDataUrl,
  };
}

function ringFromPoints(points) {
  if (!points || points.length < 3) return null;
  const ring = points.map(([x, y]) => [x, y]);
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  return [ring];
}

function multipolygonArea(mp) {
  let total = 0;
  for (const polygon of mp) {
    if (!polygon.length) continue;
    total += polygonArea(polygon[0].slice(0, -1));
    for (let i = 1; i < polygon.length; i++) {
      total -= polygonArea(polygon[i].slice(0, -1));
    }
  }
  return Math.max(0, total);
}

function rotatePoint(x, y, cx, cy, cos, sin) {
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos];
}

/**
 * Local origin for a tiling layer: top-left of its geometry (or floor bounds for the base).
 * Offset and orientation are applied relative to this point.
 */
export function tilingOriginFromBounds(bounds) {
  return [bounds.minX, bounds.minY];
}

export function tilingOriginFromPoints(points, floorPlan) {
  if (!points || points.length < 1) {
    return tilingOriginFromBounds(floorPlan.bounds);
  }
  return tilingOriginFromBounds(polygonBounds(points));
}

/**
 * Generate tile rectangles covering `coverBounds`.
 * Offset is relative to `origin` (layer top-left); rotation is around that same origin.
 * Iteration happens in unrotated tile space so we only create tiles that can intersect the cover.
 */
export function generateTileRects(tiling, coverBounds, floorPlan, origin = null) {
  const bounds = coverBounds || floorPlan.bounds;
  const w = Math.max(0.01, Number(tiling.widthCm) || 0.01);
  const h = Math.max(0.01, Number(tiling.lengthCm) || 0.01);
  const gap = Math.max(0, Number(tiling.spacingCm) || 0);
  const ox = Number(tiling.offsetXCm) || 0;
  const oy = Number(tiling.offsetYCm) || 0;
  const deg = Number(tiling.orientationDeg) || 0;
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const invCos = Math.cos(-rad);
  const invSin = Math.sin(-rad);
  const [cx, cy] = origin || tilingOriginFromBounds(floorPlan.bounds);

  const corners = [
    [bounds.minX, bounds.minY],
    [bounds.maxX, bounds.minY],
    [bounds.maxX, bounds.maxY],
    [bounds.minX, bounds.maxY],
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, invCos, invSin));

  const local = polygonBounds(corners);
  const margin = Math.max(w, h) + gap;
  const stepX = w + gap;
  const stepY = h + gap;

  // Local tile-space coordinates are relative to the layer origin.
  const i0 = Math.floor((local.minX - cx - margin - ox) / stepX);
  const i1 = Math.ceil((local.maxX - cx + margin - ox) / stepX);
  const j0 = Math.floor((local.minY - cy - margin - oy) / stepY);
  const j1 = Math.ceil((local.maxY - cy + margin - oy) / stepY);

  const rects = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = cx + i * stepX + ox;
      const y = cy + j * stepY + oy;
      const world = [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ].map(([px, py]) => rotatePoint(px, py, cx, cy, cos, sin));
      rects.push(world);
    }
  }
  return rects;
}

function aabbFromPointsLocal(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function aabbsOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** Ray-cast point-in-ring. Ring may be open or closed. */
function pointInRing(x, y, ring) {
  const n = ring.length;
  if (n < 3) return false;
  const last = ring[n - 1];
  const closed = last[0] === ring[0][0] && last[1] === ring[0][1];
  const count = closed ? n - 1 : n;
  let inside = false;
  for (let i = 0, j = count - 1; i < count; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInMultipolygon(x, y, mp) {
  for (const polygon of mp) {
    const outer = polygon[0];
    if (!outer || !pointInRing(x, y, outer)) continue;
    let inHole = false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(x, y, polygon[i])) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
}

function multipolygonAabb(mp) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of mp) {
    const outer = polygon[0];
    if (!outer) continue;
    for (const [x, y] of outer) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function clipRectsToRegion(rects, regionMp, tiling) {
  if (!regionMp || !regionMp.length) {
    return { pieces: [], coveredAreaCm2: 0, tileCount: 0 };
  }

  const pieces = [];
  let coveredAreaCm2 = 0;
  let tileCount = 0;
  const color = tiling.color;
  const imageDataUrl = tiling.imageDataUrl || null;
  const widthCm = Math.max(0.01, Number(tiling.widthCm) || 0.01);
  const lengthCm = Math.max(0.01, Number(tiling.lengthCm) || 0.01);
  const regionAabb = multipolygonAabb(regionMp);
  if (!regionAabb) {
    return { pieces, coveredAreaCm2, tileCount };
  }

  const pushFullRect = (rect) => {
    tileCount += 1;
    coveredAreaCm2 += widthCm * lengthCm;
    pieces.push({
      points: rect,
      color,
      imageDataUrl,
      tileCorners: rect,
      widthCm,
      lengthCm,
    });
  };

  for (const rect of rects) {
    const rectAabb = aabbFromPointsLocal(rect);
    if (!aabbsOverlap(rectAabb, regionAabb)) continue;

    // Fast path: all corners inside a simple (no-hole) region → skip clip.
    // Unsafe for holes (tile may cover a void) or strongly concave notches.
    const simpleRegion = regionMp.length === 1 && regionMp[0].length === 1;
    if (simpleRegion && rect.every(([x, y]) => pointInMultipolygon(x, y, regionMp))) {
      pushFullRect(rect);
      continue;
    }

    const rectMp = ringFromPoints(rect);
    if (!rectMp) continue;
    let clipped;
    try {
      clipped = polygonClipping.intersection(regionMp, rectMp);
    } catch {
      continue;
    }
    if (!clipped || !clipped.length) continue;
    const area = multipolygonArea(clipped);
    if (area < 1e-6) continue;
    tileCount += 1;
    coveredAreaCm2 += area;
    for (const polygon of clipped) {
      const outer = polygon[0];
      if (!outer || outer.length < 4) continue;
      pieces.push({
        points: outer.slice(0, -1),
        color,
        imageDataUrl,
        tileCorners: rect,
        widthCm,
        lengthCm,
      });
    }
  }

  return { pieces, coveredAreaCm2, tileCount };
}

export function clipPointsToFloor(points, floorPlan) {
  const clipped = intersectAreaWithFloor(points, floorPlan);
  if (!clipped) return null;
  let best = clipped[0][0];
  let bestArea = 0;
  for (const poly of clipped) {
    const outer = poly[0];
    const a = polygonArea(outer.slice(0, -1));
    if (a > bestArea) {
      bestArea = a;
      best = outer;
    }
  }
  return best.slice(0, -1);
}

/** Floor ∩ area as a multipolygon, or null if no overlap. */
export function intersectAreaWithFloor(points, floorPlan) {
  const floorMp = ringFromPoints(floorPlan.points);
  const areaMp = ringFromPoints(points);
  if (!floorMp || !areaMp) return null;
  let clipped;
  try {
    clipped = polygonClipping.intersection(floorMp, areaMp);
  } catch {
    return null;
  }
  if (!clipped || !clipped.length) return null;
  return clipped;
}

function multipolygonBounds(mp, fallbackBounds) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const polygon of mp) {
    const outer = polygon[0];
    if (!outer) continue;
    for (const [x, y] of outer) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (!Number.isFinite(minX)) return fallbackBounds;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function computeTilingPreview(baseTiling, areas, floorPlan) {
  const floorMp = ringFromPoints(floorPlan.points);

  const stacked = areas.map((area) => ({
    area,
    floorClip: intersectAreaWithFloor(area.points, floorPlan),
  }));

  const areaVisible = stacked.map(({ area, floorClip }, index) => {
    if (!floorClip) {
      return { area, visible: null };
    }
    let visible = floorClip;
    for (let j = index + 1; j < stacked.length; j++) {
      const above = stacked[j].floorClip;
      if (!above) continue;
      try {
        visible = polygonClipping.difference(visible, above);
      } catch {
        /* keep previous */
      }
      if (!visible || !visible.length) {
        visible = null;
        break;
      }
    }
    return { area, visible };
  });

  let baseRegion = floorMp;
  for (const { floorClip } of stacked) {
    if (!floorClip) continue;
    try {
      baseRegion = polygonClipping.difference(baseRegion, floorClip);
    } catch {
      /* keep previous */
    }
  }
  if (baseRegion && !baseRegion.length) baseRegion = null;

  const baseOrigin = tilingOriginFromBounds(floorPlan.bounds);
  const baseRects = generateTileRects(baseTiling, floorPlan.bounds, floorPlan, baseOrigin);
  const baseResult = clipRectsToRegion(baseRects, baseRegion, baseTiling);
  const baseCount = baseResult.tileCount;

  const areaResults = areaVisible.map(({ area, visible }) => {
    const tiling = area.tiling;
    if (!visible) {
      return {
        id: area.id,
        pieces: [],
        coveredAreaCm2: 0,
        count: 0,
        points: area.points,
      };
    }
    const cover = multipolygonBounds(visible, floorPlan.bounds);
    const origin = tilingOriginFromPoints(area.points, floorPlan);
    const rects = generateTileRects(tiling, cover, floorPlan, origin);
    const result = clipRectsToRegion(rects, visible, tiling);
    return {
      id: area.id,
      pieces: result.pieces,
      coveredAreaCm2: result.coveredAreaCm2,
      count: result.tileCount,
      points: area.points,
    };
  });

  const totalCount = baseCount + areaResults.reduce((s, a) => s + a.count, 0);

  return {
    basePieces: baseResult.pieces,
    baseCount,
    baseCoveredAreaCm2: baseResult.coveredAreaCm2,
    areas: areaResults,
    totalCount,
  };
}
