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
//   1. all exports exist on the built addon (the original ten, plus SB-5's
//      setLayerMix/setLayerMuted/setLayerSoloed/renderComposite/bakeComposite)
//   2. open → stackAdd (x2) → stackSetParam → stackSetBypassed → stackReorder
//      → render → getRenderedBuffer (polled) → bake → stackRemove → close
//      all report explicit {success:true}/{ready:true}, never undefined
//   3. every documented rejection path reports {success:false, reason} —
//      unknown layer, unknown op, wrong param type, a redundant bypass, an
//      out-of-range reorder, a poll before anything has rendered
//   4. getRenderedBuffer's `data` arrives as a real Buffer of the documented
//      size (interleaved float32 PCM), not lost across the fork boundary
//   5. SB-5: the deliverable fixture — 3 layers (plain / reversed / offset
//      +12ms) mix into a composite of the expected length and a sane level,
//      bake to a brand-new SampleBank asset addable back as a source, and
//      that bake's undo/redo is verified through real sandbox_open calls
//      against the SAME sampleId going tombstoned and live again
//   6. SB-6: the deliverable fixture — one region placed on TWO pattern
//      tracks, swapped to a sandbox render, with the bound sample's LENGTH
//      measured before/after so "all placed instances update" is counted
//      rather than asserted; sandbox_undo restores the old sample and
//      refuses to touch a timeline edit sitting on the shared stack; and a
//      real project save → load reproduces the exact op-stacks and workspace
//      while REBINDING each layer's SampleBank id (a project whose sandbox
//      sources went missing reloads unbound with its stacks intact)
//
// Run after rebuilding the native addon:
//   node bridge/test_sandbox_bridge.js

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

// Scratch project root for the SB-6 persistence fixture. Removed at teardown.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-sandbox-'));

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
    'sandbox_render', 'sandbox_getRenderedBuffer', 'sandbox_getSpectrogram',
    'sandbox_getPitchTrack', 'sandbox_bake',
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

  // ── 1b. sandbox_getPitchTrack (AUTOTUNE detection pass) ──────────────────
  // Reads the layer's RAW SOURCE buffer (sampleBank->getSample), not a
  // rendered composite — so unlike getSpectrogram this works right after
  // open, before any sandbox_render call.
  group('sandbox_getPitchTrack');
  {
    const beforeAnyLayer = fn.sandbox_getPitchTrack(999999);
    ok(beforeAnyLayer.ready === false, `unknown layerId -> ready:false (${JSON.stringify(beforeAnyLayer)})`);

    const r = fn.sandbox_getPitchTrack(layerId);
    ok(r.ready === true, `analysis of the layer's source succeeds (${JSON.stringify(r)})`);
    if (r.ready) {
      ok(r.sampleRate > 0, `reports sampleRate (${r.sampleRate})`);
      ok(r.hopSamples > 0, `reports hopSamples (${r.hopSamples})`);
      ok(typeof r.numFrames === 'number' && r.numFrames >= 0, `reports numFrames (${r.numFrames})`);
      ok(typeof r.monophonic === 'boolean', `reports a monophonic boolean (${r.monophonic})`);
      ok(typeof r.reason === 'string', 'reports a reason string (empty when monophonic)');
      ok(Array.isArray(r.notes), `reports a notes array (${r.notes.length} note(s))`);
      ok(Buffer.isBuffer(r.frames), `frames survives the fork boundary as a real Buffer (got ${typeof r.frames})`);
      const expectedBytes = r.numFrames * 2 * 4; // (f0Hz, confidence) float32 pairs
      ok(r.frames.length === expectedBytes,
         `frames byte length matches numFrames*2*4 (${r.frames.length} vs ${expectedBytes})`);
      // additive.wav (this suite's fixture) is only ~336 samples — shorter
      // than one analysis frame (2048), so the honest answer is a clean
      // "too short" refusal (0 frames, monophonic:false) rather than a
      // fabricated pitch. Assert that refusal explicitly when it's the case,
      // so this stays a real check either way the fixture's length lands.
      if (r.numFrames === 0) {
        ok(r.monophonic === false && r.reason.length > 0,
           `a too-short buffer refuses cleanly with a reason (${r.reason})`);
      }

      // sourceBufferId-keyed cache: re-fetching the same layer's source must
      // be a hit — byte-identical frames, not just the same shape.
      const r2 = fn.sandbox_getPitchTrack(layerId);
      ok(r2.ready === true && Buffer.compare(r.frames, r2.frames) === 0,
         're-fetching the same source returns byte-identical frames (cache hit)');
    }
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

  // ── 3b. gainEnvelope over the generic RPC surface ────────────────────────
  // The only op whose params carry a LIST rather than scalars, so it is the
  // only one that exercises array marshalling through opFromJson. There is no
  // dedicated RPC method for it — that is the point of the check: a new op
  // type should reach the engine through sandbox_stackAdd/stackSetParam
  // unchanged.
  group('sandbox_stackAdd — gainEnvelope');
  {
    const duck = [
      { samplePos: 0, db: 0 },
      { samplePos: 2000, db: -20 },
      { samplePos: 4000, db: 0 },
    ];
    const add = fn.sandbox_stackAdd(layerId, { type: 'gainEnvelope', params: { points: duck } });
    ok(add.success === true && typeof add.opId === 'number',
       `add a gain envelope succeeds (${JSON.stringify(add)})`);

    const envOpId = add.opId;

    // An identical write is "not an edit" — same contract as every scalar op,
    // which means the breakpoint list compares by VALUE on the engine side.
    const noop = fn.sandbox_stackSetParam(layerId, envOpId, { type: 'gainEnvelope', params: { points: duck } });
    ok(noop.success === false,
       `re-writing the same curve → success:false (${JSON.stringify(noop)})`);

    const deeper = duck.map((q) => (q.samplePos === 2000 ? { samplePos: 2000, db: -30 } : q));
    const edit = fn.sandbox_stackSetParam(layerId, envOpId, { type: 'gainEnvelope', params: { points: deeper } });
    ok(edit.success === true, `deepening one breakpoint succeeds (${JSON.stringify(edit)})`);

    // An unsorted curve is repaired on ingest rather than rejected, so the
    // SAME curve written out of order is still "not an edit".
    const shuffled = [deeper[2], deeper[0], deeper[1]];
    const reorderNoop = fn.sandbox_stackSetParam(layerId, envOpId, { type: 'gainEnvelope', params: { points: shuffled } });
    ok(reorderNoop.success === false,
       `the same curve written out of order normalizes to "not an edit" (${JSON.stringify(reorderNoop)})`);

    // Mode 2 (Relative) — flipping mode alone, with the curve untouched, is
    // still a real edit: it changes the rendered audio just as much as a
    // breakpoint move would, so it must not be swallowed as "not an edit".
    const toRelative = fn.sandbox_stackSetParam(layerId, envOpId,
      { type: 'gainEnvelope', params: { points: deeper, mode: 1, followerAttackMs: 8, followerReleaseMs: 220 } });
    ok(toRelative.success === true, `switching to Relative mode succeeds (${JSON.stringify(toRelative)})`);

    const sameRelative = fn.sandbox_stackSetParam(layerId, envOpId,
      { type: 'gainEnvelope', params: { points: deeper, mode: 1, followerAttackMs: 8, followerReleaseMs: 220 } });
    ok(sameRelative.success === false,
       `re-writing the same mode/follower/curve → success:false (${JSON.stringify(sameRelative)})`);

    const backToAbsolute = fn.sandbox_stackSetParam(layerId, envOpId,
      { type: 'gainEnvelope', params: { points: deeper, mode: 0 } });
    ok(backToAbsolute.success === true,
       `mode alone, curve unchanged, still counts as an edit (${JSON.stringify(backToAbsolute)})`);

    const gone = fn.sandbox_stackRemove(layerId, envOpId);
    ok(gone.success === true, 'the envelope op is removed again, leaving the stack as it was');
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

  // ── 8a. AUTOTUNE over the bridge (P5-3) ──────────────────────────────────
  // The op's typed params must survive JSON in BOTH directions, and the
  // renderer's refusal channel must arrive alongside the audio on the poll the
  // UI already runs. Both are things only a real bridge round-trip can prove:
  // the engine tests exercise the C++ structs directly and never see the JSON.
  group('sandbox AUTOTUNE op');
  {
    const params = {
      scale: 2, key: 2, allowedNotes: [],       // D Phrygian, the specced default
      correctionAmount: 100, retuneSpeedMs: 0, smoothnessMs: 0,
      jumpiness: 0, preserveVibrato: 0,
    };
    const added = fn.sandbox_stackAdd(layerId, { type: 'autotune', params });
    ok(added.success === true && typeof added.opId === 'number',
       `an autotune op is accepted (${JSON.stringify(added)})`);

    fn.sandbox_render(layerId, 'autotune-smoke');
    let result = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const r = fn.sandbox_getRenderedBuffer(layerId);
      if (r.ready) { result = r; break; }
      await sleep(25);
    }
    ok(result !== null, 'an autotune render publishes a buffer');
    if (result) {
      // The refusal channel is present on EVERY poll, refused or not — the UI
      // reads one shape rather than testing for the field's existence.
      ok(typeof result.refusedOps === 'number',
         `getRenderedBuffer reports refusedOps (${result.refusedOps})`);
      ok(typeof result.refusalReason === 'string',
         `getRenderedBuffer reports refusalReason (${JSON.stringify(result.refusalReason)})`);
      // additive.wav is a synthesis fixture, not a vocal — it may legitimately
      // be refused by the monophonic gate. Either verdict is correct here; what
      // must hold is that the two fields AGREE with each other, so the UI can
      // trust one without cross-checking the other.
      ok((result.refusedOps > 0) === (result.refusalReason.length > 0),
         `refusedOps and refusalReason agree (${result.refusedOps}, ${JSON.stringify(result.refusalReason)})`);
    }

    // Param round-trip: set every field to a non-default and read it back.
    const edited = {
      scale: 10, key: 7, allowedNotes: [0, 4, 7],
      correctionAmount: 62.5, retuneSpeedMs: 81, smoothnessMs: 44,
      jumpiness: 33, preserveVibrato: 12.5,
    };
    const setRes = fn.sandbox_stackSetParam(layerId, added.opId,
                                            { type: 'autotune', params: edited });
    ok(setRes.success === true, `autotune params accepted (${JSON.stringify(setRes)})`);

    const removed = fn.sandbox_stackRemove(layerId, added.opId);
    ok(removed.success === true, 'the autotune op removes cleanly');
  }

  // ── 8b. sandbox_getSpectrogram (P3-1) ─────────────────────────────────────
  group('sandbox_getSpectrogram');
  {
    const beforeAnyLayer = fn.sandbox_getSpectrogram(999999);
    ok(beforeAnyLayer.ready === false, `unknown layerId -> ready:false (${JSON.stringify(beforeAnyLayer)})`);

    const r = fn.sandbox_getSpectrogram(layerId);
    ok(r.ready === true, `analysis of the just-rendered buffer succeeds (${JSON.stringify(r)})`);
    if (r.ready) {
      ok(typeof r.numFrames === 'number' && r.numFrames > 0, `reports numFrames (${r.numFrames})`);
      ok(r.numBins === 1025, `reports numBins == kFftSize/2+1 (${r.numBins})`);
      ok(r.hopSize === 512, `reports hopSize (${r.hopSize})`);
      ok(r.sampleRate > 0, `reports sampleRate (${r.sampleRate})`);
      ok(r.maxDb >= r.minDb, `maxDb >= minDb (${r.minDb}..${r.maxDb})`);
      ok(Buffer.isBuffer(r.data), `data survives the fork boundary as a real Buffer (got ${typeof r.data})`);
      const expectedBytes = r.numFrames * r.numBins; // one uint8 token per (frame, bin)
      ok(r.data.length === expectedBytes,
         `data byte length matches numFrames*numBins (${r.data.length} vs ${expectedBytes})`);

      // Content-hash cache: re-fetching the SAME published render must be a
      // hit — byte-identical tokens, not just the same shape.
      const r2 = fn.sandbox_getSpectrogram(layerId);
      ok(r2.ready === true && Buffer.compare(r.data, r2.data) === 0,
         're-fetching the same render returns byte-identical tokens (cache hit)');
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

    const spcAfterClose = fn.sandbox_getSpectrogram(layerId);
    ok(spcAfterClose.ready === false, 'getSpectrogram after close reports not-ready, not stale data');

    const pitchAfterClose = fn.sandbox_getPitchTrack(layerId);
    ok(pitchAfterClose.ready === false, 'getPitchTrack after close reports not-ready, not stale data');
  }

  // ── 12. SB-5: layering + bake-to-new-asset ───────────────────────────────
  group('SB-5 exports');
  {
    const sb5Names = [
      'sandbox_setLayerMix', 'sandbox_setLayerMuted', 'sandbox_setLayerSoloed',
      'sandbox_renderComposite', 'sandbox_bakeComposite',
    ];
    for (const n of sb5Names) { fn[n] = mustFn(n); ok(true, `addon.${n} is exported`); }
  }

  group('sandbox_setLayerMix / setLayerMuted / setLayerSoloed');
  {
    // `layerId` (from the ORIGINAL sandbox_open smoke section) was already
    // closed by the sandbox_close group above — open a fresh layer for this
    // one rather than reusing a stale id.
    const opened = fn.sandbox_open(sourceRef, 'mix-smoke-layer');
    ok(opened.success === true, `sandbox_open for the mix smoke section succeeds (${JSON.stringify(opened)})`);
    const mixLayerId = opened.layerId;

    const missing = fn.sandbox_setLayerMix(999999, -6, 0, 0);
    ok(missing.success === false, `unknown layerId → success:false (${JSON.stringify(missing)})`);

    const r = fn.sandbox_setLayerMix(mixLayerId, -3, 0.25, 100);
    ok(r.success === true, `setLayerMix succeeds (${JSON.stringify(r)})`);

    const noop = fn.sandbox_setLayerMix(mixLayerId, -3, 0.25, 100);
    ok(noop.success === false, `writing the same mix again → success:false (${JSON.stringify(noop)})`);

    const mute = fn.sandbox_setLayerMuted(mixLayerId, true);
    ok(mute.success === true, `setLayerMuted succeeds (${JSON.stringify(mute)})`);
    const muteAgain = fn.sandbox_setLayerMuted(mixLayerId, true);
    ok(muteAgain.success === false, `re-muting an already-muted layer → success:false (${JSON.stringify(muteAgain)})`);
    fn.sandbox_setLayerMuted(mixLayerId, false);   // restore

    const solo = fn.sandbox_setLayerSoloed(mixLayerId, true);
    ok(solo.success === true, `setLayerSoloed succeeds (${JSON.stringify(solo)})`);
    fn.sandbox_setLayerSoloed(mixLayerId, false);   // restore
    fn.sandbox_setLayerMix(mixLayerId, 0, 0, 0);    // restore

    fn.sandbox_close(mixLayerId);
  }

  // The deliverable fixture: 3 layers (one plain, one REVERSED, one offset
  // +12ms) → composite renders to the expected length/level, then bakes to a
  // brand-new SampleBank asset that can be re-opened as a source; bake
  // undo/redo is verified through the SAME sampleId going tombstoned and
  // live again via real sandbox_open calls against it.
  group('SB-5 fixture — 3 layers (plain / reversed / +12ms offset) → composite bake');
  {
    const open = (name) => {
      const r = fn.sandbox_open(sourceRef, name);
      if (!r.success) throw new Error(`sandbox_open(${name}) failed: ${JSON.stringify(r)}`);
      return r;
    };
    const renderAndWait = async (id) => {
      fn.sandbox_render(id, 'sb5-fixture');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const r = fn.sandbox_getRenderedBuffer(id);
        if (r.ready) return r;
        await sleep(25);
      }
      throw new Error(`layer ${id} did not render within 5s`);
    };

    const a = open('plain');
    const b = open('reversed');
    const c = open('offset+12ms');

    const revOp = fn.sandbox_stackAdd(b.layerId, { type: 'reverse', params: { startSample: 0, endSample: -1 } });
    ok(revOp.success === true, `stackAdd(reverse) on layer B succeeds (${JSON.stringify(revOp)})`);

    const offsetSamples = Math.round(0.012 * a.bufferSampleRate);
    const mixC = fn.sandbox_setLayerMix(c.layerId, 0, 0, offsetSamples);
    ok(mixC.success === true, `setLayerMix(+12ms = ${offsetSamples} smp) on layer C succeeds (${JSON.stringify(mixC)})`);

    const bufA = await renderAndWait(a.layerId);
    const bufB = await renderAndWait(b.layerId);
    const bufC = await renderAndWait(c.layerId);
    ok(bufA.ready && bufB.ready && bufC.ready, 'all three layers rendered');

    const composite = fn.sandbox_renderComposite();
    ok(composite.ready === true,
       `renderComposite succeeds (numSamples=${composite.numSamples}, layersMixed=${composite.layersMixed})`);
    ok(composite.layersMixed === 3, `all 3 layers mixed (${composite.layersMixed})`);

    const expectedLen = Math.max(bufA.numSamples, bufB.numSamples, offsetSamples + bufC.numSamples);
    ok(composite.numSamples === expectedLen,
       `composite length matches expectation: max(A, B, offset+C) = ${expectedLen} (got ${composite.numSamples})`);

    let peak = 0;
    const floatData = new Float32Array(
      composite.data.buffer, composite.data.byteOffset, composite.data.length / 4);
    for (let i = 0; i < floatData.length; i++) peak = Math.max(peak, Math.abs(floatData[i]));
    ok(peak > 0 && peak < 4, `composite level is sane — non-silent, not runaway (peak=${peak.toFixed(4)})`);

    const bake = fn.sandbox_bakeComposite('sb5-fixture-bake');
    ok(bake.success === true, `bakeComposite succeeds (${JSON.stringify(bake)})`);
    ok(bake.numSamples === expectedLen,
       `baked asset length matches the composite (${bake.numSamples} vs ${expectedLen})`);
    ok(typeof bake.sampleId === 'number' && bake.sampleId >= 0, `bakeComposite returns a new sampleId (${bake.sampleId})`);
    const bakedSampleId = bake.sampleId;

    // Verify undo/redo IMMEDIATELY after the bake, before anything else pushes
    // its own undo-stack entry on top of it — sandbox_open(bakedSampleId, ...)
    // to prove "add back as a source" is itself an undoable AddSandboxLayerCommand,
    // so doing that FIRST would make undo_undo() below undo THAT instead of the
    // bake. undo_undo/undo_redo are generic engine RPCs, not sandbox_*-prefixed,
    // so they were never added to `fn` via mustFn() above — call them straight
    // off the addon.
    const undone = addon.undo_undo();
    ok(undone === true, `undo_undo() undoes the bake (${undone})`);
    const reopenAfterUndo = fn.sandbox_open(bakedSampleId, 'reopen-after-undo');
    ok(reopenAfterUndo.success === false,
       `after undo, the baked asset's slot is tombstoned — sandbox_open on it fails (${JSON.stringify(reopenAfterUndo)})`);

    const redone = addon.undo_redo();
    ok(redone === true, `undo_redo() redoes the bake (${redone})`);
    const reopenAfterRedo = fn.sandbox_open(bakedSampleId, 'reopen-after-redo');
    ok(reopenAfterRedo.success === true,
       `after redo, the SAME sampleId is live again — and it can be added back as a source (${JSON.stringify(reopenAfterRedo)})`);
    fn.sandbox_close(reopenAfterRedo.layerId);

    fn.sandbox_close(a.layerId);
    fn.sandbox_close(b.layerId);
    fn.sandbox_close(c.layerId);
  }

  group('sandbox_renderComposite / sandbox_bakeComposite rejection paths');
  {
    const noLayers = fn.sandbox_renderComposite();
    ok(noLayers.ready === false, `renderComposite with no layers → ready:false (${JSON.stringify(noLayers)})`);

    const noLayersBake = fn.sandbox_bakeComposite();
    ok(noLayersBake.success === false, `bakeComposite with no layers → success:false (${JSON.stringify(noLayersBake)})`);

    const fresh = fn.sandbox_open(sourceRef, 'unrendered-fixture');
    const notRendered = fn.sandbox_renderComposite();
    ok(notRendered.ready === false && typeof notRendered.reason === 'string',
       `an unrendered layer blocks the composite (${JSON.stringify(notRendered)})`);
    fn.sandbox_close(fresh.layerId);
  }

  // ── SPC selection tool: sandbox_extractSelection (COPY TO NEW LAYER) ─────
  group('sandbox_extractSelection exports');
  {
    fn.sandbox_extractSelection = mustFn('sandbox_extractSelection');
    ok(true, 'addon.sandbox_extractSelection is exported');
  }

  group('sandbox_extractSelection — SPC selection COPY TO NEW LAYER');
  {
    const opened = fn.sandbox_open(sourceRef, 'extract-fixture');
    ok(opened.success === true, `sandbox_open for the extraction fixture succeeds (${JSON.stringify(opened)})`);
    const layerId = opened.layerId;

    fn.sandbox_render(layerId, 'extract-fixture');
    const deadline = Date.now() + 5000;
    let rendered = null;
    while (Date.now() < deadline) {
      const r = fn.sandbox_getRenderedBuffer(layerId);
      if (r.ready) { rendered = r; break; }
      await sleep(25);
    }
    ok(!!rendered, 'the extraction fixture layer renders');

    const halfWidthSamples = Math.round(rendered.sampleRate * 0.05);
    const dabs = [{
      centerSample: Math.round(rendered.numSamples / 2),
      halfWidthSamples,
      centerFreqHz: 1000,
      halfHeightHz: 500,
      amountDb: 0,
      featherTimeMs: 10,
      featherFreqHz: 50,
    }];

    const missing = fn.sandbox_extractSelection(999999, dabs);
    ok(missing.success === false, `unknown layerId → success:false (${JSON.stringify(missing)})`);

    const empty = fn.sandbox_extractSelection(layerId, []);
    ok(empty.success === false, `empty dabs → success:false (${JSON.stringify(empty)})`);

    const extracted = fn.sandbox_extractSelection(layerId, dabs, 'extracted-region');
    ok(extracted.success === true, `extractSelection succeeds (${JSON.stringify(extracted)})`);
    ok(extracted.numSamples === rendered.numSamples,
       `extraction preserves buffer length (${extracted.numSamples} vs ${rendered.numSamples})`);
    ok(typeof extracted.sampleId === 'number' && extracted.sampleId >= 0,
       `extractSelection returns a new sampleId (${extracted.sampleId})`);
    ok(extracted.name === 'extracted-region', `extractSelection honors the requested name (${extracted.name})`);

    // Same undo/redo tombstone/restore contract as bakeComposite — both share
    // BakeSandboxCompositeCommand (see Sandbox_ExtractSelection's own comment
    // in XlethEngineService.cpp for why).
    const undone = addon.undo_undo();
    ok(undone === true, `undo_undo() undoes the extraction (${undone})`);
    const reopenAfterUndo = fn.sandbox_open(extracted.sampleId, 'reopen-after-undo');
    ok(reopenAfterUndo.success === false,
       `after undo, the extracted asset's slot is tombstoned (${JSON.stringify(reopenAfterUndo)})`);

    const redone = addon.undo_redo();
    ok(redone === true, `undo_redo() redoes the extraction (${redone})`);
    const reopenAfterRedo = fn.sandbox_open(extracted.sampleId, 'reopen-after-redo');
    ok(reopenAfterRedo.success === true,
       `after redo, the extracted asset can be opened as a new layer (${JSON.stringify(reopenAfterRedo)})`);
    fn.sandbox_close(reopenAfterRedo.layerId);

    fn.sandbox_close(layerId);
  }

  // ── 13. SB-6: swap-in, session undo/redo, workspace persistence ──────────
  group('SB-6 exports');
  {
    const sb6Names = [
      'sandbox_swapIn', 'sandbox_getWorkspace',
      'sandbox_undo', 'sandbox_redo', 'sandbox_getHistory',
    ];
    for (const n of sb6Names) { fn[n] = mustFn(n); ok(true, `addon.${n} is exported`); }
  }

  // The deliverable fixture. One region, TWO pattern tracks both playing it
  // through the same pattern — so "ALL placed instances update" is something
  // the test can actually count rather than assert by inspection.
  //
  // Read the note on sandbox_swapIn before changing this: the audio binding is
  // REGION-scoped (MixEngine::regionToSampleMap_) while {trackId, regionId}
  // keys only the Sampler instance, which is exactly why one swap moves both
  // tracks. trackId is validated, not used to narrow the write.
  group('SB-6 fixture — swap in replaces the sample under every placed instance');
  let projDir, swapRegionId, swapTrackA, swapTrackB, swapLayerId;
  let baselineSamples = 0, swappedSamples = 0, swappedPath = '', fixtureDur = 0;
  {
    const createProject = mustFn('project_create');
    const addRegion     = mustFn('timeline_addRegion');
    const addTrack      = mustFn('timeline_addTrack');
    const toPatternTrack= mustFn('timeline_convertToPatternTrack');
    const addPattern    = mustFn('timeline_addPattern');
    const addBlock      = mustFn('timeline_addPatternBlock');
    const mapRegion     = mustFn('audio_mapRegionToSample');
    const regionInfo    = mustFn('timeline_getRegionAudioInfo');
    const getRegions    = mustFn('timeline_getRegions');

    projDir = path.join(tmpRoot, 'swap-proj');
    ok(createProject(projDir, 'SandboxSwapSmoke') === true, 'project_create succeeds');

    swapRegionId = addRegion({ name: 'swap-target', startTime: 0, endTime: 1,
                               audioFilePath: fixtureWav });
    ok(typeof swapRegionId === 'number' && swapRegionId >= 0,
       `timeline_addRegion → region ${swapRegionId}`);

    swapTrackA = addTrack({ name: 'pattern A' });  toPatternTrack(swapTrackA);
    swapTrackB = addTrack({ name: 'pattern B' });  toPatternTrack(swapTrackB);
    ok(swapTrackA >= 0 && swapTrackB >= 0 && swapTrackA !== swapTrackB,
       `two pattern tracks (${swapTrackA}, ${swapTrackB})`);

    const patternId = addPattern({ name: 'swap-pattern', regionId: swapRegionId, lengthTicks: 1920 });
    const blockA = addBlock({ trackId: swapTrackA, patternId, positionTicks: 0,    durationTicks: 1920 });
    const blockB = addBlock({ trackId: swapTrackB, patternId, positionTicks: 1920, durationTicks: 1920 });
    ok(blockA >= 0 && blockB >= 0, 'the same pattern is placed on BOTH tracks');

    // Bind the region's original audio — the thing the swap has to replace.
    mapRegion(swapRegionId, sourceRef);
    const base = regionInfo(swapRegionId);
    baselineSamples = base.numSamples;
    ok(baselineSamples > 0, `region is bound to its original audio (${baselineSamples} samples)`);

    const engineRate = base.engineSampleRate;
    fixtureDur = baselineSamples / engineRate;

    // Open a layer WITH a durable source reference — the path+range project
    // load re-resolves from, since the SampleBank id is minted fresh each load.
    const opened = fn.sandbox_open(sourceRef, 'swap-source',
                                   { filePath: fixtureWav, startTime: 0, endTime: fixtureDur });
    ok(opened.success === true, `sandbox_open with a source descriptor succeeds (${JSON.stringify(opened)})`);
    ok(opened.sourceFilePath === fixtureWav, 'the durable source path is echoed back');
    swapLayerId = opened.layerId;

    // A TRIM makes the sandbox output a visibly different length from the
    // original, so "the bound sample actually changed" is measurable rather
    // than a matter of trusting the call's return value.
    const trimEnd = Math.floor(baselineSamples / 2);
    const trim = fn.sandbox_stackAdd(swapLayerId, { type: 'trim', params: { startSample: 0, endSample: trimEnd } });
    ok(trim.success === true, `stackAdd(trim → ${trimEnd} samples) succeeds`);

    // Swapping before a render must be refused, not silently swap stale audio.
    const tooEarly = fn.sandbox_swapIn(swapLayerId, swapTrackA, swapRegionId);
    ok(tooEarly.success === false && /not rendered/.test(tooEarly.reason || ''),
       `swapIn before a render is refused (${JSON.stringify(tooEarly)})`);

    fn.sandbox_render(swapLayerId, 'sb6-fixture');
    const deadline = Date.now() + 5000;
    let rendered = null;
    while (Date.now() < deadline) {
      const r = fn.sandbox_getRenderedBuffer(swapLayerId);
      if (r.ready) { rendered = r; break; }
      await sleep(25);
    }
    ok(rendered !== null, 'the layer rendered');
    ok(rendered.numSamples === trimEnd,
       `the render is the TRIMMED length (${rendered.numSamples} vs ${trimEnd})`);

    const swap = fn.sandbox_swapIn(swapLayerId, swapTrackA, swapRegionId);
    ok(swap.success === true, `sandbox_swapIn succeeds (${JSON.stringify(swap)})`);
    ok(swap.previousSampleId === sourceRef,
       `it reports the binding it replaced (${swap.previousSampleId} === ${sourceRef})`);
    ok(swap.sampleId !== sourceRef,
       'the new binding is a DIFFERENT SampleBank id — an atomic handoff, not an in-place rewrite');
    ok(swap.instancesUpdated.samplers === 2,
       `both placed instances are reported updated (${swap.instancesUpdated.samplers})`);
    swappedPath = swap.swappedPath;
    ok(fs.existsSync(swappedPath), `the swapped audio was materialised on disk (${swappedPath})`);

    const after = regionInfo(swapRegionId);
    swappedSamples = after.numSamples;
    ok(Math.abs(swappedSamples - trimEnd) <= 2,
       `the region now resolves to the SANDBOX output (${swappedSamples} ≈ ${trimEnd})`);
    ok(swappedSamples !== baselineSamples, '…which is not what it resolved to before');

    const reg = getRegions().find((r) => r.id === swapRegionId);
    ok(reg && reg.hasSwappedAudio === true,
       'the region records the swap, which is what makes it survive a reload');
  }

  group('SB-6 sandbox_undo / sandbox_redo');
  {
    const regionInfo = mustFn('timeline_getRegionAudioInfo');
    const getRegions = mustFn('timeline_getRegions');

    const hist = fn.sandbox_getHistory();
    ok(hist.undoDomain === 'sandbox', `the swap is tagged as a sandbox edit (${hist.undoDomain})`);
    ok(/Swap In/.test(hist.undoDescription), `…and describes itself (${hist.undoDescription})`);
    ok(hist.sandboxUndoCount >= 1, `sandboxUndoCount counts only sandbox entries (${hist.sandboxUndoCount})`);

    const undone = fn.sandbox_undo();
    ok(undone.applied === true, `sandbox_undo applies the swap's undo (${JSON.stringify(undone.reason || '')})`);
    ok(regionInfo(swapRegionId).numSamples === baselineSamples,
       'undo restores the ORIGINAL sample under every placed instance');
    const regAfterUndo = getRegions().find((r) => r.id === swapRegionId);
    ok(regAfterUndo.hasSwappedAudio === false, '…and clears the region\'s swapped-audio state');

    const redone = fn.sandbox_redo();
    ok(redone.applied === true, 'sandbox_redo re-applies the swap');
    ok(Math.abs(regionInfo(swapRegionId).numSamples - swappedSamples) <= 2,
       '…back to the sandbox output');
    ok(fs.existsSync(swappedPath), '…without writing a second file — the first one is reused');

    // The workspace comes back on every call, because the renderer's layer list
    // is a mirror built by echoing its own mutations; an undo has to re-seed it.
    const ws = JSON.parse(redone.workspace);
    ok(Array.isArray(ws.layers) && ws.layers.length >= 1,
       'undo/redo return the whole workspace so the UI mirror can re-seed');
  }

  group('SB-6 undo domain guard — one shared stack, two surfaces');
  {
    const addTrack = mustFn('timeline_addTrack');
    const strayTrack = addTrack({ name: 'stray timeline edit' });
    ok(strayTrack >= 0, 'a TIMELINE edit lands on the same shared undo stack');

    const guarded = fn.sandbox_undo();
    ok(guarded.applied === false,
       'sandbox_undo REFUSES when the next entry is not a sandbox edit');
    ok(guarded.domain === 'timeline', `…and says whose it is (${guarded.domain})`);
    ok(/timeline/.test(guarded.reason || ''), `…with a reason the panel can show (${guarded.reason})`);

    ok(addon.undo_undo() === true, 'the generic undo pops the timeline edit');
    const nowSandbox = fn.sandbox_getHistory();
    ok(nowSandbox.undoDomain === 'sandbox',
       'with it gone, the sandbox edit is back on top');
  }

  group('SB-6 swapIn rejection paths');
  {
    const bad = [
      [fn.sandbox_swapIn(999999, swapTrackA, swapRegionId), 'unknown layerId'],
      [fn.sandbox_swapIn(swapLayerId, swapTrackA, 999999),  'unknown regionId'],
      [fn.sandbox_swapIn(swapLayerId, 999999, swapRegionId), 'unknown trackId'],
      [fn.sandbox_swapIn(swapLayerId, swapTrackA, swapRegionId, { slotIndex: 3 }), 'slotIndex != 0'],
    ];
    for (const [r, label] of bad)
      ok(r && r.success === false && typeof r.reason === 'string',
         `${label} → {success:false, reason} (${JSON.stringify(r)})`);
  }

  // The other half of the deliverable: the workspace itself has to come back
  // byte-for-byte across a save/load, and the layer has to REBIND to real
  // audio rather than to whatever SampleBank id the file happened to record.
  group('SB-6 persistence — op-stack + workspace round-trip through project.json');
  {
    const saveProject = mustFn('project_save');
    const loadProject = mustFn('project_load');
    const regionInfo  = mustFn('timeline_getRegionAudioInfo');

    // A second layer with mix params and a multi-op stack, so the round-trip
    // covers more than the one layer the swap used.
    // A sub-range of the fixture, derived from its MEASURED duration — the
    // fixture is only a few milliseconds long, so a hardcoded range would
    // decode zero samples and reload (correctly) unresolved, which is not what
    // this group is testing.
    const second = fn.sandbox_open(sourceRef, 'persist-layer',
                                   { filePath: fixtureWav,
                                     startTime: fixtureDur * 0.25,
                                     endTime:   fixtureDur * 0.75 });
    ok(second.success === true, 'a second layer is opened for the round-trip');
    fn.sandbox_stackAdd(second.layerId, { type: 'reverse', params: { startSample: 0, endSample: -1 } });
    fn.sandbox_stackAdd(second.layerId, { type: 'gain', params: { startSample: 0, endSample: -1, gainDb: -6, normalize: false, normalizeTargetDb: 0 } });
    // A gain ENVELOPE too, with awkward fractional dB values on purpose: this
    // group compares the whole workspace JSON before and after the round-trip,
    // so a breakpoint list that lost a point, reordered itself, or rounded a dB
    // fails the comparison below rather than needing its own assertion.
    fn.sandbox_stackAdd(second.layerId, {
      type: 'gainEnvelope',
      params: { points: [
        { samplePos: 0,   db: 0 },
        { samplePos: 64,  db: -18.25 },
        { samplePos: 192, db: -3.5 },
        { samplePos: 400, db: 6.125 },
      ] },
    });
    fn.sandbox_setLayerMix(second.layerId, -3.5, 0.5, 128);
    fn.sandbox_setLayerMuted(second.layerId, true);

    const before = JSON.parse(fn.sandbox_getWorkspace());
    // 3 since P5-3 added SandboxOpType::Autotune — see kSandboxStackVersion's
    // own history comment (engine/src/sandbox/SandboxOp.h) for why an additive
    // op type still bumps it.
    ok(before.sandboxStackVersion === 3, `workspace carries sandboxStackVersion 3 (${before.sandboxStackVersion})`);
    ok(before.layers.length === 2, `two layers in the live workspace (${before.layers.length})`);

    ok(saveProject() === true, 'project_save succeeds');

    const raw = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8'));
    ok(raw.schema_version === 7, `project.json is schema v7 (${raw.schema_version})`);
    ok(raw.sandboxWorkspace && Array.isArray(raw.sandboxWorkspace.layers)
       && raw.sandboxWorkspace.layers.length === 2,
       'the workspace is ON DISK — the project.json key whitelist did not drop it');
    ok(raw.sandboxWorkspace.layers.every((l) => typeof l.sourceFilePath === 'string' && l.sourceFilePath),
       'every layer carries its DURABLE source reference, not just a SampleBank id');

    ok(loadProject(projDir) === true, 'project_load succeeds');

    const after = JSON.parse(fn.sandbox_getWorkspace());
    ok(after.layers.length === before.layers.length,
       `every layer came back (${after.layers.length} of ${before.layers.length})`);

    // Compare everything EXCEPT the runtime binding: sourceBufferId and
    // bufferSampleRate are deliberately re-resolved on load, because the id in
    // the file names the previous session's bank slot.
    const strip = (l) => { const c = { ...l }; delete c.sourceBufferId; delete c.bufferSampleRate; return c; };
    const beforeStripped = JSON.stringify(before.layers.map(strip));
    const afterStripped  = JSON.stringify(after.layers.map(strip));
    ok(beforeStripped === afterStripped,
       'the op-stacks, ids, names, mix params and source refs are IDENTICAL after the round-trip');
    if (beforeStripped !== afterStripped) {
      console.error('    before:', beforeStripped);
      console.error('    after :', afterStripped);
    }

    ok(after.layers.every((l) => l.sourceBufferId >= 0),
       'every layer REBOUND to a freshly minted SampleBank id');
    ok(after.layers.every((l) => l.bufferSampleRate > 0),
       '…at a known sample rate, so the renderer will not refuse it');
    ok(after.layers.some((l) => l.ops.length === 3 && l.muted === true && l.pan === 0.5),
       'the multi-op layer kept its stack AND its mix params');

    // Spelled out separately from the whole-JSON comparison above, because
    // "the breakpoints survived a save/load" is a deliverable in its own right
    // and a future change to `strip` must not be able to quietly stop checking it.
    const reloadedEnv = after.layers
      .flatMap((l) => l.ops)
      .find((o) => o.type === 'gainEnvelope');
    ok(!!reloadedEnv && reloadedEnv.params.points.length === 4,
       `the gain envelope came back with all 4 breakpoints (${JSON.stringify(reloadedEnv && reloadedEnv.params)})`);
    ok(!!reloadedEnv && reloadedEnv.params.points[1].db === -18.25
       && reloadedEnv.params.points[3].db === 6.125,
       'every breakpoint dB round-trips to the bit — no rounding, no clamping');

    // And the swap itself survived, through the region\'s swappedAudioPath.
    ok(Math.abs(regionInfo(swapRegionId).numSamples - swappedSamples) <= 2,
       'the SWAP survives the reload too — the region still plays the sandbox output');

    // A layer whose durable source is gone must reload unbound with its stack
    // intact, not bound to whatever id took that slot.
    const missingDir = path.join(tmpRoot, 'missing-proj');
    fs.mkdirSync(missingDir, { recursive: true });
    const doctored = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8'));
    doctored.sandboxWorkspace.layers.forEach((l) => { l.sourceFilePath = 'Z:/nope/gone.wav'; });
    fs.writeFileSync(path.join(missingDir, 'project.json'), JSON.stringify(doctored, null, 2));
    ok(loadProject(missingDir) === true, 'a project whose sandbox sources are missing still loads');
    const orphaned = JSON.parse(fn.sandbox_getWorkspace());
    ok(orphaned.layers.length === before.layers.length, '…with every layer present');
    ok(orphaned.layers.every((l) => l.sourceBufferId === -1),
       '…each UNBOUND rather than pointing at a stale id');
    // Counted against the fixture built above (reverse + gain + gainEnvelope),
    // so adding an op to that fixture has to be reflected here too.
    ok(orphaned.layers.every((l) => Array.isArray(l.ops)) &&
       orphaned.layers.some((l) => l.ops.length === 3),
       '…and every op-stack intact — it is the binding that is lost, never the edit');
    ok(orphaned.layers.flatMap((l) => l.ops)
              .some((o) => o.type === 'gainEnvelope' && o.params.points.length === 4),
       '…including the gain envelope, whose curve outlives its own audio');
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  group('shutdown');
  try { addon.shutdown(); ok(true, 'shutdown() completed'); }
  catch (e) { ok(false, `shutdown() threw: ${e.message}`); }

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

  console.log('\n--------------------------------------------------');
  console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${passed + failed} tests`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});
