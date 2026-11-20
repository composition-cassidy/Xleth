'use strict';
//
// bridge/test_project_load_bank_growth.js — reloading a project must not grow
// the SampleBank or the waveform mipmap cache.
//
// project_load decodes every region (and every layer file) into fresh SampleBank
// ids. It used to clear the region -> sample map and leave the previous
// project's samples in the bank, so each load kept the last one's decoded audio
// (~12 MB per load for two 8 s tones) plus a waveform mipmap per sample.
//
// The project: two 8 s tones, four regions over them (two on a clip track, one
// on a pattern track, one carrying a layer file in slot 1). It is loaded 20
// times; after each load every region is asked for its audio the way the
// timeline UI does on mount (audio_loadRegionAudio, which also requests the
// waveform mipmap). diag_getBankStats must read the same after every load.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_project_load_bank_growth.js
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
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

const ffmpeg = path.resolve(__dirname, '../vendor/ffmpeg/bin/ffmpeg.exe');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-bank-growth-'));
const projectDir = path.join(tmpDir, 'project');
const wav = (name) => path.join(tmpDir, name);
function synth(out, freq, seconds) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    '-ac', '2', out,
  ], { encoding: 'utf8' }).status === 0;
}

const PPQ = 960;
const LOADS = 20;
let addon = null;

try {
  if (!fs.existsSync(ffmpeg)) skip('vendored FFmpeg not present — cannot synthesise audio');
  if (!synth(wav('a.wav'), 220, 8) || !synth(wav('b.wav'), 330, 8) || !synth(wav('layer.wav'), 550, 2)) {
    skip('FFmpeg failed to write the test tones');
  }

  addon = require(native.addonPath);
  ok(typeof addon.diag_getBankStats === 'function', 'addon exports diag_getBankStats');
  ok(addon.initialize({}) === true, 'engine initializes');
  ok(addon.project_create(projectDir, 'BankGrowth') === true, 'project created');

  // ── The project ────────────────────────────────────────────────────────────
  const srcA = addon.project_importSource(wav('a.wav'));
  const srcB = addon.project_importSource(wav('b.wav'));
  const region = (name, sourceId, startTime, endTime) =>
    addon.timeline_addRegion({ name, label: name, sourceId, startTime, endTime });
  const regions = [region('A1', srcA, 0, 4), region('A2', srcA, 4, 8),
                   region('B1', srcB, 0, 4), region('B2', srcB, 4, 8)];
  ok(regions.every((id) => id >= 0), 'four regions over two sources');

  const clipTrack = addon.timeline_addTrack({ name: 'Clips', volume: 1.0, order: 0 });
  ok(addon.timeline_addClip({ trackId: clipTrack, regionId: regions[0], positionTicks: 0, durationTicks: 8 * PPQ, velocity: 1 }) > 0
     && addon.timeline_addClip({ trackId: clipTrack, regionId: regions[2], positionTicks: 8 * PPQ, durationTicks: 8 * PPQ, velocity: 1 }) > 0,
     'two clips on a clip track');

  const patternTrack = addon.timeline_addTrack({ name: 'Pattern', volume: 1.0, order: 1 });
  addon.timeline_convertToPatternTrack(patternTrack);
  const patternId = addon.timeline_addPattern({ name: 'P', regionId: regions[1], lengthTicks: 4 * PPQ });
  addon.timeline_addPatternBlock({ trackId: patternTrack, patternId, positionTicks: 0, durationTicks: 16 * PPQ, offsetTicks: 0 });
  ok(patternId >= 0, 'a pattern track plays region A2');

  ok(regions.every((id) => addon.audio_loadRegionAudio(id) >= 0), 'every region decodes');
  const slot = addon.timeline_addSampleSlot(regions[3], wav('layer.wav'));
  ok(slot && slot.success === true && slot.slotIndex === 1, 'region B2 carries a layer file in slot 1');
  ok(addon.project_save() === true, 'project saved');

  // ── Load it 20 times ───────────────────────────────────────────────────────
  console.log(`\n[ project_load x ${LOADS} ]`);
  const stats = [];
  let allLoaded = true, allDecoded = true;
  for (let i = 0; i < LOADS; i += 1) {
    allLoaded = addon.project_load(projectDir) === true && allLoaded;
    const ids = addon.timeline_getRegions().map((r) => r.id);
    allDecoded = ids.length === 4 && ids.every((id) => addon.audio_loadRegionAudio(id) >= 0) && allDecoded;
    stats.push(addon.diag_getBankStats());
  }
  ok(allLoaded, `project_load succeeded ${LOADS} times`);
  ok(allDecoded, 'every region has its audio after every load');

  const first = stats[0];
  const last = stats[LOADS - 1];
  console.log(`  bank after load 1:  slots=${first.slots} live=${first.live} mipmaps=${first.mipmapEntries}`);
  console.log(`  bank after load ${LOADS}: slots=${last.slots} live=${last.live} mipmaps=${last.mipmapEntries}`);

  // Four regions + one layer file: five samples belong to the project.
  ok(first.live === 5, `the loaded project holds its 5 samples (live=${first.live})`);
  const flat = (key) => stats.every((s) => s[key] === first[key]);
  ok(flat('live'), `live samples stay at ${first.live} across ${LOADS} loads (${stats.map((s) => s.live).join(' ')})`);
  ok(flat('slots'), `bank slots stay at ${first.slots} across ${LOADS} loads (${stats.map((s) => s.slots).join(' ')})`);
  ok(flat('mipmapEntries'),
     `mipmap entries stay at ${first.mipmapEntries} across ${LOADS} loads (${stats.map((s) => s.mipmapEntries).join(' ')})`);
  ok(first.mipmapEntries <= first.live, `no mipmap outlives its sample (${first.mipmapEntries} <= ${first.live})`);
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  failed += 1;
} finally {
  try { if (addon) addon.shutdown(); } catch (_) { /* best effort */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
