import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {startWasi} from '../wclap-js/es6/wasi/wasi.mjs';
import {maximumMemoryPages} from '../wclap-js/es6/wclap-plugin.mjs';

test('the default plug-in heap allows 128 MiB', () => {
	assert.equal(maximumMemoryPages * 65536, 128 * 1024 * 1024);
});

test('fresh WASI memory honours the supplied memory specification', async () => {
	const previousIsolation = globalThis.crossOriginIsolated;
	globalThis.crossOriginIsolated = true;

	try {
		const bytes = await readFile(new URL('../wclap-js/es6/wasi/wasi.wasm', import.meta.url));
		const module = await WebAssembly.compile(bytes);
		const wasi = await startWasi({
			module,
			seedString: 'test',
			memorySpec: {initial: 8, maximum: 8, shared: true},
		});
		const memory = wasi.initObj().memory;

		assert.ok(memory instanceof WebAssembly.Memory);
		assert.throws(() => memory.grow(1), RangeError);
	} finally {
		if (previousIsolation === undefined) delete globalThis.crossOriginIsolated;
		else globalThis.crossOriginIsolated = previousIsolation;
	}
});
