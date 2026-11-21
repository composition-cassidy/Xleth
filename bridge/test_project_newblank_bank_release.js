'use strict';
//
// bridge/test_project_newblank_bank_release.js — File -> New must release the
// closed project's decoded audio, like project_load does.
//
// project_newBlank cleared the timeline and the region -> sample map but left
// every SampleBank sample and its waveform mipmap behind, so repeated File -> New
// leaked the whole audio footprint of each project that was closed. The test
// opens a project with samples (a saved project loaded, then fresh work in each
// blank project), calls project_newBlank 20 times and reads diag_getBankStats
// after every call: the bank must be empty and stay empty.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_project_newblank_bank_release.js
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
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-newblank-release-'));
const wav = (name) => path.join(tmpDir, name);
function synth(out, freq, seconds) {
  return spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`,
    '-ac', '2', out,
  ], { encoding: 'utf8' }).status === 0;
}

const NEW_BLANKS = 20;
let addon = null;

// One project's worth of decoded audio: two regions over one source, one layer
// file. Three bank samples, three mipmaps.
function openWork(dir, name) {
  if (addon.project_create(dir, name) !== true) return false;
  const src = addon.project_importSource(wav('a.wav'));
  const regions = [0, 4].map((t, i) => addon.timeline_addRegion(
    { name: `R${i}`, label: `R${i}`, sourceId: src, startTime: t, endTime: t + 4 }));
  const decoded = regions.every((id) => id >= 0 && addon.audio_loadRegionAudio(id) >= 0);
  const slot = addon.timeline_addSampleSlot(regions[1], wav('layer.wav'));
  return decoded && slot && slot.success === true;
}

try {
  if (!fs.existsSync(ffmpeg)) skip('vendored FFmpeg not present — cannot synthesise audio');
  if (!synth(wav('a.wav'), 220, 8) || !synth(wav('layer.wav'), 550, 2)) skip('FFmpeg failed to write the test tones');

  addon = require(native.addonPath);
  ok(typeof addon.diag_getBankStats === 'function', 'addon exports diag_getBankStats');
  ok(addon.initialize({}) === true, 'engine initializes');

  // A saved project, loaded: the case File -> New follows in the app.
  ok(openWork(path.join(tmpDir, 'saved'), 'Saved') && addon.project_save() === true, 'a project with samples is saved');
  ok(addon.project_load(path.join(tmpDir, 'saved')) === true, 'the project loads');
  const loaded = addon.diag_getBankStats();
  ok(loaded.live > 0 && loaded.mipmapEntries > 0, `the loaded project holds samples (live=${loaded.live} mipmaps=${loaded.mipmapEntries})`);

  console.log(`\n[ project_newBlank x ${NEW_BLANKS} ]`);
  const stats = [];
  let allBlank = true, allWorked = true;
  for (let i = 0; i < NEW_BLANKS; i += 1) {
    const r = addon.project_newBlank();
    allBlank = r && r.ok === true && allBlank;
    stats.push(addon.diag_getBankStats());
    // The user works in the blank project (new decoded audio), then picks File -> New again.
    allWorked = openWork(path.join(tmpDir, `p${i}`), `P${i}`) && allWorked;
  }
  ok(allBlank, `project_newBlank succeeded ${NEW_BLANKS} times`);
  ok(allWorked, 'each blank project can decode fresh audio');

  const col = (key) => stats.map((s) => s[key]).join(' ');
  console.log(`  live after each New:    ${col('live')}`);
  console.log(`  slots after each New:   ${col('slots')}`);
  console.log(`  mipmaps after each New: ${col('mipmapEntries')}`);
  ok(stats.every((s) => s.live === 0), 'no live samples after any New');
  ok(stats.every((s) => s.mipmapEntries === 0), 'no mipmap entries after any New');
  const flat = (key) => stats.every((s) => s[key] === stats[0][key]);
  ok(flat('slots'), `bank slots stay flat across ${NEW_BLANKS} New calls`);
} catch (err) {
  console.error(err && err.stack ? err.stack : err);
  failed += 1;
} finally {
  try { if (addon) addon.shutdown(); } catch (_) { /* best effort */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
