'use strict';

// ── P3 — Effect Chain + effect parameter / meter access ──────────────────────
// Extracted from ui/main.js (S5 Stage 4 decomposition). The chain mutations
// (add/remove/move/bypass, track + master), the generic parameter/meter
// accessors and the EQ- / SmartBalance- / Waveshaper-specific accessors
// migrated to ui/rpc-manifest.js (AUDIT.md S1 slice 6) — the chain mutations
// as `graph: 'track' | 'master'` entries, which keep broadcasting
// xleth:graph:changed through main.js's graphHandler. trackKey/masterKey are
// the broadcast keys, shared with effects-graph.js and rpc-registry.js
// (exported below). Only the two handlers with per-call main-process logic
// remain hand-written here.

const { ipcMain } = require('electron');
const { callWorker } = require('./worker');

const trackKey = (_, trackId) => String(trackId);
const masterKey = () => 'master';

function init(deps) {
  const { safeHandler } = deps;

  // ── Effect visualization (dynamics; binary ArrayBuffer payload) ────────────
  // NOT in the manifest: the handlers coerce their trailing arg (!!enabled /
  // maxBuckets|0) — the generic pass-through would drop that — and the drain
  // returns the binary viz payload ({ frames: ArrayBuffer }).
  ipcMain.handle('xleth:audio:setEffectVisualizationEnabled',
    safeHandler((_, trackId, nodeId, enabled) =>
      callWorker('audio_setEffectVisualizationEnabled', [trackId, nodeId, !!enabled])));

  ipcMain.handle('xleth:audio:drainEffectVizFrames',
    safeHandler((_, trackId, nodeId, maxBuckets) =>
      callWorker('audio_drainEffectVizFrames', [trackId, nodeId, maxBuckets | 0])));
}

module.exports = { init, trackKey, masterKey };
