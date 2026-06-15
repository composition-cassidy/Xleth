'use strict';
//
// bridge/test_preview_seek_contract.js
//
// Focused contract test for stopped-preview seek requests. This does not
// require GPU preview output; it verifies export, validation, canonical timing
// resolution shape, and monotonic request sequencing.
//

const fs = require('fs');
const path = require('path');

function pickNativeConfig() {
  const requested = process.env.XLETH_NATIVE_CONFIG;
  const configs = requested ? [requested] : ['Release', 'Debug'];
  for (const config of configs) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

const native = pickNativeConfig();
const dllDirs = [
  path.dirname(native.addonPath),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/debug/bin'),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

const addon = require(native.addonPath);

let passed = 0;
let failed = 0;
let total = 0;

function ok(condition, label) {
  total += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function near(actual, expected, tolerance, label) {
  ok(Math.abs(actual - expected) <= tolerance,
     `${label} (expected ${expected}, got ${actual}, tolerance ${tolerance})`);
}

function throws(fn, label) {
  let didThrow = false;
  try { fn(); } catch (_) { didThrow = true; }
  ok(didThrow, label);
}

async function main() {
  console.log(`=== xleth preview seek contract test (${native.config}) ===\n`);

  ok(addon.initialize({ disablePreviewGpu: true }) === true, 'initialize() returns true');
  ok(typeof addon.video_requestPreviewFrameAtTimelinePosition === 'function',
     'preview seek endpoint is exported');
  ok(typeof addon.diag_getVisualPreviewDiagnostic === 'function',
     'visual preview diagnostics are exported');

  addon.timeline_setBPM(120);

  const beat = addon.video_requestPreviewFrameAtTimelinePosition({ beat: 4 });
  const ticks = addon.video_requestPreviewFrameAtTimelinePosition({ ticks: 3840 });
  const seconds = addon.video_requestPreviewFrameAtTimelinePosition({ seconds: 2 });

  ok(beat.accepted === true, 'beat request accepted while stopped');
  ok(ticks.accepted === true, 'ticks request accepted while stopped');
  ok(seconds.accepted === true, 'seconds request accepted while stopped');
  near(beat.sample, ticks.sample, 1, 'beat and ticks resolve to the same sample');
  near(beat.sample, seconds.sample, 1, 'beat and seconds resolve to the same sample');
  ok(String(beat.timingPath).includes('RenderClock'), 'beat request reports RenderClock timing path');
  ok(String(seconds.timingPath).includes('FrameCollector::collectRequests'),
     'seconds request reports FrameCollector collection path');
  ok(ticks.seq === beat.seq + 1 && seconds.seq === ticks.seq + 1,
     'request sequences increase monotonically');

  const diag = addon.diag_getVisualPreviewDiagnostic();
  ok(diag.stoppedPreview && typeof diag.stoppedPreview.latestSeq === 'number',
     'diagnostics expose stopped preview latestSeq');
  ok(diag.stoppedPreview.latestSeq >= seconds.seq,
     'diagnostic latestSeq includes latest request');
  ok(diag.stoppedPreview.pendingSeq === seconds.seq,
     'diagnostic pendingSeq is latest request');
  near(diag.stoppedPreview.pendingSample, seconds.sample, 1,
       'diagnostic pendingSample is latest resolved sample');

  throws(() => addon.video_requestPreviewFrameAtTimelinePosition({}), 'empty request is rejected');
  throws(() => addon.video_requestPreviewFrameAtTimelinePosition({ beat: 1, seconds: 1 }),
         'multiple position fields are rejected');
  throws(() => addon.video_requestPreviewFrameAtTimelinePosition({ beat: Number.NaN }),
         'non-finite beat is rejected');

  addon.shutdown();
  ok(true, 'shutdown() completed');

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch((err) => {
  try { addon.shutdown(); } catch (_) {}
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
