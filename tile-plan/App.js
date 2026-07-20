import htm from 'htm';
import {
  createElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  buildFloorPlan,
  parseSweetHome3dFile,
  pointsToPath,
} from './floorPlan.js';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redoHistory,
  undoHistory,
} from './history.js';
import {
  aabbFromPoints,
  areasIntersectFloor,
  collectSnapTargets,
  emptySnapGuides,
  HANDLE_SIZE_CM,
  handlePosition,
  RESIZE_HANDLES,
  rectPointsFromAabb,
  SNAP_SOURCE,
  snapResizeAabb,
  snapTranslation,
  translatePoints,
} from './snap.js';
import {
  CAMERA_STORAGE_KEY,
  createDefaultCamera,
  createDefaultConfig,
  downloadConfig,
  loadCamera,
  loadConfig,
  loadInitJson,
  normalizeCamera,
  parseImportedFile,
  saveCamera,
  saveConfig,
  STORAGE_KEY,
} from './storage.js';
import {
  AreaGeometryFields,
  CollapsiblePanel,
  LayerPlacementFields,
  TileLibraryPanel,
  TileSwatch,
} from './libraryUi.js';
import {
  defaultLayerPlacement,
  defaultTileDefinition,
  findTile,
  getAreaLayerName,
  getBaseLayerName,
  resolveConfigLayers,
} from './tileLibrary.js';
import { clipPointsToFloor, computeTilingPreview } from './tiling.js';

const h = htm.bind(createElement);

const BASE_SELECTION = 'base';
const PITCH_STEP = 5;
const YAW_STEP = 10;
const ZOOM_STEP = 0.12;
/** 1 mm in app units (cm). */
const NUDGE_CM = 0.1;

function cameraTransformCss(camera) {
  return `rotateX(${camera.pitchDeg}deg) rotateZ(${camera.yawDeg}deg) scale(${camera.zoom})`;
}

function cameraTransformStyle(camera) {
  return { transform: cameraTransformCss(camera) };
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Map image onto the full tile quad; clip to the visible piece. */
const TilePiece = memo(function TilePiece({ piece, id }) {
  const pathD = pointsToPath(piece.points);
  const style = { pointerEvents: 'none' };

  if (!piece.imageDataUrl || !piece.tileCorners || piece.tileCorners.length < 4) {
    return h`
      <path
        key=${id}
        class="tile-piece"
        fill=${piece.color}
        d=${pathD}
        style=${style}
      />
    `;
  }

  const [p0, p1, , p3] = piece.tileCorners;
  const w = piece.widthCm;
  const ht = piece.lengthCm;
  const a = (p1[0] - p0[0]) / w;
  const b = (p1[1] - p0[1]) / w;
  const c = (p3[0] - p0[0]) / ht;
  const d = (p3[1] - p0[1]) / ht;
  const e = p0[0];
  const f = p0[1];
  const clipId = `tile-clip-${id}`;

  return h`
    <g key=${id} style=${style}>
      <defs>
        <clipPath id=${clipId}>
          <path d=${pathD} />
        </clipPath>
      </defs>
      <g clip-path=${`url(#${clipId})`}>
        <path class="tile-piece" fill=${piece.color} d=${pathD} />
        <image
          href=${piece.imageDataUrl}
          width=${w}
          height=${ht}
          preserveAspectRatio="none"
          transform=${`matrix(${a} ${b} ${c} ${d} ${e} ${f})`}
        />
      </g>
    </g>
  `;
});

/** Isolates tile SVG from App re-renders (camera, menus, live form fields). */
const TilePreviewLayer = memo(function TilePreviewLayer({ preview }) {
  return h`
    <g clip-path="url(#floor-clip)">
      ${preview.basePieces.map(
        (piece, i) => h`
          <${TilePiece} key=${`b-${i}`} id=${`b-${i}`} piece=${piece} />
        `,
      )}
      ${preview.areas.map((area) =>
        area.pieces.map(
          (piece, i) => h`
            <${TilePiece}
              key=${`${area.id}-${i}`}
              id=${`${area.id}-${i}`}
              piece=${piece}
            />
          `,
        ),
      )}
    </g>
  `;
});

function svgPoint(svg, clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const local = pt.matrixTransform(ctm.inverse());
  return [local.x, local.y];
}

function mergeLiveAreas(areas, liveAreas) {
  if (!liveAreas) return areas;
  return areas.map((a) => (liveAreas[a.id] ? { ...a, points: liveAreas[a.id] } : a));
}

function roundCm(n) {
  return Math.round(Number(n) * 100) / 100;
}

function boundsFromPoints(points) {
  const aabb = aabbFromPoints(points);
  return {
    x: roundCm(aabb.minX),
    y: roundCm(aabb.minY),
    width: roundCm(aabb.maxX - aabb.minX),
    height: roundCm(aabb.maxY - aabb.minY),
  };
}

function pointsFromAreaBounds(area, currentPoints, bounds) {
  const width = Math.max(0.1, Number(bounds.width) || 0.1);
  const height = Math.max(0.1, Number(bounds.height) || 0.1);
  const minX = Number(bounds.x);
  const minY = Number(bounds.y);
  if (area.kind === 'rect') {
    return rectPointsFromAabb({
      minX,
      minY,
      maxX: minX + width,
      maxY: minY + height,
    });
  }
  const old = aabbFromPoints(currentPoints);
  const oldW = Math.max(1e-9, old.maxX - old.minX);
  const oldH = Math.max(1e-9, old.maxY - old.minY);
  return currentPoints.map(([x, y]) => [
    minX + ((x - old.minX) / oldW) * width,
    minY + ((y - old.minY) / oldH) * height,
  ]);
}

function reorderAreas(areas, dragId, targetId, insertAfter) {
  if (dragId === targetId) return areas;
  const from = areas.findIndex((a) => a.id === dragId);
  let to = areas.findIndex((a) => a.id === targetId);
  if (from < 0 || to < 0) return areas;
  const next = [...areas];
  const [item] = next.splice(from, 1);
  if (from < to) to -= 1;
  if (insertAfter) to += 1;
  next.splice(to, 0, item);
  return next;
}

export function App() {
  const noSavedConfig = useRef(false);
  const [history, setHistory] = useState(() => {
    const saved = loadConfig();
    noSavedConfig.current = saved === null;
    return createHistory(saved ?? createDefaultConfig());
  });
  const config = history.present;
  const [tool, setTool] = useState('select');
  /** null | 'base' | area uuid */
  const [selectedId, setSelectedId] = useState(BASE_SELECTION);
  const [draft, setDraft] = useState(null);
  const [liveBaseLayer, setLiveBaseLayer] = useState(null);
  const [liveAreaLayer, setLiveAreaLayer] = useState(null);
  const [liveAreas, setLiveAreas] = useState(null);
  const [snapGuides, setSnapGuides] = useState(() => emptySnapGuides());
  const [viewMode, setViewMode] = useState('edit'); // 'edit' | '3d'
  const [camera, setCamera] = useState(() => loadCamera());
  const [orbiting, setOrbiting] = useState(false);
  const [layerDragId, setLayerDragId] = useState(null);
  const [layerDrop, setLayerDrop] = useState(null);
  const [editingTileId, setEditingTileId] = useState(null);
  const [liveTileDraft, setLiveTileDraft] = useState(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [addLayerMenuOpen, setAddLayerMenuOpen] = useState(false);
  const [liveLayerName, setLiveLayerName] = useState('');
  const [liveBounds, setLiveBounds] = useState(null);
  const fileRef = useRef(null);
  const floorFileRef = useRef(null);
  const svgRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const layerDragRef = useRef(null);
  const orbitRef = useRef(null);
  const cameraRef = useRef(camera);
  const cameraSaveTimerRef = useRef(null);
  const is3d = viewMode === '3d';

  const selectedAreaId = selectedId && selectedId !== BASE_SELECTION ? selectedId : null;
  const baseSelected = selectedId === BASE_SELECTION;

  const floorPlan = useMemo(() => buildFloorPlan(config.floorPlan), [config.floorPlan]);

  const resolvedLayers = useMemo(() => {
    const previewConfig = {
      ...config,
      baseLayer: liveBaseLayer || config.baseLayer,
      areas: mergeLiveAreas(config.areas, liveAreas).map((area) => {
        if (liveAreaLayer && selectedAreaId === area.id) {
          return { ...area, layer: liveAreaLayer };
        }
        return area;
      }),
    };
    return resolveConfigLayers(previewConfig);
  }, [config, liveBaseLayer, liveAreaLayer, selectedAreaId, liveAreas]);

  const displayConfig = useMemo(
    () => ({
      ...config,
      baseTiling: resolvedLayers.baseTiling,
      areas: mergeLiveAreas(resolvedLayers.areas, liveAreas),
    }),
    [config, resolvedLayers, liveAreas],
  );

  // Defer expensive tile recompute while dragging/editing so the UI stays responsive.
  const deferredDisplayConfig = useDeferredValue(displayConfig);
  const preview = useMemo(
    () =>
      computeTilingPreview(
        deferredDisplayConfig.baseTiling,
        deferredDisplayConfig.areas,
        floorPlan,
      ),
    [deferredDisplayConfig, floorPlan],
  );

  const selectedArea = config.areas.find((a) => a.id === selectedAreaId) || null;

  const selectedDisplay = useMemo(
    () => displayConfig.areas.find((a) => a.id === selectedAreaId) || null,
    [displayConfig.areas, selectedAreaId],
  );

  useEffect(() => {
    if (noSavedConfig.current) {
      loadInitJson().then((initConfig) => {
        if (initConfig) {
          setHistory(createHistory(initConfig));
        }
      });
    }
  }, []);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    cameraRef.current = camera;
    const el = stageRef.current;
    if (!el) return;
    if (is3d) {
      el.style.transform = cameraTransformCss(camera);
    } else {
      el.style.transform = '';
    }
  }, [camera, is3d]);

  useEffect(() => {
    return () => {
      if (cameraSaveTimerRef.current) {
        clearTimeout(cameraSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    setLiveBaseLayer(null);
  }, [config.baseLayer]);

  useEffect(() => {
    setLiveAreaLayer(null);
  }, [config.areas, selectedAreaId]);

  useEffect(() => {
    if (liveTileDraft) return;
    if (baseSelected) {
      setEditingTileId(config.baseLayer.tileId);
    } else if (selectedArea) {
      setEditingTileId(selectedArea.layer?.tileId ?? null);
    }
  }, [baseSelected, selectedArea?.id, selectedArea?.layer?.tileId, config.baseLayer.tileId, liveTileDraft]);

  useEffect(() => {
    if (baseSelected) {
      setLiveLayerName(config.baseLayerName || 'Base');
    } else if (selectedArea) {
      setLiveLayerName(selectedArea.name || '');
    } else {
      setLiveLayerName('');
    }
  }, [baseSelected, selectedArea, config.baseLayerName, selectedArea?.name, selectedArea?.id]);

  useEffect(() => {
    if (!selectedArea) {
      setLiveBounds(null);
      return;
    }
    setLiveBounds(boundsFromPoints(selectedArea.points));
  }, [selectedAreaId, selectedArea?.points]);

  useEffect(() => {
    if (!saveMenuOpen && !addLayerMenuOpen) return undefined;
    const closeMenus = () => {
      setSaveMenuOpen(false);
      setAddLayerMenuOpen(false);
    };
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, [saveMenuOpen, addLayerMenuOpen]);

  useEffect(() => {
    if (!is3d) return;
    setDraft(null);
    setLiveAreas(null);
    setSnapGuides(emptySnapGuides());
    dragRef.current = null;
    setTool('select');
    setLayerDragId(null);
    setLayerDrop(null);
    layerDragRef.current = null;
  }, [is3d]);

  const applyCameraDom = useCallback((cam) => {
    cameraRef.current = cam;
    const el = stageRef.current;
    if (el) el.style.transform = cameraTransformCss(cam);
  }, []);

  const commitCamera = useCallback((cam, { debounceMs = 0 } = {}) => {
    if (cam) cameraRef.current = cam;
    if (cameraSaveTimerRef.current) {
      clearTimeout(cameraSaveTimerRef.current);
      cameraSaveTimerRef.current = null;
    }
    const flush = () => {
      cameraSaveTimerRef.current = null;
      const latest = cameraRef.current;
      setCamera(latest);
      saveCamera(latest);
    };
    if (debounceMs > 0) {
      cameraSaveTimerRef.current = setTimeout(flush, debounceMs);
    } else {
      flush();
    }
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !is3d) return undefined;
    const onWheelNative = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      const next = normalizeCamera({
        ...cameraRef.current,
        zoom: cameraRef.current.zoom + delta,
      });
      applyCameraDom(next);
      commitCamera(next, { debounceMs: 120 });
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [is3d, applyCameraDom, commitCamera]);

  const updateCamera = useCallback(
    (patch) => {
      const prev = cameraRef.current;
      const next = normalizeCamera({
        ...prev,
        ...(typeof patch === 'function' ? patch(prev) : patch),
      });
      applyCameraDom(next);
      commitCamera(next);
    },
    [applyCameraDom, commitCamera],
  );

  const commit = useCallback((next) => {
    setHistory((h) => pushHistory(h, next));
  }, []);

  const undo = useCallback(() => {
    setHistory((h) => undoHistory(h));
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => redoHistory(h));
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (isTypingTarget(e.target)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (e.key === 'Escape') {
        setSaveMenuOpen(false);
        setAddLayerMenuOpen(false);
        setDraft(null);
        setLiveAreas(null);
        setSnapGuides(emptySnapGuides());
        dragRef.current = null;
        setTool('select');
      } else if (e.key === 'Enter' && draft?.kind === 'polygon' && draft.points.length >= 3) {
        e.preventDefault();
        finishPolygon(draft.points);
      } else if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        selectedAreaId &&
        tool === 'select' &&
        !dragRef.current &&
        !is3d
      ) {
        e.preventDefault();
        deleteSelected();
      } else if (
        !is3d &&
        tool === 'select' &&
        !dragRef.current &&
        (baseSelected || selectedAreaId) &&
        (e.key === 'ArrowUp' ||
          e.key === 'ArrowDown' ||
          e.key === 'ArrowLeft' ||
          e.key === 'ArrowRight')
      ) {
        e.preventDefault();
        const dx = e.key === 'ArrowLeft' ? -NUDGE_CM : e.key === 'ArrowRight' ? NUDGE_CM : 0;
        const dy = e.key === 'ArrowUp' ? -NUDGE_CM : e.key === 'ArrowDown' ? NUDGE_CM : 0;
        if (mod) {
          nudgeSelectedLayerOffset(dx, dy);
        } else {
          nudgeSelectedLayerGeometry(dx, dy);
        }
      } else if (
        !is3d &&
        tool === 'select' &&
        !dragRef.current &&
        (baseSelected || selectedAreaId) &&
        (e.key === 'PageUp' || e.key === 'PageDown')
      ) {
        e.preventDefault();
        nudgeSelectedTileSpacing(e.key === 'PageUp' ? NUDGE_CM : -NUDGE_CM);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function selectBase() {
    setSelectedId(BASE_SELECTION);
    setTool('select');
  }

  function selectArea(id) {
    setSelectedId(id);
    setTool('select');
  }

  function clearSelection() {
    setSelectedId(null);
  }

  function finishPolygon(points) {
    const clipped = clipPointsToFloor(points, floorPlan);
    setDraft(null);
    if (!clipped || clipped.length < 3) return;
    const area = {
      id: crypto.randomUUID(),
      kind: 'polygon',
      points: clipped,
      layer: defaultLayerPlacement(config.baseLayer.tileId),
    };
    commit({
      ...config,
      areas: [...config.areas, area],
    });
    setSelectedId(area.id);
    setTool('select');
  }

  function finishRect(a, b) {
    const points = rectPointsFromAabb({
      minX: Math.min(a[0], b[0]),
      minY: Math.min(a[1], b[1]),
      maxX: Math.max(a[0], b[0]),
      maxY: Math.max(a[1], b[1]),
    });
    const clipped = clipPointsToFloor(points, floorPlan);
    setDraft(null);
    dragRef.current = null;
    if (!clipped || clipped.length < 3) return;
    const w = Math.abs(a[0] - b[0]);
    const ht = Math.abs(a[1] - b[1]);
    if (w < 1 || ht < 1) return;
    const area = {
      id: crypto.randomUUID(),
      kind: 'rect',
      points,
      layer: defaultLayerPlacement(config.baseLayer.tileId),
    };
    commit({
      ...config,
      areas: [...config.areas, area],
    });
    setSelectedId(area.id);
    setTool('select');
  }

  function layerWithTileId(existingLayer, tileId) {
    return {
      tileId,
      offsetXCm: existingLayer?.offsetXCm ?? 0,
      offsetYCm: existingLayer?.offsetYCm ?? 0,
      orientationDeg: existingLayer?.orientationDeg ?? 0,
    };
  }

  function configWithTileAssigned(cfg, tileId) {
    if (baseSelected) {
      return { ...cfg, baseLayer: layerWithTileId(cfg.baseLayer, tileId) };
    }
    if (selectedArea) {
      return {
        ...cfg,
        areas: cfg.areas.map((a) =>
          a.id === selectedArea.id ? { ...a, layer: layerWithTileId(a.layer, tileId) } : a,
        ),
      };
    }
    return cfg;
  }

  function assignTileToCurrentLayer(tileId) {
    if (is3d) return;
    setEditingTileId(tileId);
    setLiveTileDraft(null);
    if (baseSelected || selectedArea) {
      commit(configWithTileAssigned(config, tileId));
    }
  }

  function startAddLayer(kind) {
    setAddLayerMenuOpen(false);
    setTool(kind);
    setDraft(null);
  }

  function commitTileLibraryEdit(tile) {
    setLiveTileDraft(null);
    commit({
      ...config,
      tileLibrary: config.tileLibrary.map((t) => (t.id === tile.id ? tile : t)),
    });
  }

  function deleteTileFromLibrary(tileId) {
    commit({
      ...config,
      tileLibrary: config.tileLibrary.filter((t) => t.id !== tileId),
    });
    if (editingTileId === tileId) {
      setEditingTileId(null);
      setLiveTileDraft(null);
    }
  }

  async function resetToInit() {
    if (!window.confirm('Reset to initial configuration? Your current work will be lost.')) return;
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(CAMERA_STORAGE_KEY);
    const initConfig = await loadInitJson();
    setHistory(createHistory(initConfig ?? createDefaultConfig()));
    setCamera(normalizeCamera(createDefaultCamera()));
    selectBase();
    setTool('select');
    setDraft(null);
    setLiveAreas(null);
    setSnapGuides(emptySnapGuides());
    setEditingTileId(null);
    setLiveTileDraft(null);
  }

  function renameBaseLayer(name) {
    const trimmed = name.trim();
    commit({ ...config, baseLayerName: trimmed || 'Base' });
  }

  function renameAreaLayer(areaId, name) {
    commit({
      ...config,
      areas: config.areas.map((a) => (a.id === areaId ? { ...a, name: name.trim() } : a)),
    });
  }

  function deleteSelected() {
    if (!selectedAreaId) return;
    commit({ ...config, areas: config.areas.filter((a) => a.id !== selectedAreaId) });
    selectBase();
  }

  function cloneSelected() {
    if (!selectedArea || is3d) return;
    const layer = liveAreaLayer || selectedArea.layer;
    const points = liveAreas?.[selectedArea.id] || selectedArea.points;
    const index = config.areas.findIndex((a) => a.id === selectedArea.id);
    const baseName = (selectedArea.name || '').trim() || getAreaLayerName(selectedArea, index);
    const clone = {
      id: crypto.randomUUID(),
      kind: selectedArea.kind,
      name: `${baseName} copy`,
      points: points.map(([x, y]) => [x, y]),
      layer: {
        tileId: layer.tileId,
        offsetXCm: layer.offsetXCm,
        offsetYCm: layer.offsetYCm,
        orientationDeg: layer.orientationDeg,
      },
    };
    const areas = [...config.areas];
    areas.splice(index + 1, 0, clone);
    commit({ ...config, areas });
    setSelectedId(clone.id);
    setTool('select');
    setLiveAreaLayer(null);
    setLiveAreas(null);
  }

  function startLayerDrag(e, areaId) {
    if (is3d) return;
    layerDragRef.current = areaId;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', areaId);
    setLayerDragId(areaId);
  }

  function endLayerDrag() {
    layerDragRef.current = null;
    setLayerDragId(null);
    setLayerDrop(null);
  }

  function updateLayerDropTarget(e, areaId) {
    const dragId = layerDragRef.current;
    if (is3d || !dragId || dragId === areaId) {
      setLayerDrop(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    setLayerDrop({ id: areaId, insertAfter });
  }

  function finishLayerDrop(e, targetId) {
    e.preventDefault();
    const dragId = e.dataTransfer.getData('text/plain') || layerDragRef.current;
    if (!dragId || dragId === targetId || is3d) {
      endLayerDrag();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const insertAfter = e.clientY > rect.top + rect.height / 2;
    commit({
      ...config,
      areas: reorderAreas(config.areas, dragId, targetId, insertAfter),
    });
    endLayerDrag();
  }

  function nudgeSelectedLayerGeometry(dx, dy) {
    if (!selectedAreaId) return;
    const area = config.areas.find((a) => a.id === selectedAreaId);
    if (!area) return;
    commitAreaPoints(selectedAreaId, translatePoints(area.points, dx, dy));
  }

  function nudgeSelectedLayerOffset(dx, dy) {
    const roundMm = (n) => Math.round(Number(n) * 1000) / 1000;
    if (baseSelected) {
      const layer = liveBaseLayer || config.baseLayer;
      setLiveBaseLayer(null);
      commit({
        ...config,
        baseLayer: {
          ...layer,
          offsetXCm: roundMm(Number(layer.offsetXCm) + dx),
          offsetYCm: roundMm(Number(layer.offsetYCm) + dy),
        },
      });
      return;
    }
    if (!selectedArea) return;
    const layer = liveAreaLayer || selectedArea.layer;
    setLiveAreaLayer(null);
    commit({
      ...config,
      areas: config.areas.map((a) =>
        a.id === selectedArea.id
          ? {
              ...a,
              layer: {
                ...layer,
                offsetXCm: roundMm(Number(layer.offsetXCm) + dx),
                offsetYCm: roundMm(Number(layer.offsetYCm) + dy),
              },
            }
          : a,
      ),
    });
  }

  function nudgeSelectedTileSpacing(deltaCm) {
    const tileId = baseSelected
      ? config.baseLayer.tileId
      : selectedArea?.layer?.tileId;
    if (!tileId) return;
    const tile = findTile(config.tileLibrary, tileId);
    if (!tile) return;
    const spacingCm = Math.max(0, Math.round((Number(tile.spacingCm) + deltaCm) * 1000) / 1000);
    commit({
      ...config,
      tileLibrary: config.tileLibrary.map((t) => (t.id === tileId ? { ...t, spacingCm } : t)),
    });
    if (liveTileDraft?.id === tileId) {
      setLiveTileDraft({ ...liveTileDraft, spacingCm });
    }
  }

  function applySelectedAreaBounds(bounds, commitNow = false) {
    if (!selectedArea) return;
    setLiveBounds(bounds);
    const sourcePoints = liveAreas?.[selectedArea.id] || selectedArea.points;
    const points = pointsFromAreaBounds(selectedArea, sourcePoints, bounds);
    if (commitNow) {
      commitAreaPoints(selectedArea.id, points);
    } else {
      setLiveAreas({ [selectedArea.id]: points });
    }
  }

  function commitAreaPoints(areaId, points) {
    if (!areasIntersectFloor(points, floorPlan) && !clipPointsToFloor(points, floorPlan)) {
      setLiveAreas(null);
      setSnapGuides(emptySnapGuides());
      return;
    }
    commit({
      ...config,
      areas: config.areas.map((a) => {
        if (a.id !== areaId) return a;
        if (a.kind === 'rect') {
          return { ...a, points: rectPointsFromAabb(aabbFromPoints(points)) };
        }
        return { ...a, points };
      }),
    });
    setLiveAreas(null);
    setSnapGuides(emptySnapGuides());
  }

  function startMove(area, point, pointerId, target) {
    target.setPointerCapture?.(pointerId);
    setSelectedId(area.id);
    dragRef.current = {
      mode: 'move',
      areaId: area.id,
      start: point,
      originPoints: area.points.map((p) => [...p]),
      pointerId,
    };
  }

  function startResize(area, handleId, point, pointerId, target) {
    target.setPointerCapture?.(pointerId);
    setSelectedId(area.id);
    dragRef.current = {
      mode: 'resize',
      areaId: area.id,
      handleId,
      originAabb: aabbFromPoints(area.points),
      pointerId,
    };
  }

  function updateEditDrag(point) {
    const drag = dragRef.current;
    if (!drag) return;

    const baseTiling = displayConfig.baseTiling;
    const activeArea = displayConfig.areas.find((a) => a.id === drag.areaId);
    const activeTiling = activeArea?.tiling;
    const { groups } = collectSnapTargets(
      displayConfig.areas,
      drag.areaId,
      baseTiling,
      activeTiling,
      floorPlan,
    );
    const guides = emptySnapGuides();

    if (drag.mode === 'move') {
      const dx = point[0] - drag.start[0];
      const dy = point[1] - drag.start[1];
      const aabb = aabbFromPoints(drag.originPoints);
      const [sdx, sdy] = snapTranslation(aabb, dx, dy, groups, guides);
      const nextPoints = translatePoints(drag.originPoints, sdx, sdy);
      drag.currentPoints = nextPoints;
      setLiveAreas({ [drag.areaId]: nextPoints });
      setSnapGuides(guides);
      return;
    }

    if (drag.mode === 'resize') {
      const nextAabb = snapResizeAabb(
        drag.originAabb,
        drag.handleId,
        point,
        groups,
        guides,
      );
      const nextPoints = rectPointsFromAabb(nextAabb);
      drag.currentPoints = nextPoints;
      setLiveAreas({ [drag.areaId]: nextPoints });
      setSnapGuides(guides);
    }
  }

  function endEditDrag() {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const points = drag.currentPoints;
    if (!points) {
      setLiveAreas(null);
      setSnapGuides(emptySnapGuides());
      return;
    }
    const origin = config.areas.find((a) => a.id === drag.areaId);
    if (!origin) {
      setLiveAreas(null);
      setSnapGuides(emptySnapGuides());
      return;
    }
    const same =
      origin.points.length === points.length &&
      origin.points.every(
        (p, i) => Math.abs(p[0] - points[i][0]) < 1e-6 && Math.abs(p[1] - points[i][1]) < 1e-6,
      );
    if (same) {
      setLiveAreas(null);
      setSnapGuides(emptySnapGuides());
      return;
    }
    commitAreaPoints(drag.areaId, points);
  }

  function onPointerDown(e) {
    if (is3d) {
      // Middle button, or primary drag on empty background, orbits the 3D view.
      if (e.button === 1 || e.button === 0) {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        orbitRef.current = {
          pointerId: e.pointerId,
          lastX: e.clientX,
          lastY: e.clientY,
        };
        setOrbiting(true);
      }
      return;
    }

    const svg = svgRef.current;
    if (!svg) return;
    const p = svgPoint(svg, e.clientX, e.clientY);
    if (!p) return;

    if (tool === 'select') {
      // Handle / area handlers stopPropagation; empty canvas deselects.
      if (e.target === svg || e.target.classList?.contains('floor-outline')) {
        clearSelection();
      }
      return;
    }

    if (tool === 'rect') {
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { start: p, mode: 'draw-rect' };
      setDraft({ kind: 'rect', points: [p, p, p, p] });
      return;
    }

    if (tool === 'polygon') {
      if (!draft || draft.kind !== 'polygon') {
        setDraft({ kind: 'polygon', points: [p], cursor: p });
      } else {
        setDraft({ ...draft, points: [...draft.points, p], cursor: p });
      }
    }
  }

  function onPointerMove(e) {
    if (orbitRef.current && is3d) {
      const dx = e.clientX - orbitRef.current.lastX;
      const dy = e.clientY - orbitRef.current.lastY;
      orbitRef.current.lastX = e.clientX;
      orbitRef.current.lastY = e.clientY;
      const cam = cameraRef.current;
      applyCameraDom(
        normalizeCamera({
          yawDeg: cam.yawDeg + dx * 0.35,
          pitchDeg: cam.pitchDeg - dy * 0.25,
          zoom: cam.zoom,
        }),
      );
      return;
    }

    if (is3d) return;

    const svg = svgRef.current;
    if (!svg) return;
    const p = svgPoint(svg, e.clientX, e.clientY);
    if (!p) return;

    if (dragRef.current?.mode === 'move' || dragRef.current?.mode === 'resize') {
      updateEditDrag(p);
      return;
    }

    if (tool === 'rect' && dragRef.current?.mode === 'draw-rect') {
      const a = dragRef.current.start;
      setDraft({
        kind: 'rect',
        points: rectPointsFromAabb({
          minX: Math.min(a[0], p[0]),
          minY: Math.min(a[1], p[1]),
          maxX: Math.max(a[0], p[0]),
          maxY: Math.max(a[1], p[1]),
        }),
      });
      return;
    }

    if (tool === 'polygon' && draft?.kind === 'polygon') {
      setDraft({ ...draft, cursor: p });
    }
  }

  function onPointerUp(e) {
    if (orbitRef.current) {
      orbitRef.current = null;
      setOrbiting(false);
      commitCamera(cameraRef.current);
      return;
    }

    if (is3d) return;

    if (dragRef.current?.mode === 'move' || dragRef.current?.mode === 'resize') {
      endEditDrag();
      return;
    }

    if (tool === 'rect' && dragRef.current?.mode === 'draw-rect') {
      const svg = svgRef.current;
      const p = svg ? svgPoint(svg, e.clientX, e.clientY) : null;
      const start = dragRef.current.start;
      if (p) finishRect(start, p);
      else {
        setDraft(null);
        dragRef.current = null;
      }
    }
  }

  function onWheel() {
    /* native non-passive listener handles zoom in 3D mode */
  }

  function onDoubleClick(e) {
    if (is3d) return;
    if (tool === 'polygon' && draft?.kind === 'polygon' && draft.points.length >= 3) {
      e.preventDefault();
      finishPolygon(draft.points);
    }
  }

  function enter3d() {
    setViewMode('3d');
  }

  function enterEdit() {
    setViewMode('edit');
    setOrbiting(false);
    orbitRef.current = null;
  }

  function resetCamera() {
    const next = createDefaultCamera();
    applyCameraDom(next);
    commitCamera(next);
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await parseImportedFile(file);
      commit(imported);
      selectBase();
      setTool('select');
    } catch (err) {
      alert(`Could not import JSON: ${err.message || err}`);
    }
  }

  async function onImportFloorFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || is3d) return;
    try {
      const spec = await parseSweetHome3dFile(file);
      if (config.areas.length > 0) {
        const ok = window.confirm(
          'Loading a new floor removes existing areas because they use the old layout. Continue?',
        );
        if (!ok) return;
      }
      commit({
        ...config,
        floorPlanId: spec.id,
        floorPlan: spec,
        areas: [],
      });
      selectBase();
      setDraft(null);
      setTool('select');
    } catch (err) {
      alert(`Could not load floor XML: ${err.message || err}`);
    }
  }

  const floorLabel = floorPlan.label || floorPlan.id;
  const baseTile = findTile(config.tileLibrary, config.baseLayer.tileId);

  const draftPath =
    draft?.kind === 'polygon'
      ? pointsToPath(draft.cursor ? [...draft.points, draft.cursor] : draft.points)
      : draft?.points
        ? pointsToPath(draft.points)
        : '';

  const selectedAabb = selectedDisplay ? aabbFromPoints(selectedDisplay.points) : null;
  const handleHalf = HANDLE_SIZE_CM / 2;

  return h`
    <div class="app">
      <header class="toolbar">
        <h1>Tile plan</h1>
        <div class="toolbar-group">
          <button
            type="button"
            class="btn btn-icon"
            title="Undo (Ctrl+Z)"
            disabled=${!canUndo(history)}
            onClick=${undo}
          >↶</button>
          <button
            type="button"
            class="btn btn-icon"
            title="Redo (Ctrl+Y)"
            disabled=${!canRedo(history)}
            onClick=${redo}
          >↷</button>
        </div>
        <div class="toolbar-group">
          <button
            type="button"
            class=${`btn ${!is3d ? 'active' : ''}`}
            onClick=${enterEdit}
            title="Edit in top-down view"
          >Edit</button>
          <button
            type="button"
            class=${`btn ${is3d ? 'active' : ''}`}
            onClick=${enter3d}
            title="Read-only 3D preview"
          >3D</button>
        </div>
        <div class="toolbar-group">
          <div class="menu-anchor">
            <button
              type="button"
              class=${`btn ${saveMenuOpen ? 'active' : ''}`}
              onClick=${(e) => {
                e.stopPropagation();
                setSaveMenuOpen((open) => !open);
              }}
            >Save ▾</button>
            ${saveMenuOpen
              ? h`
                  <div class="dropdown-menu">
                    <button
                      type="button"
                      class="dropdown-item"
                      onClick=${() => {
                        setSaveMenuOpen(false);
                        downloadConfig(config);
                      }}
                    >Export JSON</button>
                    <button
                      type="button"
                      class="dropdown-item"
                      disabled=${is3d}
                      onClick=${() => {
                        setSaveMenuOpen(false);
                        fileRef.current?.click();
                      }}
                    >Import JSON</button>
                    <button
                      type="button"
                      class="dropdown-item"
                      disabled=${is3d}
                      onClick=${() => {
                        setSaveMenuOpen(false);
                        floorFileRef.current?.click();
                      }}
                    >Load floor XML</button>
                    <button
                      type="button"
                      class="dropdown-item danger"
                      onClick=${() => {
                        setSaveMenuOpen(false);
                        resetToInit();
                      }}
                    >Reset to init.json</button>
                  </div>
                `
              : null}
          </div>
          <input
            ref=${floorFileRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            hidden
            onChange=${onImportFloorFile}
          />
          <input
            ref=${fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange=${onImportFile}
          />
        </div>
        <div class="toolbar-spacer"></div>
        <div class="count-badge" title="Each cut tile counts as a full tile (leftovers are not reused)">
          Tiles <strong>${preview.totalCount}</strong>
          <span style=${{ color: 'var(--muted)' }}>
            (base ${preview.baseCount}${preview.areas.length ? ` + areas ${preview.totalCount - preview.baseCount}` : ''})
          </span>
        </div>
      </header>

      <div class="main">
        <aside class="sidebar">
          <${CollapsiblePanel}
            title="Layers"
            variant="layers"
            defaultOpen=${true}
            actions=${!is3d
              ? h`
                  <div class="menu-anchor">
                    <button
                      type="button"
                      class=${`btn ${addLayerMenuOpen ? 'active' : ''}`}
                      onClick=${(e) => {
                        e.stopPropagation();
                        setAddLayerMenuOpen((open) => !open);
                      }}
                    >+ Add</button>
                    ${addLayerMenuOpen
                      ? h`
                          <div class="dropdown-menu dropdown-menu-right">
                            <button
                              type="button"
                              class="dropdown-item"
                              onClick=${() => startAddLayer('rect')}
                            >Rectangle</button>
                            <button
                              type="button"
                              class="dropdown-item"
                              onClick=${() => startAddLayer('polygon')}
                            >Polygon</button>
                          </div>
                        `
                      : null}
                  </div>
                `
              : null}
          >
            <p class="hint">
              ${is3d
                ? '3D mode is read-only. Switch to Edit to change layers, draw areas, or resize.'
                : tool === 'rect'
                  ? 'Draw a rectangle on the canvas. Esc cancels.'
                  : tool === 'polygon'
                    ? 'Click points on the canvas. Enter or double-click to finish. Esc cancels.'
                    : h`Select a layer, then pick a tile from the library. Drag the
              <span class="layer-drag-handle inline">⋮⋮</span> grip to reorder stacking.`}
            </p>
            <ul class="area-list">
              <li>
                <button
                  type="button"
                  class=${`btn select layer-select ${baseSelected ? 'active' : ''}`}
                  onClick=${selectBase}
                >
                  ${baseTile ? h`<${TileSwatch} tile=${baseTile} />` : null}
                  <span>${getBaseLayerName(config)} · ${preview.baseCount} tiles</span>
                </button>
              </li>
              ${config.areas.map(
                (area, i) => {
                  const areaTile = findTile(config.tileLibrary, area.layer?.tileId);
                  const areaPreview = preview.areas.find((a) => a.id === area.id);
                  const dropBefore = layerDrop?.id === area.id && !layerDrop.insertAfter;
                  const dropAfter = layerDrop?.id === area.id && layerDrop.insertAfter;
                  return h`
                  <li
                    key=${area.id}
                    class=${[
                      layerDragId === area.id ? 'layer-dragging' : '',
                      dropBefore ? 'layer-drop-before' : '',
                      dropAfter ? 'layer-drop-after' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragOver=${(e) => updateLayerDropTarget(e, area.id)}
                    onDragLeave=${(e) => {
                      if (e.currentTarget.contains(e.relatedTarget)) return;
                      if (layerDrop?.id === area.id) setLayerDrop(null);
                    }}
                    onDrop=${(e) => finishLayerDrop(e, area.id)}
                  >
                    <span
                      class="layer-drag-handle"
                      draggable=${!is3d}
                      title="Drag to reorder layer"
                      onDragStart=${(e) => startLayerDrag(e, area.id)}
                      onDragEnd=${endLayerDrag}
                    >⋮⋮</span>
                    <button
                      type="button"
                      class=${`btn select layer-select ${selectedAreaId === area.id ? 'active' : ''}`}
                      onClick=${() => selectArea(area.id)}
                    >
                      ${areaTile ? h`<${TileSwatch} tile=${areaTile} />` : null}
                      <span>
                        ${getAreaLayerName(area, i)}
                        ${areaPreview ? ` · ${areaPreview.count} tiles` : ''}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="btn danger btn-icon"
                      title="Delete area"
                      disabled=${is3d}
                      onClick=${() => {
                        if (is3d) return;
                        commit({
                          ...config,
                          areas: config.areas.filter((a) => a.id !== area.id),
                        });
                        if (selectedAreaId === area.id) selectBase();
                      }}
                    >×</button>
                  </li>
                `;
                },
              )}
            </ul>

            ${!is3d && baseSelected
              ? h`
                  <div class="panel-subsection">
                    <h3>Base layer</h3>
                    <div class="field">
                      <label>Layer name</label>
                      <input
                        type="text"
                        value=${liveLayerName}
                        onInput=${(e) => setLiveLayerName(e.target.value)}
                        onBlur=${(e) => renameBaseLayer(e.target.value)}
                      />
                    </div>
                    <${LayerPlacementFields}
                      layer=${liveBaseLayer || config.baseLayer}
                      tile=${findTile(
                        config.tileLibrary,
                        (liveBaseLayer || config.baseLayer).tileId,
                      )}
                      onChange=${(layer) => setLiveBaseLayer(layer)}
                      onCommit=${(layer) => {
                        setLiveBaseLayer(null);
                        commit({ ...config, baseLayer: layer });
                      }}
                    />
                  </div>
                `
              : null}

            ${!is3d && selectedArea
              ? h`
                  <div class="panel-subsection">
                    <h3>Area layer</h3>
                    <div class="field">
                      <label>Layer name</label>
                      <input
                        type="text"
                        value=${liveLayerName}
                        placeholder=${getAreaLayerName(
                          selectedArea,
                          config.areas.findIndex((a) => a.id === selectedArea.id),
                        )}
                        onInput=${(e) => setLiveLayerName(e.target.value)}
                        onBlur=${(e) => renameAreaLayer(selectedArea.id, e.target.value)}
                      />
                    </div>
                    <${AreaGeometryFields}
                      bounds=${liveBounds || boundsFromPoints(selectedArea.points)}
                      onChange=${(bounds) => applySelectedAreaBounds(bounds, false)}
                      onCommit=${(bounds) => applySelectedAreaBounds(bounds, true)}
                    />
                    <${LayerPlacementFields}
                      layer=${liveAreaLayer || selectedArea.layer}
                      tile=${findTile(
                        config.tileLibrary,
                        (liveAreaLayer || selectedArea.layer).tileId,
                      )}
                      onChange=${(layer) => setLiveAreaLayer(layer)}
                      onCommit=${(layer) => {
                        setLiveAreaLayer(null);
                        commit({
                          ...config,
                          areas: config.areas.map((a) =>
                            a.id === selectedArea.id ? { ...a, layer } : a,
                          ),
                        });
                      }}
                    />
                    <div class="row layer-actions">
                      <button type="button" class="btn" onClick=${cloneSelected}>Clone layer</button>
                      <button type="button" class="btn danger" onClick=${deleteSelected}>Delete area</button>
                    </div>
                  </div>
                `
              : null}
          <//>

          <${TileLibraryPanel}
            library=${config.tileLibrary}
            config=${config}
            preview=${preview}
            selectedTileId=${editingTileId}
            liveTileDraft=${liveTileDraft}
            disabled=${is3d}
            layerSelected=${baseSelected || !!selectedArea}
            onSelectTile=${assignTileToCurrentLayer}
            onAddTile=${() => {
              const tile = defaultTileDefinition(`Tile ${config.tileLibrary.length + 1}`);
              setEditingTileId(tile.id);
              setLiveTileDraft(tile);
            }}
            onDeleteTile=${deleteTileFromLibrary}
            onDraftChange=${setLiveTileDraft}
            onCommitTile=${(tile) => {
              if (!config.tileLibrary.some((t) => t.id === tile.id)) {
                commit(
                  configWithTileAssigned(
                    { ...config, tileLibrary: [...config.tileLibrary, tile] },
                    tile.id,
                  ),
                );
                setLiveTileDraft(null);
                setEditingTileId(tile.id);
                return;
              }
              commitTileLibraryEdit(tile);
            }}
          />
        </aside>

        <div class=${`canvas-wrap ${is3d ? 'view-3d' : ''}`}>
          ${is3d
            ? h`<div class="view-badge">3D preview · read-only · drag to orbit · scroll to zoom</div>`
            : null}

          <div
            ref=${stageRef}
            class=${`canvas-stage ${orbiting ? 'orbiting' : ''}`}
            style=${is3d ? cameraTransformStyle(camera) : undefined}
            onPointerDown=${onPointerDown}
            onPointerMove=${onPointerMove}
            onPointerUp=${onPointerUp}
            onPointerCancel=${onPointerUp}
            onWheel=${onWheel}
            onContextMenu=${(e) => {
              if (is3d) e.preventDefault();
            }}
          >
            <svg
              ref=${svgRef}
              viewBox=${floorPlan.viewBox.toString()}
              onDoubleClick=${onDoubleClick}
            >
              <path class="floor-outline" d=${pointsToPath(floorPlan.points)} />

              <defs>
                <clipPath id="floor-clip">
                  <path d=${pointsToPath(floorPlan.points)} />
                </clipPath>
              </defs>

              <${TilePreviewLayer} preview=${preview} />

              ${!is3d
                ? [SNAP_SOURCE.UNDERLYING, SNAP_SOURCE.INNER, SNAP_SOURCE.GEOMETRY].flatMap(
                    (type) => {
                      const g = snapGuides[type] || { xs: [], ys: [] };
                      return [
                        ...g.xs.map(
                          (x) => h`
                            <line
                              key=${`sx-${type}-${x}`}
                              class=${`snap-guide ${type}`}
                              x1=${x}
                              y1=${floorPlan.viewBox.y}
                              x2=${x}
                              y2=${floorPlan.viewBox.y + floorPlan.viewBox.height}
                            />
                          `,
                        ),
                        ...g.ys.map(
                          (y) => h`
                            <line
                              key=${`sy-${type}-${y}`}
                              class=${`snap-guide ${type}`}
                              x1=${floorPlan.viewBox.x}
                              y1=${y}
                              x2=${floorPlan.viewBox.x + floorPlan.viewBox.width}
                              y2=${y}
                            />
                          `,
                        ),
                      ];
                    },
                  )
                : null}

              ${!is3d
                ? displayConfig.areas.map((area) => {
                    const selected = selectedAreaId === area.id;
                    const interior = selected ? clipPointsToFloor(area.points, floorPlan) : null;
                    return h`
                      <g key=${`area-${area.id}`}>
                        ${interior
                          ? h`
                              <path
                                class="area-interior-fill selected"
                                d=${pointsToPath(interior)}
                              />
                            `
                          : null}
                        <path
                          class="area-hit"
                          d=${pointsToPath(area.points)}
                          style=${{ pointerEvents: tool === 'select' ? 'fill' : 'none' }}
                          onPointerDown=${(e) => {
                            if (tool !== 'select') return;
                            e.stopPropagation();
                            const svg = svgRef.current;
                            const pt = svg ? svgPoint(svg, e.clientX, e.clientY) : null;
                            if (!pt) return;
                            startMove(area, pt, e.pointerId, e.currentTarget);
                          }}
                        />
                        ${selected
                          ? h`
                              <path
                                class=${[
                                  'area-outline',
                                  'selected',
                                  tool === 'select' ? 'draggable' : '',
                                  liveAreas?.[area.id] ? 'editing' : '',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                                d=${pointsToPath(area.points)}
                                style=${{ pointerEvents: 'none' }}
                              />
                            `
                          : null}
                      </g>
                    `;
                  })
                : selectedAreaId
                  ? displayConfig.areas
                      .filter((area) => area.id === selectedAreaId)
                      .map(
                        (area) => h`
                          <path
                            key=${`outline-ro-${area.id}`}
                            class="area-outline selected"
                            d=${pointsToPath(area.points)}
                            style=${{ pointerEvents: 'none' }}
                          />
                        `,
                      )
                  : null}

              ${!is3d &&
              tool === 'select' &&
              selectedDisplay?.kind === 'rect' &&
              selectedAabb
                ? RESIZE_HANDLES.map((handle) => {
                    const [hx, hy] = handlePosition(selectedAabb, handle.id);
                    return h`
                      <rect
                        key=${`h-${handle.id}`}
                        class="resize-handle"
                        x=${hx - handleHalf}
                        y=${hy - handleHalf}
                        width=${HANDLE_SIZE_CM}
                        height=${HANDLE_SIZE_CM}
                        style=${{ cursor: handle.cursor }}
                        onPointerDown=${(e) => {
                          e.stopPropagation();
                          const svg = svgRef.current;
                          const pt = svg ? svgPoint(svg, e.clientX, e.clientY) : null;
                          if (!pt) return;
                          startResize(
                            selectedDisplay,
                            handle.id,
                            pt,
                            e.pointerId,
                            e.currentTarget,
                          );
                        }}
                      />
                    `;
                  })
                : null}

              ${!is3d && draftPath ? h`<path class="draft-shape" d=${draftPath} />` : null}
            </svg>
          </div>

          ${is3d
            ? h`
                <div class="view3d-controls" onPointerDown=${(e) => e.stopPropagation()}>
                  <div class="label">Orbit</div>
                  <div class="row">
                    <button
                      type="button"
                      class="btn"
                      title="Pitch up"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, pitchDeg: c.pitchDeg - PITCH_STEP }))}
                    >↑</button>
                  </div>
                  <div class="row">
                    <button
                      type="button"
                      class="btn"
                      title="Yaw left"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, yawDeg: c.yawDeg - YAW_STEP }))}
                    >←</button>
                    <button
                      type="button"
                      class="btn"
                      title="Pitch down"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, pitchDeg: c.pitchDeg + PITCH_STEP }))}
                    >↓</button>
                    <button
                      type="button"
                      class="btn"
                      title="Yaw right"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, yawDeg: c.yawDeg + YAW_STEP }))}
                    >→</button>
                  </div>
                  <div class="label">Zoom</div>
                  <div class="row">
                    <button
                      type="button"
                      class="btn"
                      title="Zoom out"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, zoom: c.zoom - ZOOM_STEP }))}
                    >−</button>
                    <button
                      type="button"
                      class="btn"
                      title="Zoom in"
                      onClick=${() =>
                        updateCamera((c) => ({ ...c, zoom: c.zoom + ZOOM_STEP }))}
                    >+</button>
                  </div>
                  <button type="button" class="btn" onClick=${resetCamera}>Reset view</button>
                </div>
              `
            : null}

          <div class="meta-overlay">
            Floor ${floorPlan.areaM2.toFixed(2)} m²
            ${floorLabel ? ` · ${floorLabel}` : ''}
            · units cm
          </div>
        </div>
      </div>
    </div>
  `;
}
