export function midiFrameFromTimestamp(audioContext, timestamp = performance.now()) {
	let receivedAt = performance.now();
	if (!Number.isFinite(timestamp) || (timestamp === 0 && receivedAt > 1000)) timestamp = receivedAt;
	let targetTime;
	let outputTimestamp = audioContext.getOutputTimestamp?.();
	if (outputTimestamp
		&& Number.isFinite(outputTimestamp.contextTime)
		&& Number.isFinite(outputTimestamp.performanceTime)) {
		targetTime = outputTimestamp.contextTime + (timestamp - outputTimestamp.performanceTime)/1000;
	} else {
		targetTime = audioContext.currentTime + (timestamp - performance.now())/1000;
	}
	return Math.max(0, Math.round(targetTime*audioContext.sampleRate));
}

export const CLAP_PARAM_IS_STEPPED = 1 << 0;

export function isMidiCC(data) {
	return data?.length === 3 && (data[0] & 0xf0) === 0xb0
		&& data[1] >= 0 && data[1] <= 127 && data[2] >= 0 && data[2] <= 127;
}

export function midiCCChannel(status) {
	return status & 0x0f;
}

export function midiCCNumber(data) {
	return data[1];
}

export function midiCCValue(data) {
	return data[2];
}

export function parameterValueForMidiCC(ccValue, min, max, flags = 0) {
	let value = min + (max - min)*(ccValue/127);
	if (flags & CLAP_PARAM_IS_STEPPED) value = Math.round(value);
	return value;
}

export function midiEventsForBlock(events, blockStart, blockLength) {
	let blockEnd = blockStart + blockLength;
	let due = [], remaining = [];
	events.forEach(event => {
		if (event.targetFrame >= blockEnd) {
			remaining.push(event);
		} else {
			due.push({...event, time: Math.min(blockLength - 1,
				Math.max(0, Math.round(event.targetFrame - blockStart)))});
		}
	});
	due.sort((a, b) => a.time - b.time || (a.sequence ?? 0) - (b.sequence ?? 0));
	return {due, remaining};
}

export function midiEventBytes(data, time, port = 0) {
	data = Array.from(data);
	if (data.length < 1 || data.length > 3) {
		throw new RangeError("CLAP MIDI events require 1-3 bytes");
	}

	let bytes = new Uint8Array(24);
	let view = new DataView(bytes.buffer);
	view.setUint32(0, bytes.length, true);
	view.setUint32(4, time, true);
	view.setUint16(8, 0, true); // CLAP_CORE_EVENT_SPACE_ID
	view.setUint16(10, 10, true); // CLAP_EVENT_MIDI
	view.setUint32(12, 1, true); // CLAP_EVENT_IS_LIVE
	view.setUint16(16, port, true);
	bytes.set(data, 18);
	return bytes;
}

const midiQueueHeaderBytes = 16;
const midiQueueRecordBytes = 24;
const midiQueueWriteIndex = 0;
const midiQueueReadIndex = 1;
const midiQueueDroppedCount = 2;

export class SharedMidiEventQueue {
	constructor(bufferOrCapacity = 1024) {
		if (bufferOrCapacity instanceof SharedArrayBuffer) {
			this.buffer = bufferOrCapacity;
			this.capacity = (this.buffer.byteLength - midiQueueHeaderBytes)/midiQueueRecordBytes;
		} else {
			this.capacity = Math.max(2, Math.trunc(bufferOrCapacity));
			this.buffer = new SharedArrayBuffer(
				midiQueueHeaderBytes + this.capacity*midiQueueRecordBytes);
		}
		if (!Number.isInteger(this.capacity) || this.capacity < 2) {
			throw new RangeError("Invalid shared MIDI queue buffer");
		}
		this.header = new Int32Array(this.buffer, 0, midiQueueHeaderBytes/4);
		this.view = new DataView(this.buffer);
		this.sequence = 0;
	}

	push(data, targetFrame, port = 0) {
		data = Array.from(data);
		if (data.length < 1 || data.length > 3) {
			throw new RangeError("CLAP MIDI events require 1-3 bytes");
		}

		let writeIndex = Atomics.load(this.header, midiQueueWriteIndex);
		let nextWriteIndex = (writeIndex + 1)%this.capacity;
		if (nextWriteIndex === Atomics.load(this.header, midiQueueReadIndex)) {
			Atomics.add(this.header, midiQueueDroppedCount, 1);
			return false;
		}

		let offset = midiQueueHeaderBytes + writeIndex*midiQueueRecordBytes;
		this.view.setFloat64(offset, targetFrame, true);
		this.view.setUint32(offset + 8, this.sequence++, true);
		this.view.setUint16(offset + 12, port, true);
		this.view.setUint8(offset + 14, data.length);
		this.view.setUint8(offset + 15, data[0] ?? 0);
		this.view.setUint8(offset + 16, data[1] ?? 0);
		this.view.setUint8(offset + 17, data[2] ?? 0);
		Atomics.store(this.header, midiQueueWriteIndex, nextWriteIndex);
		return true;
	}

	drainInto(events) {
		this.drain((targetFrame, sequence, port, length, byte0, byte1, byte2) => {
			events.push({
				targetFrame, sequence, port,
				data: [byte0, byte1, byte2].slice(0, length)
			});
		});
		return events;
	}

	drain(callback) {
		let readIndex = Atomics.load(this.header, midiQueueReadIndex);
		let writeIndex = Atomics.load(this.header, midiQueueWriteIndex);
		while (readIndex !== writeIndex) {
			let offset = midiQueueHeaderBytes + readIndex*midiQueueRecordBytes;
			let length = this.view.getUint8(offset + 14);
			if (callback(this.view.getFloat64(offset, true),
				this.view.getUint32(offset + 8, true),
				this.view.getUint16(offset + 12, true), length,
				this.view.getUint8(offset + 15), this.view.getUint8(offset + 16),
				this.view.getUint8(offset + 17)) === false) break;
			readIndex = (readIndex + 1)%this.capacity;
		}
		Atomics.store(this.header, midiQueueReadIndex, readIndex);
	}

	clear() {
		Atomics.store(this.header, midiQueueReadIndex,
			Atomics.load(this.header, midiQueueWriteIndex));
	}

	get droppedCount() {
		return Atomics.load(this.header, midiQueueDroppedCount);
	}
}
