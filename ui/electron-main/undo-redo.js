'use strict';

// ── Undo / Redo ───────────────────────────────────────────────────────────────
// All six undo channels (undo/redo/canUndo/canRedo/get{Undo,Redo}Description)
// are now registered by rpc-registry.js from ui/rpc-manifest.js (AUDIT.md S1) —
// they are pure pass-throughs to the engine undo manager. This module is kept as
// an empty init stub so main.js's wiring is unchanged; it has no handlers left.
// See docs/rpc-manifest.md.

function init(_deps) {
  // intentionally empty — see header.
}

module.exports = { init };
