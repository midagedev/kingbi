#!/bin/zsh
# box3d (alpha) → single-threaded WASM bridge for kingbi rubble physics.
# Requires: emcc (brew install emscripten) + box3d clone at ../box3d.
# Artifacts are committed under public/wasm so deploys need no toolchain.
# In-app-browser rules baked in: single-threaded (no SharedArrayBuffer),
# streaming-instantiate with arrayBuffer fallback lives in Box3dWorld.ts.
set -e
BOX3D="${BOX3D_SRC:-../box3d}"
cd "$(dirname "$0")/.."
emcc -O3 -msimd128 -D__SSE__=1 -D__SSE2__=1 \
  wasm/bridge.c \
  "$BOX3D"/src/*.c \
  -I"$BOX3D"/include \
  --no-entry \
  -s MODULARIZE=1 \
  -s EXPORT_NAME=Box3DModule \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -s INITIAL_MEMORY=64MB \
  -s MAXIMUM_MEMORY=256MB \
  -s EXPORTED_FUNCTIONS=_bx_init,_bx_add_box,_bx_add_static,_bx_remove,_bx_step,_bx_get_states,_bx_clear,_bx_capacity,_bx_alive_count,_bx_awake_count,_bx_kick \
  -s EXPORTED_RUNTIME_METHODS=HEAPF32 \
  -o wasm/box3d_bridge.js
cp wasm/box3d_bridge.js wasm/box3d_bridge.wasm public/wasm/
ls -la public/wasm/
