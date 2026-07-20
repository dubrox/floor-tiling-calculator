import { polygonBounds } from './floorPlan.js';

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

function getUnderlyingLayer(areas, areaId) {
  const idx = areas.findIndex((a) => a.id === areaId);
  if (idx < 0) return null;
  const current = aabbFromPoints(areas[idx].points);
  for (let i = idx - 1; i >= 0; i--) {
    if (aabbsOverlap(current, aabbFromPoints(areas[i].points))) {
      return areas[i];
    }
  }
  return null;
}

export function getUnderlyingTiling(areas, areaId, baseTiling) {
  return getUnderlyingLayer(areas, areaId)?.tiling || baseTiling;
}

function addTilingGridLines(xs, ys, tiling, floorPlan, origin = null) {
  if (!tiling) return;
  const { bounds } = floorPlan;
  const [ox0, oy0] = origin || [bounds.minX, bounds.minY];
  const w = Math.max(0.01, Number(tiling.widthCm) || 0.01);
  const h = Math.max(0.01, Number(tiling.lengthCm) || 0.01);
  const gap = Math.max(0, Number(tiling.spacingCm) || 0);
  const ox = Number(tiling.offsetXCm) || 0;
  const oy = Number(tiling.offsetYCm) || 0;
  const deg = ((Number(tiling.orientationDeg) || 0) % 180 + 180) % 180;
  const stepX = w + gap;
  const stepY = h + gap;
  const gridOx = ox0 + ox;
  const gridOy = oy0 + oy;

  const near0 = deg < 8 || deg > 172;
  const near90 = Math.abs(deg - 90) < 8;
  if (!near0 && !near90) {
    const pad = Math.hypot(bounds.width, bounds.height);
    for (const step of [stepX, stepY]) {
      const i0 = Math.floor((-pad - ox) / step) - 1;
      const i1 = Math.ceil((pad - ox) / step) + 1;
      for (let i = i0; i <= i1; i++) {
        xs.add(ox0 + i * step + ox);
        ys.add(oy0 + i * step + oy);
      }
    }
    return;
  }

  const horizStep = near90 ? stepY : stepX;
  const vertStep = near90 ? stepX : stepY;
  const i0 = Math.floor((bounds.minX - horizStep * 2 - gridOx) / horizStep);
  const i1 = Math.ceil((bounds.maxX + horizStep * 2 - gridOx) / horizStep);
  const j0 = Math.floor((bounds.minY - vertStep * 2 - gridOy) / vertStep);
  const j1 = Math.ceil((bounds.maxY + vertStep * 2 - gridOy) / vertStep);

  for (let i = i0; i <= i1; i++) xs.add(i * horizStep + gridOx);
  for (let j = j0; j <= j1; j++) ys.add(j * vertStep + gridOy);
}

function sortedLines(set) {
  return [...set].filter(Number.isFinite).sort((a, b) => a - b);
}

export function collectSnapTargets(areas, excludeId, baseTiling, activeTiling, floorPlan) {
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

  addX(geometryX, floorPlan.bounds.minX);
  addX(geometryX, floorPlan.bounds.maxX);
  addY(geometryY, floorPlan.bounds.minY);
  addY(geometryY, floorPlan.bounds.maxY);
  for (const [x, y] of floorPlan.points) {
    addX(geometryX, x);
    addY(geometryY, y);
  }

  let activeOrigin = [floorPlan.bounds.minX, floorPlan.bounds.minY];
  for (const area of areas) {
    const b = aabbFromPoints(area.points);
    if (area.id === excludeId) {
      activeOrigin = [b.minX, b.minY];
      continue;
    }
    addX(geometryX, b.minX);
    addX(geometryX, b.maxX);
    addY(geometryY, b.minY);
    addY(geometryY, b.maxY);
    for (const [x, y] of area.points) {
      addX(geometryX, x);
      addY(geometryY, y);
    }
  }

  const underlying = getUnderlyingLayer(areas, excludeId);
  const underlyingTiling = underlying?.tiling || baseTiling;
  const underlyingOrigin = underlying
    ? (() => {
        const b = aabbFromPoints(underlying.points);
        return [b.minX, b.minY];
      })()
    : [floorPlan.bounds.minX, floorPlan.bounds.minY];

  addTilingGridLines(underlyingX, underlyingY, underlyingTiling, floorPlan, underlyingOrigin);
  addTilingGridLines(innerX, innerY, activeTiling, floorPlan, activeOrigin);

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

export function areasIntersectFloor(points, floorPlan) {
  const b = aabbFromPoints(points);
  return !(
    b.maxX < floorPlan.bounds.minX ||
    b.minX > floorPlan.bounds.maxX ||
    b.maxY < floorPlan.bounds.minY ||
    b.minY > floorPlan.bounds.maxY
  );
}
