'use strict';

// ── Transport extensions ──────────────────────────────────────────────────────
// The one Phase 1 transport extension (xleth:transport:seek) is now registered by
// rpc-registry.js from ui/rpc-manifest.js (AUDIT.md S1) — it is a pure
// pass-through. Phase 0 transport (play/pause/stop/transportState) stays in
// main.js. This module is kept as an empty init stub so main.js's wiring is
// unchanged; it has no handlers left. See docs/rpc-manifest.md.

function init(_deps) {
  // intentionally empty — see header.
}

module.exports = { init };
