'use strict';

// ── Graph-mode routing + graph-owned effect instances (FXG.3-b) ───────────────
// All 24 handlers (the 8 wire add/remove/gain/mute mutations + the topology
// queries, node-position persistence, graph-owned effect instances FXG.3-b /
// parameter descriptors FXG.4-a, and the hydrate/sync/adopt topology ops
// FXG.3-d, for both the track and master graphs) are now registered by
// rpc-registry.js from ui/rpc-manifest.js (AUDIT.md S1 slice 7). The 8 wire
// mutations carry `graph: 'track' | 'master'` so they still broadcast
// xleth:graph:changed through main.js's graphHandler; the other 16 are plain
// safeHandler pass-throughs (graphState persistence keeps the renderer in sync,
// so no chain re-fetch is wanted — see the FXG.3-b design). This module has no
// handlers left; it is kept as an empty init stub so main.js's wiring is
// unchanged. See docs/rpc-manifest.md.

function init(_deps) {
  // intentionally empty — see header.
}

module.exports = { init };
