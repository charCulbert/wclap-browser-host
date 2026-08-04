import assert from 'node:assert/strict';
import test from 'node:test';

import {
	midiEventBytes,
	midiEventsForBlock,
	midiFrameFromTimestamp,
	SharedMidiEventQueue,
} from '../midi-event.mjs';

test('encodes a live CLAP MIDI event', () => {
	let bytes = midiEventBytes([0x90, 60, 100], 23, 2);
	let view = new DataView(bytes.buffer);
	assert.equal(bytes.length, 24);
	assert.equal(view.getUint32(0, true), 24);
	assert.equal(view.getUint32(4, true), 23);
	assert.equal(view.getUint16(8, true), 0);
	assert.equal(view.getUint16(10, true), 10);
	assert.equal(view.getUint32(12, true), 1);
	assert.equal(view.getUint16(16, true), 2);
	assert.deepEqual([...bytes.slice(18, 21)], [0x90, 60, 100]);
});

test('keeps future events and clamps late events to frame zero', () => {
	let events = [
		{targetFrame: 99, data: [0x90, 60, 100]},
		{targetFrame: 112, data: [0x80, 60, 0]},
		{targetFrame: 228, data: [0x90, 64, 100]},
	];
	let {due, remaining} = midiEventsForBlock(events, 100, 128);
	assert.deepEqual(due.map(event => event.time), [0, 12]);
	assert.deepEqual(remaining, [events[2]]);
});

test('maps DOM timestamps into the AudioContext frame timeline', () => {
	let context = {
		sampleRate: 48000,
		getOutputTimestamp: () => ({contextTime: 2, performanceTime: 1000}),
	};
	assert.equal(midiFrameFromTimestamp(context, 1002.5), 96120);
});

test('moves MIDI records through the shared queue without reordering', () => {
	let producer = new SharedMidiEventQueue(4);
	let consumer = new SharedMidiEventQueue(producer.buffer);
	assert.equal(producer.push([0x90, 60, 100], 120, 0), true);
	assert.equal(producer.push([0xb0, 1, 64], 110, 1), true);
	assert.equal(producer.push([0x80, 60, 0], 120, 0), true);
	assert.equal(producer.push([0x90, 64, 100], 130, 0), false);
	assert.equal(producer.droppedCount, 1);

	let events = consumer.drainInto([]);
	assert.deepEqual(events.map(event => event.data), [
		[0x90, 60, 100], [0xb0, 1, 64], [0x80, 60, 0]
	]);
	assert.deepEqual(events.map(event => event.targetFrame), [120, 110, 120]);
	assert.deepEqual(events.map(event => event.sequence), [0, 1, 2]);
	assert.equal(producer.push([0x90, 64, 100], 130, 0), true);
	assert.deepEqual(consumer.drainInto([])[0].data, [0x90, 64, 100]);
	producer.push([0x90, 67, 100], 140, 0);
	consumer.clear();
	assert.deepEqual(consumer.drainInto([]), []);
});

test('sorts due events by sample offset and arrival sequence', () => {
	let events = [
		{targetFrame: 112, sequence: 2},
		{targetFrame: 105, sequence: 1},
		{targetFrame: 112, sequence: 0},
	];
	let {due} = midiEventsForBlock(events, 100, 128);
	assert.deepEqual(due.map(event => [event.time, event.sequence]), [
		[5, 1], [12, 0], [12, 2]
	]);
});
