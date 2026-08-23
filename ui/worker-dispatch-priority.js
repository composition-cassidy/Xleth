'use strict';

// Pure predicate used by addon-worker.js to decide which RPC methods get
// their native call deferred via setImmediate rather than invoked inline.
//
// Split out from addon-worker.js (which can't be imported directly — it
// throws at load time without XLETH_BRIDGE_DIR set, and immediately wires
// process.on('message', ...) as a side effect) so the DECISION itself is
// unit-testable without forking a real child process. The actual deferral
// mechanism (setImmediate pushing execution to the next check-phase tick)
// is standard, well-defined Node.js behavior and isn't re-verified here —
// only "which methods this applies to" is.
//
// See the WAVEFORM_METHODS comment in addon-worker.js for WHY these four
// specifically: they're the only RPCs that can arrive in a multi-message
// burst from one gesture (Timeline's Phase 5 hi-res fetch coalescing) and
// are the only ones without a general-purpose lock on the globals they
// touch, which rules out true parallel (AsyncWorker) execution — deferring
// is a same-thread ordering fix, not a concurrency one.
const WAVEFORM_METHODS = new Set([
  'waveform_getRegionPeaks',
  'waveform_getRawSamples',
  'waveform_getFilePeaks',
  'waveform_getClipPeaks',
]);

function shouldDeferMethod(method) {
  return WAVEFORM_METHODS.has(method);
}

module.exports = { WAVEFORM_METHODS, shouldDeferMethod };
