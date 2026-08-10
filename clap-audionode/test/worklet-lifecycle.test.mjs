import assert from 'node:assert/strict';
import test from 'node:test';

let WorkletProcessor;
globalThis.AudioWorkletProcessor = class {};
globalThis.registerProcessor = (_name, Processor) => { WorkletProcessor = Processor; };

await import('../clap-audioworkletprocessor.mjs');

test('keeps the processor alive while plug-in startup is pending', () => {
	const processor = Object.create(WorkletProcessor.prototype);
	processor.fatalError = null;
	processor.running = true;
	processor.ready = false;

	assert.equal(processor.process([], [], {}), true);
});
