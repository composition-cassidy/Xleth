'use strict';
//
// bridge/test_sampler_live_settings.js — every region / sampler setting reaches
// the sampler that is actually playing.
//
// A Sampler copies everything it plays from its region at build time (settings,
// modulation, and its own copy of the PCM). So an RPC that changes any of that
// has to get the live samplers rebuilt, or the model says one thing while the
// audio thread keeps playing another until the next Play. This test drives each
// such RPC through the real addon and reads the result back off the LIVE
// samplers with diag_getSamplerState:
//
//   builtFrom   the settings + SampleBank ids the sampler was built from
//   stale       builtFrom no longer matches the region (must never be true)
//   buildSerial bumps when a sampler is rebuilt — a carry-over keeps its serial
//   live        values read straight off the Sampler (slot count, which slots
//               sound, MANGLE instance count, modulation route count)
//
// It also holds the other half of the bargain: editing one region must NOT
// rebuild another region's samplers (their notes keep sounding).
//
// Run after rebuilding the native addon:
//   cd bridge && node test_sampler_live_settings.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function pickNativeConfig() {
  for (const config of ['Release', 'Debug']) {
    const addonPath = path.resolve(__dirname, 'build', config, 'xleth_native.node');
    if (fs.existsSync(addonPath)) return { config, addonPath };
  }
  throw new Error('xleth_native.node not found in bridge/build/Debug or bridge/build/Release');
}

const native = pickNativeConfig();
const dllDirs = [
  path.dirname(native.addonPath),
  path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin'),
  path.resolve(__dirname, '../build/engine', native.config),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}
function skip(reason) {
  console.log(`  SKIP  ${reason}`);
  console.log(`\n${passed} passed, ${failed} failed (skipped)`);
  process.exit(0);
}
const same = (a, b) => (typeof a === 'number' && typeof b === 'number')
  ? Math.abs(a - b) < 1e-4 : JSON.stringify(a) === JSON.stringify(b);

const ffmpeg = path.resolve(__dirname, '../vendor/ffmpeg/bin/ffmpeg.exe');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-sampler-live-'));
const wav = (name) => path.join(tmpDir, name);
function synth(out, freq) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2:sample_rate=48000`,
    '-ac', '2', out,
  ], { encoding: 'utf8' }).status === 0;
}

const PPQ = 960;
let addon = null;

try {
  if (!fs.existsSync(ffmpeg)) skip('vendored FFmpeg not present — cannot synthesise audio');
  if (!synth(wav('a.wav'), 220) || !synth(wav('b.wav'), 440) || !synth(wav('c.wav'), 330)
      || !synth(wav('d.wav'), 550)) skip('FFmpeg failed to write the test tones');

  addon = require(native.addonPath);
  ok(typeof addon.diag_getSamplerState === 'function', 'addon exports diag_getSamplerState');
  ok(addon.initialize({}) === true, 'engine initializes');
  ok(addon.project_create(path.join(tmpDir, 'project'), 'SamplerLive') === true, 'project created');

  // ── Two instruments: region A on track 1, region B on track 2 ──────────────
  const makeInstrument = (name, file) => {
    const sourceId = addon.project_importSource(file);
    const regionId = addon.timeline_addRegion({ name, label: 'Tone', sourceId, startTime: 0, endTime: 2 });
    const trackId = addon.timeline_addTrack({ name, volume: 1.0, order: 0 });
    addon.timeline_convertToPatternTrack(trackId);
    const patternId = addon.timeline_addPattern({ name, regionId, lengthTicks: 4 * PPQ });
    addon.timeline_addPatternBlock({ trackId, patternId, positionTicks: 0, durationTicks: 16 * PPQ, offsetTicks: 0 });
    return { sourceId, regionId, trackId, patternId };
  };
  const A = makeInstrument('A', wav('a.wav'));
  const B = makeInstrument('B', wav('b.wav'));
  ok(A.regionId >= 0 && B.regionId >= 0 && A.trackId >= 0 && B.trackId >= 0, 'two instruments created');

  const state = () => addon.diag_getSamplerState();
  const playbackOf = (regionId) => state().playback.filter((s) => s.regionId === regionId);
  const previewOf = (regionId) => state().preview.find((s) => s.regionId === regionId);
  const modelOf = (regionId) => addon.timeline_getRegions().find((r) => r.id === regionId);
  const noStale = () => {
    const s = state();
    return s.playback.every((x) => x.stale === false) && s.preview.every((x) => x.stale === false);
  };
  // Every live sampler of `regionId` (playback, and preview when one exists)
  // satisfies `check(entry)`.
  const everyLive = (regionId, check) => {
    const pb = playbackOf(regionId);
    const pv = previewOf(regionId);
    return pb.length > 0 && pb.every(check) && (!pv || check(pv));
  };

  // ── audio_loadRegionAudio: mapping a region's audio builds its sampler ─────
  console.log('\n[ audio_loadRegionAudio ]');
  ok(addon.audio_loadRegionAudio(A.regionId) >= 0 && addon.audio_loadRegionAudio(B.regionId) >= 0,
     'both regions decode');
  ok(playbackOf(A.regionId).length === 1 && playbackOf(B.regionId).length === 1,
     'each region has a live playback sampler as soon as its audio is mapped');
  ok(everyLive(A.regionId, (s) => s.live.slots[0].hasAudio === true), 'and it holds audio');
  ok(noStale(), 'nothing is stale');

  // A preview sampler too, so every check below covers both kinds.
  addon.timeline_previewNote(A.regionId, 60, 0.8);
  addon.timeline_previewAllNotesOff(A.regionId);
  ok(!!previewOf(A.regionId), 'region A has a preview sampler');

  const serialB0 = playbackOf(B.regionId)[0].buildSerial;

  // ── timeline_updateSamplerSettings: every region-level key ─────────────────
  console.log('\n[ timeline_updateSamplerSettings — sampler-level keys ]');
  const regionKeys = [
    ['crossfadeEnabled', true], ['monoEnabled', true], ['legatoEnabled', true], ['voiceCount', 7],
    ['portamentoEnabled', true], ['portamentoTimeMs', 222], ['portamentoMode', 1], ['portamentoCurve', 0.5],
    ['arpEnabled', true], ['arpTempoSync', false], ['arpDivision', 16], ['arpFreeTimeMs', 77],
    ['arpGate', 0.4], ['arpRange', 3], ['arpDirection', 2],
  ];
  for (const [key, value] of regionKeys) {
    const before = playbackOf(A.regionId)[0].buildSerial;
    addon.timeline_updateSamplerSettings(A.regionId, { [key]: value });
    const model = modelOf(A.regionId)[key];
    ok(same(model, value) && everyLive(A.regionId, (s) => s.stale === false && same(s.builtFrom[key], value))
       && playbackOf(A.regionId)[0].buildSerial > before,
       `${key} = ${value} reached the live samplers (model ${model})`);
  }

  // ── timeline_updateSamplerSettings: every per-slot key ─────────────────────
  console.log('\n[ timeline_updateSamplerSettings — slot keys ]');
  const slotKeys = [
    ['rootNote', 55], ['octave', 1], ['semitone', 3], ['fine', 12.5], ['coarse', -2],
    ['volume', 0.5], ['pan', -0.25],
    ['smpStart', 100], ['smpLength', 20000], ['declickMs', 3], ['fadeInMs', 5], ['fadeOutMs', 7],
    ['loopEnabled', true], ['loopStart', 1000], ['loopEnd', 5000], ['crossfadeSamples', 64],
    ['loopMode', 1], ['exitLoopOnRelease', true],
    ['dcOffsetRemoved', true], ['normalized', true], ['polarityReversed', true], ['reversed', true],
    ['prepAlgorithm', 3], ['prepShiftCents', 50], ['prepStretch', 1.25],
  ];
  for (const [key, value] of slotKeys) {
    addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, [key]: value });
    const model = modelOf(A.regionId).slots[0][key];
    ok(same(model, value)
       && everyLive(A.regionId, (s) => s.stale === false && same(s.builtFrom.slots[0][key], value)),
       `slot.${key} = ${value} reached the live samplers (model ${model})`);
  }
  // PREP back to unity so no bake is left running against the rest of the test.
  addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, prepStretch: 1.0, prepShiftCents: 0 });

  // Mute / solo / MANGLE are also readable straight off the live Sampler.
  addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, mute: true });
  ok(everyLive(A.regionId, (s) => s.builtFrom.slots[0].mute === true && s.live.slots[0].sounds === false),
     'slot.mute: the live sampler\'s slot no longer sounds');
  addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, mute: false, solo: true });
  ok(everyLive(A.regionId, (s) => s.builtFrom.slots[0].solo === true && s.live.slots[0].sounds === true),
     'slot.solo reached the live samplers');
  addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, solo: false,
    mangleChain: [{ mode: 18, amount: 0.8, mix: 1, bypass: false }, { mode: 14, amount: 0.3, mix: 0.9, bypass: false }] });
  ok(everyLive(A.regionId, (s) => s.builtFrom.slots[0].mangleChain.length === 2 && s.live.slots[0].mangleCount === 2),
     'slot.mangleChain: the live sampler runs a 2-instance chain');

  // ── timeline_setSamplerModulation ─────────────────────────────────────────
  console.log('\n[ timeline_setSamplerModulation ]');
  const routes = [
    { source: 0, target: 1, index: 0, stage: 0, amount: 0.5, bipolar: false },   // ENV1 -> slot volume
    { source: 6, target: 2, index: 0, stage: 0, amount: -0.25, bipolar: true },  // LFO1 -> slot pan
  ];
  const modResult = addon.timeline_setSamplerModulation(A.regionId, { routes });
  ok(modResult && modResult.routeCount === 2, 'two routes accepted');
  ok(everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.modulation.routes.length === 2
                                 && s.live.modulationRoutes === 2),
     'the live samplers compiled the two routes');

  // ── Slot list: add / set audio / duplicate / remove ───────────────────────
  console.log('\n[ sample slots ]');
  const added = addon.timeline_addSampleSlot(A.regionId, wav('c.wav'));
  ok(added && added.success === true && added.slotIndex === 1, `slot added (${added && added.error})`);
  ok(everyLive(A.regionId, (s) => s.stale === false && s.live.slotCount === 2 && s.live.slots[1].hasAudio === true
                                 && s.builtFrom.bankIds.length === 2 && s.builtFrom.bankIds[1] >= 0),
     'addSampleSlot: the live samplers play two layers');
  const bank1 = playbackOf(A.regionId)[0].builtFrom.bankIds[1];
  const retarget = addon.timeline_setSlotAudio(A.regionId, 1, wav('d.wav'));
  ok(retarget && retarget.success === true, `slot audio retargeted (${retarget && retarget.error})`);
  ok(everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.bankIds[1] !== bank1 && s.builtFrom.bankIds[1] >= 0),
     'setSlotAudio: the live samplers hold the new audio');
  const dup = addon.timeline_duplicateSampleSlot(A.regionId, 1);
  ok(dup && dup.success === true, `slot duplicated (${dup && dup.error})`);
  ok(everyLive(A.regionId, (s) => s.stale === false && s.live.slotCount === 3 && s.live.slots[2].hasAudio === true),
     'duplicateSampleSlot: the live samplers play three layers');
  const removed = addon.timeline_removeSampleSlot(A.regionId, 1);
  ok(removed && removed.success === true, `slot removed (${removed && removed.error})`);
  ok(everyLive(A.regionId, (s) => s.stale === false && s.live.slotCount === 2 && s.builtFrom.slots.length === 2),
     'removeSampleSlot: the live samplers are back to two layers');

  // ── Region audio: swap / relink / revert / raw remap ──────────────────────
  console.log('\n[ region audio ]');
  const bank0 = () => playbackOf(A.regionId)[0].builtFrom.bankIds[0];
  const liveBankIs = (id) => everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.bankIds[0] === id);
  const original = bank0();
  const swap = addon.audio_swapRegionAudio(A.regionId, wav('b.wav'));
  ok(swap && swap.success === true, `audio swapped (${swap && swap.error})`);
  const swapped = bank0();
  ok(swapped !== original && liveBankIs(swapped), 'audio_swapRegionAudio: the live samplers hold the swapped audio');

  const relinked = addon.project_relinkRegionAudio(A.regionId, wav('c.wav'));
  ok(relinked === true, 'project_relinkRegionAudio succeeds');
  ok(bank0() !== swapped && noStale(), 'project_relinkRegionAudio: the live samplers hold the relinked audio');

  const beforeRevert = bank0();
  const revert = addon.audio_revertRegionAudio(A.regionId);
  ok(revert && revert.success === true, 'audio reverted');
  ok(bank0() !== beforeRevert && noStale(), 'audio_revertRegionAudio: the live samplers hold the original audio again');

  const rawId = addon.audio_loadSourceRegion(wav('d.wav'), 0, 2);
  addon.audio_mapRegionToSample(A.regionId, rawId);
  ok(rawId >= 0 && liveBankIs(rawId), 'audio_mapRegionToSample: the live samplers hold the remapped audio');

  // ── timeline_modifyRegion: a region patch can carry slot settings ─────────
  console.log('\n[ timeline_modifyRegion ]');
  addon.timeline_modifyRegion(A.regionId, { rootNote: 48 });
  ok(modelOf(A.regionId).slots[0].rootNote === 48
     && everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.slots[0].rootNote === 48),
     'a slot key patched through modifyRegion reached the live samplers');
  const beforeRename = playbackOf(A.regionId)[0].buildSerial;
  addon.timeline_modifyRegion(A.regionId, { ...modelOf(A.regionId), name: 'A renamed' });
  ok(modelOf(A.regionId).name === 'A renamed' && playbackOf(A.regionId)[0].buildSerial === beforeRename
     && noStale(), 'a rename rebuilds nothing');

  // ── timeline_autoLoopForSelection ─────────────────────────────────────────
  console.log('\n[ timeline_autoLoopForSelection ]');
  {
    const res = addon.timeline_autoLoopForSelection(A.regionId, 0.2, 1.6);
    const slot0 = modelOf(A.regionId).slots[0];
    ok(noStale() && everyLive(A.regionId, (s) => s.builtFrom.slots[0].loopStart === slot0.loopStart
                                               && s.builtFrom.slots[0].loopEnd === slot0.loopEnd
                                               && s.builtFrom.slots[0].loopEnabled === slot0.loopEnabled),
       `auto-loop result (${res && (res.success ?? res.ok)}) matches the live samplers ` +
       `(loop ${slot0.loopStart}..${slot0.loopEnd})`);
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  addon.timeline_updateSamplerSettings(A.regionId, { voiceCount: 5 });
  addon.timeline_updateSamplerSettings(A.regionId, { voiceCount: 9 });
  addon.undo_undo();
  ok(modelOf(A.regionId).voiceCount === 5
     && everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.voiceCount === 5),
     'undo: playback AND preview samplers are back on the previous value');
  addon.undo_redo();
  ok(everyLive(A.regionId, (s) => s.stale === false && s.builtFrom.voiceCount === 9),
     'redo: playback AND preview samplers take the value again');

  // ── The other region was never rebuilt by any of the above ────────────────
  console.log('\n[ isolation ]');
  {
    // Undo/redo above are full rebuilds by design, so compare across the
    // region-scoped edits only: one more of each kind, then check B.
    const serialB1 = playbackOf(B.regionId)[0].buildSerial;
    addon.timeline_updateSamplerSettings(A.regionId, { voiceCount: 11 });
    addon.timeline_updateSamplerSettings(A.regionId, { slotIndex: 0, volume: 0.75 });
    addon.timeline_setSamplerModulation(A.regionId, { routes: [] });
    addon.timeline_modifyRegion(A.regionId, { rootNote: 50 });
    ok(playbackOf(B.regionId)[0].buildSerial === serialB1,
       'editing region A did not rebuild region B\'s sampler');
    ok(serialB0 > 0 && noStale(), 'and nothing is stale');
  }

  // ── timeline_setPatternRegion ─────────────────────────────────────────────
  console.log('\n[ timeline_setPatternRegion ]');
  addon.timeline_setPatternRegion(B.patternId, A.regionId);
  {
    const s = state();
    ok(s.playback.some((x) => x.trackId === B.trackId && x.regionId === A.regionId)
       && !s.playback.some((x) => x.regionId === B.regionId) && noStale(),
       'track B now plays region A; region B\'s sampler is gone');
  }
  addon.timeline_setPatternRegion(B.patternId, B.regionId);
  ok(playbackOf(B.regionId).length === 1 && noStale(), 'and back');

  // ── timeline_removeRegion ─────────────────────────────────────────────────
  console.log('\n[ timeline_removeRegion ]');
  addon.timeline_previewNote(B.regionId, 60, 0.8);
  addon.timeline_previewAllNotesOff(B.regionId);
  ok(!!previewOf(B.regionId), 'region B has a preview sampler');
  addon.timeline_removeRegion(B.regionId);
  ok(playbackOf(B.regionId).length === 0 && !previewOf(B.regionId),
     'removing a region drops its playback and preview samplers');
  ok(playbackOf(A.regionId).length === 1 && noStale(), 'region A is unaffected');
  addon.undo_undo();
  ok(playbackOf(B.regionId).length === 1 && noStale(), 'undo brings region B\'s sampler back');

  addon.shutdown();
  addon = null;
} catch (err) {
  console.error(`  FAIL  threw: ${err && err.stack ? err.stack : err}`);
  failed += 1;
  try { if (addon) addon.shutdown(); } catch (_) { /* already down */ }
} finally {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
