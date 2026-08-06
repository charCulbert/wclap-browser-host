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

let audioSource;
let effectNode;
let interfaceFrame;
let inputPlaying = false;
let performanceTimer;
let stateTimer;
let objectUrl;
let presets = [];
let pluginId = query.get('plugin');

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
	const noteInputs = node.capabilities.noteInputs || [];
	const acceptsMIDI = noteInputs.some(port => (port.supportedDialects & 2) !== 0);
	if (!acceptsMIDI) return;

	const midi = document.createElement('compost-midi');
	midi.setAttribute('input-only', '');
	midi.addEventListener('midi-message', event => {
		node.sendMidi(event.detail.data, {
			timestamp: event.detail.timestamp ?? event.detail.receivedAt,
			port: 0,
		});
	});
	midiSlot.append(midi);
}

async function setupParameters(node) {
	parameters.replaceChildren();
	const params = await node.getParams();
	for (const param of params) {
		const control = document.createElement('compost-slider');
		control.setAttribute('label', param.name);
		control.setAttribute('parameter-id', String(param.id));
		control.setAttribute('min', String(param.min));
		control.setAttribute('max', String(param.max));
		control.setAttribute('step', param.flags?.stepped ? '1' : '0.000001');
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
	}
	parameterPanel.hidden = params.length === 0;
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
