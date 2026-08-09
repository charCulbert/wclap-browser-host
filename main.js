import ClapAudioNode from './clap-audionode/clap-audionode.mjs?v=20260808-audio-restart2';
import './compost/src/components/compost-audio.js?v=20260808-audio-default';
import './compost/src/components/compost-button.js';
import './compost/src/components/compost-drawer.js';
import './compost/src/components/compost-midi.js';
import './compost/src/components/compost-midi-mappings.js';
import './compost/src/components/compost-knob.js';
import './compost/src/components/compost-piano.js';
import './compost/src/components/compost-select.js';
import {midiMappingMatchesMessage} from './compost/src/midi-mapping.js';
import {createMIDIMappings} from './compost/src/midi-mappings.js';

const $ = document.querySelector.bind(document);
const query = new URLSearchParams(location.search);
if (query.has('state')) {
	query.delete('state');
	const search = query.toString();
	history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}
const initialArchive = (() => {
	const url = new URL(query.get('module')
		|| document.body.dataset.archive
		|| 'examples/public/char-example-synth.wclap.tar.gz', document.baseURI);
	url.searchParams.set('v', '20260808-host-keyboard');
	return url.href;
})();
let archive = initialArchive;
let archiveLabel = '';
let archiveObjectUrl = null;
let wclap = new ClapAudioNode({url: archive});

const audioControl = $('compost-audio');
let audioElement = $('#input-audio');
const effectControls = $('#effect-controls');
const fileInput = $('#audio-file');
const archiveDrop = $('#archive-drop');
const archiveFile = $('#archive-file');
const hostControlsToggle = $('#host-controls-toggle');
const pluginInfoToggle = $('#plugin-info-toggle');
const hostKeyboard = $('#host-keyboard');
const main = $('main');
const midiDrawer = $('#midi-drawer');
const midiActivityLED = $('[data-midi-activity]');
const midiSlot = $('#midi-slot');
const midiMap = $('#midi-map');
const midiMapToggle = $('#midi-map-toggle');
const midiMappingsSection = $('#midi-mappings-section');
const parameterPanel = $('#parameter-panel');
const parameters = $('#parameters');
const pluginPanel = $('#plugin-panel');
const pluginSelector = $('#plugins');
const pluginInfoPanel = $('#plugin-info-panel');
const pluginInfo = $('#plugin-info');
const presetPanel = $('#preset-panel');
const presetSelector = $('#presets');
const status = $('#status');
const mobileLayout = matchMedia('(max-width: 600px)');

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
let midiActivityTimeout = 0;
let parameterDefinitions = new Map();
let hostControlsVisible = false;
let interfaceKeyWindow = null;
let interfaceLoadHandler = null;
let pluginCatalog = [];
let pluginsReady = Promise.resolve();
let loadGeneration = 0;
archiveLabel = archiveDisplayName(archive);

function setStatus(message, isError = false) {
	status.textContent = message;
	status.toggleAttribute('data-error', isError);
	status.hidden = !message;
}

function syncMIDIDrawerLayout() {
	const isOpen = !midiDrawer.hidden && midiDrawer.open;
	document.body.toggleAttribute('data-midi-drawer-open', isOpen);
	document.documentElement.style.setProperty('--midi-drawer-space',
		isOpen && !mobileLayout.matches ? `${midiDrawer.getBoundingClientRect().width}px` : '0px');
}

function syncMobileLayout() {
	midiDrawer.setAttribute('edge', mobileLayout.matches ? 'top' : 'left');
	midiDrawer.setAttribute('min-size', mobileLayout.matches ? '220' : '320');
	requestAnimationFrame(syncMIDIDrawerLayout);
}

midiDrawer.addEventListener('toggle', () => requestAnimationFrame(syncMIDIDrawerLayout));
midiDrawer.addEventListener('drawer-resize', () => requestAnimationFrame(syncMIDIDrawerLayout));
mobileLayout.addEventListener('change', syncMobileLayout);
syncMobileLayout();

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

function archiveDisplayName(source) {
	if (source?.name) return source.name;
	try {
		const path = decodeURIComponent(new URL(source, document.baseURI).pathname);
		return path.split('/').filter(Boolean).pop() || 'WCLAP archive';
	} catch {
		return 'WCLAP archive';
	}
}

function applyPluginCatalog(plugins) {
	pluginCatalog = plugins;
	if (!pluginId || !plugins.some(plugin => plugin.id === pluginId))
		pluginId = plugins[0].id;

	pluginSelector.replaceChildren(...plugins.map(plugin => {
		const option = document.createElement('option');
		option.value = plugin.id;
		option.textContent = plugin.name;
		return option;
	}));
	pluginSelector.value = pluginId;
	pluginPanel.hidden = false;

	renderPluginInfo();
}

async function setupPlugins(module = wclap) {
	const plugins = await module.plugins();
	if (!plugins.length) throw Error('The WCLAP archive contains no plugins');
	applyPluginCatalog(plugins);
	return plugins;
}

function updatePluginURL(nextPluginID) {
	const nextQuery = new URLSearchParams(location.search);
	if (nextPluginID) nextQuery.set('plugin', nextPluginID);
	else nextQuery.delete('plugin');
	nextQuery.delete('state');
	const search = nextQuery.toString();
	history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
}

async function selectPlugin(nextPluginID) {
	if (!nextPluginID || nextPluginID === pluginId) return;

	const context = audioControl.getContext();
	const shouldStart = context?.state === 'running';
	pluginSelector.disabled = true;
	setStatus(`Loading ${pluginCatalog.find(plugin => plugin.id === nextPluginID)?.name || 'plug-in'}…`);

	try {
		await storeState();
		pluginId = nextPluginID;
		updatePluginURL(pluginId);
		unloadPlugin();
		pluginSelector.value = pluginId;

		if (shouldStart) await start(context);
		else setStatus(`Selected ${pluginCatalog.find(plugin => plugin.id === pluginId)?.name || 'plug-in'}. Press Start audio.`);
	} catch (error) {
		showError(error);
	} finally {
		pluginSelector.disabled = false;
	}
}

pluginSelector.addEventListener('change', event => {
	void selectPlugin(event.target.value);
});

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

function sendHostNote(note, on) {
	if (!effectNode) return;
	const value = Number(note);
	if (!Number.isInteger(value) || value < 0 || value > 127) return;
	effectNode.sendMidi(new Uint8Array([on ? 0x90 : 0x80, value, on ? 100 : 0]), {
		timestamp: performance.now(),
		port: 0,
	});
}

hostKeyboard.addEventListener('note-down', event => sendHostNote(event.detail.note, true));
hostKeyboard.addEventListener('note-up', event => sendHostNote(event.detail.note, false));

function mappingTarget(parameterID, name = '') {
	const id = String(parameterID);
	const definition = parameterDefinitions.get(id);
	const target = parameterControls.get(id);
	if (!definition || !target || midiMap.controller?.state === 'idle') return false;
	if (name) target.setAttribute('label', name);
	return midiMap.controller?.selectTarget(target, {focus: false}) || false;
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

	try {
		if (previous) await node.clearMidiCCMapping(workletMapping(node, previous));
		await node.setMidiCCMapping(workletMapping(node, mapping));
		midiMappings.applyMapping(mapping);
		if (previous) await mappingIndication(node, previous, false);
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

	parameterDefinitions = definitions;

	midiMappings = createMIDIMappings({
		parameters: {definition: parameterID => definitions.get(String(parameterID)) || null},
	});
	midiMappings.addEventListener('midi-mapping-request', event =>
		void installMapping(node, event.detail));
	midiMappings.addEventListener('midi-unmapping-request', event =>
		void uninstallMapping(node, event.detail.parameterID));
	midiMap.mappings = midiMappings;
	const canMapMIDI = midiAvailable && definitions.size !== 0;
	midiMappingsSection.hidden = !canMapMIDI;
	midiMapToggle.hidden = !canMapMIDI;

	const validPrevious = previousMappings.filter(mapping => definitions.has(mapping.parameterID));
	if (validPrevious.length) {
		midiMappings.applyMappings(validPrevious);
		for (const mapping of validPrevious) void mappingIndication(node, mapping, true);
	}
}

function setupMIDI(node) {
	midiSlot.replaceChildren();
	midiAvailable = false;
	midiDrawer.hidden = true;
	midiDrawer.open = false;
	midiMappingsSection.hidden = true;
	midiMapToggle.hidden = true;
	midiMapToggle.pressed = false;
	hostKeyboard.hidden = true;
	document.body.removeAttribute('data-host-keyboard');
	syncMIDIDrawerLayout();
	const noteInputs = node.capabilities.noteInputs || [];
	const acceptsMIDI = noteInputs.some(port => (port.supportedDialects & 2) !== 0);
	if (!acceptsMIDI) return;
	midiAvailable = true;
	midiDrawer.hidden = false;
	hostKeyboard.hidden = false;
	document.body.setAttribute('data-host-keyboard', '');

	const midi = document.createElement('compost-midi');
	midi.id = 'web-midi';
	midi.setAttribute('input-only', '');
	midi.addEventListener('midi-message', event => {
		const data = event.detail.data;
		clearTimeout(midiActivityTimeout);
		midiActivityLED.classList.add('active');
		midiActivityTimeout = setTimeout(() => midiActivityLED.classList.remove('active'), 60);
		const learningTarget = midiMap.controller?.state === 'learning'
			? midiMap.controller.lastTarget?.getAttribute?.('parameter-id')
			: '';
		const currentMapping = learningTarget ? midiMappings?.get(learningTarget) : null;
		if (!midiMappingMatchesMessage(currentMapping, data)) midiMappings?.handleMIDIMessage(data);
		hostKeyboard.handleExternalMIDI(data);
		node.sendMidi(event.detail.data, {
			timestamp: event.detail.timestamp ?? event.detail.receivedAt,
			port: 0,
		});
	});
	midiSlot.append(midi);
}

function updateHostControls(hasParameters, hasPluginUI) {
	if (!hasParameters) {
		hostControlsVisible = false;
		hostControlsToggle.hidden = true;
		parameterPanel.hidden = true;
		if (interfaceFrame) interfaceFrame.hidden = false;
		return;
	}

	if (!hasPluginUI) {
		hostControlsVisible = true;
		hostControlsToggle.hidden = true;
		parameterPanel.hidden = false;
		return;
	}

	hostControlsToggle.hidden = false;
	hostControlsToggle.textContent = 'UI';
	hostControlsToggle.setAttribute('aria-label', hostControlsVisible
		? 'Show plug-in UI'
		: 'Show host controls');
	hostControlsToggle.setAttribute('aria-pressed', String(!hostControlsVisible));
	parameterPanel.hidden = !hostControlsVisible;
	interfaceFrame.hidden = hostControlsVisible;
}

function cancelMIDIMap() {
	if (!midiMap.controller || midiMap.controller.state === 'idle') return;
	midiMap.controller.cancel('host');
}

function parameterIDFromKeyEvent(event) {
	const target = event.composedPath?.().find(node =>
		typeof node?.getAttribute === 'function' && node.getAttribute('parameter-id'));
	return target?.getAttribute('parameter-id')
		|| midiMap.controller?.lastTarget?.getAttribute?.('parameter-id')
		|| '';
}

function handleInterfaceKeyDown(event) {
	if (!midiMap.controller || midiMap.controller.state === 'idle') return;
	if (event.key === 'Delete' || event.key === 'Backspace') {
		const parameterID = parameterIDFromKeyEvent(event);
		if (parameterID && midiMappings?.get?.(parameterID)) {
			event.preventDefault();
			event.stopPropagation();
			midiMappings.requestClear(parameterID);
		}
		return;
	}
	if (event.key !== 'Escape') return;
	event.preventDefault();
	event.stopPropagation();
	cancelMIDIMap();
}

function bindInterfaceKeyboard(frame) {
	interfaceLoadHandler = () => {
		try {
			if (interfaceKeyWindow && interfaceKeyWindow !== frame.contentWindow)
				interfaceKeyWindow.removeEventListener('keydown', handleInterfaceKeyDown, true);
			interfaceKeyWindow = frame.contentWindow;
			interfaceKeyWindow?.addEventListener('keydown', handleInterfaceKeyDown, true);
		} catch {
			interfaceKeyWindow = null;
		}
	};
	frame.addEventListener('load', interfaceLoadHandler);
	interfaceLoadHandler();
}

function unbindInterfaceKeyboard(frame) {
	if (interfaceLoadHandler) frame?.removeEventListener('load', interfaceLoadHandler);
	interfaceKeyWindow?.removeEventListener('keydown', handleInterfaceKeyDown, true);
	interfaceKeyWindow = null;
	interfaceLoadHandler = null;
}

midiMapToggle.addEventListener('change', () => {
	if (!midiMap.controller) {
		midiMapToggle.pressed = false;
		return;
	}
	if (midiMapToggle.pressed) midiMap.controller.beginSelecting();
	else midiMap.controller.cancel('toolbar');
});

midiMap.addEventListener('midi-map-mode-change', event => {
	const active = event.detail?.active === true;
	midiMapToggle.pressed = active;
	document.body.toggleAttribute('data-midi-map-mode', active);
	if (active) midiDrawer.open = true;
});

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
		const control = document.createElement('compost-knob');
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
	updateHostControls(params.length !== 0, Boolean(interfaceFrame));
}

async function setupPresets(node) {
	presetPanel.hidden = true;
	presets = node.supportsPresetLoad ? await node.getPresets() : [];
	if (!presets.length) return;

	presetSelector.replaceChildren(...presets.map((preset, index) => {
		const option = document.createElement('option');
		option.value = String(index);
		option.textContent = preset.name;
		return option;
	}));
	presetPanel.hidden = false;
}

function formatNoteDialects(value) {
	const names = [];
	if (value & 1) names.push('CLAP');
	if (value & 2) names.push('MIDI');
	if (value & 4) names.push('MPE');
	if (value & 8) names.push('MIDI 2');
	return names.join(', ') || 'Unknown dialect';
}

function formatPorts(ports, notes = false) {
	if (!ports?.length) return 'None';
	return ports.map((port, index) => {
		const name = port.name || `Port ${index + 1}`;
		if (notes) return `${name} (${formatNoteDialects(Number(port.supportedDialects) || 0)})`;
		return `${name} (${port.channelCount ?? '?'} channels)`;
	}).join('; ');
}

function renderPluginInfo() {
	const descriptor = effectNode?.descriptor
		|| pluginCatalog.find(plugin => plugin.id === pluginId);
	if (!descriptor) {
		pluginInfo.replaceChildren();
		if (!pluginCatalog.length) pluginInfoPanel.hidden = true;
		pluginInfoToggle.hidden = true;
		pluginInfoToggle.setAttribute('aria-pressed', 'false');
		return;
	}

	document.title = descriptor.name || 'Compost';
	$('#plugin-name').textContent = descriptor.name || 'Compost';
	pluginInfoToggle.hidden = false;
	const infoVisible = !pluginInfoPanel.hidden;
	pluginInfoToggle.setAttribute('aria-pressed', String(infoVisible));
	pluginInfoToggle.setAttribute('aria-label', infoVisible
		? 'Hide plug-in information'
		: 'Show plug-in information');
	const capabilities = effectNode?.capabilities;
	const rows = [
		['Archive', archiveLabel],
		['Name', descriptor.name || 'Unnamed plug-in'],
		['Vendor', descriptor.vendor || 'Unknown'],
		['CLAP ID', descriptor.id || 'Unknown'],
		['Features', descriptor.features?.length ? descriptor.features.join(', ') : 'None'],
	];
	if (descriptor.description) rows.push(['Description', descriptor.description]);
	if (capabilities) {
		rows.push(
			['Audio inputs', formatPorts(capabilities.audioInputs)],
			['Audio outputs', formatPorts(capabilities.audioOutputs)],
			['MIDI inputs', formatPorts(capabilities.noteInputs, true)],
			['MIDI outputs', formatPorts(capabilities.noteOutputs, true)],
			['Parameters', String(parameterDefinitions.size)],
			['Presets', effectNode.supportsPresetLoad
				? (presets.length ? String(presets.length) : 'None')
				: 'Not supported'],
		);
	} else {
		rows.push(['Runtime details', 'Press Start audio to inspect ports, parameters, and presets']);
	}

	pluginInfo.replaceChildren();
	for (const [label, value] of rows) {
		const term = document.createElement('dt');
		term.textContent = label;
		const description = document.createElement('dd');
		description.textContent = value;
		pluginInfo.append(term, description);
	}
}

async function start(context) {
	const requestedGeneration = loadGeneration;
	const requestedWclap = wclap;
	setStatus('Loading WCLAP plug-in…');
	await pluginsReady;
	if (requestedGeneration !== loadGeneration || requestedWclap !== wclap) return;
	if (!pageProxyReady) throw new Error('This browser context does not support Service Workers.');
	const pageProxy = await pageProxyReady;
	const node = await requestedWclap.createNode(context, pluginId, {
		numberOfInputs: 1,
		numberOfOutputs: 1,
		outputChannelCount: [2],
	});
	if (requestedGeneration !== loadGeneration || requestedWclap !== wclap) {
		node.disconnect();
		return;
	}

	const hasAudioInput = (node.capabilities.audioInputs || []).length > 0;

	document.title = node.descriptor.name;
	$('#plugin-name').textContent = node.descriptor.name;
	effectControls.hidden = !hasAudioInput;
	effectNode = node;

	hostControlsToggle.onclick = () => {
		hostControlsVisible = !hostControlsVisible;
		updateHostControls(parameterDefinitions.size !== 0, Boolean(interfaceFrame));
	};

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
		mappingTarget(parameterID);
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
		bindInterfaceKeyboard(interfaceFrame);
		main.prepend(interfaceFrame);
	}
	setupMIDI(node);
	await setupParameters(node);
	await setupPresets(node);
	renderPluginInfo();
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

function unloadPlugin() {
	++loadGeneration;
	++parameterSetupGeneration;
	++parameterRefreshGeneration;
	clearInterval(performanceTimer);
	performanceTimer = null;
	clearTimeout(stateTimer);
	inputPlaying = false;
	audioElement.pause();
	audioSource?.disconnect();
	const previousNode = effectNode;
	effectNode = null;
	const pausePromise = previousNode?.pause?.();
	pausePromise?.catch(() => {});
	previousNode?.disconnect();
	const replacementAudioElement = audioElement.cloneNode();
	audioElement.replaceWith(replacementAudioElement);
	audioElement = replacementAudioElement;
	previousNode?.closeInterface?.();
	midiMappings?.cancelLearn?.();
	midiMap.mappings = null;
	midiMapToggle.pressed = false;
	midiMapToggle.hidden = true;
	clearTimeout(midiActivityTimeout);
	midiActivityLED.classList.remove('active');
	document.body.removeAttribute('data-midi-map-mode');
	midiMappingsSection.hidden = true;
	midiDrawer.open = false;
	midiDrawer.hidden = true;
	hostKeyboard.allNotesOff();
	hostKeyboard.hidden = true;
	document.body.removeAttribute('data-host-keyboard');
	unbindInterfaceKeyboard(interfaceFrame);
	interfaceFrame?.remove();
	interfaceFrame = null;
	audioSource = null;
	effectControls.hidden = true;
	midiSlot.replaceChildren();
	parameterPanel.hidden = true;
	parameters.replaceChildren();
	parameterControls.clear();
	parameterDefinitions.clear();
	hostControlsVisible = false;
	hostControlsToggle.hidden = true;
	hostControlsToggle.textContent = 'UI';
	hostControlsToggle.removeAttribute('aria-label');
	hostControlsToggle.setAttribute('aria-pressed', 'false');
	parameterFlags.clear();
	midiMappings = null;
	midiAvailable = false;
	syncMIDIDrawerLayout();
	presetPanel.hidden = true;
	presets = [];
	$('#cpu').textContent = '';
	$('#play-input').setAttribute('label', 'Play');
	renderPluginInfo();
}

function stop() {
	unloadPlugin();
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

function isWclapFile(file) {
	const name = file?.name?.toLowerCase() || '';
	return name.endsWith('.wclap')
		|| name.endsWith('.wclap.tar.gz')
		|| name.endsWith('.tar.gz')
		|| file?.type === 'application/gzip'
		|| file?.type === 'application/x-gzip';
}

async function loadWclapFile(file) {
	if (!file) return;
	if (!isWclapFile(file)) {
		showError(new Error('Drop a .wclap or .tar.gz archive.'));
		return;
	}

	const nextObjectUrl = URL.createObjectURL(file);
	const nextWclap = new ClapAudioNode({url: nextObjectUrl});
	const previousObjectUrl = archiveObjectUrl;
	const context = audioControl.getContext();
	const shouldStart = context?.state === 'running';
	let committed = false;
	archiveDrop.disabled = true;
	setStatus(`Loading ${file.name || 'WCLAP archive'}…`);

	try {
		const nextPlugins = await nextWclap.plugins();
		if (!nextPlugins.length) throw new Error('The WCLAP archive contains no plugins');

		++loadGeneration;
		archive = nextObjectUrl;
		archiveObjectUrl = nextObjectUrl;
		archiveLabel = file.name || 'WCLAP archive';
		wclap = nextWclap;
		globalThis.wclapModule = wclap;
		pluginId = nextPlugins[0].id;
		pluginsReady = Promise.resolve(nextPlugins);
		unloadPlugin();
		applyPluginCatalog(nextPlugins);
		committed = true;
		if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);

		if (shouldStart) {
			await start(context);
		} else {
			setStatus(`Loaded ${archiveLabel}. Press Start audio.`);
		}

	} catch (error) {
		if (!committed) URL.revokeObjectURL(nextObjectUrl);
		showError(error);
	} finally {
		archiveDrop.disabled = false;
	}
}

function showError(error) {
	console.error(error);
	setStatus(error?.message || String(error), true);
}

pluginsReady = setupPlugins(wclap).catch(error => {
	showError(error);
	throw error;
});

audioControl.addEventListener('audio-started', event => {
	if (!effectNode) start(event.detail.context).catch(showError);
});
audioControl.addEventListener('audio-state-change', event => {
	if (event.detail.state === 'suspended') hostKeyboard.allNotesOff();
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

pluginInfoToggle.addEventListener('click', () => {
	const visible = pluginInfoPanel.hidden;
	pluginInfoPanel.hidden = !visible;
	pluginInfoToggle.setAttribute('aria-pressed', String(visible));
	pluginInfoToggle.setAttribute('aria-label', visible
		? 'Hide plug-in information'
		: 'Show plug-in information');
});

archiveDrop.addEventListener('click', () => archiveFile.click());
archiveFile.addEventListener('change', () => {
	const file = archiveFile.files?.[0];
	archiveFile.value = '';
	void loadWclapFile(file);
});
archiveDrop.addEventListener('dragover', event => {
	event.preventDefault();
	event.stopPropagation();
	archiveDrop.setAttribute('data-dragover', '');
	if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
});
archiveDrop.addEventListener('dragleave', event => {
	event.preventDefault();
	event.stopPropagation();
	archiveDrop.removeAttribute('data-dragover');
});
archiveDrop.addEventListener('drop', event => {
	event.preventDefault();
	event.stopPropagation();
	archiveDrop.removeAttribute('data-dragover');
	void loadWclapFile(event.dataTransfer?.files?.[0]);
});

document.body.addEventListener('dragover', event => {
	event.preventDefault();
});
document.body.addEventListener('drop', event => {
	if (event.defaultPrevented) return;
	event.preventDefault();
	const file = event.dataTransfer?.files?.[0];
	if (isWclapFile(file)) void loadWclapFile(file);
	else loadAudioFile(file);
});

presetSelector.addEventListener('change', async event => {
	const preset = presets[Number(event.target.value)];
	if (!effectNode || !preset) return;
	if (!await effectNode.loadPreset(preset)) {
		throw new Error(`Could not load preset: ${preset.name}`);
	}
	await storeState();
});

window.addEventListener('unhandledrejection', event => showError(event.reason));
window.addEventListener('error', event => showError(event.error || event.message));

globalThis.wclapModule = wclap;
