import { FLOOR_PLAN_ID } from './floorPlan.js';
import { defaultTiling, normalizeTiling } from './tiling.js';

export const STORAGE_KEY = 'tile-plan:v1';
export const CAMERA_STORAGE_KEY = 'tile-plan:camera:v1';

export function createDefaultConfig() {
  return {
    version: 1,
    floorPlanId: FLOOR_PLAN_ID,
    baseTiling: defaultTiling(),
    areas: [],
  };
}

export function createDefaultCamera() {
  return {
    pitchDeg: 55,
    yawDeg: -28,
    zoom: 1,
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function normalizeCamera(raw) {
  const base = createDefaultCamera();
  if (!raw || typeof raw !== 'object') return base;
  const pitchDeg = Number(raw.pitchDeg);
  const yawDeg = Number(raw.yawDeg);
  const zoom = Number(raw.zoom);
  return {
    pitchDeg: Number.isFinite(pitchDeg) ? clamp(pitchDeg, 5, 85) : base.pitchDeg,
    yawDeg: Number.isFinite(yawDeg) ? ((yawDeg % 360) + 360) % 360 : base.yawDeg,
    zoom: Number.isFinite(zoom) ? clamp(zoom, 0.45, 2.4) : base.zoom,
  };
}

export function loadCamera() {
  try {
    const raw = localStorage.getItem(CAMERA_STORAGE_KEY);
    if (!raw) return normalizeCamera(createDefaultCamera());
    return normalizeCamera(JSON.parse(raw));
  } catch {
    return normalizeCamera(createDefaultCamera());
  }
}

export function saveCamera(camera) {
  try {
    localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(normalizeCamera(camera)));
  } catch {
    /* quota / private mode */
  }
}

export function normalizeConfig(raw) {
  const base = createDefaultConfig();
  if (!raw || typeof raw !== 'object') return base;

  const baseTiling = normalizeTiling(raw.baseTiling);

  const areas = Array.isArray(raw.areas)
    ? raw.areas
        .filter((a) => a && Array.isArray(a.points) && a.points.length >= 3)
        .map((a) => ({
          id: String(a.id || crypto.randomUUID()),
          kind: a.kind === 'rect' ? 'rect' : 'polygon',
          points: a.points.map(([x, y]) => [Number(x), Number(y)]),
          tiling: normalizeTiling(a.tiling),
        }))
    : [];

  return {
    version: 1,
    floorPlanId: FLOOR_PLAN_ID,
    baseTiling,
    areas,
  };
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultConfig();
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return createDefaultConfig();
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch (err) {
    console.warn('Could not save tiling config (storage full?)', err);
  }
}

export function exportConfigJson(config) {
  return JSON.stringify(config, null, 2);
}

export function downloadConfig(config) {
  const blob = new Blob([exportConfigJson(config)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tile-plan-config.json';
  a.click();
  URL.revokeObjectURL(url);
}

export async function parseImportedFile(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  return normalizeConfig(data);
}

/** Compress an image file to a data URL suitable for localStorage. */
export function fileToTileImageDataUrl(file, maxEdge = 640, quality = 0.72) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith('image/')) {
      reject(new Error('Please choose an image file'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read image'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not decode image'));
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas unavailable'));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        try {
          resolve(canvas.toDataURL('image/jpeg', quality));
        } catch (err) {
          reject(err);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
