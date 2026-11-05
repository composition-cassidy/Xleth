'use strict';
//
// bridge/test_regenerable_lifecycle_contract.js
//
// End-to-end contract test for the regenerable-file lifecycle, driven through the
// REAL xleth_native.node — the same RPC surface the renderer's window.xleth.*
// wrappers call (ui/rpc-manifest.js). Nothing is mocked: proxies are really
// encoded, peak caches really written.
//
//   • "Delete regenerable files when closing a project"  (project_setPurgeOnClose)
//   • "Clean up project"                                  (project_cleanupScan / Run)
//   • rebuild-on-open of whatever a purge removed         (proxy_getStatus().rebuild)
//   • the .tmp sweep that runs on every open
//
// Two node processes, on purpose. Process 1 builds a project, exercises Clean up,
// then closes it with the setting ON (purge). Process 2 is a brand-new engine
// that opens the purged project — i.e. the purge really happened "while the app
// was closed", with no in-memory state (peak cache, decoders, flags) surviving.
//
//   node test_regenerable_lifecycle_contract.js            (runs both phases)
//
// Safety properties asserted, each of which is a way this feature could destroy
// user data: source media, project.json, unrecognised files and offline-media
// proxies survive every purge; a failed load and a same-folder reopen purge
// nothing; the purge report matches the bytes that actually disappeared.
//
// Media is synthesized with vendor/ffmpeg/bin/ffmpeg.exe; SKIPs (exit 0) without
// it or without an H.264 encoder.
//

const crypto = require('crypto');
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
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
  path.resolve(__dirname, '..', 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;

const FFMPEG = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe');
const FFPROBE = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe');

const PPQ = 960;
const BPM = 120;
const secToTicks = (s) => Math.round(s * (BPM / 60) * PPQ);
const H = 720;

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else { failed += 1; console.error(`  FAIL  ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (p) => fs.existsSync(p);
const size = (p) => (has(p) ? fs.statSync(p).size : 0);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const tmpIn = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(150);
  }
  console.error(`  (timed out after ${timeoutMs} ms waiting for: ${label})`);
  return false;
}

function probeCodec(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return String(r.stdout).trim();
}
function synthVideo(out, seconds) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=1280x720:rate=24:duration=${seconds}`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '48', '-pix_fmt', 'yuv420p', out]);
  return r.status === 0 && has(out);
}
function synthWav(out, seconds) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `sine=frequency=330:duration=${seconds}`, '-ar', '44100', '-ac', '2', out]);
  return r.status === 0 && has(out);
}
function hasPeakMagic(p) {
  if (!has(p)) return false;
  const fd = fs.openSync(p, 'r');
  const b = Buffer.alloc(4);
  fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  return b.toString('latin1') === 'XLPK';
}

// The Unicode source name is deliberate: the real proxy/poster writers derive
// file names from the source stem, and the registry must recognise those names
// as OWNED (a stem it failed to match would be classified Orphan and deleted).
const NAME_A = 'clipＡ 7： Intruder';     // "clipＡ 7： Intruder"  (fullwidth A and colon)
const NAME_B = 'clipB';

function layoutOf(work, ctx) {
  const projDir = path.join(work, 'project');
  const proxiesDir = path.join(projDir, 'proxies');
  return {
    projDir, proxiesDir,
    mediaA: path.join(work, `${NAME_A}.mp4`),
    mediaB: path.join(work, `${NAME_B}.mp4`),
    wav: path.join(work, 'narration.wav'),
    srcProxyA: (codec) => path.join(proxiesDir, `${NAME_A}.preview.${H}p${codec === 'h264' ? '.h264' : ''}.mov`),
    srcProxyB: (codec) => path.join(proxiesDir, `${NAME_B}.preview.${H}p${codec === 'h264' ? '.h264' : ''}.mov`),
    posterA: path.join(proxiesDir, `${NAME_A}.xlposter.jpg`),
    posterB: path.join(proxiesDir, `${NAME_B}.xlposter.jpg`),
    regProxy: (id, codec) => path.join(proxiesDir, codec === 'h264' ? `${id}.h264.mov` : `${id}.mxf`),
    ...ctx,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 1 — build, Clean up, purge-on-close
// ═══════════════════════════════════════════════════════════════════════════════
async function phase1() {
  console.log(`=== xleth regenerable-file lifecycle contract test (${native.config}) — phase 1: build, clean up, purge ===\n`);
  if (!has(FFMPEG) || !has(FFPROBE)) { console.log('SKIP: vendor/ffmpeg ffmpeg.exe / ffprobe.exe not found'); return 'skip'; }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth_regen_'));
  const L = layoutOf(work, {});
  if (!synthVideo(L.mediaA, 5) || !synthVideo(L.mediaB, 4) || !synthWav(L.wav, 3)) {
    console.log('SKIP: could not synthesize test media'); return 'skip';
  }

  const addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'initialize() returns true');

  const codecState = addon.proxy_getCodec();
  if (!codecState || codecState.h264Available !== true) {
    console.log('SKIP: no H.264 encoder opens on this machine'); addon.shutdown(); return 'skip';
  }
  const codec = codecState.effective;          // 'h264'

  // ── The setting's RPC surface. Return values are checked: an unexported call
  //    would be `undefined`, and the renderer's optional chaining would swallow it.
  ok(typeof addon.project_setPurgeOnClose === 'function', 'project_setPurgeOnClose is exported by the addon');
  ok(typeof addon.project_takeLastPurge === 'function', 'project_takeLastPurge is exported by the addon');
  ok(typeof addon.project_cleanupScan === 'function', 'project_cleanupScan is exported by the addon');
  ok(typeof addon.project_cleanupRun === 'function', 'project_cleanupRun is exported by the addon');
  ok(addon.project_setPurgeOnClose(true) === true, 'project_setPurgeOnClose(true) echoes true');
  ok(addon.project_setPurgeOnClose(false) === false, 'project_setPurgeOnClose(false) echoes false');
  let threw = false;
  try { addon.project_setPurgeOnClose('yes'); } catch (_) { threw = true; }
  ok(threw, 'project_setPurgeOnClose rejects a non-boolean');
  ok(addon.project_takeLastPurge() === null, 'no purge reported before anything has closed');

  // Untitled project: Clean up has nothing to act on and says so.
  const untitled = addon.project_cleanupScan();
  ok(untitled && untitled.hasProject === false, 'cleanupScan on an untitled project reports hasProject=false');
  const untitledRun = addon.project_cleanupRun();
  ok(untitledRun && untitledRun.ok === false, 'cleanupRun on an untitled project refuses (ok=false)');

  // ── Build a project: two video sources + one audio source ─────────────────
  addon.setBPM(BPM);
  addon.timeline_setPreviewPosterMode(false);
  const projDir2 = path.join(work, 'project2');
  ok(addon.project_create(projDir2, 'Second') !== false && addon.project_save() !== false, 'project_create (an empty second project to switch to)');
  ok(addon.project_create(L.projDir, 'RegenLifecycle') !== false, 'project_create');
  const sidA = addon.project_importSource(L.mediaA);
  const sidB = addon.project_importSource(L.mediaB);
  const sidW = addon.project_importSource(L.wav);
  ok(sidA > 0 && sidB > 0 && sidW > 0, `imported three sources (${sidA}, ${sidB}, ${sidW})`);
  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
  const regA = addon.timeline_addRegion({ name: 'A', label: 'A', sourceId: sidA, startTime: 0, endTime: 5 });
  const regB = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sidB, startTime: 0, endTime: 4 });
  addon.timeline_addClip({ trackId: trackA, regionId: regA, positionTicks: 0, durationTicks: secToTicks(5), velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackB, regionId: regB, positionTicks: 0, durationTicks: secToTicks(4), velocity: 1.0 });
  addon.timeline_setGridLayout({ columns: 1, rows: 1, previewFps: 30,
    slots: [{ trackId: trackA, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1.0, zOrder: 0 }] });
  ok(addon.project_save() !== false, 'project_save');

  ok(addon.project_load(L.projDir) === true, 'project_load → proxies build in the background');
  const built = await waitFor(() => has(L.srcProxyA(codec)) && has(L.srcProxyB(codec))
    && has(L.regProxy(regA, codec)) && has(L.regProxy(regB, codec))
    && addon.proxy_getStatus().pending === 0
    && !addon.proxy_getStatus().rebuild.active, 5 * 60 * 1000, 'all proxies built');
  ok(built, `source + region proxies built for both sources (names derived from the Unicode stem "${NAME_A}")`);
  ok(probeCodec(L.srcProxyA(codec)) === 'h264', 'whole-source proxy is H.264');

  // The first open of a project whose proxies were never generated is itself a
  // rebuild ("purged earlier, OR never generated") and is reported as one.
  const firstStatus = addon.proxy_getStatus();
  ok(firstStatus.rebuild && firstStatus.rebuild.total >= 4 && firstStatus.rebuild.failed === 0,
     `first open counted its ${firstStatus.rebuild && firstStatus.rebuild.total} never-generated proxies as a rebuild batch, none failed`);

  // Waveform peak cache beside the (external) audio source — written by the real
  // synchronous waveform path, never by the test.
  const wf = addon.waveform_getFilePeaks(L.wav, 0, -1, 100, 0);
  ok(wf && wf.ready === true, 'waveform_getFilePeaks generated the waveform');
  const peakWav = `${L.wav}.xlpeak`;
  ok(hasPeakMagic(peakWav), 'a real .xlpeak (magic XLPK) now sits beside the audio source');

  ok(addon.project_save() !== false, 'project_save (project.json now records the proxies as ready)');
  const projectJson = path.join(L.projDir, 'project.json');
  const projectJsonHash = sha(projectJson);

  // ── Stray files: things Clean up MUST and MUST NOT remove ─────────────────
  const orphanRegion = path.join(L.proxiesDir, '4242.h264.mov');                  // no such region
  const orphanSource = path.join(L.proxiesDir, `removed.preview.${H}p.h264.mov`); // no such source
  const orphanThumb  = path.join(L.proxiesDir, 'removed.t9.xlposter.jpg');
  const interrupted  = path.join(L.proxiesDir, `${NAME_A}.preview.${H}p.h264.mov.tmp`);
  const peakTemp     = `${L.wav}.xlpeak.0123abcd-4567-89ab-cdef-0123456789ab.tmp`;
  const notes        = path.join(L.proxiesDir, 'notes.txt');
  const foreignTmp   = path.join(work, 'somebody_elses.tmp');
  fs.writeFileSync(orphanRegion, Buffer.alloc(300000));
  fs.writeFileSync(orphanSource, Buffer.alloc(500000));
  fs.writeFileSync(orphanThumb, Buffer.alloc(20000));
  fs.writeFileSync(interrupted, Buffer.alloc(700000));
  fs.writeFileSync(peakTemp, Buffer.alloc(9000));
  fs.writeFileSync(notes, 'not ours');
  fs.writeFileSync(foreignTmp, 'not ours either');
  const strayBytes = [orphanRegion, orphanSource, orphanThumb, interrupted, peakTemp]
    .reduce((n, p) => n + size(p), 0);

  // ── Clean up project ──────────────────────────────────────────────────────
  console.log('\n  -- Clean up project --');
  const scan = addon.project_cleanupScan();
  ok(scan.hasProject === true, 'cleanupScan sees the open project');
  ok(scan.willFree.files === 5, `dry run lists exactly the 5 stale files (got ${scan.willFree.files})`);
  ok(scan.willFree.bytes === strayBytes, `dry run byte total equals their sizes (${scan.willFree.bytes} vs ${strayBytes})`);
  ok(scan.willFree.categories.some((c) => c.id === 'proxies') && scan.willFree.categories.some((c) => c.id === 'partials'),
     'dry run breaks the total down by category');
  ok([orphanRegion, orphanSource, orphanThumb, interrupted, peakTemp].every(has), 'scanning deleted NOTHING');

  const run = addon.project_cleanupRun();
  ok(run.ok === true, 'cleanupRun ok');
  ok(run.freedBytes === strayBytes && run.filesRemoved === 5, `cleanupRun freed exactly the stale files (${run.filesRemoved} files, ${run.freedBytes} B)`);
  ok([orphanRegion, orphanSource, orphanThumb, interrupted, peakTemp].every((p) => !has(p)),
     'orphans and partial outputs removed');
  ok(has(L.srcProxyA(codec)) && has(L.srcProxyB(codec)) && has(L.regProxy(regA, codec)) && has(L.regProxy(regB, codec)),
     'LIVE proxies untouched by Clean up (the project is still using them)');
  ok(hasPeakMagic(peakWav), 'live peak cache untouched by Clean up');
  ok(has(notes) && has(foreignTmp), 'unrecognised files (notes.txt, a foreign .tmp) untouched');
  ok(has(L.mediaA) && has(L.mediaB) && has(L.wav) && sha(projectJson) === projectJsonHash, 'source media and project.json untouched');
  ok(addon.project_cleanupScan().willFree.files === 0, 'a second scan finds nothing left to clean');

  // ── A same-folder reopen is not a close ───────────────────────────────────
  console.log('\n  -- purge-on-close --');
  addon.project_setPurgeOnClose(true);
  ok(addon.project_load(L.projDir) === true, 'project_load of the SAME folder (purge setting ON)');
  ok(has(L.srcProxyA(codec)) && has(L.regProxy(regA, codec)), 'reopening the same project purged nothing');
  ok(addon.project_takeLastPurge() === null, '…and reported no purge');

  // ── A failed open must not strip the project the user is still in ─────────
  const bogus = path.join(work, 'no_such_project');
  ok(addon.project_load(bogus) === false, 'project_load of a missing folder returns false');
  ok(has(L.srcProxyA(codec)) && has(L.regProxy(regA, codec)) && hasPeakMagic(peakWav),
     'a FAILED open purged nothing — the still-open project keeps its proxies');
  ok(addon.project_takeLastPurge() === null, '…and reported no purge');

  // ── Offline media: source B goes missing → its proxies are the only copy ──
  {
    const pj = JSON.parse(fs.readFileSync(projectJson, 'utf8'));
    pj.sources.find((s) => s.id === sidB).filePath = path.join(work, 'gone', `${NAME_B}.mp4`);
    fs.writeFileSync(projectJson, JSON.stringify(pj, null, 2));
  }
  const projectJsonHash2 = sha(projectJson);
  ok(addon.project_load(L.projDir) === true, 'project_load (source B now offline)');
  await waitFor(() => addon.proxy_getStatus().pending === 0, 60000, 'settle');
  const scanOffline = addon.project_cleanupScan();
  // B's proxies AND its base poster (written at import) are unrebuildable now.
  const keptNow = [L.srcProxyB(codec), L.regProxy(regB, codec), L.posterB].filter(has);
  ok(keptNow.length >= 2 && scanOffline.kept.files === keptNow.length,
     `Clean up reports the offline source's ${keptNow.length} files as KEPT (got ${scanOffline.kept.files}: ${(scanOffline.kept.items || []).map((i) => i.name).join(', ')})`);
  ok(scanOffline.willFree.files === 0, 'and offers to delete none of them');

  // Snapshot exactly what the purge is about to remove.
  const peakA = `${L.mediaA}.xlpeak`;              // written by the engine itself, if at all
  const removable = [L.srcProxyA(codec), L.regProxy(regA, codec), peakWav]
    .concat(has(peakA) ? [peakA] : [])
    .concat(has(L.posterA) ? [L.posterA] : []);          // the base poster written at import
  const retained = keptNow;
  const removableBytes = removable.reduce((n, p) => n + size(p), 0);
  const leftoverTmp = path.join(L.proxiesDir, 'leftover.tmp');
  fs.writeFileSync(leftoverTmp, Buffer.alloc(4096));
  const expectedBytes = removableBytes + size(leftoverTmp);
  const missingBefore = removable.concat(retained).filter((p) => !has(p));
  ok(missingBefore.length === 0, `precondition: every file the purge will judge exists${missingBefore.length ? ` (missing: ${missingBefore.map((p) => path.basename(p)).join(', ')})` : ''}`);
  console.log(`  purge will judge: remove [${removable.map((p) => path.basename(p)).join(', ')}]  keep [${retained.map((p) => path.basename(p)).join(', ')}]`);

  // ── Close the project: switch away with the setting ON ────────────────────
  const blank = addon.project_newBlank();
  ok(blank && blank.ok === true, 'project_newBlank (close the project)');
  ok(removable.every((p) => !has(p)), 'purge-on-close removed the regenerable proxies and the waveform cache');
  ok(!has(leftoverTmp), '…and the leftover .tmp');
  ok(retained.every(has), 'proxies of the OFFLINE source were kept — they are not regenerable');
  ok(has(L.mediaA) && has(L.mediaB) && has(L.wav), 'source media untouched by the purge');
  ok(sha(projectJson) === projectJsonHash2, 'project.json byte-identical after the purge');
  ok(has(notes) && has(foreignTmp), 'unrecognised files untouched by the purge');
  const purge = addon.project_takeLastPurge();
  ok(purge && purge.freedBytes === expectedBytes,
     `purge report matches the bytes that disappeared (${purge && purge.freedBytes} vs ${expectedBytes})`);
  ok(purge && purge.filesRemoved === removable.length + 1, `purge report counts the files (${purge && purge.filesRemoved})`);
  ok(purge && Array.isArray(purge.categories) && purge.categories.length > 0, 'purge report carries a per-category breakdown');
  ok(purge && path.resolve(purge.projectDir) === path.resolve(L.projDir), 'purge report names the closed project');
  ok(addon.project_takeLastPurge() === null, 'the report is consumed (second take → null)');

  // ── Setting OFF: closing purges nothing ───────────────────────────────────
  addon.project_setPurgeOnClose(false);
  ok(addon.project_load(L.projDir) === true, 'project_load again (purge setting OFF) → rebuilds what was purged');
  await waitFor(() => has(L.srcProxyA(codec)) && has(L.regProxy(regA, codec)) && addon.proxy_getStatus().pending === 0
    && !addon.proxy_getStatus().rebuild.active, 5 * 60 * 1000, 'rebuild after purge');
  ok(has(L.srcProxyA(codec)) && has(L.regProxy(regA, codec)), 'proxies rebuilt after the purge');
  // Let any in-flight poster/proxy job finish so the directory is quiescent.
  await waitFor(() => has(L.posterA) && tmpIn(L.proxiesDir).length === 0, 60000, 'background jobs quiescent');
  const beforeOff = fs.readdirSync(L.proxiesDir).sort().join('|');
  addon.project_newBlank();
  ok(fs.readdirSync(L.proxiesDir).sort().join('|') === beforeOff, 'with the setting OFF, closing deletes nothing');
  ok(addon.project_takeLastPurge() === null, '…and reports nothing');

  // ── Direct switch A → B: project_load of a DIFFERENT folder closes A ──────
  addon.project_setPurgeOnClose(true);
  ok(addon.project_load(L.projDir) === true, 'project_load A (purge ON)');
  await waitFor(() => has(L.srcProxyA(codec)) && has(L.regProxy(regA, codec)) && has(L.posterA)
    && addon.proxy_getStatus().pending === 0 && !addon.proxy_getStatus().rebuild.active
    && tmpIn(L.proxiesDir).length === 0, 5 * 60 * 1000, 'A rebuilt before switching');
  addon.project_takeLastPurge();                       // drop the (empty) report from opening A
  const switchRemovable = [L.srcProxyA(codec), L.regProxy(regA, codec), L.posterA];
  ok(switchRemovable.every(has), 'precondition: project A has its proxies and poster');
  ok(addon.project_load(projDir2) === true, 'project_load of a DIFFERENT project (closes A)');
  ok(switchRemovable.every((p) => !has(p)), 'switching projects purged the project that was closed');
  ok(retained.every(has), '…but kept the offline-source files');
  ok(has(L.mediaA) && has(L.mediaB) && has(L.wav) && sha(projectJson) === projectJsonHash2,
     '…and left source media and project.json alone');
  const switchPurge = addon.project_takeLastPurge();
  ok(switchPurge && switchPurge.freedBytes > 0 && path.resolve(switchPurge.projectDir) === path.resolve(L.projDir),
     `switch reported the space freed from the closed project (${switchPurge && switchPurge.freedBytes} B)`);
  ok(addon.project_load(L.projDir) === true, 'project_load A again (the second project had nothing to purge)');

  // ── Hand-off to phase 2: purge the project, plant the "closed app" state ──
  addon.project_setPurgeOnClose(true);
  ok(addon.project_load(L.projDir) === true, 'project_load (purge ON) …');
  addon.project_newBlank();                              // …closed → purged again
  ok(!has(L.srcProxyA(codec)) && !has(L.regProxy(regA, codec)), 'purged for the reopen phase');
  // Crash leftovers that were on disk when the "app" died.
  fs.writeFileSync(path.join(L.proxiesDir, 'crash.tmp'), Buffer.alloc(2048));
  fs.writeFileSync(`${L.wav}.xlpeak.aaaabbbb-cccc-dddd-eeee-ffff00001111.tmp`, Buffer.alloc(512));
  addon.shutdown();

  fs.writeFileSync(path.join(work, 'handoff.json'), JSON.stringify({
    codec, sidA, sidB, regA, regB, projectJsonHash: sha(projectJson),
  }));
  return work;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 2 — a fresh engine opens the purged project
// ═══════════════════════════════════════════════════════════════════════════════
async function phase2(work) {
  console.log(`\n=== phase 2: reopen the purged project in a fresh engine ===\n`);
  const h = JSON.parse(fs.readFileSync(path.join(work, 'handoff.json'), 'utf8'));
  const { codec } = h;
  const L = layoutOf(work, {});
  const addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'initialize() (fresh engine, no memory of phase 1)');
  ok(addon.project_setPurgeOnClose(false) === false, 'purge setting reset for this phase');

  const projectJson = path.join(L.projDir, 'project.json');
  ok(sha(projectJson) === h.projectJsonHash, 'project.json is byte-identical to before the purge');
  ok(!has(L.srcProxyA(codec)) && !has(L.regProxy(h.regA, codec)), 'precondition: the proxies really are gone');
  ok(has(L.srcProxyB(codec)) && has(L.regProxy(h.regB, codec)), 'precondition: offline-source proxies were kept');

  // ── Open: .tmp sweep is synchronous and silent ────────────────────────────
  const t0 = Date.now();
  ok(addon.project_load(L.projDir) === true, 'project_load of the purged project');
  const loadMs = Date.now() - t0;
  ok(!has(path.join(L.proxiesDir, 'crash.tmp')), 'interrupted *.tmp in proxies/ swept on open, no prompt');
  ok(!has(`${L.wav}.xlpeak.aaaabbbb-cccc-dddd-eeee-ffff00001111.tmp`), 'interrupted peak temp beside the audio swept on open');
  ok(has(path.join(work, 'somebody_elses.tmp')) && has(path.join(L.proxiesDir, 'notes.txt')),
     'the sweep left every non-partial file alone');
  ok(has(L.mediaA) && has(L.mediaB) && has(L.wav), 'source media untouched by the open');

  // ── Rebuild: async, reported, non-blocking, project usable meanwhile ──────
  const st = addon.proxy_getStatus();
  ok(st.rebuild && st.rebuild.total >= 2, `rebuild scheduled on open (total=${st.rebuild && st.rebuild.total}: source A + region A)`);
  ok(st.rebuild.failed === 0, 'no rebuild job failed to schedule (offline source B is skipped, not queued to fail)');
  ok(loadMs < 20000, `project_load returned promptly (${loadMs} ms) — the rebuild is not on the open path`);

  let sawActive = st.rebuild.active;
  let usableMs = 0;
  if (st.rebuild.active) {
    // The project must stay fully usable while previews rebuild.
    const u0 = Date.now();
    const tracks = addon.timeline_getTracks();
    const clips = addon.timeline_getClips();
    const newTrack = addon.timeline_addTrack({ name: 'edit-during-rebuild', volume: 1.0, order: 9 });
    addon.play(); await sleep(150); addon.stop();
    usableMs = Date.now() - u0;
    ok(Array.isArray(tracks) && tracks.length >= 2 && Array.isArray(clips) && clips.length >= 2, 'timeline reads work while rebuilding');
    ok(newTrack > 0, 'timeline edits work while rebuilding');
    ok(usableMs < 3000, `transport + edits responsive during the rebuild (${usableMs} ms)`);
  } else {
    console.log('  (rebuild already finished before it could be probed — usability check skipped)');
  }
  let maxProgress = 0;
  const finished = await waitFor(() => {
    const r = addon.proxy_getStatus().rebuild;
    sawActive = sawActive || r.active;
    maxProgress = Math.max(maxProgress, r.progress);
    return has(L.srcProxyA(codec)) && has(L.regProxy(h.regA, codec)) && !r.active
      && addon.proxy_getStatus().pending === 0;
  }, 5 * 60 * 1000, 'rebuild finished');
  ok(sawActive, 'the rebuild batch reported itself active');
  ok(finished, 'the purged proxies were rebuilt automatically');
  const done = addon.proxy_getStatus().rebuild;
  ok(done.completed === done.total && done.failed === 0, `rebuild batch completed ${done.completed}/${done.total}, 0 failed`);
  ok(done.progress >= 0.999, `rebuild progress reached 100% (${(done.progress * 100).toFixed(0)}%)`);
  ok(probeCodec(L.srcProxyA(codec)) === 'h264' && probeCodec(L.regProxy(h.regA, codec)) === 'h264', 'rebuilt proxies are valid H.264');
  ok(await waitFor(() => has(L.posterA), 60000, 'poster rebuilt'), 'the purged base poster was rebuilt on open (poster mode is off)');
  ok(has(L.posterB), 'the offline source\'s poster was kept');
  ok(tmpIn(L.proxiesDir).length === 0, 'no partial file left behind by the rebuild');
  ok(!has(L.srcProxyB(codec)) || size(L.srcProxyB(codec)) > 0, 'offline-source proxy still intact');

  // ── Waveform cache: rebuilt on demand, never blocks the open ──────────────
  const peakWav = `${L.wav}.xlpeak`;
  const wf = addon.waveform_getFilePeaks(L.wav, 0, -1, 100, 0);
  ok(wf && wf.ready === true && hasPeakMagic(peakWav), 'the waveform is served, and its .xlpeak regenerated, on demand');

  // ── Quit with the setting ON: shutdown purges ─────────────────────────────
  addon.project_setPurgeOnClose(true);
  addon.shutdown();
  ok(!has(L.srcProxyA(codec)) && !has(L.regProxy(h.regA, codec)) && !has(peakWav) && !has(L.posterA),
     'shutdown with the setting ON purged the open project (quit path)');
  ok(has(L.srcProxyB(codec)) && has(L.mediaA) && has(L.mediaB) && has(L.wav) && sha(projectJson) === h.projectJsonHash,
     'quit path kept offline-source proxies, source media and project.json');
}

async function main() {
  const phaseArg = process.argv.find((a) => a.startsWith('--phase='));
  let work;
  if (phaseArg && phaseArg.split('=')[1] === '2') {
    work = process.argv[process.argv.indexOf(phaseArg) + 1];
    await phase2(work);
  } else {
    work = await phase1();
    if (work === 'skip') return 0;
    // The engine is a process-wide singleton, so phase 2 needs a fresh process.
    const r = spawnSync(process.execPath, [__filename, '--phase=2', work],
      { stdio: 'inherit', env: process.env });
    if (r.status !== 0) { failed += 1; console.error(`  FAIL  phase 2 exited with ${r.status}`); }
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
