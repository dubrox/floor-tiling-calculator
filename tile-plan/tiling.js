import polygonClipping from 'polygon-clipping';
import {
  FLOOR_BOUNDS,
  FLOOR_CENTROID,
  FLOOR_POINTS_CM,
  polygonArea,
  polygonBounds,
} from './floorPlan.js';

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
 * Generate tile rectangles covering `coverBounds` after rotation around floor centroid + offset.
 * Iteration happens in unrotated tile space so we only create tiles that can intersect the floor.
 */
export function generateTileRects(tiling, coverBounds = FLOOR_BOUNDS) {
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
  const [cx, cy] = FLOOR_CENTROID;

  // Inverse-rotate cover bounds into tile-local space (rotation around floor centroid).
  const corners = [
    [coverBounds.minX, coverBounds.minY],
    [coverBounds.maxX, coverBounds.minY],
    [coverBounds.maxX, coverBounds.maxY],
    [coverBounds.minX, coverBounds.maxY],
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, invCos, invSin));

  const local = polygonBounds(corners);
  const margin = Math.max(w, h) + gap;
  const stepX = w + gap;
  const stepY = h + gap;

  const i0 = Math.floor((local.minX - margin - ox) / stepX);
  const i1 = Math.ceil((local.maxX + margin - ox) / stepX);
  const j0 = Math.floor((local.minY - margin - oy) / stepY);
  const j1 = Math.ceil((local.maxY + margin - oy) / stepY);

  const rects = [];
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const x = i * stepX + ox;
      const y = j * stepY + oy;
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

  for (const rect of rects) {
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
    // Any visible fragment of a tile consumes that whole tile (cut leftovers unused).
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

export function clipPointsToFloor(points) {
  const clipped = intersectAreaWithFloor(points);
  if (!clipped) return null;
  // Prefer largest polygon if multipolygon
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
export function intersectAreaWithFloor(points) {
  const floorMp = ringFromPoints(FLOOR_POINTS_CM);
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

function multipolygonBounds(mp) {
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
  if (!Number.isFinite(minX)) return FLOOR_BOUNDS;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function computeTilingPreview(baseTiling, areas) {
  const floorMp = ringFromPoints(FLOOR_POINTS_CM);

  // Later areas in the list sit on top of earlier ones.
  const stacked = areas.map((area) => ({
    area,
    floorClip: intersectAreaWithFloor(area.points),
  }));

  // Visible region per area = (floor ∩ area) − union(areas above).
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

  // Base is whatever remains of the floor under all areas.
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

  const baseRects = generateTileRects(baseTiling);
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
    const cover = multipolygonBounds(visible);
    const rects = generateTileRects(tiling, cover);
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
