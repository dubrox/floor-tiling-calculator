import htm from 'htm';
import { createElement, useRef } from 'react';
import { fileToTileImageDataUrl } from './storage.js';
import { countTileUsage, formatTileSize } from './tileLibrary.js';

const h = htm.bind(createElement);

const ORIENTATION_PRESETS = [0, 45, 90];

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
      <div class="field">
        <label>Offset X (cm)</label>
        <input
          type="number"
          step="0.1"
          value=${layer.offsetXCm}
          onInput=${(e) => set('offsetXCm', Number(e.target.value))}
          onBlur=${(e) => set('offsetXCm', Number(e.target.value), true)}
        />
      </div>
      <div class="field">
        <label>Offset Y (cm)</label>
        <input
          type="number"
          step="0.1"
          value=${layer.offsetYCm}
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
                class=${`btn ${Number(layer.orientationDeg) === deg ? 'active' : ''}`}
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
          value=${layer.orientationDeg}
          onInput=${(e) => set('orientationDeg', Number(e.target.value))}
          onBlur=${(e) => set('orientationDeg', Number(e.target.value), true)}
        />
      </div>
    </div>
  `;
}

function TilePickerCard({ tile, onPick }) {
  return h`
    <button type="button" class="tile-picker-card" onClick=${() => onPick(tile.id)}>
      <${TileSwatch} tile=${tile} large=${true} />
      <span class="tile-picker-name">${tile.name}</span>
      <span class="tile-picker-meta">${formatTileSize(tile)}</span>
      <span class="tile-picker-meta">Gap ${tile.spacingCm} cm</span>
    </button>
  `;
}

export function TilePickerPanel({
  title,
  library,
  mode,
  draftTile,
  onPick,
  onCancel,
  onStartCreate,
  onDraftChange,
  onSaveDraft,
}) {
  return h`
    <div class="tile-picker-panel">
      <div class="panel-heading-row">
        <h3>${mode === 'create' ? 'New tile type' : title}</h3>
        <button type="button" class="btn btn-icon" title="Close" onClick=${onCancel}>×</button>
      </div>

      ${mode === 'create'
        ? h`
            <p class="hint">Define tile appearance and dimensions. Offset and rotation are set per layer.</p>
            <${TileDefinitionFields}
              tile=${draftTile}
              onChange=${onDraftChange}
              onCommit=${onDraftChange}
            />
            <div class="tile-picker-actions">
              <button type="button" class="btn" onClick=${onCancel}>Cancel</button>
              <button type="button" class="btn active" onClick=${onSaveDraft}>Save & use</button>
            </div>
          `
        : h`
            <p class="hint">Choose a tile from the library. Each layer keeps its own offset and orientation.</p>
            <div class="tile-picker-grid">
              ${library.map(
                (tile) => h`
                  <${TilePickerCard} key=${tile.id} tile=${tile} onPick=${onPick} />
                `,
              )}
            </div>
            <div class="tile-picker-actions">
              <button type="button" class="btn" onClick=${onStartCreate}>Add new tile type</button>
            </div>
          `}
    </div>
  `;
}

export function TileLibraryPanel({
  library,
  config,
  editingTileId,
  liveTileDraft,
  disabled,
  onSelectEdit,
  onAddTile,
  onDeleteTile,
  onDraftChange,
  onCommitTile,
}) {
  const editingTile =
    liveTileDraft || library.find((t) => t.id === editingTileId) || null;

  return h`
    <section class="panel tile-library-panel">
      <div class="panel-heading-row">
        <h2>Tile library</h2>
        <button type="button" class="btn" disabled=${disabled} onClick=${onAddTile}>+ Add</button>
      </div>
      <p class="hint">Shared tile definitions. Layers only store offset and orientation.</p>
      <ul class="tile-library-list">
        ${library.map((tile) => {
          const usage = countTileUsage(config, tile.id);
          return h`
            <li key=${tile.id}>
              <button
                type="button"
                class=${`tile-library-item ${editingTileId === tile.id ? 'active' : ''}`}
                disabled=${disabled}
                onClick=${() => onSelectEdit(tile.id)}
              >
                <${TileSwatch} tile=${tile} />
                <span class="tile-library-item-text">
                  <strong>${tile.name}</strong>
                  <span class="hint">${formatTileSize(tile)} · used ${usage}×</span>
                </span>
              </button>
              <button
                type="button"
                class="btn danger btn-icon"
                title=${usage ? 'In use — cannot delete' : 'Delete tile type'}
                disabled=${disabled || usage > 0}
                onClick=${() => onDeleteTile(tile.id)}
              >×</button>
            </li>
          `;
        })}
      </ul>

      ${editingTile && !disabled
        ? h`
            <h2>Edit tile</h2>
            <${TileDefinitionFields}
              tile=${editingTile}
              onChange=${onDraftChange}
              onCommit=${onCommitTile}
            />
          `
        : null}
    </section>
  `;
}
