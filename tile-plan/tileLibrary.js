import { defaultTiling, normalizeTiling } from './tiling.js';

export const CONFIG_VERSION = 2;

export function defaultTileDefinition(name = 'New tile') {
  const base = defaultTiling();
  return {
    id: crypto.randomUUID(),
    name,
    color: base.color,
    imageDataUrl: base.imageDataUrl,
    widthCm: base.widthCm,
    lengthCm: base.lengthCm,
    spacingCm: base.spacingCm,
  };
}

export function normalizeTileDefinition(raw) {
  const base = defaultTileDefinition();
  if (!raw || typeof raw !== 'object') return base;
  const imageDataUrl =
    typeof raw.imageDataUrl === 'string' && raw.imageDataUrl.startsWith('data:image/')
      ? raw.imageDataUrl
      : null;
  return {
    id: String(raw.id || crypto.randomUUID()),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    color: typeof raw.color === 'string' && raw.color ? raw.color : base.color,
    imageDataUrl,
    widthCm: Number.isFinite(Number(raw.widthCm)) ? Number(raw.widthCm) : base.widthCm,
    lengthCm: Number.isFinite(Number(raw.lengthCm)) ? Number(raw.lengthCm) : base.lengthCm,
    spacingCm: Number.isFinite(Number(raw.spacingCm)) ? Number(raw.spacingCm) : base.spacingCm,
  };
}

export function defaultLayerPlacement(tileId) {
  return {
    tileId,
    offsetXCm: 0,
    offsetYCm: 0,
    orientationDeg: 0,
  };
}

export function normalizeLayerPlacement(raw, fallbackTileId) {
  const base = defaultLayerPlacement(fallbackTileId);
  if (!raw || typeof raw !== 'object') return base;
  return {
    tileId: String(raw.tileId || fallbackTileId),
    offsetXCm: Number.isFinite(Number(raw.offsetXCm)) ? Number(raw.offsetXCm) : base.offsetXCm,
    offsetYCm: Number.isFinite(Number(raw.offsetYCm)) ? Number(raw.offsetYCm) : base.offsetYCm,
    orientationDeg: Number.isFinite(Number(raw.orientationDeg))
      ? Number(raw.orientationDeg)
      : base.orientationDeg,
  };
}

export function findTile(library, tileId) {
  return library.find((t) => t.id === tileId) || null;
}

export function resolveLayer(library, layerRef) {
  const fallbackId = library[0]?.id;
  const tile = findTile(library, layerRef?.tileId) || library[0];
  const placement = normalizeLayerPlacement(layerRef, tile?.id || fallbackId);
  if (!tile) return defaultTiling();
  return {
    color: tile.color,
    imageDataUrl: tile.imageDataUrl,
    widthCm: tile.widthCm,
    lengthCm: tile.lengthCm,
    spacingCm: tile.spacingCm,
    offsetXCm: placement.offsetXCm,
    offsetYCm: placement.offsetYCm,
    orientationDeg: placement.orientationDeg,
  };
}

export function resolveConfigLayers(config) {
  const library = config.tileLibrary || [];
  return {
    baseTiling: resolveLayer(library, config.baseLayer),
    areas: (config.areas || []).map((area) => ({
      ...area,
      tiling: resolveLayer(library, area.layer),
    })),
  };
}

function definitionKey(def) {
  return JSON.stringify({
    color: def.color,
    imageDataUrl: def.imageDataUrl,
    widthCm: def.widthCm,
    lengthCm: def.lengthCm,
    spacingCm: def.spacingCm,
  });
}

function definitionFromTiling(tiling) {
  const t = normalizeTiling(tiling);
  return {
    color: t.color,
    imageDataUrl: t.imageDataUrl,
    widthCm: t.widthCm,
    lengthCm: t.lengthCm,
    spacingCm: t.spacingCm,
  };
}

export function migrateLegacyConfig(raw) {
  const library = [];
  const idByKey = new Map();
  let nameCounter = 1;

  function ensureTile(tiling, preferredName) {
    const def = definitionFromTiling(tiling);
    const key = definitionKey(def);
    if (idByKey.has(key)) return idByKey.get(key);
    const id = crypto.randomUUID();
    library.push(
      normalizeTileDefinition({
        id,
        name: preferredName || `Tile ${nameCounter++}`,
        ...def,
      }),
    );
    idByKey.set(key, id);
    return id;
  }

  const baseTiling = normalizeTiling(raw.baseTiling);
  const baseTileId = ensureTile(baseTiling, 'Default');
  const baseLayer = normalizeLayerPlacement(
    {
      tileId: baseTileId,
      offsetXCm: baseTiling.offsetXCm,
      offsetYCm: baseTiling.offsetYCm,
      orientationDeg: baseTiling.orientationDeg,
    },
    baseTileId,
  );

  const areas = (Array.isArray(raw.areas) ? raw.areas : [])
    .filter((a) => a && Array.isArray(a.points) && a.points.length >= 3)
    .map((a, i) => {
      const tiling = normalizeTiling(a.tiling);
      const tileId = ensureTile(tiling, `Tile ${i + 1}`);
      return {
        id: String(a.id || crypto.randomUUID()),
        kind: a.kind === 'rect' ? 'rect' : 'polygon',
        points: a.points.map(([x, y]) => [Number(x), Number(y)]),
        layer: normalizeLayerPlacement(
          {
            tileId,
            offsetXCm: tiling.offsetXCm,
            offsetYCm: tiling.offsetYCm,
            orientationDeg: tiling.orientationDeg,
          },
          tileId,
        ),
      };
    });

  if (!library.length) {
    const fallback = defaultTileDefinition('Default');
    library.push(fallback);
    baseLayer.tileId = fallback.id;
  }

  return { tileLibrary: library, baseLayer, areas };
}

export function normalizeTileLibrary(raw) {
  if (!Array.isArray(raw) || !raw.length) {
    return [defaultTileDefinition('Default')];
  }
  return raw.map((t) => normalizeTileDefinition(t));
}

export function countTileUsage(config, tileId) {
  let count = 0;
  if (config.baseLayer?.tileId === tileId) count += 1;
  for (const area of config.areas || []) {
    if (area.layer?.tileId === tileId) count += 1;
  }
  return count;
}

export function formatTileSize(tile) {
  return `${tile.widthCm}×${tile.lengthCm} cm`;
}
