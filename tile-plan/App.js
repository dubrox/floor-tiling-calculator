import htm from 'htm';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  createDefaultCamera,
  downloadConfig,
  loadCamera,
  loadConfig,
  normalizeCamera,
  parseImportedFile,
  saveCamera,
  saveConfig,
} from './storage.js';
import {
  LayerPlacementFields,
  TileLibraryPanel,
  TilePickerModal,
  TileSwatch,
} from './libraryUi.js';
import {
  defaultLayerPlacement,
  defaultTileDefinition,
  findTile,
  resolveConfigLayers,
} from './tileLibrary.js';
import { clipPointsToFloor, computeTilingPreview } from './tiling.js';

const h = htm.bind(createElement);

const BASE_SELECTION = 'base';
const PITCH_STEP = 5;
const YAW_STEP = 10;
const ZOOM_STEP = 0.12;

function cameraTransformStyle(camera) {
  const yaw = camera.yawDeg;
  const pitch = camera.pitchDeg;
  const zoom = camera.zoom;
  return {
    transform: `rotateX(${pitch}deg) rotateZ(${yaw}deg) scale(${zoom})`,
  };
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/** Map image onto the full tile quad; clip to the visible piece. */
function TilePiece({ piece, id }) {
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
}

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
  const [history, setHistory] = useState(() => createHistory(loadConfig()));
  const config = history.present;
  const [tool, setTool] = useState('select');
  /** null | 'base' | area uuid */
  const [selectedId, setSelectedId] = useState(null);
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
  const [tilePicker, setTilePicker] = useState(null);
  const [pickerDraftTile, setPickerDraftTile] = useState(null);
  const fileRef = useRef(null);
  const floorFileRef = useRef(null);
  const svgRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const layerDragRef = useRef(null);
  const orbitRef = useRef(null);
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

  const preview = useMemo(
    () => computeTilingPreview(displayConfig.baseTiling, displayConfig.areas, floorPlan),
    [displayConfig, floorPlan],
  );

  const selectedDisplay = useMemo(
    () => displayConfig.areas.find((a) => a.id === selectedAreaId) || null,
    [displayConfig.areas, selectedAreaId],
  );

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  useEffect(() => {
    saveCamera(camera);
  }, [camera]);

  useEffect(() => {
    setLiveBaseLayer(null);
  }, [config.baseLayer]);

  useEffect(() => {
    setLiveAreaLayer(null);
  }, [config.areas, selectedAreaId]);

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

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !is3d) return undefined;
    const onWheelNative = (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setCamera((cam) => normalizeCamera({ ...cam, zoom: cam.zoom + delta }));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [is3d]);

  const updateCamera = useCallback((patch) => {
    setCamera((prev) =>
      normalizeCamera({
        ...prev,
        ...(typeof patch === 'function' ? patch(prev) : patch),
      }),
    );
  }, []);

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
        if (tilePicker) {
          if (tilePicker.mode === 'create') {
            setTilePicker((prev) => (prev ? { ...prev, mode: 'pick' } : null));
            setPickerDraftTile(null);
          } else {
            closeTilePicker();
          }
          return;
        }
        setDraft(null);
        setLiveAreas(null);
        setSnapGuides(emptySnapGuides());
        dragRef.current = null;
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
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const selectedArea = config.areas.find((a) => a.id === selectedAreaId) || null;

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
    setTilePicker({
      mode: 'pick',
      target: 'new-area',
      area: {
        id: crypto.randomUUID(),
        kind: 'polygon',
        points: clipped,
      },
    });
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
    setTilePicker({
      mode: 'pick',
      target: 'new-area',
      area: {
        id: crypto.randomUUID(),
        kind: 'rect',
        points,
      },
    });
  }

  function closeTilePicker() {
    setTilePicker(null);
    setPickerDraftTile(null);
  }

  function cancelTilePicker() {
    if (tilePicker?.mode === 'create') {
      setTilePicker((prev) => (prev ? { ...prev, mode: 'pick' } : null));
      setPickerDraftTile(null);
      return;
    }
    closeTilePicker();
  }

  function layerWithTileId(existingLayer, tileId) {
    return {
      tileId,
      offsetXCm: existingLayer?.offsetXCm ?? 0,
      offsetYCm: existingLayer?.offsetYCm ?? 0,
      orientationDeg: existingLayer?.orientationDeg ?? 0,
    };
  }

  function applyTileSelection(tileId, libraryOverride) {
    if (!tilePicker) return;
    const library = libraryOverride || config.tileLibrary;

    if (tilePicker.target === 'new-area') {
      const area = {
        ...tilePicker.area,
        layer: defaultLayerPlacement(tileId),
      };
      commit({ ...config, tileLibrary: library, areas: [...config.areas, area] });
      setSelectedId(area.id);
      setTool('select');
    } else if (tilePicker.target === 'base') {
      commit({
        ...config,
        tileLibrary: library,
        baseLayer: layerWithTileId(config.baseLayer, tileId),
      });
    } else if (tilePicker.target === 'change-area') {
      commit({
        ...config,
        tileLibrary: library,
        areas: config.areas.map((a) =>
          a.id === tilePicker.areaId ? { ...a, layer: layerWithTileId(a.layer, tileId) } : a,
        ),
      });
    }
    closeTilePicker();
  }

  function pickTileFromLibrary(tileId) {
    applyTileSelection(tileId);
  }

  function startPickerCreate() {
    setPickerDraftTile(defaultTileDefinition(`Tile ${config.tileLibrary.length + 1}`));
    setTilePicker((prev) => (prev ? { ...prev, mode: 'create' } : prev));
  }

  function savePickerDraftTile() {
    if (!pickerDraftTile || !tilePicker) return;
    const tile = { ...pickerDraftTile, id: pickerDraftTile.id || crypto.randomUUID() };
    applyTileSelection(tile.id, [...config.tileLibrary, tile]);
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

  function deleteSelected() {
    if (!selectedAreaId) return;
    commit({ ...config, areas: config.areas.filter((a) => a.id !== selectedAreaId) });
    clearSelection();
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
      updateCamera((cam) => ({
        yawDeg: cam.yawDeg + dx * 0.35,
        pitchDeg: cam.pitchDeg - dy * 0.25,
        zoom: cam.zoom,
      }));
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
    setCamera(createDefaultCamera());
  }

  async function onImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imported = await parseImportedFile(file);
      commit(imported);
      clearSelection();
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
      clearSelection();
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
          <button
            type="button"
            class=${`btn ${tool === 'select' ? 'active' : ''}`}
            disabled=${is3d}
            onClick=${() => {
              setTool('select');
              setDraft(null);
            }}
          >Select</button>
          <button
            type="button"
            class=${`btn ${tool === 'rect' ? 'active' : ''}`}
            disabled=${is3d}
            onClick=${() => {
              setTool('rect');
              setDraft(null);
            }}
          >Rect</button>
          <button
            type="button"
            class=${`btn ${tool === 'polygon' ? 'active' : ''}`}
            disabled=${is3d}
            onClick=${() => {
              setTool('polygon');
              setDraft(null);
            }}
          >Polygon</button>
        </div>
        <div class="toolbar-group">
          <button
            type="button"
            class="btn"
            disabled=${is3d}
            title="Load floor outline from Sweet Home 3D Home.xml"
            onClick=${() => floorFileRef.current?.click()}
          >Load floor XML</button>
          <input
            ref=${floorFileRef}
            type="file"
            accept=".xml,application/xml,text/xml"
            hidden
            onChange=${onImportFloorFile}
          />
          <button type="button" class="btn" onClick=${() => downloadConfig(config)}>Export JSON</button>
          <button type="button" class="btn" onClick=${() => fileRef.current?.click()}>Import JSON</button>
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
          <section class="panel">
            <h2>Layers</h2>
            <p class="hint">
              ${is3d
                ? '3D mode is read-only. Switch to Edit to change layers, draw areas, or resize.'
                : h`Draw an area to pick a tile from the library. Drag the
              <span class="layer-drag-handle inline">⋮⋮</span> grip to reorder stacking.
              Later areas sit on top. Each layer keeps its own offset and orientation.`}
            </p>
            <ul class="area-list">
              <li>
                <button
                  type="button"
                  class=${`btn select layer-select ${baseSelected ? 'active' : ''}`}
                  onClick=${selectBase}
                >
                  ${baseTile ? h`<${TileSwatch} tile=${baseTile} />` : null}
                  <span>Base · ${preview.baseCount} tiles</span>
                </button>
              </li>
              ${config.areas.map(
                (area, i) => {
                  const areaTile = findTile(config.tileLibrary, area.layer?.tileId);
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
                        ${area.kind} ${i + 1}
                        ${preview.areas.find((a) => a.id === area.id)
                          ? ` · ${preview.areas.find((a) => a.id === area.id).count} tiles`
                          : ''}
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
                        if (selectedAreaId === area.id) clearSelection();
                      }}
                    >×</button>
                  </li>
                `;
                },
              )}
            </ul>

            ${!is3d && baseSelected
              ? h`
                  <h2>Base layer</h2>
                  <button
                    type="button"
                    class="btn"
                    onClick=${() => setTilePicker({ mode: 'pick', target: 'base' })}
                  >
                    Change tile type
                  </button>
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
                `
              : null}

            ${!is3d && selectedArea
              ? h`
                  <h2>Area layer</h2>
                  <button
                    type="button"
                    class="btn"
                    onClick=${() =>
                      setTilePicker({
                        mode: 'pick',
                        target: 'change-area',
                        areaId: selectedArea.id,
                      })}
                  >
                    Change tile type
                  </button>
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
                  <button type="button" class="btn danger" onClick=${deleteSelected}>Delete area</button>
                `
              : null}
          </section>

          <${TileLibraryPanel}
            library=${config.tileLibrary}
            config=${config}
            editingTileId=${editingTileId}
            liveTileDraft=${liveTileDraft}
            disabled=${is3d}
            onSelectEdit=${(id) => {
              setEditingTileId(id);
              setLiveTileDraft(null);
            }}
            onAddTile=${() => {
              const tile = defaultTileDefinition(`Tile ${config.tileLibrary.length + 1}`);
              setEditingTileId(tile.id);
              setLiveTileDraft(tile);
            }}
            onDeleteTile=${deleteTileFromLibrary}
            onDraftChange=${setLiveTileDraft}
            onCommitTile=${(tile) => {
              if (!config.tileLibrary.some((t) => t.id === tile.id)) {
                commit({ ...config, tileLibrary: [...config.tileLibrary, tile] });
                setLiveTileDraft(null);
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

      <${TilePickerModal}
        open=${!!tilePicker}
        title=${tilePicker?.target === 'new-area'
          ? 'Choose tile for new layer'
          : tilePicker?.target === 'base'
            ? 'Choose tile for base layer'
            : 'Choose tile type'}
        library=${config.tileLibrary}
        mode=${tilePicker?.mode || 'pick'}
        draftTile=${pickerDraftTile}
        onPick=${pickTileFromLibrary}
        onCancel=${cancelTilePicker}
        onStartCreate=${startPickerCreate}
        onDraftChange=${setPickerDraftTile}
        onSaveDraft=${savePickerDraftTile}
      />
    </div>
  `;
}
