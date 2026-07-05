'use strict';

// ── RPC method manifest — single source of truth for the RPC surface ─────────
// AUDIT.md S1. One entry here wires all five layers that used to be
// hand-maintained per method: the preload wrapper, the ipcMain channel, the
// worker method string, the addon export, and the engine dispatch line.
// See docs/rpc-manifest.md for the design and the migration plan.
//
// Consumed by:
//   ui/preload.js                    — attachRpcWrappers() builds window.xleth.* wrappers
//   ui/electron-main/rpc-registry.js — registers ipcMain.handle() channels
//   scripts/generate-rpc-registries.js — emits bridge/src/XlethRpcExports.inc and
//                                        engine/src/XlethRpcDispatch.inc (checked in;
//                                        staleness enforced by bridge/test_rpc_manifest.js)
//
// Entry fields:
//   method   — worker message string == addon export name == engine dispatch name
//   channels — ipcMain.handle channel(s) routed to this method (phase0 legacy
//              surfaces map two channels to one method, e.g. getFrameRGBA)
//   api      — window.xleth wrapper path(s) → which channel each invokes
//   handler  — C++ handler symbol inside engine/src/XlethEngineService.cpp
//   returns  — 'value' | 'void': shape of the generated dispatch wrapper
//   binary   — null | 'frame' | 'midiImport'. Binary transport handling stays
//              EXPLICIT in ui/addon-worker.js (frames as Buffer sends, ArrayBuffer
//              conversion); this field only declares which methods those explicit
//              branches apply to. Do not genericize the binary paths.
//
// Methods with per-call logic in main.js (arg fixups, dialogs, progress
// intervals) do NOT belong here — only pure pass-throughs migrate.

const METHODS = [
  {
    method: 'timeline_getBPM',
    channels: ['xleth:timeline:getBPM'],
    api: { 'timeline.getBPM': 'xleth:timeline:getBPM' },
    handler: 'Timeline_GetBPM',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_getTempoLocked',
    channels: ['xleth:timeline:getTempoLocked'],
    api: { 'timeline.getTempoLocked': 'xleth:timeline:getTempoLocked' },
    handler: 'Timeline_GetTempoLocked',
    returns: 'value',
    binary: null,
  },
  {
    method: 'timeline_setBPM',
    channels: ['xleth:timeline:setBPM'],
    api: { 'timeline.setBPM': 'xleth:timeline:setBPM' },
    handler: 'Timeline_SetBPM',
    returns: 'void',
    binary: null,
  },
  {
    // Phase 0 legacy frame fetch (per-call RGBA over IPC; the hot path is the
    // shm mapping, not this). Two legacy channels and four wrapper paths all
    // funnel into the one worker method — its Buffer 'frame' send stays
    // hand-written in addon-worker.js.
    method: 'getFrameRGBA',
    channels: ['xleth:currentFrame', 'xleth:frameRGBA'],
    api: {
      'getCurrentFrame':      'xleth:currentFrame',
      'getFrameRGBA':         'xleth:frameRGBA',
      'video.getFrameBuffer': 'xleth:currentFrame',
      'video.getFrameRGBA':   'xleth:frameRGBA',
    },
    handler: 'GetCurrentFrameRGBA',
    returns: 'value',
    binary: 'frame',
  },
];

// Binary kinds addon-worker.js knows how to transport. A manifest entry with
// any other value is a wiring mistake, caught by validateManifest().
const KNOWN_BINARY_KINDS = new Set(['frame', 'midiImport']);

function validateManifest() {
  const methods = new Set();
  const channels = new Set();
  const apiPaths = new Set();
  for (const m of METHODS) {
    if (!m.method || typeof m.method !== 'string')
      throw new Error(`rpc-manifest: entry with missing method name`);
    if (methods.has(m.method))
      throw new Error(`rpc-manifest: duplicate method '${m.method}'`);
    methods.add(m.method);
    if (!Array.isArray(m.channels) || m.channels.length === 0)
      throw new Error(`rpc-manifest: '${m.method}' has no channels`);
    for (const ch of m.channels) {
      if (channels.has(ch))
        throw new Error(`rpc-manifest: duplicate channel '${ch}'`);
      channels.add(ch);
    }
    if (!m.api || typeof m.api !== 'object')
      throw new Error(`rpc-manifest: '${m.method}' has no api map`);
    for (const [apiPath, ch] of Object.entries(m.api)) {
      if (apiPaths.has(apiPath))
        throw new Error(`rpc-manifest: duplicate api path '${apiPath}'`);
      apiPaths.add(apiPath);
      if (!m.channels.includes(ch))
        throw new Error(
          `rpc-manifest: api '${apiPath}' targets '${ch}' which is not a channel of '${m.method}'`);
    }
    if (!m.handler || typeof m.handler !== 'string')
      throw new Error(`rpc-manifest: '${m.method}' has no engine handler symbol`);
    if (m.returns !== 'value' && m.returns !== 'void')
      throw new Error(`rpc-manifest: '${m.method}' returns must be 'value' or 'void'`);
    if (m.binary !== null && !KNOWN_BINARY_KINDS.has(m.binary))
      throw new Error(`rpc-manifest: '${m.method}' has unknown binary kind '${m.binary}'`);
  }
  return true;
}

// Build window.xleth.* wrappers from the manifest. `target` is the object
// literal preload.js just created; nested namespaces (timeline, video, …)
// already exist there, but are created on demand so a manifest entry can
// introduce a new namespace without touching preload.js.
function attachRpcWrappers(target, invoke) {
  for (const m of METHODS) {
    for (const [apiPath, channel] of Object.entries(m.api)) {
      const parts = apiPath.split('.');
      let obj = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!obj[parts[i]]) obj[parts[i]] = {};
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = (...args) => invoke(channel, ...args);
    }
  }
}

module.exports = { METHODS, validateManifest, attachRpcWrappers };
