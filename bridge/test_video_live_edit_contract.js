'use strict';
//
// bridge/test_video_live_edit_contract.js — edits reach the picture.
//
// The preview's VideoEvent list is derived from the timeline (clips, pattern
// blocks, notes). It used to be rebuilt only by transport play(), so a clip or
// note added while PLAYING or PAUSED stayed invisible until the next Stop/Play,
// even though the audio engine picked it up immediately — the loop-and-draw
// workflow showed stale video.
//
// The engine now flags the list stale after every UndoManager mutation and the
// video thread rebuilds it at the top of its next tick. This test drives the
// real preview path and asserts, through the engine's own diagnostics, that:
//
//   playing : add a clip        -> its cell lights up, no Stop/Play
//             remove that clip  -> the cell goes dark
//             undo the removal  -> the cell comes back
//   paused  : add a pattern note under the playhead -> the paused frame redraws
//             with it
//
// "Cell count" is counters.lastCellCount: the number of cell requests the last
// composited frame carried. One video-backed event under the playhead on a
// placed track == one cell.
//
// Skips (exit 0) when the vendored ffmpeg or a GPU compositor is unavailable —
// same convention as test_perf_regression.js.
//

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}
function skip(msg) { console.log(`\n[SKIP] ${msg}`); process.exit(0); }

function findVendoredFfmpeg() {
  const p = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(p)) return null;
  const r = spawnSync(p, ['-version'], { stdio: 'ignore' });
  return (r.error || r.status !== 0) ? null : p;
}

const PPQ = 960;
const BPM = 120;
const SECONDS = 20;
const TICKS_PER_SEC = PPQ * (BPM / 60);

async function main() {
  console.log(`=== xleth live video-edit contract (${native.config}) ===\n`);

  const ffmpeg = findVendoredFfmpeg();
  if (!ffmpeg) skip('vendor/ffmpeg/bin/ffmpeg.exe not found — needed to synthesize the test clip.');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-live-edit-'));
  const videoPath = path.join(tmpRoot, 'testsrc.mp4');
  let addon = null;

  try {
    const enc = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i',
      `testsrc2=size=160x90:rate=24:duration=${SECONDS + 2}`,
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', videoPath], { stdio: 'ignore' });
    ok(enc.status === 0 && fs.existsSync(videoPath), 'vendored ffmpeg generated the test clip');

    addon = require(native.addonPath);
    ok(addon.initialize({}) === true, 'initialize() returns true');
    if (!addon.diag_getVisualPreviewDiagnostic().compositorReady) {
      addon.shutdown();
      skip('GPU preview compositor did not initialise (no usable D3D11 device).');
    }
    ok(addon.project_create(path.join(tmpRoot, 'project'), 'LiveEdit') === true, 'project_create()');
    try { addon.audio_setMasterVolume(0); } catch { /* optional */ }

    addon.setBPM(BPM);
    const sourceId = addon.project_importSource(videoPath);
    const regionId = addon.timeline_addRegion({
      name: 'R', label: 'R', sourceId, startTime: 0, endTime: SECONDS + 1,
    });

    const FULL = 8;
    const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
    const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
    const trackP = addon.timeline_addTrack({ name: 'P', volume: 1.0, order: 2, type: 'Pattern' });
    addon.timeline_addClip({ trackId: trackA, regionId, positionTicks: 0,
                             durationTicks: SECONDS * TICKS_PER_SEC, velocity: 1.0 });
    // The pattern track starts with an EMPTY pattern: its cell is dark.
    const patId = addon.timeline_addPattern({ name: 'Pat', regionId, lengthTicks: 16 * PPQ });
    addon.timeline_addPatternBlock({ trackId: trackP, patternId: patId, positionTicks: 0,
                                     durationTicks: 16 * PPQ, offsetTicks: 0 });
    addon.timeline_setGridLayout({
      columns: 3, rows: 1, previewFps: 30, gapScale: 0,
      slots: [trackA, trackB, trackP].map((trackId, i) => (
        { trackId, gridX: i * FULL, gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: i })),
    });
    addon.timeline_setPreviewPosterMode(false);

    const cells = () => addon.diag_getVisualPreviewDiagnostic().counters.lastCellCount;
    // Poll until the last composited frame carries `want` cells.
    const waitForCells = async (want, timeoutMs = 2000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        if (cells() === want) return Date.now() - t0;
        await sleep(10);
      }
      return -1;
    };

    // ── Playing ────────────────────────────────────────────────────────────
    console.log('\n[ while playing ]');
    addon.transport_seek(0);
    addon.play();
    ok(await waitForCells(1, 3000) >= 0, 'baseline: one clip under the playhead -> 1 cell');

    const clipB = addon.timeline_addClip({ trackId: trackB, regionId, positionTicks: 0,
                                           durationTicks: SECONDS * TICKS_PER_SEC, velocity: 1.0 });
    const tAdd = await waitForCells(2);
    ok(tAdd >= 0, `a clip added during playback lights its cell without Stop/Play (${tAdd} ms)`);

    addon.timeline_removeClip(clipB);
    const tRemove = await waitForCells(1);
    ok(tRemove >= 0, `removing it darkens the cell (${tRemove} ms)`);

    addon.undo_undo();
    const tUndo = await waitForCells(2);
    ok(tUndo >= 0, `undoing the removal brings the cell back (${tUndo} ms)`);

    // ── Paused ─────────────────────────────────────────────────────────────
    console.log('\n[ while paused ]');
    addon.stop();
    await sleep(200);
    addon.transport_seek(2);            // beat 2: inside both clips and the block
    ok(await waitForCells(2, 3000) >= 0, 'paused frame at beat 2 shows the two clip cells');

    addon.timeline_addNote(patId, { positionTicks: 0, durationTicks: 8 * PPQ, pitch: 60, velocity: 1.0 });
    const tNote = await waitForCells(3);
    ok(tNote >= 0, `a note added under the paused playhead redraws the frame with its cell (${tNote} ms)`);

    addon.undo_undo();
    const tNoteUndo = await waitForCells(2);
    ok(tNoteUndo >= 0, `undoing the note removes the cell again (${tNoteUndo} ms)`);
  } finally {
    if (addon) { try { addon.shutdown(); } catch { /* best effort */ } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
