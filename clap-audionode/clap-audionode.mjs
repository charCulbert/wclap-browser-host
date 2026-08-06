import {getHost, startHost, getWclap} from "./wclap-js/wclap.mjs";
import {hostImports, startThreadWorker} from "./host-imports.mjs";
import CBOR from "./cbor.mjs";
import {midiFrameFromTimestamp, SharedMidiEventQueue} from "./midi-event.mjs";

function decodeHostCbor(host, api, bytesPtr) {
	let cborPtr = api.getBytesData(bytesPtr);
	let cborLength = api.getBytesLength(bytesPtr);
	let bytes = new Uint8Array(host.hostMemory.buffer).slice(cborPtr, cborPtr + cborLength);
	return CBOR.decode(bytes);
}

export default class ClapAudioNode {
	#moduleAddedToAudioContext = Symbol();

	static #routingId = Symbol();
	static #timerSharedArrayBuffer;
	static #hostConfigPromise;
	static #warnedNoSharedMidi = false;
	#ready;
	#presetReady;
	
	constructor(wclapOptions) {
		if (typeof wclapOptions === 'string') wclapOptions = {url: wclapOptions};
		wclapOptions.url = new URL(wclapOptions.url, document.baseURI).href;

		// Load configs and start host/WCLAP
		if (!ClapAudioNode.#hostConfigPromise) {
			ClapAudioNode.#hostConfigPromise = getHost(new URL("./host.wasm", import.meta.url).href);
		}
		this.#ready = (async (hostConfigPromise, wclapConfigPromise) => {
			// We *could* have a common host across all WCLAP modules, but then we'd need to figure out when to de-register them
			let host = await startHost(await hostConfigPromise, hostImports());
			let wclapConfig = await wclapConfigPromise;
			let api = host.hostInstance.exports;
			return {
				host: host,
				api: api,
				bytesPtr: api.createBytes(),
				wclapConfig: wclapConfig,
				files: wclapConfig.files // TODO: we use this for `.getFiles()` but actually that should use the WASI VFS which these are loaded into
			};
		})(ClapAudioNode.#hostConfigPromise, getWclap(wclapOptions));
		
		// Optional timer thread to get more accurate CPU measurements
		if (globalThis.crossOriginIsolated && wclapOptions?.timerWorklet && !ClapAudioNode.#timerSharedArrayBuffer) {
			let workerJs = new Blob([`this.onmessage = e => {`,
				`console.log("CLAP AudioNode performance timer starting");`,
				`let dv = new DataView(e.data);`,
				`while (1) dv.setFloat64(0, performance.now());`,
			`};`], {type: 'application/javascript'});
			let worker = new Worker(URL.createObjectURL(workerJs), {name: "CLAP AudioNode performance timer"});
			let buffer = ClapAudioNode.#timerSharedArrayBuffer = new SharedArrayBuffer(8);
			new DataView(buffer).setFloat64(0, performance.now());
			worker.postMessage(buffer);
		}
	}
	
	async plugins() {
		let {host, api, wclapConfig, bytesPtr} = await this.#ready;
		// distinct copy - we're going to register and run it independently of the processor to inspect the plugin list
		wclapConfig = await getWclap(wclapConfig);

		let wclap = await host.startWclap(wclapConfig);
		let hostedPtr = api.makeHosted(wclap.ptr); // this specific host's wrapper around an `Instance *`
		if (!hostedPtr) throw Error("Failed to start WCLAP");

		let decodeCbor = _ => {
			let cborPtr = api.getBytesData(bytesPtr);
			let cborLength = api.getBytesLength(bytesPtr);

			// Have to copy because the TextDecoder doesn't like shared buffers
			let bytes = new Uint8Array(host.hostMemory.buffer).slice(cborPtr, cborPtr + cborLength);
			return CBOR.decode(bytes);
		};
		
		let info = decodeCbor(api.getInfo(hostedPtr, bytesPtr));
		api.removeHosted(hostedPtr);
		
		console.log(info);
		return info.plugins;
	}

	async #presetHost() {
		if (!this.#presetReady) {
			this.#presetReady = (async () => {
				let {host, api, wclapConfig} = await this.#ready;
				let presetConfig = await getWclap(wclapConfig);
				let wclap = await host.startWclap(presetConfig);
				let hostedPtr = api.makeHosted(wclap.ptr);
				if (!hostedPtr) throw Error("Failed to start WCLAP preset discovery");
				return {host, api, hostedPtr, bytesPtr: api.createBytes()};
			})();
		}
		return this.#presetReady;
	}

	async presetDiscovery() {
		let {host, api, hostedPtr, bytesPtr} = await this.#presetHost();
		api.getPresetDiscovery(hostedPtr, bytesPtr);
		return decodeHostCbor(host, api, bytesPtr);
	}

	async presetMetadata(providerId, locationKind, location = null) {
		let {host, api, hostedPtr, bytesPtr} = await this.#presetHost();
		let encoder = new TextEncoder();
		let providerBytes = encoder.encode(providerId);
		let locationBytes = encoder.encode(location || "");
		let bytes = new Uint8Array(providerBytes.length + locationBytes.length);
		bytes.set(providerBytes);
		bytes.set(locationBytes, providerBytes.length);
		let dataPtr = api.resizeBytes(bytesPtr, bytes.length);
		new Uint8Array(host.hostMemory.buffer, dataPtr, bytes.length).set(bytes);
		api.getPresetMetadata(hostedPtr, locationKind, bytesPtr, providerBytes.length);
		return decodeHostCbor(host, api, bytesPtr);
	}

	async getPresets(pluginId = null) {
		let providers = await this.presetDiscovery();
		let presets = [];
		for (let provider of providers) {
			for (let location of provider.locations) {
				// File-location crawling needs a browser/WASI filesystem index, and is deliberately separate.
				if (location.kind !== 1) continue;
				let result = await this.presetMetadata(provider.id, location.kind, location.location);
				if (!result.success) continue;
				result.presets.forEach(preset => {
					let applies = !pluginId || preset.pluginIds.length === 0
						|| preset.pluginIds.some(id => id.abi === "clap" && id.id === pluginId);
					if (applies) presets.push({
						providerID: provider.id,
						locationKind: location.kind,
						location: location.location,
						...preset
					});
				});
			}
		}
		return presets;
	}
	
	async createNode(audioContext, pluginId, nodeOptions) {
		if (!nodeOptions && typeof pluginId === 'object') { // optional argument
			nodeOptions = pluginId;
			pluginId = null;
		}
		nodeOptions = nodeOptions || {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [2],
		};

		// Add the AudioWorkletProcessor module
		if (!audioContext[this.#moduleAddedToAudioContext]) {
			let moduleUrl = new URL('./clap-audioworkletprocessor.mjs', import.meta.url);
			await audioContext.audioWorklet.addModule(moduleUrl);
		}
		audioContext[this.#moduleAddedToAudioContext] = true;

		let {host, wclapConfig} = await this.#ready;
		let sharedMidiAvailable = globalThis.crossOriginIsolated
			&& typeof SharedArrayBuffer === "function";
		let midiQueue = sharedMidiAvailable ? new SharedMidiEventQueue() : null;
		nodeOptions.processorOptions = {
			// These provide enough information for the processor to load the module and start the plugin
			host: host.initObj(),
			wclap: wclapConfig,
			pluginId: pluginId,
			midiQueueBuffer: midiQueue?.buffer
		};

		let effectNode = new AudioWorkletNode(audioContext, 'audioworkletprocessor-clap', nodeOptions);

		// Connect to timer worker, if running
		if (ClapAudioNode.#timerSharedArrayBuffer) {
			effectNode.port.postMessage(["timer-sharedArrayBuffer", ClapAudioNode.#timerSharedArrayBuffer]);
		}

		let responseMap = Object.create(null);
		let idCounter = 0;
		function addRemoteMethod(name) {
			effectNode[name] = (...args) => {
				let requestId = idCounter++;

				effectNode.port.postMessage([requestId, name, args]);

				return new Promise((pass, fail) => {
					responseMap[requestId] = {m_pass: pass, m_fail: fail};
				});
			};
		}

		effectNode.getFile = async path => {
			let files = (await this.#ready).files;
			return files[path.replace(/[?#].*/, '')];
		};

		// Hacky event-handling: add a named function to this map
		effectNode.events = Object.create(null);
		effectNode.events.preset_loaded = detail => effectNode.dispatchEvent(
			new CustomEvent("preset-loaded", {detail}));
		effectNode.events.preset_load_error = detail => effectNode.dispatchEvent(
			new CustomEvent("preset-load-error", {detail}));
		
		function handleWorkerMessage(data) {
			if (data?.[0] == 'thread-worker') return startThreadWorker(host, wclapConfig, data[1]);
			return false;
		}

		return new Promise(resolve => {
			effectNode.port.onmessage = e => {
				if (handleWorkerMessage(e.data)) return;
				let {routingId, desc, methods, webview, presetLoad, capabilities} = e.data;
				effectNode[ClapAudioNode.#routingId] = routingId;
				effectNode.descriptor = desc;
				effectNode.capabilities = capabilities || {
					audioInputs: [], audioOutputs: [], noteInputs: [], noteOutputs: []
				};
				effectNode.supportsPresetLoad = presetLoad;
				methods.forEach(addRemoteMethod);
				let loadPresetFromLocation = effectNode.loadPreset;
				effectNode.getPresets = () => this.getPresets(effectNode.descriptor.id);
				effectNode.loadPreset = preset => loadPresetFromLocation(
					preset.locationKind, preset.location, preset.loadKey);
				effectNode.midiTransport = midiQueue ? "shared-memory" : "message-port";
				let acceptsMidi = (effectNode.capabilities.noteInputs || [])
					.some(port => (port.supportedDialects & 2) !== 0);
				if (!midiQueue && acceptsMidi && !ClapAudioNode.#warnedNoSharedMidi) {
					let reason = globalThis.crossOriginIsolated
						? "this browser or context does not expose SharedArrayBuffer"
						: "cross-origin isolation is disabled; check COOP/COEP response headers";
					console.warn(
						`SharedArrayBuffer not available due to ${reason}, falling back to MessagePort for passing MIDI. `
						+ "Enable Cross-Origin-Opener-Policy: same-origin and "
						+ "Cross-Origin-Embedder-Policy: credentialless to use SharedArrayBuffer "
						+ "for better MIDI scheduling precision."
					);
					ClapAudioNode.#warnedNoSharedMidi = true;
				}
				effectNode.sendMidi = (data, options = {}) => {
					let timestamp = options.timestamp ?? performance.now();
					let targetFrame = midiFrameFromTimestamp(audioContext, timestamp);
					if (midiQueue) {
						let accepted = midiQueue.push(data, targetFrame, options.port ?? 0);
						if (!accepted) effectNode.dispatchEvent(new CustomEvent("midi-drop", {
							detail: {droppedCount: midiQueue.droppedCount}
						}));
						return accepted;
					}
					effectNode.port.postMessage(["midi", Array.from(data), targetFrame, options.port ?? 0]);
					return true;
				};
				effectNode.sendMIDI = (data, timestamp = performance.now(), port = 0) =>
					effectNode.sendMidi(data, {timestamp, port});
				let clearMidiInWorklet = effectNode.clearMidi;
				effectNode.clearMidi = () => {
					midiQueue?.clear();
					return clearMidiInWorklet();
				};
				effectNode.attachMidiInput = async (input, options = {}) => {
					if (!input) throw Error("A MIDIInput is required");
					if (audioContext.state !== "running") {
						throw Error("The AudioContext must be running before MIDI input is attached");
					}
					await input.open?.();
					if (input.connection && input.connection !== "open") {
						throw Error(`Could not open MIDI input: ${input.name || input.id}`);
					}
					let listener = event => effectNode.sendMidi(event.data, {
						timestamp: event.timeStamp || performance.now(),
						port: options.port ?? 0
					});
					input.addEventListener("midimessage", listener);
					return () => input.removeEventListener("midimessage", listener);
				};
				// For [dis]connectEvents, replace the other node with its ID
				effectNode.connectEvents = (prevMethod => otherNode => {
					if (otherNode[ClapAudioNode.#routingId] != null) {
						return prevMethod(otherNode[ClapAudioNode.#routingId]);
					}
				})(effectNode.connectEvents);
				effectNode.disconnectEvents = (prevMethod => nodeOrNull => {
					return prevMethod(nodeOrNull?.[ClapAudioNode.#routingId]);
				})(effectNode.disconnectEvents);

				let prevGetResource = effectNode.getResource;
				effectNode.getResource = async path => {
					let obj = await prevGetResource(path);
					if (!obj) return null;
					// Can't construct Blob in the AudioWorklet, so we translate it here
					return new Blob([obj.bytes], {type: obj.type});
				};

				let iframe = null;

				effectNode.port.onmessage = e => {
					if (handleWorkerMessage(e.data)) return;
					let data = e.data;
					if (data instanceof ArrayBuffer) {
						// it's a message from the plugin to the UI
						if (iframe) iframe.contentWindow.postMessage(data, '*');
						return;
					}
					if (typeof data[0] === 'string') {
						// it's an event - call a handler if there is one
						let handler = effectNode.events[data[0]];
						if (handler) {
							handler(data[1]);
						} else {
							console.error("unhandled event:", ...data);
						}
						return;
					}
					let response = responseMap[data[0]];
					if (data[1]) {
						response.m_fail(data[1]);
					} else {
						response.m_pass(data[2]);
					}
				};

				if (webview) {
					let messageHandler = e => {
						if (e.source === iframe?.contentWindow) {
							let data = e.data;
							if (!(data instanceof ArrayBuffer)) throw Error("messages must be ArrayBuffers");
							effectNode.port.postMessage(data);
						}
					};
					let visibilityHandler;
					effectNode.openInterface = (uiOptions) => {
						iframe = document.createElement('iframe');
						window.addEventListener('message', messageHandler);
						window.addEventListener('visibilitychange', visibilityHandler = () => {
							effectNode.webviewOpen(true, !document.hidden);
						});
						let src = webview;
						if (/^file:/.test(src) && uiOptions?.filePrefix) {
							src = uiOptions.filePrefix + webview.replace(/^file:\/*/, '/');
						} else if (src[0] == "/" && uiOptions?.resourcePrefix) {
							src = uiOptions.resourcePrefix + webview;
						}
						iframe.src = new URL(src, document.baseURI);
						effectNode.webviewOpen(true, !document.hidden);
						return iframe;
					};
					effectNode.closeInterface = () => {
						effectNode.webviewOpen(false);
						if (iframe) {
							window.removeEventListener('message', messageHandler);
							window.removeEventListener('visibilitychange', visibilityHandler);
						}
						iframe = null;
					}
				}

				let prevConnect = effectNode.connect;
				effectNode.connect = function() {
					effectNode.resume();
					prevConnect.apply(this, arguments);
				};

				resolve(effectNode);
			};
		});
	}
}
