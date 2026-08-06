import { defineElement, editParameterGesture, endParameterGesture } from '../utils.js';

let nextRadioGroupID = 1;

export class RadioGroup extends HTMLElement {
  static get observedAttributes() {
    return [
      'label',
      'name',
      'value',
      'disabled',
      'options',
      'values',
      'parameter-values',
      'orientation',
      'stack',
      'parameter-id',
      'section',
    ];
  }

  constructor() {
    super();

    this.internalName = `compost-radio-group-${nextRadioGroupID++}`;
    this.root = this.attachShadow({ mode: 'open' });
    this.root.innerHTML = `
      <style>
        :host {
          display: inline-flex;
          --compost-radio-group-bg: transparent;
          --compost-radio-group-color: #111111;
          --compost-radio-group-border: var(--compost-radio-group-color);
          --compost-radio-group-fill: var(--compost-radio-group-active-bg, var(--compost-radio-group-color));
          --compost-radio-group-focus: var(--compost-radio-group-color);
          --compost-radio-group-gap: 12px;
          --compost-radio-group-option-gap: 8px;
          --compost-radio-group-padding: 0;
          --compost-radio-group-size: 18px;
          --compost-radio-group-dot-size: 10px;
          --compost-radio-group-direction: row;
          --compost-radio-group-label-radius: 4px;
          --compost-radio-group-color-scheme: light;
          --midi-map-learn-color: #005fc0;
          --midi-map-label-text: var(--midi-map-learn-color);
          --midi-map-label-shadow: none;
          color-scheme: var(--compost-radio-group-color-scheme);
          color: var(--compost-radio-group-color);
          font: inherit;
        }
        .options {
          display: flex;
          flex-direction: var(--compost-radio-group-direction);
          flex-wrap: wrap;
          gap: var(--compost-radio-group-gap);
          align-items: center;
          padding: var(--compost-radio-group-padding);
          background: var(--compost-radio-group-bg);
          position: relative;
        }
        label {
          min-height: calc(var(--compost-radio-group-size) + 8px);
          border-radius: var(--compost-radio-group-label-radius);
          padding: 2px 4px;
          display: inline-grid;
          grid-template-columns: auto 1fr;
          gap: var(--compost-radio-group-option-gap);
          align-items: center;
          color: inherit;
          cursor: pointer;
          font: inherit;
          text-align: left;
          position: relative;
        }
        input {
          width: var(--compost-radio-group-size);
          height: var(--compost-radio-group-size);
          margin: 0;
          appearance: none;
          -webkit-appearance: none;
          border: 2px solid var(--compost-radio-group-border);
          border-radius: 50%;
          background: transparent;
          cursor: pointer;
          display: grid;
          place-items: center;
        }
        input::after {
          content: "";
          width: var(--compost-radio-group-dot-size);
          height: var(--compost-radio-group-dot-size);
          border-radius: 50%;
          background: var(--compost-radio-group-fill);
          opacity: 0;
        }
        input:checked {
          border-color: var(--compost-radio-group-fill);
        }
        input:checked::after {
          opacity: 1;
        }
        label:hover input {
          border-color: var(--compost-radio-group-fill);
        }
        input:focus {
          box-shadow: 0 0 0 1px color-mix(in srgb, var(--compost-radio-group-focus) 45%, transparent);
        }
        input:focus-visible {
          outline: 2px solid var(--compost-radio-group-focus);
          outline-offset: 3px;
          box-shadow: none;
        }
        input:disabled,
        :host([disabled]) input,
        :host([disabled]) label {
          cursor: default;
          opacity: 0.45;
        }
        .text {
          line-height: 1.2;
          min-width: 0;
          overflow-wrap: anywhere;
          white-space: normal;
        }
        :host([data-midi-map-target-active]) input {
          box-shadow: 0 0 0 1px var(--midi-map-learn-color);
          transition: box-shadow 220ms ease;
        }
        :host([data-midi-map-target-active][data-midi-map-pulse]) input {
          box-shadow: 0 0 0 3px var(--midi-map-learn-color);
        }
        :host([data-midi-map-mode][data-midi-map-label]) .options::after {
          content: var(--midi-map-label);
          color: var(--midi-map-label-text);
          font-size: 10px;
          font-weight: 800;
          letter-spacing: 0.02em;
          line-height: 1;
          pointer-events: none;
          text-shadow: var(--midi-map-label-shadow);
          white-space: nowrap;
        }
        .sr-only {
          width: 1px;
          height: 1px;
          position: absolute;
          overflow: hidden;
          clip: rect(0 0 0 0);
          clip-path: inset(50%);
          white-space: nowrap;
        }
        @media (prefers-reduced-motion: reduce) {
          :host([data-midi-map-target-active]) input {
            transition: none;
          }
        }
      </style>
      <span class="sr-only" id="${this.internalName}-keyboard-help">Use arrow keys to move between radio options. Press Tab to leave the radio group.</span>
      <div class="options" part="options"></div>`;

    this.optionsElement = this.root.querySelector('.options');
  }

  connectedCallback() {
    this.setAttribute('role', 'radiogroup');
    this.refresh();
  }

  attributeChangedCallback() {
    this.refresh();
  }

  get value() {
    const option = this.optionForValue(this.getAttribute('value'));
    return option ? option.value : '';
  }

  set value(value) {
    if (value == null || value === '') {
      this.removeAttribute('value');
    } else {
      const option = this.optionForValue(value);
      this.setAttribute('value', option ? option.value : String(value));
    }
  }

  get disabled() {
    return this.hasAttribute('disabled');
  }

  get parameterID() {
    return this.getAttribute('parameter-id') || '';
  }

  get parameterKind() { return this.getAttribute('parameter-kind') || 'discrete'; }

  get options() {
    const labels = this.splitList(this.getAttribute('options'));
    const values = this.splitList(this.getAttribute('values'));
    const parameterValues = this.splitList(this.getAttribute('parameter-values'));

    return labels.map((label, index) => ({
      label,
      value: values[index] || label,
      parameterValue: this.numberOrNull(parameterValues[index]),
    }));
  }

  get renderedOptions() {
    return [...this.optionsElement.querySelectorAll('input[type="radio"]')];
  }

  get min() {
    return 0;
  }

  get max() {
    return Math.max(0, this.options.length - 1);
  }

  get step() {
    return 1;
  }

  get selectedOption() {
    return this.optionForValue(this.value);
  }

  getParameterValue() {
    const option = this.selectedOption;
    return option ? this.parameterValueForOption(option) : 0;
  }

  setValue(value, shouldEmit = true, source = 'control') {
    if (value == null || value === '') {
      this.value = '';
      this.refresh();
      return;
    }

    const option = this.optionForValue(value);
    if (!option) {
      const firstOption = this.options[0];
      if (firstOption) {
        this.selectOption(firstOption, shouldEmit, source);
        return;
      }
      this.refresh();
      return;
    }

    this.selectOption(option, shouldEmit, source);
  }

  refresh() {
    const label = this.getAttribute('label') || this.getAttribute('name') || 'Options';
    const options = this.options;
    const orientation = this.orientation;
    this.syncRangeAttributes(options.length);
    const selectedOption = this.optionForValue(this.getAttribute('value'));
    if (selectedOption && this.getAttribute('value') !== selectedOption.value) {
      this.setAttribute('value', selectedOption.value);
      return;
    }
    const selectedIndex = selectedOption
      ? options.findIndex((option) => option.value === selectedOption.value)
      : -1;
    const focusIndex = selectedIndex >= 0 ? selectedIndex : 0;

    this.setAttribute('aria-label', label);
    this.setAttribute('aria-orientation', orientation);
    this.optionsElement.style.setProperty('--compost-radio-group-direction', orientation === 'vertical' ? 'column' : 'row');
    this.optionsElement.style.alignItems = orientation === 'vertical' ? 'start' : 'center';
    this.optionsElement.innerHTML = options.map((option, index) => `
      <label part="option">
        <input
          part="input indicator"
          type="radio"
          name="${this.internalName}"
          value="${this.escapeHTML(option.value)}"
          aria-label="${this.escapeHTML(option.label)}"
          aria-describedby="${this.internalName}-keyboard-help"
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
          ${index === selectedIndex ? 'checked' : ''}
          ${index === focusIndex ? '' : 'tabindex="-1"'}
          ${this.disabled ? 'disabled' : ''}
        >
        <span class="text" part="text">${this.escapeHTML(option.label)}</span>
      </label>
    `).join('');

    this.renderedOptions.forEach((input, index) => {
      input.addEventListener('change', () => {
        if (input.checked) this.selectOption(options[index], true);
      });
      input.addEventListener('keydown', (event) => this.handleOptionKeydown(event, index));
    });
  }

  get orientation() {
    const value = (this.getAttribute('orientation') || this.getAttribute('stack') || 'horizontal').toLowerCase();
    return value === 'vertical' || value === 'column' ? 'vertical' : 'horizontal';
  }

  handleOptionKeydown(event, currentIndex) {
    if (this.disabled) return;

    const options = this.options;
    if (!options.length) return;

    let nextIndex = currentIndex;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % options.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = options.length - 1;
    } else if (event.key === ' ' || event.key === 'Enter') {
      this.selectOption(options[currentIndex], true);
      event.preventDefault();
      return;
    } else {
      return;
    }

    this.selectOption(options[nextIndex], true);
    this.renderedOptions[nextIndex]?.focus();
    event.preventDefault();
  }

  selectOption(option, shouldEmit, source = 'control') {
    if (!option) return;

    const previousValue = this.value;
    this.value = option.value;
    this.refresh();

    if (!shouldEmit || previousValue === option.value) return;

    const detail = {
      name: this.getAttribute('name') || '',
      value: option.value,
      label: option.label,
      option,
    };

    this.dispatchEvent(new CustomEvent('input', {
      bubbles: true,
      composed: true,
      detail,
    }));

    this.dispatchEvent(new CustomEvent('change', {
      bubbles: true,
      composed: true,
      detail,
    }));

    editParameterGesture(this, this.getParameterValue(), { source });
    endParameterGesture(this, this.getParameterValue(), { source });
  }

  optionForParameterValue(value) {
    if (!Number.isFinite(value)) return null;

    let best = null;
    let bestDistance = Infinity;

    for (const option of this.options) {
      const distance = Math.abs(this.parameterValueForOption(option) - value);
      if (distance < bestDistance) {
        best = option;
        bestDistance = distance;
      }
    }

    return best;
  }

  optionForValue(value) {
    if (value == null || value === '') return null;

    const options = this.options;
    const stringMatch = options.find((candidate) => candidate.value === String(value));
    if (stringMatch) return stringMatch;

    return this.optionForParameterValue(Number(value));
  }

  parameterValueForOption(option) {
    if (option.parameterValue != null) {
      return option.parameterValue;
    }

    return Math.max(0, this.options.findIndex((candidate) => candidate.value === option.value));
  }

  syncRangeAttributes(optionCount) {
    const parameterValues = this.options
      .map((option) => option.parameterValue)
      .filter((value) => Number.isFinite(value));
    const defaultMin = parameterValues.length ? Math.min(...parameterValues) : 0;
    const defaultMax = parameterValues.length ? Math.max(...parameterValues) : Math.max(0, optionCount - 1);

    if (!this.hasAttribute('min')) {
      this.setAttribute('min', String(defaultMin));
    }

    if (!this.hasAttribute('max')) {
      this.setAttribute('max', String(defaultMax));
    }

    if (!this.hasAttribute('step')) {
      this.setAttribute('step', '1');
    }
  }

  splitList(value) {
    return (value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  numberOrNull(value) {
    if (value == null || value === '') return null;

    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  escapeHTML(value) {
    return String(value)
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;')
      .replace(/"/gu, '&quot;');
  }
}

defineElement('compost-radio-group', RadioGroup);
