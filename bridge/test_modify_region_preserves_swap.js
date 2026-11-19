'use strict';
//
// bridge/test_modify_region_preserves_swap.js — rename / relabel must not wipe
// the rest of a region.
//
// Regression: timeline_modifyRegion parsed its payload onto a DEFAULT-constructed
// SampleRegion and ModifyRegionCommand then replaced the stored region with it.
// jsToRegion only reads ~10 keys, so renaming a sample from the Browser reset
// everything else — hasSwappedAudio/swappedAudioPath (so the Sample Sandbox lost
// the swapped audio and the loss was then saved into project.json), swapped
// video, proxy state, customLabelName and the whole sampler config.
//
// The three UI callers (rename, dedupe-rename, change label) all send the full
// region object back with one field changed, exactly as simulated below.
//
// Skips (exit 0) when the vendored FFmpeg needed to synthesise audio is absent.
//
// Run after rebuilding the native addon:
//   node bridge/test_modify_region_preserves_swap.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

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

const ffmpeg = path.resolve(__dirname, '../vendor/ffmpeg/bin/ffmpeg.exe');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-modify-region-'));
const wavPath = path.join(tmpDir, 'tone.wav');
const swapSrc = path.join(tmpDir, 'processed.wav');
const projectDir = path.join(tmpDir, 'project');

function synth(out, freq) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=2:sample_rate=48000`,
    '-ac', '2', out,
  ], { encoding: 'utf8' });
}

let addon = null;
try {
  if (!fs.existsSync(ffmpeg)) skip('vendored FFmpeg not present — cannot synthesise audio');
  if (synth(wavPath, 220).status !== 0 || synth(swapSrc, 440).status !== 0) {
    skip('FFmpeg failed to write the test tones');
  }

  addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'engine initializes');
  ok(addon.project_create(projectDir, 'ModifyRegionSwap') === true, 'project created');

  const sourceId = addon.project_importSource(wavPath);
  ok(Number.isInteger(sourceId) && sourceId >= 0, `imported source (sourceId=${sourceId})`);

  const regionId = addon.timeline_addRegion({
    name: 'Tone', label: 'Tone', sourceId, startTime: 0, endTime: 2,
  });
  ok(Number.isInteger(regionId) && regionId >= 0, `created region (regionId=${regionId})`);

  const sampleId = addon.audio_loadSourceRegion(wavPath, 0, 2);
  addon.audio_mapRegionToSample(regionId, sampleId);

  const swap = addon.audio_swapRegionAudio(regionId, swapSrc);
  ok(swap && swap.success === true, `audio swapped (${swap && (swap.error || swap.swappedPath)})`);

  const find = () => addon.timeline_getRegions().find((r) => r.id === regionId);
  const before = find();
  ok(before.hasSwappedAudio === true && !!before.swappedAudioPath,
     'precondition: region carries swapped audio');

  // ── Rename exactly as SampleSelectorTab.commitRename does ──────────────────
  addon.timeline_modifyRegion(regionId, { ...before, name: 'Renamed Tone' });
  const afterRename = find();
  ok(afterRename.name === 'Renamed Tone', 'rename applied');
  ok(afterRename.hasSwappedAudio === true, 'rename keeps hasSwappedAudio');
  ok(afterRename.swappedAudioPath === before.swappedAudioPath, 'rename keeps swappedAudioPath');
  ok(afterRename.swappedAudioDurationSec === before.swappedAudioDurationSec,
     'rename keeps swappedAudioDurationSec');
  ok(afterRename.audioFilePath === before.audioFilePath, 'rename keeps audioFilePath');

  // ── Relabel (changeLabel path) ─────────────────────────────────────────────
  addon.timeline_modifyRegion(regionId, { ...afterRename, label: 'Quote' });
  const afterLabel = find();
  ok(afterLabel.label === 'Quote', 'relabel applied');
  ok(afterLabel.hasSwappedAudio === true && afterLabel.swappedAudioPath === before.swappedAudioPath,
     'relabel keeps the swap');

  // ── A minimal patch (no spread) must also leave the swap alone ─────────────
  addon.timeline_modifyRegion(regionId, { name: 'Patched' });
  const afterPatch = find();
  ok(afterPatch.name === 'Patched', 'minimal patch applied');
  ok(afterPatch.hasSwappedAudio === true, 'minimal patch keeps the swap');
  ok(afterPatch.endTime === before.endTime && afterPatch.sourceId === before.sourceId,
     'minimal patch keeps unmentioned core fields');

  // ── Undo restores the pre-rename state, swap included ──────────────────────
  addon.undo_undo();
  ok(find().name === 'Renamed Tone', 'undo reverts the last modify');
  ok(find().hasSwappedAudio === true, 'swap survives undo of a modify');
} catch (err) {
  failed += 1;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon?.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
