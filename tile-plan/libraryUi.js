import htm from 'htm';
import { createElement, useRef, useState } from 'react';
import { fileToTileImageDataUrl } from './storage.js';
import {
  countTileUsage,
  countTilesInLayout,
  formatTileSize,
} from './tileLibrary.js';

const h = htm.bind(createElement);

const ORIENTATION_PRESETS = [0, 45, 90];

export function CollapsiblePanel({
  title,
  variant = 'default',
  actions = null,
  defaultOpen = true,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);

  return h`
    <section
      class=${`collapsible-panel panel-variant-${variant} ${open ? 'is-open' : 'is-collapsed'}`}
    >
      <header class="collapsible-panel-header">
        <button
          type="button"
          class="collapsible-panel-toggle"
          aria-expanded=${open}
          onClick=${() => setOpen((v) => !v)}
        >
          <span class="collapsible-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
          <h2>${title}</h2>
        </button>
        ${actions ? h`<div class="collapsible-panel-actions">${actions}</div>` : null}
      </header>
      ${open ? h`<div class="collapsible-panel-body">${children}</div>` : null}
    </section>
  `;
}

export function TileSwatch({ tile, large = false }) {
  const aspect = Math.max(0.2, (tile.lengthCm || 1) / (tile.widthCm || 1));
  const style = {
    aspectRatio: `${1 / aspect}`,
  };
  if (tile.imageDataUrl) {
    return h`
      <div
        class=${`tile-swatch ${large ? 'large' : ''}`}
        style=${{ ...style, backgroundColor: tile.color }}
      >
        <img src=${tile.imageDataUrl} alt="" />
      </div>
    `;
  }
  return h`
    <div
      class=${`tile-swatch color-only ${large ? 'large' : ''}`}
      style=${{ ...style, backgroundColor: tile.color }}
    ></div>
  `;
}

export function TileDefinitionFields({ tile, onChange, onCommit, imageInputRef: externalRef }) {
  const internalRef = useRef(null);
  const imageInputRef = externalRef || internalRef;

  const set = (key, value, commit = false) => {
    const next = { ...tile, [key]: value };
    onChange(next);
    if (commit) onCommit(next);
  };

  async function onImagePicked(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const imageDataUrl = await fileToTileImageDataUrl(file);
      const next = { ...tile, imageDataUrl };
      onChange(next);
      onCommit(next);
    } catch (err) {
      alert(err.message || 'Could not use that image');
    }
  }

  function removeImage() {
    const next = { ...tile, imageDataUrl: null };
    onChange(next);
    onCommit(next);
  }

  return h`
    <div class="tile-definition-fields">
      <div class="field">
        <label>Name</label>
        <input
          type="text"
          value=${tile.name}
          onInput=${(e) => set('name', e.target.value)}
          onBlur=${(e) => set('name', e.target.value.trim() || tile.name, true)}
        />
      </div>
      <div class="field">
        <label>Color</label>
        <input
          type="color"
          value=${tile.color}
          onInput=${(e) => set('color', e.target.value)}
          onChange=${(e) => set('color', e.target.value, true)}
        />
      </div>
      <div class="field">
        <label>Tile photo (optional)</label>
        <div class="row image-row">
          <button type="button" class="btn" onClick=${() => imageInputRef.current?.click()}>
            ${tile.imageDataUrl ? 'Replace photo' : 'Add photo'}
          </button>
          ${tile.imageDataUrl
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
          value=${tile.widthCm}
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
          value=${tile.lengthCm}
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
          value=${tile.spacingCm}
          onInput=${(e) => set('spacingCm', Number(e.target.value))}
          onBlur=${(e) => set('spacingCm', Number(e.target.value), true)}
        />
      </div>
    </div>
  `;
}

export function LayerPlacementFields({ layer, tile, onChange, onCommit }) {
  const set = (key, value, commit = false) => {
    const next = { ...layer, [key]: value };
    onChange(next);
    if (commit) onCommit(next);
  };

  return h`
    <div class="layer-placement-fields">
      ${tile
        ? h`
            <div class="layer-tile-ref">
              <${TileSwatch} tile=${tile} />
              <div>
                <strong>${tile.name}</strong>
                <div class="hint">${formatTileSize(tile)} · gap ${tile.spacingCm} cm</div>
              </div>
            </div>
          `
        : null}
      <div class="field-row">
        <div class="field">
          <label>Offset X</label>
          <input
            type="number"
            step="0.1"
            value=${layer.offsetXCm}
            onInput=${(e) => set('offsetXCm', Number(e.target.value))}
            onBlur=${(e) => set('offsetXCm', Number(e.target.value), true)}
          />
        </div>
        <div class="field">
          <label>Offset Y</label>
          <input
            type="number"
            step="0.1"
            value=${layer.offsetYCm}
            onInput=${(e) => set('offsetYCm', Number(e.target.value))}
            onBlur=${(e) => set('offsetYCm', Number(e.target.value), true)}
          />
        </div>
      </div>
      <div class="field field-orientation">
        <label>Orientation (°)</label>
        <div class="row orientation-row">
          ${ORIENTATION_PRESETS.map(
            (deg) => h`
              <button
                key=${deg}
                type="button"
                class=${`btn ${Number(layer.orientationDeg) === deg ? 'active' : ''}`}
                onClick=${() => set('orientationDeg', deg, true)}
              >
                ${deg}°
              </button>
            `,
          )}
          <input
            type="number"
            step="1"
            value=${layer.orientationDeg}
            onInput=${(e) => set('orientationDeg', Number(e.target.value))}
            onBlur=${(e) => set('orientationDeg', Number(e.target.value), true)}
          />
        </div>
      </div>
    </div>
  `;
}

/** Bounds of an area layer (AABB position + size), for fine-tuning. */
export function AreaGeometryFields({ bounds, onChange, onCommit }) {
  const set = (key, raw, commit = false) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const next = { ...bounds, [key]: value };
    if (key === 'width') next.width = Math.max(0.1, value);
    if (key === 'height') next.height = Math.max(0.1, value);
    onChange(next);
    if (commit) onCommit(next);
  };

  return h`
    <div class="area-geometry-fields">
      <div class="field-row">
        <div class="field">
          <label>Pos X</label>
          <input
            type="number"
            step="0.1"
            value=${bounds.x}
            onInput=${(e) => set('x', e.target.value)}
            onBlur=${(e) => set('x', e.target.value, true)}
          />
        </div>
        <div class="field">
          <label>Pos Y</label>
          <input
            type="number"
            step="0.1"
            value=${bounds.y}
            onInput=${(e) => set('y', e.target.value)}
            onBlur=${(e) => set('y', e.target.value, true)}
          />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Width</label>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value=${bounds.width}
            onInput=${(e) => set('width', e.target.value)}
            onBlur=${(e) => set('width', e.target.value, true)}
          />
        </div>
        <div class="field">
          <label>Height</label>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value=${bounds.height}
            onInput=${(e) => set('height', e.target.value)}
            onBlur=${(e) => set('height', e.target.value, true)}
          />
        </div>
      </div>
    </div>
  `;
}

export function TileLibraryPanel({
  library,
  config,
  preview,
  selectedTileId,
  liveTileDraft,
  disabled,
  layerSelected,
  onSelectTile,
  onAddTile,
  onDeleteTile,
  onDraftChange,
  onCommitTile,
}) {
  const editingTile =
    liveTileDraft || library.find((t) => t.id === selectedTileId) || null;

  return h`
    <${CollapsiblePanel}
      title="Tile library"
      variant="library"
      actions=${h`
        <button type="button" class="btn" disabled=${disabled} onClick=${onAddTile}>+ Add</button>
      `}
    >
      <p class="hint">
        ${layerSelected
          ? 'Select a tile to assign it to the current layer.'
          : 'Select a layer first, then pick a tile here.'}
      </p>
      <ul class="tile-library-list">
        ${library.map((tile) => {
          const layerRefs = countTileUsage(config, tile.id);
          const tileCount = countTilesInLayout(config, preview, tile.id);
          return h`
            <li key=${tile.id}>
              <button
                type="button"
                class=${`tile-library-item ${selectedTileId === tile.id ? 'active' : ''}`}
                disabled=${disabled}
                onClick=${() => onSelectTile(tile.id)}
              >
                <${TileSwatch} tile=${tile} />
                <span class="tile-library-item-text">
                  <strong>${tile.name}</strong>
                  <span class="hint">
                    ${formatTileSize(tile)}
                    ${tileCount ? ` · ${tileCount} tile${tileCount === 1 ? '' : 's'} in layout` : ''}
                  </span>
                </span>
              </button>
              <button
                type="button"
                class="btn danger btn-icon"
                title=${layerRefs ? 'In use — cannot delete' : 'Delete tile type'}
                disabled=${disabled || layerRefs > 0}
                onClick=${(e) => {
                  e.stopPropagation();
                  onDeleteTile(tile.id);
                }}
              >×</button>
            </li>
          `;
        })}
      </ul>

      ${editingTile && !disabled
        ? h`
            <div class="panel-subsection">
              <h3>Edit tile</h3>
              <${TileDefinitionFields}
                tile=${editingTile}
                onChange=${onDraftChange}
                onCommit=${onCommitTile}
              />
            </div>
          `
        : null}
    <//>
  `;
}
