'use strict';
//
// bridge/test_pitchshifter_bridge.js - Pitch Shifter (XlethPitchShifterEffect)
// registration contract + live-playback smoke test.
//
// Exercises the bridge calls the Pitch Shifter UI path will use, through the
// SAME native entry points the renderer reaches via window.xleth.audio. The
// four-layer bridge optional-chains past undefined methods, so reading the
// renderer proves nothing - this file calls each one for real and asserts.
//
// Covered:
//   timeline_addTrack              - a real track to hang the chain on
//   audio_addEffect                - "pitchshifter" resolves in
//                                    AudioGraph::createEffect
//   audio_getEffectChain           - the node is on the TRACK chain
//   audio_getEffectParameters      - exactly the 10-parameter surface,
//                                    ranges + defaults
//   audio_setEffectParameter       - round-trip for all 10, incl. both choice
//                                    params and the bool, plus range clamping
//   audio_getEffectLatency         - non-zero in Granular/Smart/Voice, and
//                                    EXACTLY 0 in Clip
//   audio_addGraphEffectNode +
//   audio_getGraphEffectParameters - the automatable flags, read from the ONE
//                                    exporter that reports them
//                                    (GraphEffectParameters.cpp). mode and
//                                    every clip_* must be false; the six
//                                    realtime params must be true.
//   live playback                  - a peak burst per mode: finite, non-NaN,
//                                    plausible level
//   audio_removeEffect             - teardown
//
// Run after rebuilding the native addon:
//   node bridge/test_pitchshifter_bridge.js
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

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol,
     `${label} (expected ~${expected}, got ${actual}, tol +/-${tol})`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function db(x) { return x > 1e-9 ? 20 * Math.log10(x) : -Infinity; }

function parseJson(text, label) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); }
  catch (err) { ok(false, `${label} returns valid JSON (${err.message})`); return null; }
}

function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

function getParams(trackId, nodeId) {
  return parseJson(addon.audio_getEffectParameters(trackId, nodeId),
                   'audio_getEffectParameters');
}

function findParam(params, id) {
  return Array.isArray(params) ? params.find((p) => p.id === id) : null;
}

function getParamValue(trackId, nodeId, id) {
  const p = findParam(getParams(trackId, nodeId), id);
  return p ? p.value : undefined;
}

function latencySamples(trackId, nodeId) {
  const lat = parseJson(addon.audio_getEffectLatency(trackId, nodeId),
                        'audio_getEffectLatency');
  return lat?.samples ?? lat?.latencySamples ?? lat?.latency;
}

// ── Parameter surface ───────────────────────────────────────────────────────
// [id, min, max, default]. mode is the 4 modes (0..3, default 0 = Granular).
// clip_method offers the five LIVE StretchMethod engines (the Global sentinel
// is deliberately not exposed), default index 1 = Rubber.
const SPEC_PARAMS = [
  ['mode',            0,    3,    0],
  ['mix',             0,    1,    1],
  ['semitones',      -24,   24,   0],
  ['cents',          -100,  100,  0],
  ['size',            10,   100,  50],
  ['formant',         0.5,  2,    1],
  ['clip_semitones', -24,   24,   0],
  ['clip_cents',     -100,  100,  0],
  ['clip_method',     0,    4,    1],
  ['clip_formant',    0,    1,    0],
];

// Deliberately-not-default values, one per parameter, for the round-trip.
const PROBE_VALUES = [
  ['mode',            2],      // Voice
  ['mix',             0.65],
  ['semitones',      -7],
  ['cents',           33],
  ['size',            72],
  ['formant',         1.4],
  ['clip_semitones',  5],
  ['clip_cents',     -60],
  ['clip_method',     4],      // WORLD
  ['clip_formant',    1],
];

// mode + every clip_* is withAutomatable(false); the six realtime params are
// automatable. This is the contract the automation lane and the FX-graph
// modulation ports read (EnvelopeParameterModulation treats automatable ===
// false as ReadOnly), so it is asserted against the real exporter.
const AUTOMATABLE = {
  mode: false,
  mix: true,
  semitones: true,
  cents: true,
  size: true,
  formant: true,
  clip_semitones: false,
  clip_cents: false,
  clip_method: false,
  clip_formant: false,
};

const MODES = [
  ['Granular', 0],
  ['Smart',    1],
  ['Voice',    2],
  ['Clip',     3],
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_pitchshifter_bridge_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;

// Peak meters are a decaying "highest since last read", so a single sample is
// noise. Roll the transport from the top of the clip and take the LOUDEST of a
// short poll burst.
async function measurePeak(trackId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(400);
  let best = 0;
  for (let i = 0; i < 40; i += 1) {
    const p = addon.audio_getTrackPeak(trackId);
    best = Math.max(best, p?.peakL ?? 0, p?.peakR ?? 0);
    await sleep(25);
  }
  addon.stop();
  console.log(`  info  ${label}: peak ${best.toFixed(5)} (${db(best).toFixed(2)} dBFS)`);
  return best;
}

(async () => {
  console.log('=== Pitch Shifter (XlethPitchShifterEffect) bridge test ===\n');

  let initOk = false;
  try { initOk = addon.initialize(); }
  catch (err) {
    console.error(`Engine init failed: ${err.message}`);
    console.error('SKIPPING - this test needs an audio device.');
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'PitchShifterBridgeTest') === true,
     'project_create() returns true');

  console.log('\n[ track + instantiation ]');
  const trackRaw = addon.timeline_addTrack({ name: 'Pitch Test', volume: 1.0, order: 0 });
  const trackId = typeof trackRaw === 'number' ? trackRaw : getNodeId(trackRaw);
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack() -> trackId=${trackId}`);
  if (!(trackId >= 0)) process.exit(1);

  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'pitchshifter', 0));
  ok(nodeId >= 0, `audio_addEffect(${trackId}, "pitchshifter", 0) -> nodeId=${nodeId}`);
  if (nodeId < 0) {
    console.error('  pitchshifter did not resolve in AudioGraph::createEffect '
                  + '- factory registration is missing.');
    process.exit(1);
  }

  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const entry = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(!!entry, 'audio_getEffectChain lists the node on the TRACK chain');
    ok(entry?.pluginId === 'pitchshifter',
       `chain entry pluginId is "pitchshifter" (got ${entry?.pluginId})`);
    ok(entry?.bypassed === false, 'chain entry starts un-bypassed');
  }

  console.log('\n[ parameter surface ]');
  const params = getParams(trackId, nodeId);
  ok(Array.isArray(params), 'audio_getEffectParameters returns an array');
  if (!Array.isArray(params)) process.exit(1);

  ok(params.length === SPEC_PARAMS.length,
     `exposes exactly ${SPEC_PARAMS.length} parameters `
     + `(got ${params.length}: ${params.map((p) => p.id).join(', ')})`);

  for (const [id, min, max, def] of SPEC_PARAMS) {
    const p = findParam(params, id);
    ok(!!p, `parameter "${id}" exists`);
    if (!p) continue;
    near(p.min, min, 1e-4, `${id}.min`);
    near(p.max, max, 1e-4, `${id}.max`);
    near(p.default, def, 1e-4, `${id}.default`);
  }

  console.log('\n[ set/get round-trip, every parameter ]');
  for (const [id, value] of PROBE_VALUES) {
    addon.audio_setEffectParameter(trackId, nodeId, id, value);
    const back = getParamValue(trackId, nodeId, id);
    // Choice params quantise to their step; floats come back essentially exact.
    near(back, value, 1e-3, `${id} round-trips ${value}`);
  }

  console.log('\n[ out-of-range clamping ]');
  {
    addon.audio_setEffectParameter(trackId, nodeId, 'semitones', 999);
    near(getParamValue(trackId, nodeId, 'semitones'), 24, 1e-3,
         'semitones clamps above the range');
    addon.audio_setEffectParameter(trackId, nodeId, 'semitones', -999);
    near(getParamValue(trackId, nodeId, 'semitones'), -24, 1e-3,
         'semitones clamps below the range');
    addon.audio_setEffectParameter(trackId, nodeId, 'size', 9999);
    near(getParamValue(trackId, nodeId, 'size'), 100, 1e-3,
         'size clamps to the 100 ms maximum');
    addon.audio_setEffectParameter(trackId, nodeId, 'size', 0);
    near(getParamValue(trackId, nodeId, 'size'), 10, 1e-3,
         'size clamps to the 10 ms minimum');
    // Reset to a neutral, fully-wet state for the latency and playback phases.
    addon.audio_setEffectParameter(trackId, nodeId, 'semitones', 0);
    addon.audio_setEffectParameter(trackId, nodeId, 'cents', 0);
    addon.audio_setEffectParameter(trackId, nodeId, 'size', 50);
    addon.audio_setEffectParameter(trackId, nodeId, 'formant', 1);
    addon.audio_setEffectParameter(trackId, nodeId, 'mix', 1);
  }

  console.log('\n[ automatable flags (GraphEffectParameters exporter) ]');
  {
    // audio_getEffectParameters (the APVTS dump) does not carry the flag; the
    // ONE place it is exported is buildGraphEffectParameterDescriptors, which
    // is reachable through a graph-owned instance. Create one purely to read
    // the descriptors.
    const instanceId = 'pitchshifter-bridge-test-instance';
    const addRaw = addon.audio_addGraphEffectNode(trackId, instanceId, 'pitchshifter');
    const graphNodeId = getNodeId(addRaw);
    ok(graphNodeId >= 0,
       `audio_addGraphEffectNode(${trackId}, "${instanceId}", "pitchshifter") `
       + `-> nodeId=${graphNodeId}`);

    if (graphNodeId >= 0) {
      const desc = parseJson(addon.audio_getGraphEffectParameters(trackId, instanceId),
                             'audio_getGraphEffectParameters');
      ok(desc?.ok === true, `audio_getGraphEffectParameters ok (got ${desc?.reason ?? 'ok'})`);
      ok(desc?.pluginId === 'pitchshifter',
         `descriptor pluginId is "pitchshifter" (got ${desc?.pluginId})`);

      const list = desc?.parameters;
      ok(Array.isArray(list), 'descriptors carry a parameters array');
      if (Array.isArray(list)) {
        ok(list.length === SPEC_PARAMS.length,
           `descriptors cover all ${SPEC_PARAMS.length} parameters (got ${list.length})`);
        for (const [id, want] of Object.entries(AUTOMATABLE)) {
          const d = list.find((p) => p.parameterId === id);
          ok(!!d, `descriptor for "${id}" exists`);
          if (!d) continue;
          ok(d.automatable === want,
             `${id}.automatable === ${want} (got ${d.automatable})`);
        }
      }
      addon.audio_removeGraphEffectNode?.(trackId, instanceId);
    }
  }

  console.log('\n[ per-mode latency ]');
  // Granular/Smart/Voice must report real PDC; Clip must report exactly 0.
  // Mode is non-automatable precisely so this re-report is legal.
  const modeLatency = {};
  for (const [name, value] of MODES) {
    addon.audio_setEffectParameter(trackId, nodeId, 'mode', value);
    const samples = latencySamples(trackId, nodeId);
    modeLatency[name] = samples;
    console.log(`  info  mode ${name} -> latency ${samples} samples`);
    if (name === 'Clip') {
      ok(samples === 0, `Clip reports EXACTLY 0 latency (got ${samples})`);
    } else {
      ok(Number.isFinite(samples) && samples > 0,
         `${name} reports non-zero latency (got ${samples})`);
    }
  }
  ok(modeLatency.Granular !== modeLatency.Smart,
     'Granular and Smart report different latencies '
     + `(${modeLatency.Granular} vs ${modeLatency.Smart})`);

  console.log('\n[ live playback: a peak burst per mode ]');
  if (!fs.existsSync(AUDIO)) {
    console.log(`  info  fixture missing (${AUDIO}) - skipping the playback phase.`);
  } else {
    addon.setBPM(120);
    const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
    const regionId = addon.timeline_addRegion({
      name: 'chord', label: 'chord', startTime: 0, endTime: 4, audioFilePath: AUDIO,
    });
    addon.audio_mapRegionToSample(regionId, sampleId);
    addon.timeline_addClip({
      trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0,
    });

    // Baseline with the shifter bypassed, so each mode has something to be
    // "plausible" relative to.
    addon.audio_setEffectBypass(trackId, nodeId, true);
    const baseline = await measurePeak(trackId, 'bypassed (baseline)');
    ok(baseline > 0.01,
       `the track is actually making sound (peak ${baseline.toFixed(4)})`);
    addon.audio_setEffectBypass(trackId, nodeId, false);

    for (const [name, value] of MODES) {
      addon.audio_setEffectParameter(trackId, nodeId, 'mode', value);
      // A musically real setting rather than unity, so each path's DSP runs.
      addon.audio_setEffectParameter(trackId, nodeId, 'semitones',
                                     name === 'Clip' ? 0 : 5);
      const peak = await measurePeak(trackId, `mode ${name}`);

      ok(Number.isFinite(peak), `${name} peak is finite (no NaN/inf)`);
      ok(peak > 0.001, `${name} produces audible output (peak ${peak.toFixed(5)})`);
      // Nothing should blow up: a pitch shifter is not a gain stage, so a peak
      // far above the dry signal means the DSP is diverging.
      ok(peak < baseline * 4,
         `${name} peak is plausible vs baseline `
         + `(${peak.toFixed(4)} < 4x ${baseline.toFixed(4)})`);
    }

    // Clip mode is a pure pass-through, so its peak must land on the bypassed
    // baseline rather than merely "somewhere sensible".
    addon.audio_setEffectParameter(trackId, nodeId, 'mode', 3);
    addon.audio_setEffectParameter(trackId, nodeId, 'semitones', 12);
    const clipPeak = await measurePeak(trackId, 'Clip @ semitones 12 (must be inert)');
    near(clipPeak, baseline, Math.max(0.02, baseline * 0.05),
         'Clip passes the dry signal through untouched, ignoring semitones');
  }

  console.log('\n[ teardown ]');
  ok(addon.audio_removeEffect(trackId, nodeId) !== false,
     'audio_removeEffect returns success');
  {
    const chain = parseJson(addon.audio_getEffectChain(trackId), 'audio_getEffectChain');
    const still = Array.isArray(chain) ? chain.find((e) => e.nodeId === nodeId) : null;
    ok(!still, 'the node is gone from the chain after removal');
  }

  try { addon.shutdown?.(); } catch (_) { /* best effort */ }

  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
