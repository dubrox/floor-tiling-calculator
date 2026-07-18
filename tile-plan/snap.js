import { FLOOR_BOUNDS, FLOOR_CENTROID, FLOOR_POINTS_CM, polygonBounds } from './floorPlan.js';

export const SNAP_THRESHOLD_CM = 6;
export const MIN_RECT_SIZE_CM = 2;
export const HANDLE_SIZE_CM = 5;

export const SNAP_SOURCE = {
  UNDERLYING: 'underlying',
  INNER: 'inner',
  GEOMETRY: 'geometry',
};

export function aabbFromPoints(points) {
  return polygonBounds(points);
}

export function rectPointsFromAabb({ minX, minY, maxX, maxY }) {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

export function translatePoints(points, dx, dy) {
  return points.map(([x, y]) => [x + dx, y + dy]);
}

function aabbsOverlap(a, b) {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/**
 * Tiling of the topmost layer underneath `areaId` (by list order: earlier = below).
 * Falls back to base when nothing below overlaps.
 */
export function getUnderlyingTiling(areas, areaId, baseTiling) {
  const idx = areas.findIndex((a) => a.id === areaId);
  if (idx < 0) return baseTiling;
  const current = aabbFromPoints(areas[idx].points);
  for (let i = idx - 1; i >= 0; i--) {
    if (aabbsOverlap(current, aabbFromPoints(areas[i].points))) {
      return areas[i].tiling;
    }
  }
  return baseTiling;
}

function addTilingGridLines(xs, ys, tiling) {
  if (!tiling) return;
  const w = Math.max(0.01, Number(tiling.widthCm) || 0.01);
  const h = Math.max(0.01, Number(tiling.lengthCm) || 0.01);
  const gap = Math.max(0, Number(tiling.spacingCm) || 0);
  const ox = Number(tiling.offsetXCm) || 0;
  const oy = Number(tiling.offsetYCm) || 0;
  const deg = ((Number(tiling.orientationDeg) || 0) % 180 + 180) % 180;
  const stepX = w + gap;
  const stepY = h + gap;

  const near0 = deg < 8 || deg > 172;
  const near90 = Math.abs(deg - 90) < 8;
  if (!near0 && !near90) {
    const [cx, cy] = FLOOR_CENTROID;
    const pad = Math.hypot(FLOOR_BOUNDS.width, FLOOR_BOUNDS.height);
    for (const step of [stepX, stepY]) {
      const i0 = Math.floor((-pad - ox) / step) - 1;
      const i1 = Math.ceil((pad - ox) / step) + 1;
      for (let i = i0; i <= i1; i++) {
        xs.add(cx + i * step + ox);
        ys.add(cy + i * step + oy);
      }
    }
    return;
  }

  const horizStep = near90 ? stepY : stepX;
  const vertStep = near90 ? stepX : stepY;
  const i0 = Math.floor((FLOOR_BOUNDS.minX - horizStep * 2 - ox) / horizStep);
  const i1 = Math.ceil((FLOOR_BOUNDS.maxX + horizStep * 2 - ox) / horizStep);
  const j0 = Math.floor((FLOOR_BOUNDS.minY - vertStep * 2 - oy) / vertStep);
  const j1 = Math.ceil((FLOOR_BOUNDS.maxY + vertStep * 2 - oy) / vertStep);

  for (let i = i0; i <= i1; i++) xs.add(i * horizStep + ox);
  for (let j = j0; j <= j1; j++) ys.add(j * vertStep + oy);
}

function sortedLines(set) {
  return [...set].filter(Number.isFinite).sort((a, b) => a - b);
}

/**
 * Collect typed snap targets for editing an area.
 * - geometry: floor + other area edges
 * - underlying: tile grid of the layer underneath
 * - inner: tile grid of the area being edited (align to full/uncut tiles)
 */
export function collectSnapTargets(areas, excludeId, baseTiling, activeTiling) {
  const geometryX = new Set();
  const geometryY = new Set();
  const underlyingX = new Set();
  const underlyingY = new Set();
  const innerX = new Set();
  const innerY = new Set();

  const addX = (set, v) => {
    if (Number.isFinite(v)) set.add(v);
  };
  const addY = (set, v) => {
    if (Number.isFinite(v)) set.add(v);
  };

  addX(geometryX, FLOOR_BOUNDS.minX);
  addX(geometryX, FLOOR_BOUNDS.maxX);
  addY(geometryY, FLOOR_BOUNDS.minY);
  addY(geometryY, FLOOR_BOUNDS.maxY);
  for (const [x, y] of FLOOR_POINTS_CM) {
    addX(geometryX, x);
    addY(geometryY, y);
  }

  for (const area of areas) {
    if (area.id === excludeId) continue;
    const b = aabbFromPoints(area.points);
    addX(geometryX, b.minX);
    addX(geometryX, b.maxX);
    addY(geometryY, b.minY);
    addY(geometryY, b.maxY);
    for (const [x, y] of area.points) {
      addX(geometryX, x);
      addY(geometryY, y);
    }
  }

  const underlyingTiling = getUnderlyingTiling(areas, excludeId, baseTiling);
  addTilingGridLines(underlyingX, underlyingY, underlyingTiling);
  addTilingGridLines(innerX, innerY, activeTiling);

  return {
    groups: [
      { type: SNAP_SOURCE.UNDERLYING, xs: sortedLines(underlyingX), ys: sortedLines(underlyingY) },
      { type: SNAP_SOURCE.INNER, xs: sortedLines(innerX), ys: sortedLines(innerY) },
      { type: SNAP_SOURCE.GEOMETRY, xs: sortedLines(geometryX), ys: sortedLines(geometryY) },
    ],
    underlyingTiling,
  };
}

export function emptySnapGuides() {
  return {
    [SNAP_SOURCE.UNDERLYING]: { xs: [], ys: [] },
    [SNAP_SOURCE.INNER]: { xs: [], ys: [] },
    [SNAP_SOURCE.GEOMETRY]: { xs: [], ys: [] },
  };
}

function snapAxis(value, groups, axis, threshold) {
  let best = value;
  let bestDist = threshold;
  let bestType = null;
  for (const g of groups) {
    const lines = axis === 'x' ? g.xs : g.ys;
    for (const line of lines) {
      const d = Math.abs(line - value);
      if (d < bestDist) {
        bestDist = d;
        best = line;
        bestType = g.type;
      }
    }
  }
  return { value: best, type: bestType, line: bestType ? best : null };
}

function pushGuide(guides, type, axis, line) {
  if (!type || line == null) return;
  const bucket = guides[type] || (guides[type] = { xs: [], ys: [] });
  const arr = axis === 'x' ? bucket.xs : bucket.ys;
  if (!arr.includes(line)) arr.push(line);
}

/**
 * Snap translation; returns [dx, dy] and mutates guides with typed lines.
 */
export function snapTranslation(aabb, dx, dy, groups, guides, threshold = SNAP_THRESHOLD_CM) {
  const edgesX = [
    { edge: aabb.minX + dx, which: 'min' },
    { edge: aabb.maxX + dx, which: 'max' },
  ];
  const edgesY = [
    { edge: aabb.minY + dy, which: 'min' },
    { edge: aabb.maxY + dy, which: 'max' },
  ];

  let bestDx = dx;
  let bestDxDist = threshold;
  let bestDxType = null;
  let bestDxLine = null;
  for (const { edge } of edgesX) {
    const snapped = snapAxis(edge, groups, 'x', threshold);
    if (snapped.type) {
      const candDx = dx + (snapped.value - edge);
      const d = Math.abs(snapped.value - edge);
      if (d < bestDxDist) {
        bestDxDist = d;
        bestDx = candDx;
        bestDxType = snapped.type;
        bestDxLine = snapped.line;
      }
    }
  }

  let bestDy = dy;
  let bestDyDist = threshold;
  let bestDyType = null;
  let bestDyLine = null;
  for (const { edge } of edgesY) {
    const snapped = snapAxis(edge, groups, 'y', threshold);
    if (snapped.type) {
      const candDy = dy + (snapped.value - edge);
      const d = Math.abs(snapped.value - edge);
      if (d < bestDyDist) {
        bestDyDist = d;
        bestDy = candDy;
        bestDyType = snapped.type;
        bestDyLine = snapped.line;
      }
    }
  }

  pushGuide(guides, bestDxType, 'x', bestDxLine);
  pushGuide(guides, bestDyType, 'y', bestDyLine);
  return [bestDx, bestDy];
}

export function snapResizeAabb(aabb, handle, cursor, groups, guides, threshold = SNAP_THRESHOLD_CM) {
  let { minX, minY, maxX, maxY } = aabb;
  let [cx, cy] = cursor;

  const resizeLeft = handle.includes('w');
  const resizeRight = handle.includes('e');
  const resizeTop = handle.includes('n');
  const resizeBottom = handle.includes('s');

  if (resizeLeft || resizeRight) {
    const snapped = snapAxis(cx, groups, 'x', threshold);
    if (snapped.type) {
      cx = snapped.value;
      pushGuide(guides, snapped.type, 'x', snapped.line);
    }
  }
  if (resizeTop || resizeBottom) {
    const snapped = snapAxis(cy, groups, 'y', threshold);
    if (snapped.type) {
      cy = snapped.value;
      pushGuide(guides, snapped.type, 'y', snapped.line);
    }
  }

  if (resizeLeft) minX = Math.min(cx, maxX - MIN_RECT_SIZE_CM);
  if (resizeRight) maxX = Math.max(cx, minX + MIN_RECT_SIZE_CM);
  if (resizeTop) minY = Math.min(cy, maxY - MIN_RECT_SIZE_CM);
  if (resizeBottom) maxY = Math.max(cy, minY + MIN_RECT_SIZE_CM);

  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export const RESIZE_HANDLES = [
  { id: 'nw', cursor: 'nwse-resize' },
  { id: 'n', cursor: 'ns-resize' },
  { id: 'ne', cursor: 'nesw-resize' },
  { id: 'e', cursor: 'ew-resize' },
  { id: 'se', cursor: 'nwse-resize' },
  { id: 's', cursor: 'ns-resize' },
  { id: 'sw', cursor: 'nesw-resize' },
  { id: 'w', cursor: 'ew-resize' },
];

export function handlePosition(aabb, handleId) {
  const { minX, minY, maxX, maxY } = aabb;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  switch (handleId) {
    case 'nw':
      return [minX, minY];
    case 'n':
      return [cx, minY];
    case 'ne':
      return [maxX, minY];
    case 'e':
      return [maxX, cy];
    case 'se':
      return [maxX, maxY];
    case 's':
      return [cx, maxY];
    case 'sw':
      return [minX, maxY];
    case 'w':
      return [minX, cy];
    default:
      return [cx, cy];
  }
}

export function areasIntersectFloor(points) {
  const b = aabbFromPoints(points);
  return !(
    b.maxX < FLOOR_BOUNDS.minX ||
    b.minX > FLOOR_BOUNDS.maxX ||
    b.maxY < FLOOR_BOUNDS.minY ||
    b.minY > FLOOR_BOUNDS.maxY
  );
}
