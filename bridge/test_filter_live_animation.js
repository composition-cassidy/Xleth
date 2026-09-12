'use strict';
//
// bridge/test_filter_live_animation.js - XLETH Filter panel animation, end to end
//
// The engine test (engine/test/test_xlethfilter_mod.cpp, case m) proves
// getLiveState's payload in-process. This one proves the thing that test cannot:
// that the SAME payload reaches a renderer through the real shipping addon,
// while real audio is rolling on the live device — which is exactly what the
// panel's 30 Hz loop does.
//
// Method: one real clip on one track, an xlethfilter with a 2 Hz LFO wired to
// slot 0's cutoff, transport rolling, and audio_filterGetLiveState polled the
// way FilterPanel polls it.
//   1. before playback   -> the slot reports its telemetry INVALID and the live
//                           curve is the parked curve (nothing animates yet)
//   2. rolling            -> the slot goes valid, the effective cutoff sweeps,
//                           the lane's source value swings BOTH ways, and the
//                           live curve leaves the parked curve
//
// Needs an audio device (the audio thread is what writes the telemetry). Run
// after rebuilding the native addon:
//   node bridge/test_filter_live_animation.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
const vcpkgDir = path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin');
process.env.PATH = `${vcpkgDir};${dllDir};${process.env.PATH}`;

const addon = require('./build/Release/xleth_native.node');

let passed = 0;
let failed = 0;
let total = 0;

function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else { console.error(`  FAIL  ${label}`); failed += 1; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

// Layout of XlethFilterEffect::getLiveState — kept in the same shape as
// ui/src/stores/filterStore.js decodeLiveState(), which is the real reader.
const HEADER = 4;
const LANE_OFF = 8;
const MAX_LANES = 6;
const STRIDE = LANE_OFF + MAX_LANES * 2;   // 20
const MAX_SLOTS = 8;
const CURVE_OFF = HEADER + MAX_SLOTS * STRIDE;
const CURVE_SIZE = 512;

function readSlot(buf, i) {
  const b = HEADER + i * STRIDE;
  const lanes = [];
  for (let j = 0; j < MAX_LANES; j += 1) {
    lanes.push({ src: buf[b + LANE_OFF + j * 2], accent: buf[b + LANE_OFF + j * 2 + 1] });
  }
  return {
    cutoff: buf[b + 0], q: buf[b + 1], gain: buf[b + 2], morph: buf[b + 3],
    drive: buf[b + 4], mix: buf[b + 5], valid: buf[b + 6] > 0.5, lanes,
  };
}

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_filter_anim_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;
const LFO_LANE = 1;   // lane 0 is left empty on purpose

(async () => {
  console.log('=== XLETH Filter live-animation payload check ===\n');

  if (!fs.existsSync(AUDIO)) {
    console.error(`Missing test audio: ${AUDIO}`);
    process.exit(1);
  }
  fs.mkdirSync(PROJ_DIR, { recursive: true });

  let initOk = false;
  try { initOk = addon.initialize(); }
  catch (err) {
    console.error(`initialize() threw: ${err.message}`);
    process.exit(1);
  }
  ok(initOk === true, 'initialize() returns true');

  addon.project_create(PROJ_DIR, 'FilterAnim');

  const trackId = addon.timeline_addTrack({ name: 'Filter Anim', volume: 1.0, order: 0 });
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack -> ${trackId}`);

  const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
  ok(Number.isInteger(sampleId) && sampleId >= 0, `audio_loadSourceRegion -> ${sampleId}`);

  const regionId = addon.timeline_addRegion({
    name: 'chord', startTime: 0, endTime: 4, audioFilePath: AUDIO,
  });
  addon.audio_mapRegionToSample(regionId, sampleId);
  addon.timeline_addClip({
    trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8,
  });

  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'xlethfilter', 0));
  ok(nodeId >= 0, `audio_addEffect("xlethfilter") -> nodeId=${nodeId}`);

  const slot = addon.audio_filterAddSlot(trackId, nodeId);
  ok(slot === 0, `audio_filterAddSlot -> slot ${slot}`);

  const set = (name, value) => addon.audio_filterSetSlotParam(trackId, nodeId, slot, name, value);
  set('enabled', 1);
  set('type', 0);          // LP12
  set('slope', 2);         // 24 dB, so the corner is unmistakable on the curve
  set('cutoff', 1000);
  set('q', 4);
  set('mix', 1);
  // A 2 Hz free-running sine on cutoff, full depth: four sweeps in two seconds.
  set(`m${LFO_LANE}_kind`, 1);        // Lfo
  set(`m${LFO_LANE}_dest`, 0);        // Cutoff
  set(`m${LFO_LANE}_depth`, 1);
  set(`m${LFO_LANE}_shape`, 0);       // Sine
  set(`m${LFO_LANE}_rate_mode`, 0);   // Free
  set(`m${LFO_LANE}_rate_ms`, 500);   // 2 Hz

  // ── 1. Nothing has played yet ───────────────────────────────────────────────
  const parked = addon.audio_filterGetResponseCurve(trackId, nodeId);
  const cold = addon.audio_filterGetLiveState(trackId, nodeId);

  ok(cold instanceof Float32Array && cold.length === CURVE_OFF + CURVE_SIZE,
     `audio_filterGetLiveState -> Float32Array(${CURVE_OFF + CURVE_SIZE}), got ${cold?.length}`);
  ok(cold[0] === 1, `payload stamps format 1, got ${cold[0]}`);
  ok(Math.round(cold[1]) === 1, `payload reports one slot, got ${cold[1]}`);
  ok(cold[2] > 8000, `payload reports a real sample rate, got ${cold[2]}`);

  let coldDelta = 0;
  for (let i = 0; i < CURVE_SIZE; i += 1) {
    coldDelta = Math.max(coldDelta, Math.abs(cold[CURVE_OFF + i] - parked[i]));
  }
  ok(coldDelta < 1e-3,
     `with no telemetry the live curve IS the parked curve (max delta ${coldDelta.toFixed(6)} dB)`);

  // ── 2. Roll the transport and poll the way the panel does ──────────────────
  addon.transport_seek(0);
  addon.play();
  await sleep(400);                       // let the device settle and the ramps arrive

  let cutLo = Infinity, cutHi = 0;
  let srcLo = Infinity, srcHi = -Infinity;
  let curveDelta = 0;
  let everValid = false;
  let frames = 0;

  // ~2 s at the panel's own ~30 Hz cadence.
  for (let i = 0; i < 60; i += 1) {
    const buf = addon.audio_filterGetLiveState(trackId, nodeId);
    const s = readSlot(buf, 0);
    if (s.valid) {
      everValid = true;
      frames += 1;
      cutLo = Math.min(cutLo, s.cutoff);
      cutHi = Math.max(cutHi, s.cutoff);
      srcLo = Math.min(srcLo, s.lanes[LFO_LANE].src);
      srcHi = Math.max(srcHi, s.lanes[LFO_LANE].src);
      for (let k = 0; k < CURVE_SIZE; k += 1) {
        curveDelta = Math.max(curveDelta, Math.abs(buf[CURVE_OFF + k] - parked[k]));
      }
    }
    await sleep(33);
  }
  addon.stop();

  console.log(`  info  ${frames} live frames; cutoff ${cutLo.toFixed(1)} .. ${cutHi.toFixed(1)} Hz;`
            + ` lane src ${srcLo.toFixed(3)} .. ${srcHi.toFixed(3)};`
            + ` curve moved ${curveDelta.toFixed(2)} dB`);

  ok(everValid, 'playing audio marks the slot telemetry valid');
  ok(frames > 30, `the poll saw a steady stream of live frames, got ${frames}`);
  ok(cutHi > cutLo * 4, `the effective cutoff sweeps (${cutLo.toFixed(1)} .. ${cutHi.toFixed(1)} Hz)`);
  ok(srcLo < -0.5 && srcHi > 0.5,
     `the LFO lane reports a bipolar source (${srcLo.toFixed(3)} .. ${srcHi.toFixed(3)})`);
  ok(curveDelta > 6,
     `the live curve leaves the parked curve while the LFO runs (${curveDelta.toFixed(2)} dB)`);

  // Removing the modulator parks everything again — this is what the panel's
  // "no modulator, no polling" gate relies on being true.
  set(`m${LFO_LANE}_kind`, 0);
  addon.transport_seek(0);
  addon.play();
  await sleep(600);
  addon.stop();
  const settled = readSlot(addon.audio_filterGetLiveState(trackId, nodeId), 0);
  console.log(`  info  after removing the LFO: cutoff ${settled.cutoff.toFixed(1)} Hz,`
            + ` lane src ${settled.lanes[LFO_LANE].src.toFixed(3)}`);
  ok(Math.abs(settled.cutoff - 1000) < 60,
     `removing the modulator parks the cutoff back at 1000 Hz, got ${settled.cutoff.toFixed(1)}`);
  ok(settled.lanes[LFO_LANE].src === 0,
     `a removed lane reports no source value, got ${settled.lanes[LFO_LANE].src}`);

  try { addon.shutdown(); } catch (_) { /* best effort */ }

  console.log(`\n--------------------------------------------------`);
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}`);
    process.exit(1);
  }
  process.exit(0);
})();
