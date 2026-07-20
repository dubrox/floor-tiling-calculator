/** Default room polygon from Sweet Home 3D Home.xml (coordinates in cm). */
export const DEFAULT_FLOOR_PLAN_ID = 'garage-home-xml';

export const DEFAULT_FLOOR_POINTS_CM = [
  [0.60343933, 0.4557705],
  [0.60343933, 75.45577],
  [-13.396561, 75.45577],
  [-13.396561, 420.45578],
  [223.60344, 420.45578],
  [410.98676, 233.07246],
  [410.98676, 13.072449],
  [410.98676, 0.4557705],
];

const PADDING_CM = 20;

/** @deprecated use DEFAULT_FLOOR_PLAN_ID */
export const FLOOR_PLAN_ID = DEFAULT_FLOOR_PLAN_ID;

/** @deprecated use DEFAULT_FLOOR_POINTS_CM */
export const FLOOR_POINTS_CM = DEFAULT_FLOOR_POINTS_CM;

export function polygonBounds(points) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function polygonArea(points) {
  let sum = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

export function polygonCentroid(points) {
  let cx = 0;
  let cy = 0;
  let a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % n];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-12) {
    const b = polygonBounds(points);
    return [b.minX + b.width / 2, b.minY + b.height / 2];
  }
  return [cx / (6 * a), cy / (6 * a)];
}

export function getViewBox(points, padding = PADDING_CM) {
  const b = polygonBounds(points);
  return {
    x: b.minX - padding,
    y: b.minY - padding,
    width: b.width + padding * 2,
    height: b.height + padding * 2,
    toString() {
      return `${this.x} ${this.y} ${this.width} ${this.height}`;
    },
  };
}

export function pointsToPath(points) {
  if (!points.length) return '';
  const [x0, y0] = points[0];
  let d = `M ${x0} ${y0}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0]} ${points[i][1]}`;
  }
  return `${d} Z`;
}

export function cm2ToM2(cm2) {
  return cm2 / 10000;
}

/** Serializable floor spec stored in config / export JSON. */
export function createDefaultFloorPlanSpec() {
  return {
    id: DEFAULT_FLOOR_PLAN_ID,
    points: DEFAULT_FLOOR_POINTS_CM.map(([x, y]) => [x, y]),
    label: 'Default garage',
    roomId: 'room-4f75cafd-c28f-45fe-b366-fb46ac3efbe0',
  };
}

export function normalizeFloorPlanSpec(raw) {
  const fallback = createDefaultFloorPlanSpec();
  if (!raw || typeof raw !== 'object') return fallback;

  const points = Array.isArray(raw.points)
    ? raw.points
        .filter((p) => Array.isArray(p) && p.length >= 2)
        .map(([x, y]) => [Number(x), Number(y)])
        .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
    : [];

  if (points.length < 3) return fallback;

  return {
    id: String(raw.id || raw.roomId || crypto.randomUUID()),
    points,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : null,
    roomId: typeof raw.roomId === 'string' ? raw.roomId : null,
  };
}

/** Derived floor geometry used by rendering and tiling math. */
export function buildFloorPlan(spec) {
  const normalized = normalizeFloorPlanSpec(spec);
  const points = normalized.points;
  const areaCm2 = polygonArea(points);
  return {
    ...normalized,
    bounds: polygonBounds(points),
    centroid: polygonCentroid(points),
    viewBox: getViewBox(points),
    areaCm2,
    areaM2: cm2ToM2(areaCm2),
  };
}

export const DEFAULT_FLOOR_PLAN = buildFloorPlan(createDefaultFloorPlanSpec());

/** @deprecated derived from default floor */
export const FLOOR_AREA_CM2 = DEFAULT_FLOOR_PLAN.areaCm2;
/** @deprecated */
export const FLOOR_AREA_M2 = DEFAULT_FLOOR_PLAN.areaM2;
/** @deprecated */
export const FLOOR_VIEWBOX = DEFAULT_FLOOR_PLAN.viewBox;
/** @deprecated */
export const FLOOR_CENTROID = DEFAULT_FLOOR_PLAN.centroid;
/** @deprecated */
export const FLOOR_BOUNDS = DEFAULT_FLOOR_PLAN.bounds;

function roomPointsFromElement(roomEl) {
  const points = [];
  for (const pt of roomEl.querySelectorAll('point')) {
    const x = Number(pt.getAttribute('x'));
    const y = Number(pt.getAttribute('y'));
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

/**
 * Parse Sweet Home 3D Home.xml and return the largest room polygon (cm).
 */
export function parseSweetHome3dXml(xmlText) {
  if (typeof xmlText !== 'string' || !xmlText.trim()) {
    throw new Error('Empty XML file');
  }

  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid XML');
  }

  const rooms = [...doc.querySelectorAll('room')];
  if (!rooms.length) {
    throw new Error('No <room> found in Sweet Home 3D file');
  }

  let best = null;
  let bestArea = -1;
  for (const room of rooms) {
    const points = roomPointsFromElement(room);
    if (points.length < 3) continue;
    const area = polygonArea(points);
    if (area > bestArea) {
      bestArea = area;
      best = {
        roomId: room.getAttribute('id') || null,
        points,
      };
    }
  }

  if (!best) {
    throw new Error('No valid room polygon (<point> list) found');
  }

  return {
    id: best.roomId || `sh3d-${crypto.randomUUID()}`,
    roomId: best.roomId,
    points: best.points,
    label: null,
  };
}

export async function parseSweetHome3dFile(file) {
  const text = await file.text();
  const spec = parseSweetHome3dXml(text);
  return {
    ...spec,
    label: file.name || spec.label,
  };
}
