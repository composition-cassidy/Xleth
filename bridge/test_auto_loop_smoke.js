'use strict';
//
// bridge/test_auto_loop_smoke.js — end-to-end smoke for the sampler AUTO loop
// (timeline_autoLoopForSelection). Loads the real native addon, imports three
// corpus WAVs as track-independent regions, runs AUTO on each, and verifies:
//   • the addon actually EXPORTS the method (catches the four-layer "swallowed
//     undefined call" the loop-lab report warns about — at the deepest layer),
//   • the engine returns a valid, period-aligned loop,
//   • the loop was WRITTEN to the region (undoable sampler-settings path), and
//     undo reverts it,
//   • the instant-preview note path does not throw,
//   • timing is within the interactive budget (logged per sample).
//
// Run after `build.bat bridge-clean`:
//   cd bridge && node test_auto_loop_smoke.js
//

const path = require('path');
const fs   = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}

const CORPUS = path.resolve(__dirname, '../loop-lab-corpus');
const DATASET = path.join(CORPUS, 'dataset.json');

function main() {
  console.log('=== sampler AUTO loop smoke ===\n');

  const addon = require('./build/Release/xleth_native.node');
  assert(typeof addon.timeline_autoLoopForSelection === 'function',
    "addon exports 'timeline_autoLoopForSelection' (four-layer bridge, addon layer)");

  assert(addon.initialize() === true, 'initialize()');
  const PROJECT_DIR = path.resolve(__dirname, '_test_auto_loop');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.project_create(PROJECT_DIR, 'AutoLoopSmoke') === true, 'project_create()');

  const dataset = JSON.parse(fs.readFileSync(DATASET, 'utf8'));
  // Three representative corpus samples (two hard-tuned, one natural vibrato).
  const wanted = ['hard_tuned_vocal_0004', 'hard_tuned_vocal_0013', 'natural_vocal_0023'];
  const entries = wanted.map((id) => dataset.find((e) => e.sample_id === id)).filter(Boolean);
  assert(entries.length === 3, 'found 3 corpus entries');

  for (const entry of entries) {
    const wav = path.join(CORPUS, entry.file);
    console.log(`\n[ ${entry.sample_id} ]  ${entry.file}`);
    if (!fs.existsSync(wav)) { assert(false, `WAV present: ${wav}`); continue; }

    const durSec = entry.num_samples / entry.sample_rate;
    const sampleId = addon.audio_loadSourceRegion(wav, 0, durSec);
    assert(sampleId >= 0, `audio_loadSourceRegion -> sampleId ${sampleId}`);
    const regionId = addon.timeline_addRegion({ name: entry.sample_id, audioFilePath: wav });
    assert(regionId >= 0, `timeline_addRegion -> regionId ${regionId}`);
    addon.audio_mapRegionToSample(regionId, sampleId);

    const info = addon.timeline_getRegionAudioInfo(regionId);
    assert(info && info.numSamples > 0, `getRegionAudioInfo numSamples=${info && info.numSamples} engineSR=${info && info.engineSampleRate}`);

    // Convert the gold region (FILE domain, 44100) to the engine buffer domain
    // this machine actually stored the sample at — never assume it is 48000.
    const ratio = info.engineSampleRate / entry.sample_rate;
    const selStart = Math.round(entry.gold_loop.start * ratio);
    const selEnd = Math.round(entry.gold_loop.end * ratio);

    const t0 = process.hrtime.bigint();
    const res = addon.timeline_autoLoopForSelection(regionId, selStart, selEnd);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    assert(res && res.valid === true, `AUTO valid (reason='${res && res.reason}')`);
    if (res && res.valid) {
      const advance = res.loopEnd - res.loopStart - res.crossfadeSamples;
      const kFromAdvance = advance / res.period;
      console.log(`    loop=[${res.loopStart}..${res.loopEnd}] xfade=${res.crossfadeSamples} ` +
                  `period=${res.period.toFixed(2)} k=${res.periodMultiple} ` +
                  `advance/period=${kFromAdvance.toFixed(3)} gates=${JSON.stringify(res.gatesBound)}`);
      console.log(`    sampleDurationSec=${res.sampleDurationSec.toFixed(3)} AUTO time=${ms.toFixed(1)} ms`);
      assert(res.loopEnd > res.loopStart, 'loopEnd > loopStart');
      assert(res.crossfadeSamples >= 0 && res.crossfadeSamples <= (res.loopEnd - res.loopStart) / 2,
        'crossfade within half-loop clamp');
      assert(Math.abs(kFromAdvance - Math.round(kFromAdvance)) < 0.1,
        'audible advance is a whole period multiple');
      assert(ms <= 250, `AUTO time <= 250 ms (${ms.toFixed(1)} ms)`);

      // The loop was written to the region via the undoable command.
      const region = addon.timeline_getRegions().find((r) => r.id === regionId);
      assert(region && region.loopEnabled === true && Number(region.loopStart) === res.loopStart &&
             Number(region.loopEnd) === res.loopEnd && Number(region.crossfadeSamples) === res.crossfadeSamples,
        'region loop fields written to match AUTO result');

      addon.undo_undo();
      const afterUndo = addon.timeline_getRegions().find((r) => r.id === regionId);
      assert(afterUndo && (afterUndo.loopEnabled === false || Number(afterUndo.loopStart) !== res.loopStart),
        'undo reverts the AUTO loop (single undo step)');
      addon.undo_redo();

      // Instant-preview path must not throw.
      let previewOk = true;
      try {
        addon.timeline_previewNote(regionId, entry.root_note ?? 60, 0.8);
        addon.timeline_previewNoteOff(regionId, entry.root_note ?? 60);
      } catch (e) { previewOk = false; console.error('    preview error:', e.message); }
      assert(previewOk, 'preview note path does not throw');
    }
  }

  console.log(`\n=== ${failed === 0 ? 'PASSED' : 'FAILED'}  (${passed} pass / ${failed} fail) ===`);
  try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch {}
  process.exit(failed === 0 ? 0 : 1);
}

main();
