'use strict';
//
// bridge/test_sandbox_bridge.js — Sample Sandbox bridge surface (SB-2)
//
// The renderer reaches window.xleth.sandbox.* through optional chaining
// (window.xleth?.sandbox?.open?.(...)), so a method missing from the manifest
// — a typo, a stale addon build, a name that never made it into
// ui/rpc-manifest.js — is `undefined` and every call on it is a silent no-op:
// a UI control that looks wired but does nothing. This file resolves every
// sandbox_* export through mustFn(), which THROWS rather than skipping, so a
// wiring break fails loudly here instead of surfacing as "nothing happened"
// in the Sample Sandbox panel. See test_slot_prep_bridge.js for the same
// pattern applied to an earlier feature.
//
// Verifies, calling every sandbox_* method BY NAME:
//   1. all ten exports exist on the built addon
//   2. open → stackAdd (x2) → stackSetParam → stackSetBypassed → stackReorder
//      → render → getRenderedBuffer (polled) → bake → stackRemove → close
//      all report explicit {success:true}/{ready:true}, never undefined
//   3. every documented rejection path reports {success:false, reason} —
//      unknown layer, unknown op, wrong param type, a redundant bypass, an
//      out-of-range reorder, a poll before anything has rendered
//   4. getRenderedBuffer's `data` arrives as a real Buffer of the documented
//      size (interleaved float32 PCM), not lost across the fork boundary
//
// Run after rebuilding the native addon:
//   node bridge/test_sandbox_bridge.js

const path = require('path');
const fs   = require('fs');

const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
function group(name) { console.log(`\n=== ${name} ===`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function mustFn(name) {
  const fn = addon[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `MISSING EXPORT: addon.${name} is ${typeof fn}. ` +
      `Add it to ui/rpc-manifest.js and re-run scripts/generate-rpc-registries.js.`);
  }
  return fn.bind(addon);
}

async function main() {
  // ── 0. Every sandbox_* export exists ────────────────────────────────────
  group('exports');
  const names = [
    'sandbox_open', 'sandbox_close',
    'sandbox_stackAdd', 'sandbox_stackRemove', 'sandbox_stackReorder',
    'sandbox_stackSetParam', 'sandbox_stackSetBypassed',
    'sandbox_render', 'sandbox_getRenderedBuffer', 'sandbox_bake',
  ];
  const fn = {};
  for (const n of names) {
    fn[n] = mustFn(n);
    ok(true, `addon.${n} is exported`);
  }

  // ── Setup ────────────────────────────────────────────────────────────────
  group('init');
  ok(addon.initialize() === true, 'initialize() returns true');

  const loadSample = mustFn('loadSample');
  const fixtureWav = path.join(repoRoot, 'lmms', 'data', 'samples', 'shapes', 'additive.wav');
  const sourceRef = loadSample(fixtureWav);
  ok(typeof sourceRef === 'number' && sourceRef >= 0,
     `loadSample('additive.wav') returned a SampleBank id (${sourceRef})`);

  // ── 1. sandbox_open ──────────────────────────────────────────────────────
  group('sandbox_open');
  let layerId;
  {
    const bad = fn.sandbox_open(999999);
    ok(bad && bad.success === false && typeof bad.reason === 'string',
       `unknown sourceRef → {success:false, reason} (got ${JSON.stringify(bad)})`);

    const r = fn.sandbox_open(sourceRef, 'smoke-layer');
    ok(r && r.success === true, `sandbox_open succeeds (got ${JSON.stringify(r)})`);
    ok(typeof r.layerId === 'number', 'reports a layerId');
    ok(r.sourceBufferId === sourceRef, 'echoes sourceBufferId');
    ok(r.bufferSampleRate > 0, `reports a positive bufferSampleRate (${r.bufferSampleRate})`);
    ok(r.name === 'smoke-layer', 'echoes the given name');
    layerId = r.layerId;
  }

  // ── 2. sandbox_stackAdd ──────────────────────────────────────────────────
  group('sandbox_stackAdd');
  let gainOpId, fadeOpId;
  {
    const missingLayer = fn.sandbox_stackAdd(999999, { type: 'gain', params: { gainDb: -6 } });
    ok(missingLayer.success === false, `unknown layerId → success:false (${JSON.stringify(missingLayer)})`);

    const badType = fn.sandbox_stackAdd(layerId, { type: 'NotARealOp', params: {} });
    ok(badType.success === false, `unknown op type → success:false (${JSON.stringify(badType)})`);

    const r1 = fn.sandbox_stackAdd(layerId, { type: 'gain', params: { gainDb: -6, normalize: false, targetPeakDb: 0 } });
    ok(r1.success === true && typeof r1.opId === 'number',
       `add Gain op succeeds, returns opId (${JSON.stringify(r1)})`);
    gainOpId = r1.opId;

    const r2 = fn.sandbox_stackAdd(layerId, { type: 'fade', params: { startSample: 0, lengthSamples: 64, fadeIn: true } });
    ok(r2.success === true && typeof r2.opId === 'number' && r2.opId !== gainOpId,
       `add Fade op succeeds with a distinct opId (${JSON.stringify(r2)})`);
    fadeOpId = r2.opId;
  }

  // ── 3. sandbox_stackSetParam ─────────────────────────────────────────────
  group('sandbox_stackSetParam');
  {
    const missingOp = fn.sandbox_stackSetParam(layerId, 999999, { type: 'gain', params: { gainDb: -3 } });
    ok(missingOp.success === false, `unknown opId → success:false (${JSON.stringify(missingOp)})`);

    const wrongType = fn.sandbox_stackSetParam(layerId, gainOpId, { type: 'fade', params: {} });
    ok(wrongType.success === false, `mismatched type → success:false (${JSON.stringify(wrongType)})`);

    const r = fn.sandbox_stackSetParam(layerId, gainOpId, { type: 'gain', params: { gainDb: -12, normalize: false, targetPeakDb: 0 } });
    ok(r.success === true, `edit Gain params succeeds (${JSON.stringify(r)})`);

    const noop = fn.sandbox_stackSetParam(layerId, gainOpId, { type: 'gain', params: { gainDb: -12, normalize: false, targetPeakDb: 0 } });
    ok(noop.success === false, `writing the same value again → success:false (${JSON.stringify(noop)})`);
  }

  // ── 4. sandbox_stackSetBypassed ──────────────────────────────────────────
  group('sandbox_stackSetBypassed');
  {
    const r = fn.sandbox_stackSetBypassed(layerId, fadeOpId, true);
    ok(r.success === true, `bypass Fade op succeeds (${JSON.stringify(r)})`);

    const redundant = fn.sandbox_stackSetBypassed(layerId, fadeOpId, true);
    ok(redundant.success === false, `bypassing an already-bypassed op → success:false (${JSON.stringify(redundant)})`);

    const back = fn.sandbox_stackSetBypassed(layerId, fadeOpId, false);
    ok(back.success === true, 're-enable Fade op succeeds');
  }

  // ── 5. sandbox_stackReorder ──────────────────────────────────────────────
  group('sandbox_stackReorder');
  {
    const oob = fn.sandbox_stackReorder(layerId, 0, 99);
    ok(oob.success === false, `out-of-range toIndex → success:false (${JSON.stringify(oob)})`);

    const noop = fn.sandbox_stackReorder(layerId, 0, 0);
    ok(noop.success === false, `fromIndex===toIndex → success:false (${JSON.stringify(noop)})`);

    const r = fn.sandbox_stackReorder(layerId, 0, 1);
    ok(r.success === true, `swap the two ops succeeds (${JSON.stringify(r)})`);
  }

  // ── 6. sandbox_getRenderedBuffer before any render ───────────────────────
  group('sandbox_getRenderedBuffer (before render)');
  {
    const r = fn.sandbox_getRenderedBuffer(layerId);
    ok(r && r.ready === false && typeof r.reason === 'string',
       `nothing published yet → {ready:false, reason} (${JSON.stringify(r)})`);
  }

  // ── 7. sandbox_bake before any render ────────────────────────────────────
  group('sandbox_bake (before render)');
  {
    const r = fn.sandbox_bake(layerId);
    ok(r.success === false, `bake before render → success:false (${JSON.stringify(r)})`);
  }

  // ── 8. sandbox_render + poll sandbox_getRenderedBuffer ───────────────────
  group('sandbox_render');
  {
    const missingLayer = fn.sandbox_render(999999, 'smoke');
    ok(missingLayer.success === false, `unknown layerId → success:false (${JSON.stringify(missingLayer)})`);

    const r = fn.sandbox_render(layerId, 'smoke-test');
    ok(r.success === true && r.queued === true,
       `render queues a job (${JSON.stringify(r)})`);
  }

  group('sandbox_getRenderedBuffer (polled)');
  {
    let result = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const r = fn.sandbox_getRenderedBuffer(layerId);
      if (r.ready) { result = r; break; }
      await sleep(25);
    }
    ok(result !== null, 'render publishes a buffer within 5s');
    if (result) {
      ok(typeof result.numChannels === 'number' && result.numChannels > 0,
         `reports numChannels (${result.numChannels})`);
      ok(typeof result.numSamples === 'number' && result.numSamples > 0,
         `reports numSamples (${result.numSamples})`);
      ok(result.sampleRate > 0, `reports sampleRate (${result.sampleRate})`);
      ok(Buffer.isBuffer(result.data),
         `data survives the fork boundary as a real Buffer (got ${typeof result.data})`);
      const expectedBytes = result.numChannels * result.numSamples * 4; // float32
      ok(result.data.length === expectedBytes,
         `data byte length matches numChannels*numSamples*4 (${result.data.length} vs ${expectedBytes})`);
    }
  }

  // ── 9. sandbox_bake after render ─────────────────────────────────────────
  group('sandbox_bake (after render)');
  {
    const r = fn.sandbox_bake(layerId);
    ok(r.success === true, `bake after a published render succeeds (${JSON.stringify(r)})`);
    ok(r.numChannels > 0 && r.numSamples > 0, 'reports the baked buffer shape');
  }

  // ── 10. sandbox_stackRemove ───────────────────────────────────────────────
  group('sandbox_stackRemove');
  {
    const missing = fn.sandbox_stackRemove(layerId, 999999);
    ok(missing.success === false, `unknown opId → success:false (${JSON.stringify(missing)})`);

    const r = fn.sandbox_stackRemove(layerId, fadeOpId);
    ok(r.success === true, `remove Fade op succeeds (${JSON.stringify(r)})`);
  }

  // ── 11. sandbox_close ─────────────────────────────────────────────────────
  group('sandbox_close');
  {
    const r = fn.sandbox_close(layerId);
    ok(r.success === true, `close succeeds (${JSON.stringify(r)})`);

    const again = fn.sandbox_close(layerId);
    ok(again.success === false, `closing an already-closed layer → success:false (${JSON.stringify(again)})`);

    const afterClose = fn.sandbox_getRenderedBuffer(layerId);
    ok(afterClose.ready === false, 'getRenderedBuffer after close reports not-ready, not stale data');
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  group('shutdown');
  try { addon.shutdown(); ok(true, 'shutdown() completed'); }
  catch (e) { ok(false, `shutdown() threw: ${e.message}`); }

  console.log('\n--------------------------------------------------');
  console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${passed + failed} tests`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
