/** Room polygon from Sweet Home 3D Home.xml (coordinates in cm). */
export const FLOOR_PLAN_ID = 'garage-home-xml';

export const FLOOR_POINTS_CM = [
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

/** SVG viewBox covering the floor with padding (y grows downward for SVG). */
export function getViewBox(points = FLOOR_POINTS_CM, padding = PADDING_CM) {
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

export const FLOOR_AREA_CM2 = polygonArea(FLOOR_POINTS_CM);
export const FLOOR_AREA_M2 = cm2ToM2(FLOOR_AREA_CM2);
export const FLOOR_VIEWBOX = getViewBox(FLOOR_POINTS_CM);
export const FLOOR_CENTROID = polygonCentroid(FLOOR_POINTS_CM);
export const FLOOR_BOUNDS = polygonBounds(FLOOR_POINTS_CM);
