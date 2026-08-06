import ClapAudioNode from './clap-audionode/clap-audionode.mjs';
import './compost/components/compost-audio.js';
import './compost/components/compost-button.js';
import './compost/components/compost-midi.js';
import './compost/components/compost-radio-group.js';
import './compost/components/compost-slider.js';

const $ = document.querySelector.bind(document);
const query = new URLSearchParams(location.search);
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
const parameterPanel = $('#parameter-panel');
const parameters = $('#parameters');
const pluginPanel = $('#plugin-panel');
const pluginSelector = $('#plugins');
const presetPanel = $('#preset-panel');
const presetSelector = $('#presets');
const status = $('#status');
const mappingPanel = $('#mapping-panel');
const mappingControls = $('#mapping-controls');

const CLAP_PARAM_IS_STEPPED = 1 << 0;
const CLAP_PARAM_IS_READONLY = 1 << 3;
const CLAP_PARAM_IS_AUTOMATABLE = 1 << 5;

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
let midiAvailable = false;
let midiLearnTarget = null;

function setStatus(message, isError = false) {
	status.textContent = message;
	status.toggleAttribute('data-error', isError);
	status.hidden = !message;
}

function stateFromUrl() {
	const encoded = new URLSearchParams(location.search).get('state');
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
	const nextQuery = new URLSearchParams(location.search);
	nextQuery.set('state', state);
	history.replaceState(null, '', `?${nextQuery}`);
}

function openPluginInterface(node, pageProxy) {
	const frameId = `plugin-ui-${crypto.randomUUID()}`;
	const frame = node.openInterface({
		filePrefix: `${pageProxy.prefix}${frameId}/file`,
		resourcePrefix: `${pageProxy.prefix}${frameId}/get_resource`,
	});
	frame.id = frameId;
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

function setupMIDI(node) {
	midiSlot.replaceChildren();
	midiAvailable = false;
	midiLearnTarget = null;
	const noteInputs = node.capabilities.noteInputs || [];
	const acceptsMIDI = noteInputs.some(port => (port.supportedDialects & 2) !== 0);
	if (!acceptsMIDI) return;
	midiAvailable = true;

	const midi = document.createElement('compost-midi');
	midi.setAttribute('input-only', '');
	midi.addEventListener('midi-message', event => {
		const data = event.detail.data;
		const learnTarget = midiLearnTarget;
		if (learnTarget && data.length === 3 && (data[0] & 0xf0) === 0xb0) {
			midiLearnTarget = null;
			learnTarget.learn.textContent = 'Learn';
			learnTarget.status.textContent = `Mapping CC ${data[1]}…`;
			node.setMidiCCMapping({
				channel: data[0] & 0x0f,
				cc: data[1],
				paramId: learnTarget.param.id,
				min: learnTarget.param.min,
				max: learnTarget.param.max,
				flags: learnTarget.flags,
			}).then(() => {
				learnTarget.channel.value = String(data[0] & 0x0f);
				learnTarget.cc.value = String(data[1]);
				learnTarget.status.textContent = `CC ${data[1]}, channel ${(data[0] & 0x0f) + 1}`;
			}).catch(showError);
		}
		node.sendMidi(event.detail.data, {
			timestamp: event.detail.timestamp ?? event.detail.receivedAt,
			port: 0,
		});
	});
	midiSlot.append(midi);
}

function createMappingRow(node, param) {
	const flags = Number(param.flags) || 0;
	const row = document.createElement('div');
	row.className = 'mapping-row';

	const label = document.createElement('strong');
	label.textContent = param.name;

	const channel = document.createElement('select');
	channel.setAttribute('aria-label', `${param.name} MIDI channel`);
	channel.append(new Option('Omni', '-1'));
	for (let index = 0; index < 16; ++index) {
		channel.append(new Option(`Ch ${index + 1}`, String(index)));
	}

	const cc = document.createElement('input');
	cc.type = 'number';
	cc.min = '0';
	cc.max = '127';
	cc.step = '1';
	cc.value = '1';
	cc.setAttribute('aria-label', `${param.name} MIDI CC`);

	const learn = document.createElement('button');
	learn.type = 'button';
	learn.textContent = 'Learn';
	learn.setAttribute('aria-label', `Learn MIDI CC for ${param.name}`);

	const map = document.createElement('button');
	map.type = 'button';
	map.textContent = 'Map';
	map.setAttribute('aria-label', `Map MIDI CC for ${param.name}`);

	const clear = document.createElement('button');
	clear.type = 'button';
	clear.textContent = 'Clear';
	clear.setAttribute('aria-label', `Clear MIDI CC for ${param.name}`);

	const status = document.createElement('span');
	status.className = 'mapping-status';
	status.textContent = 'No mapping';

	const target = {param, flags, channel, cc, learn, status};
	learn.addEventListener('click', () => {
		if (midiLearnTarget) {
			midiLearnTarget.learn.textContent = 'Learn';
			midiLearnTarget.status.textContent = 'No mapping';
		}
		midiLearnTarget = target;
		learn.textContent = 'Waiting…';
		status.textContent = 'Move a MIDI CC';
	});
	map.addEventListener('click', async () => {
		try {
			await node.setMidiCCMapping({
				channel: Number(channel.value),
				cc: Number(cc.value),
				paramId: param.id,
				min: param.min,
				max: param.max,
				flags,
			});
			status.textContent = `CC ${cc.value}, ${channel.value === '-1' ? 'omni' : `channel ${Number(channel.value) + 1}`}`;
		} catch (error) {
			showError(error);
		}
	});
	clear.addEventListener('click', async () => {
		try {
			await node.clearMidiCCMapping({channel: Number(channel.value), cc: Number(cc.value)});
			status.textContent = 'No mapping';
		} catch (error) {
			showError(error);
		}
	});

	row.append(label, channel, cc, learn, map, clear, status);
	return row;
}

function setupMappings(node, params) {
	mappingControls.replaceChildren();
	const mappable = midiAvailable ? params.filter(param => {
		const flags = Number(param.flags) || 0;
		return (flags & CLAP_PARAM_IS_AUTOMATABLE) !== 0
			&& (flags & CLAP_PARAM_IS_READONLY) === 0;
	}) : [];
	for (const param of mappable) mappingControls.append(createMappingRow(node, param));
	mappingPanel.hidden = mappable.length === 0;
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

async function setupParameters(node) {
	parameters.replaceChildren();
	parameterControls.clear();
	const params = await node.getParams();
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
	setupMappings(node, params);
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
	node.events.params_rescan = () => setupParameters(node).catch(showError);
	node.events['mapped-param-values'] = handleMappedValues;

	const savedState = stateFromUrl();
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
	interfaceFrame?.remove();
	interfaceFrame = null;
	effectNode = null;
	audioSource = null;
	midiSlot.replaceChildren();
	parameterPanel.hidden = true;
	parameters.replaceChildren();
	mappingPanel.hidden = true;
	mappingControls.replaceChildren();
	parameterControls.clear();
	midiLearnTarget = null;
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

$('#copy-state').addEventListener('button-trigger', async () => {
	await storeState();
	await navigator.clipboard.writeText(location.href);
});

$('#reset-state').addEventListener('button-trigger', () => {
	const nextQuery = new URLSearchParams(location.search);
	nextQuery.delete('state');
	location.href = `${location.pathname}${nextQuery.toString() ? `?${nextQuery}` : ''}`;
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
