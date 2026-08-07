const mappingLabel = mapping => {
  const channel = mapping?.channel;
  return channel === null || channel === undefined
    ? `CC ${mapping?.cc}`
    : `ch ${channel} CC ${mapping?.cc}`;
};

const parameterLabel = mapping =>
  mapping?.label || mapping?.name || `Parameter ${mapping?.parameterID ?? ''}`;

export class StandaloneMidiMap extends HTMLElement {
  constructor() {
    super();

    this.mappingSource = null;
    this.mappingMode = false;
    this.target = null;
    this.selectedParameterID = null;
    this.records = new Map();

    this.handleMappingChange = this.handleMappingChange.bind(this);
    this.handleKeyDown = this.handleKeyDown.bind(this);

    this.root = this.attachShadow({mode: 'open'});
    this.root.innerHTML = `
      <style>
        :host {
          display: block;
          width: 100%;
          color: #f4f4f4;
          font: 12px -apple-system, BlinkMacSystemFont, sans-serif;
          pointer-events: auto;
        }
        :host([hidden]) { display: none; }
        .panel {
          min-width: 180px;
          max-width: 280px;
          padding: 8px;
          border: 1px solid #777;
          border-radius: 6px;
          background: #202020;
          box-shadow: 0 3px 14px rgba(0, 0, 0, .35);
        }
        .toolbar, .row { display: flex; align-items: center; gap: 6px; }
        .toolbar { justify-content: space-between; }
        button {
          color: inherit;
          border: 1px solid #777;
          border-radius: 4px;
          background: #2b2b2b;
          padding: 4px 7px;
          font: inherit;
          cursor: pointer;
        }
        button:hover, button:focus-visible { background: #3b3b3b; }
        button[data-active] { border-color: #78b9ff; background: #2a6f9f; }
        button:disabled { cursor: default; opacity: .45; }
        button:focus-visible { outline: 2px solid #78b9ff; outline-offset: 2px; }
        .status { margin-top: 6px; color: #c8c8c8; line-height: 1.3; }
        .rows { margin-top: 6px; }
        .row { justify-content: space-between; padding-top: 4px; }
        .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .empty { color: #979797; }
        .clear { padding: 2px 5px; }
      </style>
      <div class="panel" role="region" aria-label="MIDI mapping">
        <div class="toolbar">
          <button class="map" type="button" aria-pressed="false">Map MIDI</button>
          <button class="clear-all" type="button">Clear all</button>
        </div>
        <div class="status" role="status" aria-live="polite">Ready</div>
        <div class="rows"><span class="empty">No mappings</span></div>
      </div>`;

    this.mapButton = this.root.querySelector('.map');
    this.clearAllButton = this.root.querySelector('.clear-all');
    this.status = this.root.querySelector('.status');
    this.rows = this.root.querySelector('.rows');

    this.mapButton.addEventListener('click', () => {
      const enabled = !this.mappingMode;
      this.setMode(enabled);
      this.dispatchEvent(new CustomEvent(enabled ? 'midi-map-begin' : 'midi-map-cancel'));
    });
    this.clearAllButton.addEventListener('click', () =>
      this.dispatchEvent(new CustomEvent('midi-map-clear-all')));
  }

  connectedCallback() {
    window.addEventListener('keydown', this.handleKeyDown, true);
    this.connectMappingSource();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.handleKeyDown, true);
    this.disconnectMappingSource();
  }

  get mappings() {
    return this.mappingSource;
  }

  set mappings(value) {
    this.disconnectMappingSource();
    this.mappingSource = value;
    this.records = new Map();
    this.connectMappingSource();
    this.render();
  }

  connectMappingSource() {
    if (!this.isConnected || !this.mappingSource) return;
    this.records = new Map((this.mappingSource.all?.() || [])
      .map(mapping => [String(mapping.parameterID), mapping]));
    this.mappingSource.addEventListener('midi-map', this.handleMappingChange);
    this.mappingSource.addEventListener('midi-unmap', this.handleMappingChange);
  }

  disconnectMappingSource() {
    this.mappingSource?.removeEventListener('midi-map', this.handleMappingChange);
    this.mappingSource?.removeEventListener('midi-unmap', this.handleMappingChange);
  }

  handleMappingChange(event) {
    const mapping = event.detail;
    const id = String(mapping?.parameterID ?? '');
    if (!id) return;

    if (event.type === 'midi-unmap') {
      this.records.delete(id);
      if (this.selectedParameterID === id) {
        this.selectedParameterID = null;
        this.target = null;
        if (this.mappingMode)
          this.status.textContent = 'Touch a plug-in control, then move a MIDI CC';
      }
    } else {
      this.records.set(id, mapping);
      this.selectedParameterID = id;
      if (this.mappingMode && this.target?.parameterID === id)
        this.status.textContent = `Mapped to ${mappingLabel(mapping)}; move another CC to remap`;
      else {
        this.target = null;
        if (this.mappingMode)
          this.status.textContent = `Mapped to ${mappingLabel(mapping)}`;
      }
    }

    this.render();
  }

  handleKeyDown(event) {
    if (!this.mappingMode) return;
    if (event.key === 'Delete') {
      const parameterID = this.target?.parameterID || this.selectedParameterID;
      if (parameterID && this.records.has(parameterID)) {
        event.preventDefault();
        event.stopPropagation();
        this.dispatchEvent(new CustomEvent('midi-map-clear', {detail: {parameterID}}));
      }
      return;
    }
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    this.setMode(false);
    this.dispatchEvent(new CustomEvent('midi-map-cancel'));
  }

  setMode(enabled) {
    this.mappingMode = Boolean(enabled);
    this.mapButton.textContent = this.mappingMode ? 'Cancel MIDI' : 'Map MIDI';
    this.mapButton.toggleAttribute('data-active', this.mappingMode);
    this.mapButton.setAttribute('aria-pressed', String(this.mappingMode));
    if (!this.mappingMode) {
      this.target = null;
      this.selectedParameterID = null;
      this.status.textContent = 'Ready';
    } else if (!this.target) {
      this.status.textContent = 'Touch a plug-in control, then move a MIDI CC';
    }
  }

  setTarget(parameterID, name) {
    if (!this.mappingMode) return false;
    const id = String(parameterID);
    this.target = {parameterID: id, name: name || `Parameter ${parameterID}`};
    this.selectedParameterID = id;
    this.status.textContent = `Move a MIDI CC for ${this.target.name}`;
    return true;
  }

  clearTarget() {
    this.target = null;
    if (this.mappingMode)
      this.status.textContent = 'Touch a plug-in control, then move a MIDI CC';
  }

  render() {
    this.rows.replaceChildren();
    if (!this.records.size) {
      const empty = document.createElement('span');
      empty.className = 'empty';
      empty.textContent = 'No mappings';
      this.rows.append(empty);
    } else {
      for (const [id, mapping] of this.records) {
        const row = document.createElement('div');
        row.className = 'row';

        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${parameterLabel(mapping)} — ${mappingLabel(mapping)}`;
        name.title = name.textContent;

        const clear = document.createElement('button');
        clear.className = 'clear';
        clear.type = 'button';
        clear.textContent = 'Clear';
        clear.setAttribute('aria-label', `Clear ${parameterLabel(mapping)} mapping`);
        clear.addEventListener('click', () => this.dispatchEvent(new CustomEvent(
          'midi-map-clear', {detail: {parameterID: id}})));

        row.append(name, clear);
        this.rows.append(row);
      }
    }
    this.clearAllButton.disabled = this.records.size === 0;
  }
}

customElements.define('standalone-midi-map', StandaloneMidiMap);
