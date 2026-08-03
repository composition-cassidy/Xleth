'use strict';
//
// bridge/test_perf_regression.js — preview-performance regression gate.
//
// Guards against the exact failure class fixed in 3db1b33: SyncManager::
// videoTick() performing blocking decoder->seekAndDecode() calls in the
// bridge (.node/XLETH_CORE_ONLY) build whose output nothing ever consumed
// (compositor_ is always nullptr there). That dead work cost 100-330ms per
// scattered seek on the frame-pacing thread and collapsed a real project's
// preview from 60fps to ~17fps. See:
//   docs / memory: project_preview_fps_synctick_dead_decode
//
// This is NOT a functional-correctness test — it drives the real preview
// path (XlethEngineService::videoThreadBody) against a synthetic project
// built at gate time, then asserts hard performance budgets using the
// engine's own diagnostics (diag_getVisualPreviewDiagnostic). No user
// files, no checked-in binaries, no network: the test video is generated
// with the vendored FFmpeg (vendor/ffmpeg/bin/ffmpeg.exe) into a temp dir
// that is deleted afterward, and the project is built entirely through the
// addon's own RPCs.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_perf_regression.js
//
// Skips (exit 0) rather than fails when a hard prerequisite is missing from
// the environment (no vendored ffmpeg, no GPU preview compositor) — same
// convention as test_snapshot_transition_preview_contract.js.
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// ── addon load + FFmpeg DLL path (same pattern as the other contract tests) ─
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
function skip(msg) {
  console.log(`\n[SKIP] ${msg}`);
  process.exit(0);
}

// ── Budgets (do not weaken to make a failing build pass — see header) ──────
const BUDGET_VIDEOTICK_P95_US   = 5000;   // 5ms
const BUDGET_VIDEOTICK_MEAN_US  = 2000;   // 2ms
const BUDGET_FPS_FLOOR_FRACTION = 0.90;   // >= 90% of the previewFps cap
const PREVIEW_FPS_CAP           = 60;

// ── Fixture sizing ───────────────────────────────────────────────────────────
const N_ACTIVE_TRACKS   = 30;   // simultaneously-active clips throughout the run
const N_FILLER_PER_TRACK = 34;  // registered-but-inactive clips, off to the side
// Total registered clips = 30 * (1 + 34) = 1050 — comparable to the 1738-event
// real project this bug was found on, and split the same way that project was:
// many total registered events, a small fraction concurrently active at once.
const PPQ = 960;
const BPM = 120;
const TICKS_PER_SEC = PPQ * (BPM / 60);           // 1920
const ACTIVE_WINDOW_SECONDS = 8;
const ACTIVE_WINDOW_TICKS = ACTIVE_WINDOW_SECONDS * TICKS_PER_SEC; // 15360
const FILLER_CLIP_TICKS = 2 * PPQ;                 // 1 beat @ 120bpm = 0.5s... 2 beats = 1s

// ── Vendored FFmpeg (no network, no system dependency) ──────────────────────
function findVendoredFfmpeg() {
  const p = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (!fs.existsSync(p)) return null;
  const r = spawnSync(p, ['-version'], { stdio: 'ignore' });
  if (r.error || r.status !== 0) return null;
  return p;
}

function makeTestVideo(ffmpeg, outPath, durationSeconds) {
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi',
    '-i', `testsrc2=size=160x90:rate=24:duration=${durationSeconds}`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

// ── Percentile helper ───────────────────────────────────────────────────────
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

function fmtMs(us) { return (us / 1000).toFixed(2); }

async function main() {
  console.log(`=== xleth preview perf regression gate (${native.config}) ===\n`);

  const ffmpeg = findVendoredFfmpeg();
  if (!ffmpeg) {
    skip('vendor/ffmpeg/bin/ffmpeg.exe not found — this gate requires the vendored ' +
         'FFmpeg to synthesize its test fixture (no network, no system dependency).');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-perf-regression-'));
  const videoPath = path.join(tmpRoot, 'testsrc.mp4');
  const projectDir = path.join(tmpRoot, 'project');

  let addon = null;
  try {
    console.log('[ fixture ]');
    const encodeStart = Date.now();
    ok(makeTestVideo(ffmpeg, videoPath, ACTIVE_WINDOW_SECONDS + 2),
       `vendored ffmpeg generated a ${ACTIVE_WINDOW_SECONDS + 2}s testsrc2 clip (${Date.now() - encodeStart}ms)`);

    addon = require(native.addonPath);
    ok(addon.initialize({}) === true, 'initialize() returns true');

    const diag0 = addon.diag_getVisualPreviewDiagnostic();
    if (!diag0.compositorReady) {
      addon.shutdown();
      skip('GPU preview compositor did not initialise (no usable D3D11 device) — ' +
           'preview FPS budgets are not meaningful without it.');
    }
    ok(diag0.compositorReady === true, 'GPU preview compositor is ready');

    ok('syncManagerDecodeCount' in diag0.counters,
       'diagnostic exposes counters.syncManagerDecodeCount (added alongside the fix)');
    ok('lastVideoTickUs' in diag0.counters && 'avgVideoTickUs' in diag0.counters,
       'diagnostic exposes counters.lastVideoTickUs / avgVideoTickUs');

    ok(addon.project_create(projectDir, 'PerfRegressionGate') === true,
       'project_create() returns true');

    addon.setBPM(BPM);
    const sourceId = addon.project_importSource(videoPath);
    ok(Number.isInteger(sourceId) && sourceId >= 0, `imported test source (sourceId=${sourceId})`);

    const regionId = addon.timeline_addRegion({
      name: 'R', label: 'R', sourceId, startTime: 0, endTime: ACTIVE_WINDOW_SECONDS + 1,
    });
    ok(Number.isInteger(regionId) && regionId >= 0, `created shared region (regionId=${regionId})`);

    const FULL = 8; // kGridSubUnitsPerColumn/Row — a full-size single cell
    const COLUMNS = 6, ROWS = 5; // 30 cells for 30 active tracks
    ok(COLUMNS * ROWS >= N_ACTIVE_TRACKS, `grid ${COLUMNS}x${ROWS} has a cell for every active track`);

    const trackIds = [];
    const slots = [];
    let totalClips = 0;
    for (let i = 0; i < N_ACTIVE_TRACKS; i++) {
      const trackId = addon.timeline_addTrack({ name: `T${i}`, volume: 1.0, order: i });
      trackIds.push(trackId);

      // The genuinely-active clip: spans the whole measured playback window,
      // so this track's event passes SyncManager's beat-window check on
      // every tick for the full duration of the test.
      addon.timeline_addClip({
        trackId, regionId, positionTicks: 0, durationTicks: ACTIVE_WINDOW_TICKS, velocity: 1.0,
      });
      totalClips += 1;

      // Filler clips: registered but positioned entirely after the active
      // window, so SyncManager's per-tick loop still has to walk past them
      // (its `continue` on the beat-range check) without ever decoding —
      // this is what mirrors a real project's "many total, few active" shape
      // (the 1738-event project this bug was found on had cells=3-7 active
      // at any instant despite 1738 total registered events).
      let cursor = ACTIVE_WINDOW_TICKS;
      for (let f = 0; f < N_FILLER_PER_TRACK; f++) {
        addon.timeline_addClip({
          trackId, regionId, positionTicks: cursor, durationTicks: FILLER_CLIP_TICKS, velocity: 1.0,
        });
        cursor += FILLER_CLIP_TICKS;
        totalClips += 1;
      }

      const col = i % COLUMNS, row = Math.floor(i / COLUMNS);
      slots.push({ trackId, gridX: col * FULL, gridY: row * FULL, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: i });
    }
    ok(totalClips >= 1000, `registered ${totalClips} total clips (target >= 1000)`);

    addon.timeline_setGridLayout({
      columns: COLUMNS, rows: ROWS, previewFps: PREVIEW_FPS_CAP, gapScale: 0, slots,
    });
    const rawLayout = addon.timeline_getGridLayout();
    const layout = typeof rawLayout === 'string' ? JSON.parse(rawLayout) : rawLayout;
    ok(layout.previewFps === PREVIEW_FPS_CAP, `grid layout previewFps = ${layout.previewFps}`);

    addon.timeline_setPreviewPosterMode(false); // exercise the live decode/proxy path

    // ── Drive playback and sample diagnostics ─────────────────────────────
    console.log('\n[ measurement ]');
    addon.transport_seek(0);
    addon.play();

    const WARMUP_MS = 1500;
    const MEASURE_MS = 4000;
    const POLL_MS = 15;

    await sleep(WARMUP_MS);

    const videoTickSamplesUs = [];
    const fpsSamples = [];
    const cellSamples = [];
    const reqSamples = [];
    let lastSeenTickCount = -1;
    let lastDecodeCount = 0;
    let lastSnapshot = null;
    const measureStart = Date.now();
    while (Date.now() - measureStart < MEASURE_MS) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      const c = d.counters || {};
      const t = d.lastTick || {};
      const tickCount = c.videoTickCount;
      if (tickCount !== lastSeenTickCount) {
        lastSeenTickCount = tickCount;
        videoTickSamplesUs.push(c.lastVideoTickUs);
      }
      fpsSamples.push(c.deliveredFps);
      cellSamples.push(c.lastCellCount);
      reqSamples.push(t.requestCount);
      lastDecodeCount = c.syncManagerDecodeCount;
      lastSnapshot = { c, t };
      await sleep(POLL_MS);
    }
    const measuredElapsedMs = Date.now() - measureStart;

    addon.stop();

    // ── Assertions ─────────────────────────────────────────────────────────
    console.log('\n[ hard invariant: zero blocking decodes from SyncManager ]');
    ok(lastDecodeCount === 0,
       `syncManagerDecodeCount stayed 0 for the whole run (got ${lastDecodeCount}) — ` +
       'non-zero means the dead-decode bug (3db1b33) has resurfaced');

    console.log('\n[ videoTick budget ]');
    const sortedTicks = videoTickSamplesUs.slice().sort((a, b) => a - b);
    const tickMean = sortedTicks.reduce((s, x) => s + x, 0) / Math.max(1, sortedTicks.length);
    const tickP50 = percentile(sortedTicks, 0.50);
    const tickP95 = percentile(sortedTicks, 0.95);
    const tickMax = sortedTicks.length ? sortedTicks[sortedTicks.length - 1] : NaN;
    ok(sortedTicks.length >= 20,
       `collected ${sortedTicks.length} distinct videoTick samples (need >= 20 for a stable p95)`);
    ok(tickP95 <= BUDGET_VIDEOTICK_P95_US,
       `videoTick p95 = ${fmtMs(tickP95)}ms <= ${fmtMs(BUDGET_VIDEOTICK_P95_US)}ms budget`);
    ok(tickMean <= BUDGET_VIDEOTICK_MEAN_US,
       `videoTick mean = ${fmtMs(tickMean)}ms <= ${fmtMs(BUDGET_VIDEOTICK_MEAN_US)}ms budget`);

    console.log('\n[ sanity: the run actually exercised the preview path ]');
    const steadyFps = fpsSamples.slice(Math.floor(fpsSamples.length / 2));
    const avgFps = steadyFps.reduce((s, x) => s + x, 0) / Math.max(1, steadyFps.length);
    ok(avgFps >= PREVIEW_FPS_CAP * BUDGET_FPS_FLOOR_FRACTION,
       `steady-state delivered FPS avg = ${avgFps.toFixed(1)} >= ` +
       `${(PREVIEW_FPS_CAP * BUDGET_FPS_FLOOR_FRACTION).toFixed(1)} ` +
       `(${(BUDGET_FPS_FLOOR_FRACTION * 100).toFixed(0)}% of ${PREVIEW_FPS_CAP} cap)`);
    const maxCells = Math.max(0, ...cellSamples);
    const maxReqs = Math.max(0, ...reqSamples);
    ok(maxCells > 0, `observed lastCellCount > 0 at least once (max seen ${maxCells}) — not a vacuous run`);
    ok(maxReqs > 0, `observed requestCount > 0 at least once (max seen ${maxReqs}) — not a vacuous run`);
    ok(measuredElapsedMs >= MEASURE_MS * 0.9 && measuredElapsedMs <= MEASURE_MS * 3,
       `measurement wall-clock duration sane (${measuredElapsedMs}ms for a ${MEASURE_MS}ms window)`);

    // ── Summary table (always printed — this is what makes a failure
    //    diagnosable from CI output alone, no local repro needed) ───────────
    const c = (lastSnapshot && lastSnapshot.c) || {};
    console.log('\n── summary ──────────────────────────────────────────────');
    console.log(`fixture          : ${totalClips} clips (${N_ACTIVE_TRACKS} active, ${totalClips - N_ACTIVE_TRACKS} filler), ` +
                `${COLUMNS}x${ROWS} grid, previewFps cap ${PREVIEW_FPS_CAP}`);
    console.log(`delivered FPS    : steady-state avg ${avgFps.toFixed(1)}  (cap ${PREVIEW_FPS_CAP})`);
    console.log(`syncManager decodes: ${lastDecodeCount}  (must be 0)`);
    console.log(`videoTick (SyncManager::videoTick call only, us):`);
    console.log(`  samples=${sortedTicks.length}  mean=${fmtMs(tickMean)}ms  p50=${fmtMs(tickP50)}ms  ` +
                `p95=${fmtMs(tickP95)}ms  max=${fmtMs(tickMax)}ms`);
    console.log(`preview-pipeline per-stage (windowed avg, us) — separate stage, starts AFTER videoTick:`);
    console.log(`  collect=${fmtMs(c.avgCollectUs)}ms resolve=${fmtMs(c.avgResolveUs)}ms ` +
                `decode=${fmtMs(c.avgDecodeUs)}ms composite=${fmtMs(c.avgCompositeUs)}ms ` +
                `readback=${fmtMs(c.avgReadbackUs)}ms swizzle=${fmtMs(c.avgSwizzleUs)}ms ` +
                `wholeTick=${fmtMs(c.avgTickUs)}ms`);
    console.log(`cells/reqs (max seen): cells=${maxCells} reqs=${maxReqs}`);
    console.log('─────────────────────────────────────────────────────────');

  } finally {
    if (addon) { try { addon.shutdown(); } catch { /* best effort */ } }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
