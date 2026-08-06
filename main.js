import ClapAudioNode from './clap-audionode/clap-audionode.mjs?v=20260806-midi-map';
import './compost/components/compost-audio.js';
import './compost/components/compost-button.js';
import './compost/components/compost-midi-map.js';
import './compost/components/compost-midi.js';
import './compost/components/compost-radio-group.js';
import './compost/components/compost-slider.js';
import {createMIDIMappings} from './compost/midi-mappings.js';

const $ = document.querySelector.bind(document);
const query = new URLSearchParams(location.search);
if (query.has('state')) {
	query.delete('state');
	const search = query.toString();
	history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}
const archive = query.get('module')
	|| document.body.dataset.archive
	|| 'examples/public/char-example-synth.wclap.tar.gz';
const wclap = new ClapAudioNode({url: archive});

const audioControl = $('compost-audio');
let audioElement = $('#input-audio');
const effectControls = $('#effect-controls');
const fileInput = $('#audio-file');
const main = $('main');
const midiSlot = $('#midi-slot');
const midiMap = $('#midi-map');
const midiMappingsPanel = $('#midi-mappings-panel');
const parameterPanel = $('#parameter-panel');
const parameters = $('#parameters');
const pluginPanel = $('#plugin-panel');
const pluginSelector = $('#plugins');
const presetPanel = $('#preset-panel');
const presetSelector = $('#presets');
const status = $('#status');

const CLAP_PARAM_IS_STEPPED = 1 << 0;
const CLAP_PARAM_IS_READONLY = 1 << 3;
const CLAP_PARAM_IS_AUTOMATABLE = 1 << 5;
const CLAP_PARAM_RESCAN_VALUES = 1 << 0;
const CLAP_PARAM_RESCAN_TEXT = 1 << 1;
const CLAP_PARAM_RESCAN_INFO = 1 << 2;
const CLAP_PARAM_RESCAN_ALL = 1 << 3;

let audioSource;
let effectNode;
let interfaceFrame;
let inputPlaying = false;
let performanceTimer;
let stateTimer;
let objectUrl;
let presets = [];
let pluginId = query.get('plugin');
let parameterControls = new Map();
let parameterFlags = new Map();
let parameterSetupGeneration = 0;
let parameterRefreshGeneration = 0;
let midiMappings = null;
let midiAvailable = false;

function setStatus(message, isError = false) {
	status.textContent = message;
	status.toggleAttribute('data-error', isError);
	status.hidden = !message;
}

function stateStorageKey() {
	return `wclap-browser-host:state:${archive}:${pluginId || ''}`;
}

function stateFromStorage() {
	const encoded = sessionStorage.getItem(stateStorageKey());
	if (!encoded) return null;

	const binary = atob(encoded.replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from(binary, character => character.charCodeAt(0)).buffer;
}

function encodeState(state) {
	if (!state) return null;
	const bytes = new Uint8Array(ArrayBuffer.isView(state) ? state.buffer : state);
	let binary = '';
	bytes.forEach(byte => { binary += String.fromCharCode(byte); });
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function storeState() {
	if (!effectNode) return;
	const state = encodeState(await effectNode.saveState());
	if (!state) return;
	sessionStorage.setItem(stateStorageKey(), state);
}

function openPluginInterface(node, pageProxy) {
	const frameId = `plugin-ui-${crypto.randomUUID()}`;
	const frame = node.openInterface({
		filePrefix: `${pageProxy.prefix}${frameId}/file`,
		resourcePrefix: `${pageProxy.prefix}${frameId}/get_resource`,
	});
	frame.id = frameId;
	frame.title = `${node.descriptor.name} interface`;
	frame.width = 640;
	frame.height = 420;
	frame[pageProxy.symbol] = async path => {
		if (/^\/file\//.test(path)) return node.getFile(path.slice(5));
		if (/^\/get_resource\//.test(path)) return node.getResource(path.slice(13));
		return null;
	};
	return frame;
}

async function setupPlugins() {
	const plugins = await wclap.plugins();
	if (!plugins.length) throw Error('The WCLAP archive contains no plugins');

	if (!pluginId || !plugins.some(plugin => plugin.id === pluginId)) {
		pluginId = plugins[0].id;
	}

	if (plugins.length <= 1) return;

	pluginSelector.setAttribute('options', plugins.map(plugin => plugin.name).join(','));
	pluginSelector.setAttribute('values', plugins.map(plugin => plugin.id).join(','));
	pluginSelector.value = pluginId;
	pluginPanel.hidden = false;
	pluginSelector.addEventListener('change', event => {
		const nextQuery = new URLSearchParams(location.search);
		nextQuery.set('plugin', event.detail.value);
		nextQuery.delete('state');
		location.href = `${location.pathname}?${nextQuery}`;
	});
}

function workletChannelForMapping(mapping) {
	return mapping.channel === null ? -1 : Number(mapping.channel) - 1;
}

function workletMapping(node, mapping) {
	const parameterID = String(mapping.parameterID);
	return {
		channel: workletChannelForMapping(mapping),
		cc: Number(mapping.cc),
		paramId: Number(parameterID),
		min: Number(mapping.min),
		max: Number(mapping.max),
		flags: parameterFlags.get(parameterID) || 0,
	};
}

function mappingIndication(node, mapping, hasMapping) {
	if (typeof node.setParamMappingIndication !== 'function') return Promise.resolve();
	const label = hasMapping
		? mapping.channel === null ? `CC ${mapping.cc}` : `ch ${mapping.channel} CC ${mapping.cc}`
		: '';
	return node.setParamMappingIndication({
		paramId: Number(mapping.parameterID),
		hasMapping,
		label,
		description: hasMapping ? `Mapped to ${label}` : '',
	});
}

async function installMapping(node, mapping) {
	const parameterID = String(mapping.parameterID);
	const previous = midiMappings.get(parameterID);
	const conflicts = midiMappings.all().filter(candidate =>
		candidate.parameterID !== parameterID
		&& candidate.cc === mapping.cc
		&& candidate.channel === mapping.channel);
	const replaced = [previous, ...conflicts].filter(Boolean);

	try {
		for (const oldMapping of replaced)
			await node.clearMidiCCMapping(workletMapping(node, oldMapping));
		await node.setMidiCCMapping(workletMapping(node, mapping));
		midiMappings.applyMapping(mapping);
		for (const oldMapping of conflicts) midiMappings.applyClear(oldMapping.parameterID);
		for (const oldMapping of replaced)
			await mappingIndication(node, oldMapping, false);
		await mappingIndication(node, mapping, true);
	} catch (error) {
		showError(error);
	}
}

async function uninstallMapping(node, parameterID) {
	const mapping = midiMappings.get(parameterID);
	if (!mapping) return;

	try {
		await node.clearMidiCCMapping(workletMapping(node, mapping));
		await mappingIndication(node, mapping, false);
		midiMappings.applyClear(parameterID);
	} catch (error) {
		showError(error);
	}
}

function configureMappings(node, params) {
	const previousMappings = midiMappings?.all() || [];
	const definitions = new Map();
	parameterFlags = new Map();

	for (const param of params) {
		const id = String(param.id);
		const flags = Number(param.flags) || 0;
		parameterFlags.set(id, flags);
		if ((flags & CLAP_PARAM_IS_AUTOMATABLE) === 0
			|| (flags & CLAP_PARAM_IS_READONLY) !== 0) continue;
		definitions.set(id, {
			parameterID: id,
			kind: flags & CLAP_PARAM_IS_STEPPED ? 'discrete' : 'continuous',
			path: param.path || param.module || param.section || node.descriptor?.name || 'Plug-in',
			name: param.name,
			min: param.min,
			max: param.max,
			defaultValue: param.default,
			step: flags & CLAP_PARAM_IS_STEPPED ? 1 : 0,
		});
	}

	midiMappings = createMIDIMappings({
		parameters: {definition: parameterID => definitions.get(String(parameterID)) || null},
	});
	midiMappings.addEventListener('midi-mapping-request', event =>
		void installMapping(node, event.detail));
	midiMappings.addEventListener('midi-unmapping-request', event =>
		void uninstallMapping(node, event.detail.parameterID));
	midiMap.mappings = midiMappings;

	const validPrevious = previousMappings.filter(mapping => definitions.has(mapping.parameterID));
	if (validPrevious.length) {
		midiMappings.applyMappings(validPrevious);
		for (const mapping of validPrevious) void mappingIndication(node, mapping, true);
	}
}

function setupMIDI(node) {
	midiSlot.replaceChildren();
	midiAvailable = false;
	midiMappingsPanel.hidden = true;
	const noteInputs = node.capabilities.noteInputs || [];
	const acceptsMIDI = noteInputs.some(port => (port.supportedDialects & 2) !== 0);
	if (!acceptsMIDI) return;
	midiAvailable = true;
	midiMappingsPanel.hidden = false;

	const midi = document.createElement('compost-midi');
	midi.setAttribute('input-only', '');
	midi.addEventListener('midi-message', event => {
		const data = event.detail.data;
		midiMappings?.handleMIDIMessage(data);
		node.sendMidi(event.detail.data, {
			timestamp: event.detail.timestamp ?? event.detail.receivedAt,
			port: 0,
		});
	});
	midiSlot.append(midi);
}

function handleMappedValues(buffer) {
	if (!(buffer instanceof ArrayBuffer)) return;
	const view = new DataView(buffer);
	const count = Math.min(view.getUint32(0, true), (buffer.byteLength - 4)/12);
	for (let index = 0; index < count; ++index) {
		const offset = 4 + index*12;
		const control = parameterControls.get(String(view.getUint32(offset, true)));
		if (control) {
			control.removeAttribute('text');
			control.value = view.getFloat64(offset + 4, true);
		}
	}
}

function applyParameterValues(params) {
	for (const param of params) {
		const control = parameterControls.get(String(param.id));
		if (!control) continue;
		control.value = param.value?.value ?? param.default;
		if (param.value?.text) {
			control.setAttribute('text', param.value.text);
		} else {
			control.removeAttribute('text');
		}
	}
}

async function refreshParameterValues(node) {
	const setupGeneration = parameterSetupGeneration;
	const refreshGeneration = ++parameterRefreshGeneration;
	const params = await node.getParams();
	if (setupGeneration !== parameterSetupGeneration
		|| refreshGeneration !== parameterRefreshGeneration
		|| effectNode !== node) return;
	applyParameterValues(params);
}

async function setupParameters(node) {
	const generation = ++parameterSetupGeneration;
	++parameterRefreshGeneration;
	const params = await node.getParams();
	if (generation !== parameterSetupGeneration || effectNode !== node) return;

	parameters.replaceChildren();
	parameterControls.clear();
	for (const param of params) {
		const flags = Number(param.flags) || 0;
		const control = document.createElement('compost-slider');
		control.setAttribute('label', param.name);
		control.setAttribute('parameter-id', String(param.id));
		control.setAttribute('min', String(param.min));
		control.setAttribute('max', String(param.max));
		control.setAttribute('step', flags & CLAP_PARAM_IS_STEPPED ? '1' : '0.000001');
		control.setAttribute('reset-value', String(param.default));
		control.value = param.value?.value ?? param.default;
		if (param.value?.text) control.setAttribute('text', param.value.text);
		control.addEventListener('parameter-edit', async event => {
			if (event.detail.parameterID !== String(param.id)) return;
			const value = await node.setParam(param.id, event.detail.value);
			if (value) {
				control.value = value.value;
				control.setAttribute('text', value.text || '');
			}
		});
		control.addEventListener('parameter-end', () => storeState().catch(showError));
		parameters.append(control);
		parameterControls.set(String(param.id), control);
	}
	parameterPanel.hidden = params.length === 0;
	configureMappings(node, params);
}

async function setupPresets(node) {
	presetPanel.hidden = true;
	presets = node.supportsPresetLoad ? await node.getPresets() : [];
	if (!presets.length) return;

	presetSelector.setAttribute('options', presets
		.map(preset => preset.name.replaceAll(',', ' ')).join(','));
	presetSelector.setAttribute('values', presets.map((_, index) => String(index)).join(','));
	presetSelector.removeAttribute('value');
	presetPanel.hidden = false;
}

async function start(context) {
	setStatus('Loading WCLAP plug-in…');
	await pluginsReady;
	const pageProxy = await pageProxyReady;
	const node = await wclap.createNode(context, pluginId, {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
	});

	const hasAudioInput = (node.capabilities.audioInputs || []).length > 0;

	document.title = node.descriptor.name;
	$('#plugin-name').textContent = node.descriptor.name;
	effectControls.hidden = !hasAudioInput;
	effectNode = node;

	node.events.state_mark_dirty = () => {
		clearTimeout(stateTimer);
		stateTimer = setTimeout(() => storeState().catch(showError), 100);
	};
	node.events.params_rescan = flags => {
		const rescanFlags = Number(flags) || 0;
		const needsValueRefresh = (rescanFlags
			& (CLAP_PARAM_RESCAN_VALUES | CLAP_PARAM_RESCAN_TEXT)) !== 0;
		const needsRebuild = rescanFlags === 0
			|| (rescanFlags & (CLAP_PARAM_RESCAN_INFO | CLAP_PARAM_RESCAN_ALL)) !== 0
			|| !needsValueRefresh;
		const update = needsRebuild ? setupParameters(node) : refreshParameterValues(node);
		update.catch(showError);
	};
	node.events['mapped-param-values'] = handleMappedValues;
	node.events.param_gesture_begin = parameterID => {
		const controller = midiMap.controller;
		if (!controller || controller.state === 'idle') return;
		const target = parameterControls.get(String(parameterID));
		if (target && target !== controller.lastTarget) {
			midiMap.selectTarget(target, { focus: false });
		}
	};

	const savedState = stateFromStorage();
	if (savedState) await node.loadState(savedState);

	if (hasAudioInput) {
		audioSource = context.createMediaElementSource(audioElement);
		audioSource.connect(node);
	}
	node.connect(context.destination);

	if (node.openInterface) {
		interfaceFrame = openPluginInterface(node, pageProxy);
		main.prepend(interfaceFrame);
	}
	setupMIDI(node);
	await setupParameters(node);
	await setupPresets(node);
	setStatus('');

	clearInterval(performanceTimer);
	performanceTimer = setInterval(async () => {
		if (!effectNode) return;
		const measurement = await effectNode.performance();
		const wasm = measurement.wasm / measurement.block;
		const javascript = measurement.js / measurement.block - wasm;
		$('#cpu').textContent = `${(wasm * 100).toFixed(1)}%/${(javascript * 100).toFixed(1)}%`;
	}, 1000);
}

function stop() {
	++parameterSetupGeneration;
	++parameterRefreshGeneration;
	clearInterval(performanceTimer);
	performanceTimer = null;
	clearTimeout(stateTimer);
	inputPlaying = false;
	audioElement.pause();
	audioSource?.disconnect();
	effectNode?.disconnect();
	const replacementAudioElement = audioElement.cloneNode();
	audioElement.replaceWith(replacementAudioElement);
	audioElement = replacementAudioElement;
	effectNode?.closeInterface?.();
	midiMap.mappings = null;
	interfaceFrame?.remove();
	interfaceFrame = null;
	effectNode = null;
	audioSource = null;
	midiSlot.replaceChildren();
	parameterPanel.hidden = true;
	parameters.replaceChildren();
	parameterControls.clear();
	parameterFlags.clear();
	midiMappings = null;
	midiMappingsPanel.hidden = true;
	midiMappingsPanel.open = false;
	midiAvailable = false;
	presetPanel.hidden = true;
	presets = [];
	$('#cpu').textContent = '';
	$('#play-input').setAttribute('label', 'Play');
	setStatus('Press Start to load the plug-in.');
}

function loadAudioFile(file) {
	if (!file) return;
	if (objectUrl) URL.revokeObjectURL(objectUrl);
	objectUrl = URL.createObjectURL(file);
	audioElement.src = objectUrl;
	inputPlaying = false;
	$('#play-input').setAttribute('label', 'Play');
}

function showError(error) {
	console.error(error);
	setStatus(error?.message || String(error), true);
}

const pluginsReady = setupPlugins().catch(error => {
	showError(error);
	throw error;
});

audioControl.addEventListener('audio-started', event => {
	if (!effectNode) start(event.detail.context).catch(showError);
});
audioControl.addEventListener('audio-stopped', stop);

$('#play-input').addEventListener('button-trigger', async () => {
	if (!effectNode) return;
	if (inputPlaying) {
		audioElement.pause();
	} else {
		await audioElement.play();
	}
	inputPlaying = !inputPlaying;
	$('#play-input').setAttribute('label', inputPlaying ? 'Pause' : 'Play');
});

$('#load-input').addEventListener('button-trigger', () => fileInput.click());
fileInput.addEventListener('change', () => loadAudioFile(fileInput.files?.[0]));

document.body.addEventListener('dragover', event => {
	event.preventDefault();
});
document.body.addEventListener('drop', event => {
	event.preventDefault();
	loadAudioFile(event.dataTransfer?.files?.[0]);
});

presetSelector.addEventListener('change', async event => {
	const preset = presets[Number(event.detail.value)];
	if (!effectNode || !preset) return;
	if (!await effectNode.loadPreset(preset)) {
		throw new Error(`Could not load preset: ${preset.name}`);
	}
	await storeState();
});

window.addEventListener('unhandledrejection', event => showError(event.reason));
window.addEventListener('error', event => showError(event.error || event.message));

globalThis.wclapModule = wclap;
