import {getHost, startHost, getWclap} from "./wclap-js/wclap.mjs";
import {hostImports} from "./host-imports.mjs";
import CBOR from "./cbor.mjs";
import {parameterValueForMidiCC, SharedMidiEventQueue} from "./midi-event.mjs";

const midiMappingChannelCount = 16;
const midiMappingCCCount = 128;
const invalidParamId = 0xffffffff;
const initialMappedValueReportCapacity = 16;
const clapCoreEventSpace = 0;
const clapEventParamGestureBegin = 7;

// For debugging, we sometimes import this module into the main page, and makes that work
export default null;
if (!globalThis.AudioWorkletProcessor) globalThis.AudioWorkletProcessor = globalThis.registerProcessor = function(){}

if (!globalThis.clapRouting) {
	// Map from instance ID -> `{events: [...]}`
	globalThis.clapRouting = Object.create(null);
}

let now = (typeof performance === 'object') ? performance.now.bind(performance) : Date.now.bind(Date);
let cpuAveragePeriod = (typeof performance === 'object') ? 50 : 10000; // 150ms or 30s @ 44.1kHz
function setTimerSharedArrayBuffer(sharedArrayBuffer) {
	// We have a timer thread which is just spinning, putting performance.now() into shared memory
	let dv = new DataView(sharedArrayBuffer);
	now = _ => dv.getFloat32(0);
	cpuAveragePeriod = 50;
}

class ClapAudioWorkletProcessor extends AudioWorkletProcessor {
	inputChannelCounts = [];
	outputChannelCounts = [];
	maxFramesCount = 128;

	// Could be global
	host;
	hostApi;
	
	// Could be shared amongst all plugins from the same module
	hostedWclapPtr; // The specific WCLAP model (created from an `Instance *` in C++)
	hostedBytes; // Bytes which we can use to send/receive bigger values
	instanceMemory; // We read/write sample data directly, to avoid copying in/out of the host
	instanceAudioPointers; // pointers to read/write audio in the Instance memory
	instanceSingleThreaded = true;
	instancePluginMap = {};
	midiQueue = null;
	midiEventCapacity = 2048;
	midiEventCount = 0;
	midiTargetFrames = new Float64Array(this.midiEventCapacity);
	midiSequences = new Uint32Array(this.midiEventCapacity);
	midiPorts = new Uint16Array(this.midiEventCapacity);
	midiLengths = new Uint8Array(this.midiEventCapacity);
	midiData = new Uint8Array(this.midiEventCapacity*3);
	midiFallbackSequence = 0;
	midiBytes = new Uint8Array(24);
	midiBytesView = new DataView(this.midiBytes.buffer);

	// Buckets are read from the render path. Mapping updates arrive through the
	// control port and become active on the following render quantum. A bucket
	// can contain any number of parameter targets; each record carries its own
	// activation/removal frame so queued MIDI stays sample-accurate.
	midiMappingBuckets = Array.from({length: midiMappingChannelCount*midiMappingCCCount}, () => []);
	omniMidiMappingBuckets = Array.from({length: midiMappingCCCount}, () => []);
	mappedValueReportCount = 0;
	mappedValueReportCapacity = initialMappedValueReportCapacity;
	mappedValueReportParamIds = new Uint32Array(initialMappedValueReportCapacity);
	mappedValueReportValues = new Float64Array(initialMappedValueReportCapacity);
	mappedValueReportBuffer = new ArrayBuffer(4 + initialMappedValueReportCapacity*12);
	mappedValueReportView = new DataView(this.mappedValueReportBuffer);
	mappedValueReportNextFrame = 0;

	// specific to this module
	pluginPtr;
	
	ready = false;
	readyPromise = null;
	running = true;
	routingId;
	static #cleanup = new FinalizationRegistry(routingId => {
		delete globalThis.clapRouting[routingId];
	});

	decodeCbor() {
		let cborPtr = this.hostApi.getBytesData(this.hostedBytes);
		let cborLength = this.hostApi.getBytesLength(this.hostedBytes);
		// Have to copy because the TextDecoder doesn't like shared buffers
		let bytes = new Uint8Array(this.host.hostMemory.buffer).slice(cborPtr, cborPtr + cborLength);
		return CBOR.decode(bytes);
	}
	encodeString(str) {
		let bytes = new Uint8Array(str.length);
		for (let i = 0; i < str.length; ++i) bytes[i] = str.charCodeAt(i);
		return this.sendBytes(bytes);
	}
	sendBytes(bytes, returnCbor) {
		let bufferPtr = this.hostApi.resizeBytes(this.hostedBytes, bytes.length);
		let array = new Uint8Array(this.host.hostMemory.buffer).subarray(bufferPtr, bufferPtr + bytes.length);
		array.set(bytes);
		return this.hostedBytes;
	}
	getBytes(bytes, returnCbor) {
		let cborPtr = this.hostApi.getBytesData(this.hostedBytes);
		let cborLength = this.hostApi.getBytesLength(this.hostedBytes);
		return new Uint8Array(this.host.hostMemory.buffer).slice(cborPtr, cborPtr + cborLength);
	}
	
	constructor(options) {
		super();
		this.port.onmessageerror = e => {
			console.error(e);
			debugger;
		};
		let readyFn = null;
		this.readyPromise = new Promise(pass => (readyFn = pass));

		(async init => {
			if (init.midiQueueBuffer) {
				this.midiQueue = new SharedMidiEventQueue(init.midiQueueBuffer);
				this.acceptSharedMidiEvent = this.acceptSharedMidiEvent.bind(this);
			}
			// Create one Host for every AudioNode (for now) - could be global in future
			let imports = hostImports();
			Object.assign(imports.env, {
				webviewSend: (pluginPtr, ptr, length) => {
					let processor = this.instancePluginMap[pluginPtr];
					let bytes = new Uint8Array(this.instanceMemory.buffer, ptr, length).slice();
					processor.webviewSend(bytes);
				},
				eventsOutTryPush: (pluginPtr, ptr, length) => {
					let processor = this.instancePluginMap[pluginPtr];
					let bytes = new Uint8Array(this.instanceMemory.buffer, ptr, length).slice();
					processor.outputEvent(bytes);
					return 1;
				},
				stateMarkDirty: (pluginPtr) => {
					let processor = this.instancePluginMap[pluginPtr];
					processor.port.postMessage(['state_mark_dirty', null]);
				},
				paramsRescan: (pluginPtr, flags) => {
					let processor = this.instancePluginMap[pluginPtr];
					processor.port.postMessage(['params_rescan', flags]);
				},
				guiResizeHintsChanged: pluginPtr => {
					let processor = this.instancePluginMap[pluginPtr];
					processor.port.postMessage(['gui_resize_hints_changed', null]);
				},
				guiRequestResize: (pluginPtr, width, height) => {
					let processor = this.instancePluginMap[pluginPtr];
					processor.port.postMessage(['gui_request_resize', {width, height}]);
					return true;
				},
				presetLoadError: (pluginPtr, locationKind, locationPtr, locationLength,
					loadKeyPtr, loadKeyLength, osError, messagePtr, messageLength) => {
					let processor = this.instancePluginMap[pluginPtr];
					let decoder = new TextDecoder();
					let memory = this.instanceMemory.buffer;
					let read = (ptr, length) => length
						? decoder.decode(new Uint8Array(memory, ptr, length))
						: null;
					processor.port.postMessage(['preset_load_error', {
						locationKind,
						location: read(locationPtr, locationLength),
						loadKey: read(loadKeyPtr, loadKeyLength),
						osError,
						message: read(messagePtr, messageLength)
					}]);
				},
				presetLoaded: (pluginPtr, locationKind, locationPtr, locationLength,
					loadKeyPtr, loadKeyLength) => {
					let processor = this.instancePluginMap[pluginPtr];
					let decoder = new TextDecoder();
					let memory = this.instanceMemory.buffer;
					let read = (ptr, length) => length
						? decoder.decode(new Uint8Array(memory, ptr, length))
						: null;
					processor.port.postMessage(['preset_loaded', {
						locationKind,
						location: read(locationPtr, locationLength),
						loadKey: read(loadKeyPtr, loadKeyLength)
					}]);
				},
				log: (pluginPtr, severity, msgPtr, length) => {
					let processor = this.instancePluginMap[pluginPtr];
					let bytes = new Uint8Array(this.instanceMemory.buffer, msgPtr, length);
					let logStr = "";
					for (let i = 0; i < length; ++i) logStr += String.fromCharCode(bytes[i]);
					if (severity >= 2) {
						console.error(logStr);
					} else {
						console.log(logStr);
					}
				}
			});
			
			this.host = await startHost(init.host, imports);
			let hostApi = this.hostApi = this.host.hostInstance.exports;
			
			// This particular WASM module
			let wclapInstance = await this.host.startWclap(init.wclap, (host, threadData) => {
				// our AudioNode knows which WCLAP this is for
				this.port.postMessage(["thread-worker", threadData]);
				return true;
			});
			// Register only if needed
			this.hostedWclapPtr = init.hostedPtr ?? hostApi.makeHosted(wclapInstance.ptr);
			if (!this.hostedWclapPtr) {
				throw this.fatalError = Error("Failed to create WCLAP");
			}
			this.hostedBytes = hostApi.createBytes(); // TODO: remove this along with destroying the plugin instance

			this.instanceMemory = wclapInstance.memory;

			let pluginId = init.pluginId;
			if (!pluginId) {
				let pluginIndex = init.pluginIndex || 0;
				let moduleInfo = this.decodeCbor(hostApi.getInfo(this.hostedWclapPtr, this.hostedBytes));
				pluginId = moduleInfo.plugins[pluginIndex].id;
			}

			// Manage the event-routing entry
			this.routingId = pluginId + "/" + Math.random().toString(16).substr(2);
			globalThis.clapRouting[this.routingId] = {
				events: []
			};
			ClapAudioWorkletProcessor.#cleanup.register(this, this.routingId);
			
			this.pluginPtr = hostApi.createPlugin(this.hostedWclapPtr, this.encodeString(pluginId));
			if (!this.pluginPtr) {
				throw this.fatalError = Error("Failed to create plugin: " + pluginId);
			}
			this.instancePluginMap[this.pluginPtr] = this; // this would be removed whenever we call `hostApi.destroyPlugin()` later
			// CLAP requires a positive minimum frame count. AudioWorklet may deliver
			// smaller blocks than maxFramesCount, so advertise the conservative range
			// [1, maxFramesCount].
			this.instanceAudioPointers = this.decodeCbor(hostApi.pluginStart(this.pluginPtr, globalThis.sampleRate, 1, this.maxFramesCount, this.hostedBytes));
			if (!this.instanceAudioPointers) {
				throw this.fatalError = Error("Failed to start plugin: " + pluginId);
			}
			this.ready = true;
			readyFn();

			// initial message lists plugin descriptor and remote methods
			let pluginInfo = this.decodeCbor(hostApi.pluginGetInfo(this.pluginPtr, this.hostedBytes));
			this.port.postMessage(Object.assign(pluginInfo, {
				routingId: this.routingId,
				methods: Object.keys(this.remoteMethods),
			}));

			// subsequent messages are either proxied method calls, or ArrayBuffer messages from the webview
			this.port.onmessage = async event => {
				let data = event.data;
				if (data?.[0] == "midi") {
					let bytes = data[1];
					this.addPendingMidiEvent(data[2], this.midiFallbackSequence++, data[3],
						bytes.length, bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0);
					return;
				}
				if (data instanceof ArrayBuffer) {
					let bytes = new Uint8Array(data);
					hostApi.pluginMessage(this.pluginPtr, this.sendBytes(bytes));
					return;
				}
				let [requestId, method, args] = data;
				if (this.fatalError) return this.port.postMessage([requestId, this.fatalError]);
				if (requestId == 'timer-sharedArrayBuffer') {
					return setTimerSharedArrayBuffer(method);
				}
				
				if (!this.ready) await this.readyPromise;

				try {
					let result = await this.remoteMethods[method].call(this, ...args);
					this.port.postMessage([requestId, null, result]);
					if (this.instanceSingleThreaded) this.mainThreadCallback();
				} catch (e) {
					this.failWithError(e);
					this.port.postMessage([requestId, e]);
				}
			};
		})(options.processorOptions).catch(e => this.failWithError(e));
	}

	fatalError = null;
	failWithError(e) {
		debugger;
		console.error(e);
		this.fatalError = e;
		throw e;
	}

	mainThreadCallback() {
		this.hostApi.pluginMainThread(this.pluginPtr);
	}
	
	// Hands input events to the plugin, and clears the list
	writePendingEvents() {
		globalThis.clapRouting[this.routingId].events.forEach(bytes => {
			this.hostApi.pluginAcceptEvent(this.pluginPtr, this.sendBytes(bytes));
		});
		globalThis.clapRouting[this.routingId].events = [];
	}
	acceptSharedMidiEvent(targetFrame, sequence, port, length, byte0, byte1, byte2) {
		return this.addPendingMidiEvent(targetFrame, sequence, port, length, byte0, byte1, byte2);
	}
	addPendingMidiEvent(targetFrame, sequence, port, length, byte0, byte1, byte2) {
		if (this.midiEventCount >= this.midiEventCapacity) return false;
		let insertIndex = this.midiEventCount;
		while (insertIndex > 0) {
			let previous = insertIndex - 1;
			if (this.midiTargetFrames[previous] < targetFrame
				|| (this.midiTargetFrames[previous] === targetFrame
					&& this.midiSequences[previous] <= sequence)) break;
			this.copyMidiEvent(previous, insertIndex);
			insertIndex = previous;
		}
		this.midiTargetFrames[insertIndex] = targetFrame;
		this.midiSequences[insertIndex] = sequence;
		this.midiPorts[insertIndex] = port;
		this.midiLengths[insertIndex] = length;
		this.midiData[insertIndex*3] = byte0;
		this.midiData[insertIndex*3 + 1] = byte1;
		this.midiData[insertIndex*3 + 2] = byte2;
		++this.midiEventCount;
		return true;
	}
	copyMidiEvent(from, to) {
		this.midiTargetFrames[to] = this.midiTargetFrames[from];
		this.midiSequences[to] = this.midiSequences[from];
		this.midiPorts[to] = this.midiPorts[from];
		this.midiLengths[to] = this.midiLengths[from];
		this.midiData[to*3] = this.midiData[from*3];
		this.midiData[to*3 + 1] = this.midiData[from*3 + 1];
		this.midiData[to*3 + 2] = this.midiData[from*3 + 2];
	}
	midiMappingEffectiveFrame() {
		let currentFrame = Number(globalThis.currentFrame);
		return (Number.isFinite(currentFrame) ? currentFrame : 0) + this.maxFramesCount;
	}
	pruneMappingBuckets(buckets, currentFrame) {
		for (let bucket of buckets) {
			let writeIndex = 0;
			for (let record of bucket) {
				if (record.removedFrame > currentFrame) bucket[writeIndex++] = record;
			}
			bucket.length = writeIndex;
		}
	}
	pruneMidiMappings(currentFrame) {
		this.pruneMappingBuckets(this.midiMappingBuckets, currentFrame);
		this.pruneMappingBuckets(this.omniMidiMappingBuckets, currentFrame);
	}
	removeParameterMappings(paramId, removedFrame) {
		const removeFrom = buckets => {
			for (let bucket of buckets) {
				for (let record of bucket) {
					if (record.paramId === paramId && record.removedFrame > removedFrame)
						record.removedFrame = removedFrame;
				}
			}
		};
		removeFrom(this.midiMappingBuckets);
		removeFrom(this.omniMidiMappingBuckets);
	}
	mappingRecordCount() {
		let count = 0;
		for (let bucket of this.midiMappingBuckets) count += bucket.length;
		for (let bucket of this.omniMidiMappingBuckets) count += bucket.length;
		return count;
	}
	ensureMappedValueReportCapacity(required) {
		if (required <= this.mappedValueReportCapacity) return;
		let capacity = this.mappedValueReportCapacity;
		while (capacity < required) capacity *= 2;

		const paramIds = new Uint32Array(capacity);
		paramIds.set(this.mappedValueReportParamIds);
		const values = new Float64Array(capacity);
		values.set(this.mappedValueReportValues);
		this.mappedValueReportCapacity = capacity;
		this.mappedValueReportParamIds = paramIds;
		this.mappedValueReportValues = values;
		this.mappedValueReportBuffer = new ArrayBuffer(4 + capacity*12);
		this.mappedValueReportView = new DataView(this.mappedValueReportBuffer);
	}
	setMidiCCMapping(mapping = {}) {
		let channel = Number.isInteger(mapping.channel) ? mapping.channel : -1;
		let cc = Number(mapping.cc);
		let paramId = Number(mapping.paramId);
		let min = Number(mapping.min);
		let max = Number(mapping.max);
		if ((channel !== -1 && (channel < 0 || channel >= midiMappingChannelCount))
			|| !Number.isInteger(cc) || cc < 0 || cc >= midiMappingCCCount
			|| !Number.isInteger(paramId) || paramId < 0 || paramId >= invalidParamId
			|| !Number.isFinite(min) || !Number.isFinite(max) || max < min) {
			throw new RangeError("Invalid MIDI CC mapping");
		}

		let flags = Number.isInteger(mapping.flags) ? mapping.flags >>> 0 : 0;
		let effectiveFrame = this.midiMappingEffectiveFrame();
		const currentFrame = Number(globalThis.currentFrame);
		this.pruneMidiMappings(Number.isFinite(currentFrame) ? currentFrame : 0);
		this.removeParameterMappings(paramId, effectiveFrame);
		const bucket = channel === -1
			? this.omniMidiMappingBuckets[cc]
			: this.midiMappingBuckets[channel*midiMappingCCCount + cc];
		bucket.push({paramId, min, max, flags, effectiveFrame, removedFrame: Infinity});
		this.ensureMappedValueReportCapacity(this.mappingRecordCount());
		return {effectiveFrame};
	}
	clearMidiCCMapping(mapping = {}) {
		let channel = Number.isInteger(mapping.channel) ? mapping.channel : -1;
		let cc = Number(mapping.cc);
		if ((channel !== -1 && (channel < 0 || channel >= midiMappingChannelCount))
			|| !Number.isInteger(cc) || cc < 0 || cc >= midiMappingCCCount) {
			throw new RangeError("Invalid MIDI CC mapping");
		}

		let effectiveFrame = this.midiMappingEffectiveFrame();
		const currentFrame = Number(globalThis.currentFrame);
		this.pruneMidiMappings(Number.isFinite(currentFrame) ? currentFrame : 0);
		const bucket = channel === -1
			? this.omniMidiMappingBuckets[cc]
			: this.midiMappingBuckets[channel*midiMappingCCCount + cc];
		const paramId = Number(mapping.paramId);
		for (let record of bucket) {
			if (!Number.isInteger(paramId) || paramId < 0 || record.paramId === paramId)
				record.removedFrame = Math.min(record.removedFrame, effectiveFrame);
		}
		return {effectiveFrame};
	}
	applyMidiMappings(bucket, ccValue, targetFrame, time) {
		for (let mapping of bucket) {
			if (targetFrame < mapping.effectiveFrame || targetFrame >= mapping.removedFrame) continue;
			let value = parameterValueForMidiCC(ccValue, mapping.min, mapping.max, mapping.flags);
			this.hostApi.pluginSetParamAtTime(this.pluginPtr, mapping.paramId, value, time);
			this.recordMappedValue(mapping.paramId, value);
		}
	}
	recordMappedValue(paramId, value) {
		for (let index = 0; index < this.mappedValueReportCount; ++index) {
			if (this.mappedValueReportParamIds[index] === paramId) {
				this.mappedValueReportValues[index] = value;
				return;
			}
		}
		if (this.mappedValueReportCount >= this.mappedValueReportCapacity) return;
		let index = this.mappedValueReportCount++;
		this.mappedValueReportParamIds[index] = paramId;
		this.mappedValueReportValues[index] = value;
	}
	postMappedValues() {
		let currentFrame = Number(globalThis.currentFrame);
		if (!this.mappedValueReportCount || !Number.isFinite(currentFrame)
			|| currentFrame < this.mappedValueReportNextFrame) return;

		this.mappedValueReportView.setUint32(0, this.mappedValueReportCount, true);
		for (let index = 0; index < this.mappedValueReportCount; ++index) {
			let offset = 4 + index*12;
			this.mappedValueReportView.setUint32(offset, this.mappedValueReportParamIds[index], true);
			this.mappedValueReportView.setFloat64(offset + 4, this.mappedValueReportValues[index], true);
		}
		this.port.postMessage(["mapped-param-values", this.mappedValueReportBuffer]);
		this.mappedValueReportCount = 0;
		this.mappedValueReportNextFrame = currentFrame + sampleRate*0.05;
	}
	writePendingMidiEvents(blockLength) {
		this.midiQueue?.drain(this.acceptSharedMidiEvent);
		let blockStart = globalThis.currentFrame;
		let blockEnd = blockStart + blockLength;
		let dueCount = 0;
		while (dueCount < this.midiEventCount && this.midiTargetFrames[dueCount] < blockEnd) {
			let targetFrame = this.midiTargetFrames[dueCount];
			let time = Math.min(blockLength - 1,
				Math.max(0, Math.round(targetFrame - blockStart)));
			this.midiBytes.fill(0);
			this.midiBytesView.setUint32(0, this.midiBytes.length, true);
			this.midiBytesView.setUint32(4, time, true);
			this.midiBytesView.setUint16(10, 10, true); // CLAP_EVENT_MIDI
			this.midiBytesView.setUint32(12, 1, true); // CLAP_EVENT_IS_LIVE
			this.midiBytesView.setUint16(16, this.midiPorts[dueCount], true);
			let status = this.midiData[dueCount*3];
			let cc = this.midiData[dueCount*3 + 1];
			let ccValue = this.midiData[dueCount*3 + 2];
			this.midiBytes[18] = status;
			this.midiBytes[19] = this.midiData[dueCount*3 + 1];
			this.midiBytes[20] = this.midiData[dueCount*3 + 2];
			this.hostApi.pluginAcceptEvent(this.pluginPtr, this.sendBytes(this.midiBytes));

			if (this.midiLengths[dueCount] === 3 && (status & 0xf0) === 0xb0
				&& cc < midiMappingCCCount && ccValue < midiMappingCCCount) {
				let channel = status & 0x0f;
				this.applyMidiMappings(
					this.midiMappingBuckets[channel*midiMappingCCCount + cc],
					ccValue, targetFrame, time);
				this.applyMidiMappings(this.omniMidiMappingBuckets[cc], ccValue, targetFrame, time);
			}
			++dueCount;
		}
		for (let index = dueCount; index < this.midiEventCount; ++index) {
			this.copyMidiEvent(index, index - dueCount);
		}
		this.midiEventCount -= dueCount;
	}
	
	eventTargets = {};
	outputEvent(eventBytes) {
		if (eventBytes.length >= 20
			&& eventBytes[8] === clapCoreEventSpace
			&& eventBytes[9] === 0
			&& eventBytes[10] === clapEventParamGestureBegin
			&& eventBytes[11] === 0) {
			const paramId = (eventBytes[16]
				| (eventBytes[17] << 8)
				| (eventBytes[18] << 16)
				| (eventBytes[19] << 24)) >>> 0;
			this.port.postMessage(['param_gesture_begin', paramId]);
		}

		for (let key in this.eventTargets) {
			if (globalThis.clapRouting[key]) {
				globalThis.clapRouting[key].events.push(eventBytes);
			}
		}
	}

	webviewSend(messageBytes) {
		this.port.postMessage(messageBytes.buffer);
	}

	remoteMethods = {
		pause() {
			this.running = false;
		},
		resume() {
			this.running = true;
		},
		connectEvents(otherId) {
			this.eventTargets[otherId] = true;
		},
		disconnectEvents(otherId) {
			if (otherId == null) {
				this.eventTargets = {};
			}
		},
		saveState() {
			// TODO: transfer ownership, to avoid allocation/GC from this
			if (!this.hostApi.pluginSaveState(this.pluginPtr, this.hostedBytes)) {
				return null;
			}
			return this.getBytes();
		},
		loadState(stateArray) {
			let bytes = new Uint8Array(stateArray);
			return this.hostApi.pluginLoadState(this.pluginPtr, this.sendBytes(bytes));
		},
		loadPreset(locationKind, location, loadKey) {
			let encoder = new TextEncoder();
			let locationBytes = encoder.encode(location || "");
			let loadKeyBytes = encoder.encode(loadKey || "");
			let bytes = new Uint8Array(locationBytes.length + loadKeyBytes.length);
			bytes.set(locationBytes);
			bytes.set(loadKeyBytes, locationBytes.length);
			return this.hostApi.pluginLoadPreset(this.pluginPtr, locationKind,
				this.sendBytes(bytes), locationBytes.length);
		},
		clearMidi() {
			this.midiQueue?.clear();
			this.midiEventCount = 0;
		},
		setMidiCCMapping(mapping) {
			return this.setMidiCCMapping(mapping);
		},
		clearMidiCCMapping(mapping) {
			return this.clearMidiCCMapping(mapping);
		},
		setParamMappingIndication(mapping) {
			const label = String(mapping?.label ?? '');
			const description = String(mapping?.description ?? '');
			const encoder = new TextEncoder();
			const labelBytes = encoder.encode(label);
			const descriptionBytes = encoder.encode(description);
			const bytes = new Uint8Array(labelBytes.length + descriptionBytes.length);
			bytes.set(labelBytes);
			bytes.set(descriptionBytes, labelBytes.length);
			return this.hostApi.pluginSetParamMappingIndication(
				this.pluginPtr,
				Number(mapping?.paramId),
				Boolean(mapping?.hasMapping),
				this.sendBytes(bytes),
				labelBytes.length,
			);
		},
		setParam(paramId, value) {
			this.hostApi.pluginSetParam(this.pluginPtr, paramId, value);

			// If we're being called here (in the AudioWorklet), then it's single-threaded, so there's no reason not to immediately flush
			this.hostApi.pluginParamsFlush(this.pluginPtr);
			
			return this.remoteMethods.getParam.call(this, paramId);
		},
		getParam(paramId) {
			return this.decodeCbor(this.hostApi.pluginGetParam(this.pluginPtr, paramId, this.hostedBytes));
		},
		getParams() {
			let params = this.decodeCbor(this.hostApi.pluginGetParams(this.pluginPtr, this.hostedBytes));
			params.forEach(param => {
				param.value = this.remoteMethods.getParam.call(this, param.id);
			});
			return params;
		},
		performance() {
			return {js: this.#averageJsMs, wasm: this.#averageWasmMs, block: this.#averageBlockMs};
		},
		getResource(path) {
			return this.decodeCbor(this.hostApi.pluginGetResource(this.pluginPtr, this.encodeString(path)));
		},
		webviewOpen(isOpen, isVisible) {
			this.hostApi.pluginGuiSetOpen(this.pluginPtr, isOpen, isVisible, this.hostedBytes);
			return this.decodeCbor();
		},
		setInterfaceSize(width, height) {
			this.hostApi.pluginGuiSetSize(this.pluginPtr, width, height, this.hostedBytes);
			return this.decodeCbor();
		}
	};

	#averageJsMs = 0;
	#averageWasmMs = 0;
	#averageBlockMs = 0;
	
	process(inputs, outputs, parameters) {
		let jsStartTime = now();
		if (this.fatalError || !this.running) return false;
		if (!this.ready) return true; // outputs are pre-filled with silence

		let blockLength = (outputs[0] || inputs[0])[0].length;
		
		this.writePendingMidiEvents(blockLength);
		this.writePendingEvents();
		
		// Copy audio input
		this.instanceAudioPointers.inputs.forEach((ptrs, inputPort) => {
			let jsInput = inputs[inputPort];
			ptrs.forEach((ptr, channelIndex) => {
				let instanceArray = new Float32Array(this.instanceMemory.buffer, ptr, blockLength);
				if (jsInput && jsInput.length > 0) {
					let jsChannel = jsInput[channelIndex%jsInput.length];
					instanceArray.set(jsChannel);
				} else {
					for (let i = 0; i < blockLength; ++i) instanceArray[i] = 0;
				}
			});
		});
		
		// Actual process call
		let wasmStartTime, wasmEndTime;
		let processStatus;
		try {
			wasmStartTime = now();
			processStatus = this.hostApi.pluginProcess(this.pluginPtr, blockLength);
			if (this.instanceSingleThreaded) this.mainThreadCallback();
			wasmEndTime = now();
		} catch (e) {
			this.failWithError(e);
			return false;
		}

		// Copy audio output
		outputs.forEach((output, outputPort) => {
			let input = inputs[outputPort];
			let ptrs = this.instanceAudioPointers.outputs[outputPort];
			if (ptrs && ptrs.length) {
				// We have an output - copy from that instead
				input = ptrs.map(ptr => {
					return new Float32Array(this.instanceMemory.buffer, ptr, blockLength);
				});
			}
			if (input.length) {
				output.forEach((jsChannel, channelIndex) => {
					let inputChannel = input[channelIndex%input.length];
					jsChannel.set(inputChannel);
				});
			}
		});
		this.postMappedValues();

		let jsEndTime = now();

		let slew = 1/cpuAveragePeriod;
		this.#averageJsMs += (jsEndTime - jsStartTime - this.#averageJsMs)*slew;
		this.#averageWasmMs += (wasmEndTime - wasmStartTime - this.#averageWasmMs)*slew;
		this.#averageBlockMs += (blockLength*1000/sampleRate - this.#averageBlockMs)*slew;

		if (processStatus == 0/*CLAP_PROCESS_ERROR*/) {
			console.error("CLAP_PROCESS_ERROR");
			return false;
		} else if (processStatus === 2/*CLAP_PROCESS_CONTINUE_IF_NOT_QUIET*/) {
			let energy = 0;
			outputs.forEach(output => {
				output.forEach(channel => {
					channel.forEach(x => energy += x*x);
				});
			});
			return (energy >= 1e-6);
		} else if (processStatus === 3/*CLAP_PROCESS_TAIL*/) {
			console.log("CLAP_PROCESS_TAIL not supported")
			return inputs.some(input => input.length);
		} else if (processStatus === 4/*CLAP_PROCESS_SLEEP*/) {
			return inputs.some(input => input.length); // continue only if there's more input
		}
		return true;
	}
}

registerProcessor('audioworkletprocessor-clap', ClapAudioWorkletProcessor);
