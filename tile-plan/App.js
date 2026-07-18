import htm from 'htm';
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FLOOR_AREA_M2,
  FLOOR_POINTS_CM,
  FLOOR_VIEWBOX,
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
  fileToTileImageDataUrl,
  loadCamera,
  loadConfig,
  normalizeCamera,
  parseImportedFile,
  saveCamera,
  saveConfig,
} from './storage.js';
import { clipPointsToFloor, computeTilingPreview, defaultTiling } from './tiling.js';

const h = htm.bind(createElement);

const ORIENTATION_PRESETS = [0, 45, 90];
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

function TilingFields({ tiling, onChange, onCommit }) {
  const imageInputRef = useRef(null);

  const set = (key, value, commit = false) => {
    const next = { ...tiling, [key]: value };
    onChange(next);
    if (commit) onCommit(next);
  };

  async function onImagePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imageDataUrl = await fileToTileImageDataUrl(file);
      const next = { ...tiling, imageDataUrl };
      onChange(next);
      onCommit(next);
    } catch (err) {
      alert(err.message || 'Could not use that image');
    }
  }

  function removeImage() {
    const next = { ...tiling, imageDataUrl: null };
    onChange(next);
    onCommit(next);
  }

  return h`
    <div class="panel">
      <div class="field">
        <label>Color</label>
        <input
          type="color"
          value=${tiling.color}
          onInput=${(e) => set('color', e.target.value)}
          onChange=${(e) => set('color', e.target.value, true)}
        />
      </div>
      <div class="field">
        <label>Tile photo (optional)</label>
        <div class="row image-row">
          ${tiling.imageDataUrl
            ? h`<img class="tile-thumb" src=${tiling.imageDataUrl} alt="Tile preview" />`
            : h`<span class="hint">Uses color when no photo</span>`}
          <button
            type="button"
            class="btn"
            onClick=${() => imageInputRef.current?.click()}
          >${tiling.imageDataUrl ? 'Replace' : 'Add photo'}</button>
          ${tiling.imageDataUrl
            ? h`
                <button type="button" class="btn danger" onClick=${removeImage}>
                  Remove
                </button>
              `
            : null}
          <input
            ref=${imageInputRef}
            type="file"
            accept="image/*"
            hidden
            onChange=${onImagePicked}
          />
        </div>
      </div>
      <div class="field">
        <label>Width (cm)</label>
        <input
          type="number"
          min="0.1"
          step="0.1"
          value=${tiling.widthCm}
          onInput=${(e) => set('widthCm', Number(e.target.value))}
          onBlur=${(e) => set('widthCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Length (cm)</label>
        <input
          type="number"
          min="0.1"
          step="0.1"
          value=${tiling.lengthCm}
          onInput=${(e) => set('lengthCm', Number(e.target.value))}
          onBlur=${(e) => set('lengthCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Spacing (cm)</label>
        <input
          type="number"
          min="0"
          step="0.1"
          value=${tiling.spacingCm}
          onInput=${(e) => set('spacingCm', Number(e.target.value))}
          onBlur=${(e) => set('spacingCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Offset X (cm)</label>
        <input
          type="number"
          step="0.1"
          value=${tiling.offsetXCm}
          onInput=${(e) => set('offsetXCm', Number(e.target.value))}
          onBlur=${(e) => set('offsetXCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Offset Y (cm)</label>
        <input
          type="number"
          step="0.1"
          value=${tiling.offsetYCm}
          onInput=${(e) => set('offsetYCm', Number(e.target.value))}
          onBlur=${(e) => set('offsetYCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Orientation (°)</label>
        <div class="row">
          ${ORIENTATION_PRESETS.map(
            (deg) => h`
              <button
                key=${deg}
                type="button"
                class=${`btn ${Number(tiling.orientationDeg) === deg ? 'active' : ''}`}
                onClick=${() => set('orientationDeg', deg, true)}
              >
                ${deg}°
              </button>
            `,
          )}
        </div>
        <input
          type="number"
          step="1"
          value=${tiling.orientationDeg}
          onInput=${(e) => set('orientationDeg', Number(e.target.value))}
          onBlur=${(e) => set('orientationDeg', Number(e.target.value), true)}
        />
      </div>
    </div>
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

export function App() {
  const [history, setHistory] = useState(() => createHistory(loadConfig()));
  const config = history.present;
  const [tool, setTool] = useState('select');
  /** null | 'base' | area uuid */
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [liveBase, setLiveBase] = useState(null);
  const [liveAreaTiling, setLiveAreaTiling] = useState(null);
  const [liveAreas, setLiveAreas] = useState(null);
  const [snapGuides, setSnapGuides] = useState(() => emptySnapGuides());
  const [viewMode, setViewMode] = useState('edit'); // 'edit' | '3d'
  const [camera, setCamera] = useState(() => loadCamera());
  const [orbiting, setOrbiting] = useState(false);
  const fileRef = useRef(null);
  const svgRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const orbitRef = useRef(null);
  const is3d = viewMode === '3d';

  const selectedAreaId = selectedId && selectedId !== BASE_SELECTION ? selectedId : null;
  const baseSelected = selectedId === BASE_SELECTION;

  const displayConfig = useMemo(() => {
    const next = {
      ...config,
      baseTiling: liveBase || config.baseTiling,
      areas: mergeLiveAreas(config.areas, liveAreas),
    };
    if (liveAreaTiling && selectedAreaId) {
      next.areas = next.areas.map((a) =>
        a.id === selectedAreaId ? { ...a, tiling: liveAreaTiling } : a,
      );
    }
    return next;
  }, [config, liveBase, liveAreaTiling, selectedAreaId, liveAreas]);

  const preview = useMemo(
    () => computeTilingPreview(displayConfig.baseTiling, displayConfig.areas),
    [displayConfig],
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
    setLiveBase(null);
  }, [config.baseTiling]);

  useEffect(() => {
    setLiveAreaTiling(null);
  }, [config.areas, selectedAreaId]);

  useEffect(() => {
    if (!is3d) return;
    setDraft(null);
    setLiveAreas(null);
    setSnapGuides(emptySnapGuides());
    dragRef.current = null;
    setTool('select');
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
    const clipped = clipPointsToFloor(points);
    setDraft(null);
    if (!clipped || clipped.length < 3) return;
    const area = {
      id: crypto.randomUUID(),
      kind: 'polygon',
      points: clipped,
      tiling: { ...defaultTiling(), color: '#6b8cae' },
    };
    commit({ ...config, areas: [...config.areas, area] });
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
    const clipped = clipPointsToFloor(points);
    setDraft(null);
    dragRef.current = null;
    if (!clipped || clipped.length < 3) return;
    const w = Math.abs(a[0] - b[0]);
    const ht = Math.abs(a[1] - b[1]);
    if (w < 1 || ht < 1) return;
    // Keep axis-aligned corners for clean resize; tiling already clips to floor.
    const area = {
      id: crypto.randomUUID(),
      kind: 'rect',
      points,
      tiling: { ...defaultTiling(), color: '#6b8cae' },
    };
    commit({ ...config, areas: [...config.areas, area] });
    setSelectedId(area.id);
    setTool('select');
  }

  function deleteSelected() {
    if (!selectedAreaId) return;
    commit({ ...config, areas: config.areas.filter((a) => a.id !== selectedAreaId) });
    clearSelection();
  }

  function commitAreaPoints(areaId, points) {
    if (!areasIntersectFloor(points) && !clipPointsToFloor(points)) {
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

    const baseTiling = liveBase || config.baseTiling;
    const activeArea = config.areas.find((a) => a.id === drag.areaId);
    const activeTiling = liveAreaTiling && selectedAreaId === drag.areaId
      ? liveAreaTiling
      : activeArea?.tiling;
    const { groups } = collectSnapTargets(
      config.areas,
      drag.areaId,
      baseTiling,
      activeTiling,
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
                : h`Select a layer to edit its tiling. Later areas in the list sit on top (hidden tiles
              underneath are not counted). Drag/resize snaps to the underlying layer grid
              <span class="snap-swatch underlying"></span>, this layer’s own tile grid
              <span class="snap-swatch inner"></span>, and nearby edges.`}
            </p>
            <ul class="area-list">
              <li>
                <button
                  type="button"
                  class=${`btn select ${baseSelected ? 'active' : ''}`}
                  onClick=${selectBase}
                >
                  Base · ${preview.baseCount} tiles
                </button>
              </li>
              ${config.areas.map(
                (area, i) => h`
                  <li key=${area.id}>
                    <button
                      type="button"
                      class=${`btn select ${selectedAreaId === area.id ? 'active' : ''}`}
                      onClick=${() => selectArea(area.id)}
                    >
                      ${area.kind} ${i + 1}
                      ${preview.areas.find((a) => a.id === area.id)
                        ? ` · ${preview.areas.find((a) => a.id === area.id).count} tiles`
                        : ''}
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
                `,
              )}
            </ul>

            ${!is3d && baseSelected
              ? h`
                  <h2>Base tiling</h2>
                  <${TilingFields}
                    tiling=${liveBase || config.baseTiling}
                    onChange=${(t) => setLiveBase(t)}
                    onCommit=${(t) => {
                      setLiveBase(null);
                      commit({ ...config, baseTiling: t });
                    }}
                  />
                `
              : null}

            ${!is3d && selectedArea
              ? h`
                  <h2>Area tiling</h2>
                  <${TilingFields}
                    tiling=${liveAreaTiling || selectedArea.tiling}
                    onChange=${(t) => setLiveAreaTiling(t)}
                    onCommit=${(t) => {
                      setLiveAreaTiling(null);
                      commit({
                        ...config,
                        areas: config.areas.map((a) =>
                          a.id === selectedArea.id ? { ...a, tiling: t } : a,
                        ),
                      });
                    }}
                  />
                  <button type="button" class="btn danger" onClick=${deleteSelected}>Delete area</button>
                `
              : null}
          </section>
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
              viewBox=${FLOOR_VIEWBOX.toString()}
              onDoubleClick=${onDoubleClick}
            >
              <path class="floor-outline" d=${pointsToPath(FLOOR_POINTS_CM)} />

              <defs>
                <clipPath id="floor-clip">
                  <path d=${pointsToPath(FLOOR_POINTS_CM)} />
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
                              y1=${FLOOR_VIEWBOX.y}
                              x2=${x}
                              y2=${FLOOR_VIEWBOX.y + FLOOR_VIEWBOX.height}
                            />
                          `,
                        ),
                        ...g.ys.map(
                          (y) => h`
                            <line
                              key=${`sy-${type}-${y}`}
                              class=${`snap-guide ${type}`}
                              x1=${FLOOR_VIEWBOX.x}
                              y1=${y}
                              x2=${FLOOR_VIEWBOX.x + FLOOR_VIEWBOX.width}
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
                    const interior = selected ? clipPointsToFloor(area.points) : null;
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
            Floor ${FLOOR_AREA_M2.toFixed(2)} m² · units cm
          </div>
        </div>
      </div>
    </div>
  `;
}
