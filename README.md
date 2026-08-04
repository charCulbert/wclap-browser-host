# Hosting CLAP in the browser

This repo provides an example browser host for CLAP plugins [compiled to WASM](https://github.com/geraintluff/wclap-cpp?tab=readme-ov-file#what-is-a-wclap).  Any plugin which can be fetched with CORS can be specified with `?module=<...>` in the URL.

By default it loads WASM builds of [Signalsmith Basics](https://github.com/Signalsmith-Audio/basics).  The repo also includes my more [minimal CLAP examples](https://github.com/geraintluff/signalsmith-clap-cpp) (including webview UIs with the webview CLAP draft extension) which can be seen running [here](https://signalsmith-audio.github.io/wasm-clap-browserhost/?module=plugin/example-plugins-wasm32.wclap.tar.gz).

## AudioWorklet wrapper

The host is built on top of a wrapper in `clap-audionode/` which loads a single
WCLAP as an `AudioNode` backed by an `AudioWorkletProcessor`.

This is implemented by writing a C++ WCLAP host (see `clap-audionode/host-dev/host.cpp`) which provides a simpler API to the JS nodes.

### MIDI input and presets

The returned `AudioWorkletNode` accepts timestamped MIDI 1 short messages:

```js
node.sendMidi([0x90, 60, 100], {timestamp: midiMessage.timeStamp, port: 0});
```

The timestamp uses the DOM performance timeline. The wrapper maps it onto the
audio-context sample timeline, keeps future messages queued, and writes a
block-relative CLAP event time when the message becomes due. In a
cross-origin-isolated page, MIDI records use a `SharedArrayBuffer` queue which
the AudioWorklet drains at the start of each render block. Other pages fall back
to `MessagePort` delivery. `node.midiTransport` reports `shared-memory` or
`message-port`.

Timestamped MIDI uses no intentional lookahead. Pre-scheduled events retain
sample-exact CLAP offsets. In a 10,000-event external CoreMIDI test at 48 kHz,
96.39% reached the current render quantum and 3.61% reached the following
128-frame quantum, with no later events or queue drops. This measures delivery
from the Web MIDI callback to AudioWorklet visibility, not physical MIDI-to-audio
output latency.

A host can also attach a Web MIDI input directly, avoiding an intermediate DOM
event:

```js
const detach = await node.attachMidiInput(input);
// Later: detach();
```

When a plug-in implements `clap.preset-load`, the node also exposes:

```js
const presets = await node.getPresets();
await node.loadPreset(presets[0]);
```

`getPresets()` currently enumerates presets declared at
`CLAP_PRESET_DISCOVERY_LOCATION_PLUGIN`. The lower-level
`presetDiscovery()` and `presetMetadata()` methods expose the complete provider
metadata needed for a host to add file-location crawling separately.

## C++ and JS library

The cleanest way to interact with WCLAPs in the browser is to write a C++ WASM host, which then exposes a simpler API to your custom JS.  This keeps all the CLAP-specific structures in the "native" world.

This repo provides `wclap-js-instance`, a C++ library (`.h`/`.cpp` pair) which for building your WCLAP host.  This is built on top of [`wclap-cpp`](host-dev/modules/wclap-cpp), and provides an `Instance` implementation which abstracts all the WCLAP interactions (e.g. calling WCLAP functions, reading/writing structures in its memory).

It also provides a JavaScript library (ES6 module: `wclap-js/wclap.mjs`) which can load hosts written using the above `wclap-js-instance` library, and manages the corresponding `WebAssembly`

![wclap-js architecture diagram](doc/wclap-js-outline.png)

It also provides a WASI helper (written in C++, with JS to load it).  Currently this only implements the very basics (logging and random numbers), but it defines all the functions for `wasi_snapshot_preview1` (32-bit only).
