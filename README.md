# WCLAP browser host

This repository is a small browser host for CLAP plug-ins compiled to WCLAP.
It contains the browser runtime, the AudioWorklet host, a Compost-based host
page, and example WCLAP fixtures.

It does not depend on `clap-wrapper`, native CLAP/AUv3 code, or the parent
`wclap-compost` checkout. Those projects produce plug-in binaries; this repo
loads the resulting `.wclap` archives.

## Run the examples

Clone the repository with its runtime submodules, then serve it with the
included COOP/COEP server:

```sh
git clone --recurse-submodules https://github.com/charCulbert/wclap-browser-host.git
cd wclap-browser-host
python3 server.py 8000
```

Open [http://127.0.0.1:8000/](http://127.0.0.1:8000/). This is the dynamic
example. It loads the bundled char synth by default and accepts another WCLAP
archive with `?module=<url>`:

```text
/?module=examples/fixtures/webclap/signalsmith-clap-cpp/example-plugins.wclap.tar.gz
```

When an archive exposes multiple plug-ins, the Compost host renders a selector
for them. The static example is at:

```text
/examples/static/
```

It loads the archive bundled under `examples/public/` without requiring a
wrapper or a native build.

## Host behavior

The page uses Compost components for its host controls and keeps the complete
WCLAP behavior in the existing `ClapAudioNode` API:

- multiple plug-ins per archive and plug-in selection;
- plug-in WebView/resource loading;
- generic Compost parameter controls;
- presets and state save/restore/share;
- Web MIDI input with timestamped delivery;
- audio input, file loading, and drag-and-drop;
- AudioWorklet CPU measurements.

For a custom UI, import `ClapAudioNode` directly:

```js
import ClapAudioNode from './clap-audionode/clap-audionode.mjs';

const module = new ClapAudioNode({url: archiveURL});
const plugins = await module.plugins();
const node = await module.createNode(audioContext, plugins[0].id);
node.connect(audioContext.destination);
```

The browser host does not require the Compost page. `ClapAudioNode` remains
the headless/programmatic entry point.

## Build the browser host WASM

The native portion of the browser host is compiled with WASI SDK:

```sh
cmake -S clap-audionode/host-dev \
  -B clap-audionode/host-dev/cmake-build \
  -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK/share/cmake/wasi-sdk-pthread.cmake" \
  -DCMAKE_BUILD_TYPE=Release
cmake --build clap-audionode/host-dev/cmake-build --target host --config Release
```

No Emscripten toolchain is required.

## Fixtures

`examples/public/` contains the two char example archives used by the static
and dynamic examples. `examples/fixtures/webclap/` contains upstream Basics,
Clack, AssemblyScript, and Signalsmith WCLAP fixtures used for browser
regression testing. Their original license and source files are retained next
to each fixture.
