#!/bin/sh
set -eu

rm -rf -- dist
mkdir -p \
	dist/audio \
	dist/clap-audionode/wclap-js/es6/wasi \
	dist/compost \
	dist/examples

cp \
	_headers \
	index.html \
	main.js \
	page-proxy-service-worker.js \
	standalone-midi-map.js \
	dist/

cp audio/loop.mp3 dist/audio/
cp -R compost/src dist/compost/
cp -R examples/public dist/examples/

cp \
	clap-audionode/cbor.mjs \
	clap-audionode/clap-audionode.mjs \
	clap-audionode/clap-audioworkletprocessor.mjs \
	clap-audionode/host-imports.mjs \
	clap-audionode/host.wasm \
	clap-audionode/midi-event.mjs \
	dist/clap-audionode/

cp clap-audionode/wclap-js/wclap.mjs dist/clap-audionode/wclap-js/
cp \
	clap-audionode/wclap-js/es6/generate-forwarding-wasm.mjs \
	clap-audionode/wclap-js/es6/targz.mjs \
	clap-audionode/wclap-js/es6/wclap-plugin.mjs \
	clap-audionode/wclap-js/es6/wclap.mjs \
	dist/clap-audionode/wclap-js/es6/
cp \
	clap-audionode/wclap-js/es6/wasi/wasi.mjs \
	clap-audionode/wclap-js/es6/wasi/wasi.wasm \
	dist/clap-audionode/wclap-js/es6/wasi/
