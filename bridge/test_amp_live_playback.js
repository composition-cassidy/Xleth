'use strict';
//
// bridge/test_amp_live_playback.js - Amp Stack audible-in-live-playback check
//
// The contract test (test_amp_bridge.js) proves the node instantiates, takes
// parameters and persists. This one proves the thing the contract test cannot:
// that audio actually flows THROUGH XlethAmpEffect on the live audio device and
// that the parameters move the sound.
//
// Method: one real audio clip on one track, transport rolling, and the engine's
// own post-fader track peak meter read back per phase.
//   1. no effect                -> baseline peak
//   2. amp @ Output -24 dB      -> peak must drop by roughly 24 dB
//   3. amp @ Output   0 dB      -> peak must come back up
//   4. amp bypassed             -> peak must return to (about) baseline
//   5. amp @ Mix 0 %            -> dry path only, peak back at baseline
//   6. amp @ Drive 10, model 4  -> a clearly different peak from the clean pass
//
// Needs an audio device (the peak meter only advances while the device callback
// runs). Run after rebuilding the native addon:
//   node bridge/test_amp_live_playback.js
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

function db(x) { return x > 1e-9 ? 20 * Math.log10(x) : -Infinity; }

function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

// Peak meters are a decaying "highest since last read", so a single sample is
// noise. Roll the transport from the top of the clip and take the LOUDEST of a
// short poll burst — that is the phase's real level.
async function measurePeak(trackId, label) {
  addon.transport_seek(0);
  addon.play();
  await sleep(400);                     // let the device settle on this setting
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

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_amp_live_test');
const AUDIO = path.resolve(__dirname, '../docs/plans/hall_ab_renders/hall_before_chord.wav');
const PPQ = 960;

(async () => {
  console.log('=== Amp Stack live-playback audibility check ===\n');

  if (!fs.existsSync(AUDIO)) {
    console.error(`Test audio missing: ${AUDIO}`);
    process.exit(0);
  }

  let initOk = false;
  try { initOk = addon.initialize(); }
  catch (err) {
    console.error(`Engine init failed: ${err.message}`);
    console.error('SKIPPING - this test needs an audio device.');
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'AmpLiveTest') === true, 'project_create() returns true');

  console.log('\n[ one track, one real audio clip ]');
  addon.setBPM(120);
  const trackId = addon.timeline_addTrack({ name: 'Amp Live', volume: 1.0, order: 0 });
  ok(Number.isInteger(trackId) && trackId >= 0, `timeline_addTrack -> ${trackId}`);

  const sampleId = addon.audio_loadSourceRegion(AUDIO, 0, 4);
  ok(Number.isInteger(sampleId) && sampleId >= 0, `audio_loadSourceRegion -> sampleId=${sampleId}`);

  const regionId = addon.timeline_addRegion({
    name: 'R', label: 'R', startTime: 0, endTime: 4, audioFilePath: AUDIO,
  });
  ok(Number.isInteger(regionId) && regionId >= 0, `timeline_addRegion -> regionId=${regionId}`);
  addon.audio_mapRegionToSample(regionId, sampleId);

  const clipId = addon.timeline_addClip({
    trackId, regionId, positionTicks: 0, durationTicks: PPQ * 8, velocity: 1.0,
  });
  ok(clipId !== undefined, `timeline_addClip -> ${JSON.stringify(clipId)}`);

  console.log('\n[ 1. baseline, no effect ]');
  const baseline = await measurePeak(trackId, 'dry track');
  ok(baseline > 0.01, `dry track is actually making sound (peak ${baseline.toFixed(4)})`);
  if (!(baseline > 0.01)) {
    console.error('  No audio on the track — the rest of this test cannot mean anything.');
    addon.shutdown?.();
    process.exit(1);
  }

  console.log('\n[ 2. amp inserted, Output -24 dB ]');
  const nodeId = getNodeId(addon.audio_addEffect(trackId, 'amp', 0));
  ok(nodeId >= 0, `audio_addEffect("amp") -> nodeId=${nodeId}`);
  // Clean model, unity drive, dry-ish tone so the only big change is the trim.
  addon.audio_setEffectParameter(trackId, nodeId, 'model', 0);   // Blackface Clean
  addon.audio_setEffectParameter(trackId, nodeId, 'drive', 0);
  addon.audio_setEffectParameter(trackId, nodeId, 'output', -24);
  const trimmed = await measurePeak(trackId, 'amp @ output -24 dB');
  const trimDelta = db(trimmed) - db(baseline);
  ok(trimDelta < -12,
     `Output -24 dB audibly attenuates the live signal (delta ${trimDelta.toFixed(2)} dB)`);

  console.log('\n[ 3. Output back to 0 dB ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'output', 0);
  const restored = await measurePeak(trackId, 'amp @ output 0 dB');
  ok(db(restored) - db(trimmed) > 10,
     `Output 0 dB brings the level back (delta ${(db(restored) - db(trimmed)).toFixed(2)} dB)`);

  console.log('\n[ 4. bypass ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'output', -24);
  addon.audio_setEffectBypass(trackId, nodeId, true);
  const bypassed = await measurePeak(trackId, 'amp bypassed (output still -24)');
  ok(Math.abs(db(bypassed) - db(baseline)) < 1.5,
     `bypass restores the dry level (delta from baseline ${(db(bypassed) - db(baseline)).toFixed(2)} dB)`);
  addon.audio_setEffectBypass(trackId, nodeId, false);

  console.log('\n[ 5. Mix 0 % is the dry path ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'output', 0);
  addon.audio_setEffectParameter(trackId, nodeId, 'mix', 0);
  const dryMix = await measurePeak(trackId, 'amp @ mix 0 %');
  ok(Math.abs(db(dryMix) - db(baseline)) < 1.5,
     `Mix 0 % matches the dry level (delta ${(db(dryMix) - db(baseline)).toFixed(2)} dB)`);

  console.log('\n[ 6. a driven model sounds different from the clean one ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'mix', 100);
  addon.audio_setEffectParameter(trackId, nodeId, 'model', 0);
  addon.audio_setEffectParameter(trackId, nodeId, 'drive', 0);
  const clean = await measurePeak(trackId, 'Blackface Clean, drive 0');
  addon.audio_setEffectParameter(trackId, nodeId, 'model', 4);   // Rectifier
  addon.audio_setEffectParameter(trackId, nodeId, 'drive', 10);
  const driven = await measurePeak(trackId, 'Rectifier, drive 10');
  ok(Math.abs(db(driven) - db(clean)) > 1.0,
     `Model + Drive change the live output (delta ${(db(driven) - db(clean)).toFixed(2)} dB)`);

  console.log('\n[ 7. every model passes audio (no silent/blown-up voicing) ]');
  addon.audio_setEffectParameter(trackId, nodeId, 'drive', 5);
  for (let m = 0; m < 6; m += 1) {
    addon.audio_setEffectParameter(trackId, nodeId, 'model', m);
    const p = await measurePeak(trackId, `model ${m}`);
    ok(p > 0.005 && p < 4.0, `model ${m} output is alive and bounded (peak ${p.toFixed(4)})`);
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  try { addon.shutdown?.(); } catch (_) { /* best effort */ }
  process.exit(failed === 0 ? 0 : 1);
})();
