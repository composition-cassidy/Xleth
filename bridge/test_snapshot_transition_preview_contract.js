'use strict';
//
// bridge/test_snapshot_transition_preview_contract.js
//
// Contract test that drives the LIVE preview seam through the real
// xleth_native.node addon and proves snapshot transitions (Slice 3b) actually
// render. It exercises XlethEngineService's videoThreadBody → the shared
// xleth::renderSnapshotTransition helper (the SAME path export uses), NOT the
// engine determinism unit test (which calls the helper directly with synthesised
// textures). Here the addon composites two REAL solid-colour videos on the GPU,
// so a hard cut / no-op / stale-freeze all fail the assertions.
//
// What it verifies, seeking preview while stopped:
//   • at the pin (t=0.5) the frame is a genuine BLEND of the two DISTINCT
//     snapshots (red Base + blue Alt) — both channels present, neither pure.
//   • seeking OUT of the window then back IN re-produces the identical blend,
//     proving the freeze-outgoing cache is invalidated on seek-out (no stale A).
//   • outside the window the frame is a single composite that is byte-identical
//     whether or not a transition is authored on the cue (the pass is inert
//     outside its own window).
//
// The two snapshots are authored programmatically and the transition is enabled
// via the Slice 2 IPC (timeline_setCueTransition) — the Slice 4 drag UI does not
// exist yet, so the test MUST drive setCueTransition directly.
//
// The test needs a GPU (D3D11) and ffmpeg on PATH to synthesise the two clips.
// When either is unavailable it SKIPs (exit 0) with a clear message rather than
// failing — the same environment-gating the engine GPU tests use.
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── addon load + FFmpeg DLL path ────────────────────────────────────────────
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
// NB: deliberately do NOT set XLETH_BRIDGE_DISABLE_PREVIEW_GPU — this test needs
// the real GPU compositor + transition pass.

const PPQ = 960;                    // ticks per beat (TimelineTypes.h)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}
function skip(msg) {
  console.log(`\n[SKIP] ${msg}`);
  console.log('       (environment-gated: needs a D3D11 GPU and ffmpeg on PATH)');
  process.exit(0);
}

// ── ffmpeg-generated solid-colour test clips ────────────────────────────────
function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (!r.error && r.status === 0) return 'ffmpeg';
  return null;
}
function makeSolidVideo(ffmpeg, color, outPath) {
  if (fs.existsSync(outPath)) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=2:r=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

// ── frame helpers (getCurrentFrame → { width, height, data:RGBA }) ───────────
function avgColor(fr, cx, cy, rad) {
  const { width, height, data } = fr;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; n += 1;
    }
  }
  return { r: r / n, g: g / n, b: b / n };
}
function centerColor(fr) {
  return avgColor(fr, fr.width >> 1, fr.height >> 1, 4);
}
function frameHash(fr) {
  // FNV-1a over the whole RGBA buffer.
  let h = 0x811c9dc5 >>> 0;
  const d = fr.data;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const isPureRed  = (c) => c.r > 170 && c.b < 70 && c.g < 70;
const isPureBlue = (c) => c.b > 170 && c.r < 70 && c.g < 70;
const isBlend    = (c) => c.r > 60 && c.r < 200 && c.b > 60 && c.b < 200;

const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

async function main() {
  console.log(`=== xleth snapshot-transition preview contract (${native.config}) ===\n`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found on PATH — cannot synthesise the two test clips.');

  const tmpDir = path.join(os.tmpdir(), 'xleth-transition-preview-contract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const RED  = path.join(tmpDir, 'red.mp4');
  const BLUE = path.join(tmpDir, 'blue.mp4');
  if (!makeSolidVideo(ffmpeg, 'red', RED) || !makeSolidVideo(ffmpeg, 'blue', BLUE)) {
    skip('ffmpeg failed to produce the test clips.');
  }

  const addon = require(native.addonPath);

  ok(addon.initialize({}) === true, 'initialize() returns true');

  const diag0 = addon.diag_getVisualPreviewDiagnostic();
  if (!diag0.compositorReady) {
    addon.shutdown();
    skip('GPU preview compositor did not initialise (no usable D3D11 device).');
  }
  ok(diag0.compositorReady === true, 'GPU preview compositor is ready');
  ok(typeof addon.timeline_setCueTransition === 'function',
     'Slice 2 IPC timeline_setCueTransition is exported');

  // ── Author the project: two distinct snapshots, each a fullscreen 1×1 cell
  //    playing a different solid-colour source. ───────────────────────────────
  addon.setBPM(120);

  const sidRed  = addon.project_importSource(RED);
  const sidBlue = addon.project_importSource(BLUE);
  ok(sidRed >= 0 && sidBlue >= 0 && sidRed !== sidBlue, 'imported two distinct video sources');

  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });

  const regionRed  = addon.timeline_addRegion({ name: 'R', label: 'R', sourceId: sidRed,  startTime: 0, endTime: 2 });
  const regionBlue = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sidBlue, startTime: 0, endTime: 2 });

  // Clips span the whole transition window on both tracks so each snapshot has an
  // active event throughout.
  addon.timeline_addClip({ trackId: trackA, regionId: regionRed,  positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackB, regionId: regionBlue, positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });

  const FULL = 8;  // kGridSubUnitsPerColumn / Row — a full 1×1 cell
  const slot = (trackId) => ({ columns: 1, rows: 1, previewFps: 30,
    slots: [{ trackId, gridX: 0, gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 }] });

  // Base (the default snapshot) shows track A → red.
  const baseId = addon.timeline_listSnapshots().find((s) => s.active).id;
  addon.timeline_setGridLayout(slot(trackA));

  // Alt shows track B → blue. createSnapshot switches active to Alt.
  const altId = addon.timeline_createSnapshot('Alt');
  addon.timeline_setGridLayout(slot(trackB));
  addon.timeline_setActiveSnapshot(baseId);
  ok(baseId && altId && baseId !== altId, 'created two distinct snapshots (Base + Alt)');

  // Cue at beat 4 switches to Alt; a symmetric ±1-beat crossfade window with
  // freeze-outgoing so the freeze cache is exercised.
  const pinTick = 4 * PPQ;                 // 3840
  addon.timeline_addCue(pinTick, altId);
  const transition = {
    enabled: true,
    startOffsetTicks: PPQ,                 // window [beat3, beat5]
    endOffsetTicks: PPQ,
    type: 'crossfade',
    freezeOutgoing: true,
  };
  addon.timeline_setCueTransition(pinTick, transition);

  // Build the video-event set (rebuildVideoEventsFromClips runs inside Play),
  // then stop so stopped-preview frames publish (they don't while isPlaying()).
  addon.play();
  await sleep(150);
  addon.stop();
  await sleep(100);

  // ── seek + wait-for-publish helper (deterministic readiness) ───────────────
  async function seekSettle(tick, label) {
    const r = addon.video_requestPreviewFrameAtTimelinePosition({ ticks: tick });
    if (!r.accepted) throw new Error(`seek(${label}) not accepted`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      if (d.stoppedPreview && d.stoppedPreview.publishedSeq >= r.seq) break;
      await sleep(40);
    }
    return addon.getCurrentFrame();
  }

  const outsideBefore = 2 * PPQ;   // beat 2 — before window → Base (red)
  const outsideAfter  = 6 * PPQ;   // beat 6 — after  window → Alt  (blue)

  // 1) Pin blend.
  const fPin1 = await seekSettle(pinTick, 'pin');
  const cPin1 = centerColor(fPin1);
  console.log(`  pin center = ${cstr(cPin1)}`);
  ok(isBlend(cPin1), `pin is a real blend ${cstr(cPin1)} (both R and B present)`);
  ok(!isPureRed(cPin1),  'pin is NOT pure red (would be a hard cut / no transition)');
  ok(!isPureBlue(cPin1), 'pin is NOT pure blue (would be a hard cut / snap-to-target)');

  // 2) Outside-before is a single composite of Base (pure red).
  const fBefore = await seekSettle(outsideBefore, 'before');
  const cBefore = centerColor(fBefore);
  console.log(`  before-window center = ${cstr(cBefore)}`);
  ok(isPureRed(cBefore), `outside-before is a single composite = pure red ${cstr(cBefore)}`);

  // 3) Seek back IN → identical blend proves the freeze cache was invalidated on
  //    seek-out and re-frozen correctly (a stale A would change the hash).
  const fPin2 = await seekSettle(pinTick, 'pin-again');
  const cPin2 = centerColor(fPin2);
  console.log(`  pin-again center = ${cstr(cPin2)}`);
  ok(isBlend(cPin2), `pin re-entry is a real blend ${cstr(cPin2)}`);
  ok(frameHash(fPin2) === frameHash(fPin1),
     'pin re-entry is byte-identical to first pin (freeze cache correctly invalidated, no stale frame)');

  // 4) Outside-after is a single composite of Alt (pure blue).
  const fAfter1 = await seekSettle(outsideAfter, 'after');
  const cAfter1 = centerColor(fAfter1);
  console.log(`  after-window center = ${cstr(cAfter1)}`);
  ok(isPureBlue(cAfter1), `outside-after is a single composite = pure blue ${cstr(cAfter1)}`);
  const hashAfterWithTransition = frameHash(fAfter1);

  // 5) Byte-identical-to-no-transition: disabling the transition must not change
  //    an outside-window frame (the pass is inert outside its window). Seek away
  //    (red) to force a fresh composite, then back to the outside-after tick.
  addon.timeline_setCueTransition(pinTick, { ...transition, enabled: false });
  await seekSettle(outsideBefore, 'before-2');            // force recompute (red)
  const fAfter2 = await seekSettle(outsideAfter, 'after-2');
  ok(isPureBlue(centerColor(fAfter2)), 'outside-after (transition disabled) still pure blue');
  ok(frameHash(fAfter2) === hashAfterWithTransition,
     'outside-window frame is byte-identical with vs without the transition authored');

  addon.shutdown();
  ok(true, 'shutdown() completed');

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
