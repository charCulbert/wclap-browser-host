import { packMIDIMessage, unpackMIDIMessage } from '../midi.js';
import { defineElement } from '../utils.js';

export class WebMIDI extends HTMLElement {
  static get observedAttributes() {
    return ['input-id', 'output-id', 'input-only', 'output-only'];
  }

  constructor() {
    super();

    this.midiAccess = null;
    this.inputs = [];
    this.outputs = [];
    this.selectedInputID = '';
    this.selectedOutputID = '';
    this.status = 'Connecting';
    this.inputSelectID = `compost-midi-input-${Math.random().toString(36).slice(2)}`;
    this.outputSelectID = `compost-midi-output-${Math.random().toString(36).slice(2)}`;
    this.inputLabelID = `${this.inputSelectID}-label`;
    this.outputLabelID = `${this.outputSelectID}-label`;
    this.inputHelpID = `${this.inputSelectID}-help`;
    this.outputHelpID = `${this.outputSelectID}-help`;

    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `
      <style>
        :host {
          --compost-midi-panel-bg: transparent;
          --compost-midi-border: transparent;
          --compost-midi-text: #111111;
          --compost-midi-muted: #555555;
          --compost-midi-control-bg: #ffffff;
          --compost-midi-control-border: #111111;
          --compost-midi-focus-color: #111111;
          --compost-midi-color-scheme: light;
          color-scheme: var(--compost-midi-color-scheme);
          display: block;
        }
        .panel {
          display: grid;
          gap: 12px;
          padding: 0;
          border: 0;
          border-radius: 0;
          background: transparent;
          color: var(--compost-midi-text);
          font-size: 13px;
        }
        .row {
          display: grid;
          grid-template-columns: var(--compost-midi-columns, repeat(auto-fit, minmax(min(100%, 130px), 1fr)));
          gap: 12px;
        }
        .field { display: grid; gap: 7px; }
        .field[hidden] { display: none !important; }
        label { display: block; }
        select {
          min-width: 0;
          width: 100%;
          min-height: 30px;
          border: 1px solid var(--compost-midi-control-border);
          border-radius: 4px;
          background: var(--compost-midi-control-bg);
          color: var(--compost-midi-text);
        }
        select:focus {
          outline: 1px solid color-mix(in srgb, var(--compost-midi-focus-color) 45%, transparent);
          outline-offset: 2px;
        }
        select:focus-visible {
          outline: 2px solid var(--compost-midi-focus-color);
        }
        .status { color: var(--compost-midi-muted); font-size: 12px; opacity: 0.72; }
        .sr-only {
          position: absolute;
          width: 1px;
          height: 1px;
          padding: 0;
          margin: -1px;
          overflow: hidden;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          white-space: nowrap;
          border: 0;
        }
      </style>
      <div class="panel" part="panel">
        <div class="row">
          <div class="field" part="field input-field" data-input-field>
            <label part="label input-label" data-input-label>MIDI In</label>
            <select part="select input-select" data-input></select>
            <span class="sr-only" data-input-help>Choose a MIDI input device.</span>
          </div>
          <div class="field" part="field output-field" data-output-field>
            <label part="label output-label" data-output-label>MIDI Out</label>
            <select part="select output-select" data-output></select>
            <span class="sr-only" data-output-help>Choose a MIDI output device.</span>
          </div>
        </div>
        <div class="status" part="status" aria-live="polite" aria-atomic="true"></div>
      </div>`;

    this.inputSelect = this.root.querySelector('[data-input]');
    this.outputSelect = this.root.querySelector('[data-output]');
    this.inputLabel = this.root.querySelector('[data-input-label]');
    this.outputLabel = this.root.querySelector('[data-output-label]');
    this.inputField = this.root.querySelector('[data-input-field]');
    this.outputField = this.root.querySelector('[data-output-field]');
    this.inputHelp = this.root.querySelector('[data-input-help]');
    this.outputHelp = this.root.querySelector('[data-output-help]');
    this.statusElement = this.root.querySelector('.status');

    this.inputSelect.id = this.inputSelectID;
    this.outputSelect.id = this.outputSelectID;
    this.inputLabel.id = this.inputLabelID;
    this.outputLabel.id = this.outputLabelID;
    this.inputLabel.setAttribute('for', this.inputSelectID);
    this.outputLabel.setAttribute('for', this.outputSelectID);
    this.inputHelp.id = this.inputHelpID;
    this.outputHelp.id = this.outputHelpID;
    this.inputSelect.setAttribute('aria-labelledby', this.inputLabelID);
    this.outputSelect.setAttribute('aria-labelledby', this.outputLabelID);
    this.inputSelect.setAttribute('aria-describedby', this.inputHelpID);
    this.outputSelect.setAttribute('aria-describedby', this.outputHelpID);

    this.inputSelect.addEventListener('change', () => this.selectInput(this.inputSelect.value));
    this.outputSelect.addEventListener('change', () => this.selectOutput(this.outputSelect.value));
  }

  connectedCallback() {
    this.selectedInputID = this.getAttribute('input-id') || this.selectedInputID;
    this.selectedOutputID = this.getAttribute('output-id') || this.selectedOutputID;
    this.connect();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    if (oldValue === newValue) return;

    if (name === 'input-only' && newValue !== null && this.hasAttribute('output-only')) {
      this.removeAttribute('output-only');
    }

    if (name === 'output-only' && newValue !== null && this.hasAttribute('input-only')) {
      this.removeAttribute('input-only');
    }

    if (name === 'input-id') {
      this.selectedInputID = newValue || '';
      if (this.midiAccess) {
        this.selectInput(this.selectedInputID);
        return;
      }
    }

    if (name === 'output-id') {
      this.selectedOutputID = newValue || '';
      if (this.midiAccess) {
        this.selectOutput(this.selectedOutputID);
        return;
      }
    }

    this.applyVisibility();
    if (this.shouldHideInput()) {
      this.detachInput();
    } else if (this.midiAccess) {
      this.attachInput();
    }
    this.refresh();
  }

  disconnectedCallback() {
    this.detachInput();

    if (this.midiAccess) {
      this.midiAccess.onstatechange = null;
    }
  }

  async connect() {
    if (!navigator.requestMIDIAccess) {
      this.status = 'Web MIDI is not available in this browser';
      this.refresh();
      return;
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({
        sysex: this.hasAttribute('sysex'),
        software: true,
      });

      this.midiAccess.onstatechange = () => this.refreshDevices();
      this.refreshDevices();
      this.dispatchEvent(new CustomEvent('midi-ready', { bubbles: true, composed: true }));
    } catch (error) {
      this.status = `Could not open MIDI: ${error.message}`;
      this.refresh();
    }
  }

  refreshDevices() {
    this.inputs = [...this.midiAccess.inputs.values()].filter((device) => device.state === 'connected');
    this.outputs = [...this.midiAccess.outputs.values()].filter((device) => device.state === 'connected');
    this.selectedInputID = this.keepDevice(this.selectedInputID, this.inputs);
    this.selectedOutputID = this.keepDevice(this.selectedOutputID, this.outputs);
    this.applyVisibility();
    this.attachInput();
    this.refresh();

    this.dispatchEvent(new CustomEvent('midi-devices-changed', {
      bubbles: true,
      composed: true,
      detail: {
        inputs: this.inputs,
        outputs: this.outputs,
        input: this.getSelectedInput(),
        output: this.getSelectedOutput(),
      },
    }));
  }

  restoreSelection({ inputID = '', outputID = '', inputName = '', outputName = '' } = {}) {
    const input = this.findDevice(this.inputs, inputID, inputName);
    const output = this.findDevice(this.outputs, outputID, outputName);

    if (input) {
      this.selectInput(input.id);
    }

    if (output) {
      this.selectOutput(output.id);
    }

    return {
      input: this.getSelectedInput(),
      output: this.getSelectedOutput(),
    };
  }

  findDevice(devices, id, name) {
    return devices.find((device) => id && device.id === id)
      || devices.find((device) => name && device.name === name)
      || null;
  }

  keepDevice(id, devices) {
    return devices.some((device) => device.id === id) ? id : '';
  }

  selectInput(id) {
    this.selectedInputID = id;
    this.attachInput();
    this.refresh();
    this.dispatchSelectionEvent('midi-input-selected', this.getSelectedInput());
  }

  selectOutput(id) {
    this.selectedOutputID = id;
    this.refresh();
    this.dispatchSelectionEvent('midi-output-selected', this.getSelectedOutput());
  }

  dispatchSelectionEvent(type, device) {
    this.dispatchEvent(new CustomEvent(type, {
      bubbles: true,
      composed: true,
      detail: { device },
    }));
  }

  getSelectedInput() {
    return this.inputs.find((input) => input.id === this.selectedInputID) || null;
  }

  getSelectedOutput() {
    return this.outputs.find((output) => output.id === this.selectedOutputID) || null;
  }

  attachInput() {
    this.detachInput();

    if (this.shouldHideInput()) {
      return;
    }

    const input = this.getSelectedInput();
    if (input) {
      input.onmidimessage = (event) => this.handleMIDIMessage(event);
      this.currentInput = input;
    }
  }

  detachInput() {
    if (this.currentInput) {
      this.currentInput.onmidimessage = null;
      this.currentInput = null;
    }
  }

  handleMIDIMessage(event) {
    const data = [...event.data];
    const message = packMIDIMessage(data);
    const receivedAt = typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();

    this.dispatchEvent(new CustomEvent('midi-message', {
      bubbles: true,
      composed: true,
      detail: {
        data,
        message,
        timestamp: event.timeStamp ?? null,
        receivedAt,
        input: this.getSelectedInput(),
      },
    }));
  }

  send(data) {
    if (this.shouldHideOutput()) {
      return;
    }

    const output = this.getSelectedOutput();
    if (output) {
      output.send(data);
    }
  }

  sendPackedMessage(message) {
    this.send(unpackMIDIMessage(message));
  }

  refresh() {
    this.applyVisibility();
    this.fillSelect(this.inputSelect, this.inputs, this.selectedInputID, 'No device');
    this.fillSelect(this.outputSelect, this.outputs, this.selectedOutputID, 'No device');

    if (!this.midiAccess) {
      this.statusElement.textContent = this.status;
      this.statusElement.hidden = !this.status;
      return;
    }

    this.statusElement.textContent = '';
    this.statusElement.hidden = true;
  }

  fillSelect(select, devices, selectedID, emptyLabel) {
    select.replaceChildren();
    select.append(new Option(emptyLabel, ''));

    if (devices.length === 0) {
      select.disabled = true;
      return;
    }

    select.disabled = false;

    for (const device of devices) {
      select.append(new Option(device.name || device.id, device.id));
    }

    select.value = selectedID || '';
  }

  shouldHideInput() {
    return this.hasAttribute('output-only');
  }

  shouldHideOutput() {
    return this.hasAttribute('input-only');
  }

  applyVisibility() {
    const hideInput = this.shouldHideInput();
    const hideOutput = this.shouldHideOutput();

    if (this.inputField) {
      this.inputField.hidden = hideInput;
    }

    if (this.outputField) {
      this.outputField.hidden = hideOutput;
    }

    if (hideInput) {
      this.detachInput();
    }
  }
}

defineElement('compost-midi', WebMIDI);
