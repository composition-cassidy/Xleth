'use strict';
//
// bridge/test_snapshot_landing_contract.js
//
// Contract test for Landings (docs/XLETH_LANDING_SPEC.md §7 and §9) through the
// real xleth_native.node addon. Modeled on
// test_snapshot_transition_preview_contract.js.
//
// Part A — the RPC contract (needs only the engine):
//   timeline_setCueLandings / timeline_reflowCueLandings and the cue list they
//   return: the read-back shape, an omitted field coming back as its default,
//   normalization, de-duplication by track, the cap at 16, the no-op on a tick
//   without a cue, a cue without landings keeping its old shape, landings
//   travelling with a moved cue, and a save -> load round trip.
//
// Part B — the LIVE preview seam (needs a D3D11 GPU and ffmpeg on PATH):
//   XlethEngineService's video tick calling the shared xleth::LandingRenderer,
//   which no engine unit test reaches. Three real solid-colour clips; a cue
//   from a 1x1 snapshot to a 2x2 one; one track landing from where it was, one
//   from the bottom edge, one with no landing. Seeking the stopped preview:
//     • before the lead-in and at the pin the frame is byte-identical with and
//       without the landings authored;
//     • inside the lead-in each landing track is drawn once, at its in-flight
//       rect, and the track without a landing is not drawn before the cut;
//     • seeking back into the lead-in reproduces the same frame;
//     • inside a crossfade after the pin the landed tracks are at full strength
//       while the track without a landing is still fading in.
//   When the GPU or ffmpeg is unavailable Part B SKIPs; Part A still runs.
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

const PPQ = 960;                    // ticks per beat (TimelineTypes.h)
const FULL = 8;                     // kGridSubUnitsPerColumn / Row
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}
const near = (a, b, tol = 1e-5) => Math.abs(a - b) <= tol;

// The engine's defaults for one landing (TrackLanding in TimelineTypes.h).
const DEFAULT_LANDING = {
  leadInTicks: 960,
  from: 'edge',
  edgeAngleDeg: 270,
  custom: { x: 0, y: 0, w: 0, h: 0 },
  fromOpacity: 1,
  easing: { x1: 0.22, y1: 1, x2: 0.36, y2: 1 },
};
function isDefaultLanding(l, trackId) {
  return !!l && l.trackId === trackId
    && l.leadInTicks === DEFAULT_LANDING.leadInTicks
    && l.from === DEFAULT_LANDING.from
    && l.edgeAngleDeg === DEFAULT_LANDING.edgeAngleDeg
    && l.custom && l.custom.x === 0 && l.custom.y === 0 && l.custom.w === 0 && l.custom.h === 0
    && l.fromOpacity === 1
    && l.easing && near(l.easing.x1, 0.22) && l.easing.y1 === 1
    && near(l.easing.x2, 0.36) && l.easing.y2 === 1;
}

// ── ffmpeg-generated solid-colour test clips ────────────────────────────────
function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return (!r.error && r.status === 0) ? 'ffmpeg' : null;
}
function makeSolidVideo(ffmpeg, color, outPath, duration = 4) {
  if (fs.existsSync(outPath)) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=${duration}:r=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

// ── frame helpers (getCurrentFrame → { width, height, data:RGBA }) ───────────
function colorAtUV(fr, u, v, rad = 3) {
  const { width, height, data } = fr;
  const cx = Math.floor(u * width), cy = Math.floor(v * height);
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
function frameHash(fr) {
  let h = 0x811c9dc5 >>> 0;
  const d = fr.data;
  for (let i = 0; i < d.length; i++) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const isRed   = (c) => c.r > 170 && c.g < 70 && c.b < 70;
const isBlue  = (c) => c.b > 170 && c.r < 70 && c.g < 70;
const isGreen = (c) => c.g > 170 && c.r < 70 && c.b < 70;
const isBlack = (c) => c.r < 24 && c.g < 24 && c.b < 24;
const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

async function main() {
  console.log(`=== xleth snapshot-landing contract (${native.config}) ===\n`);

  const addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'initialize() returns true');
  ok(typeof addon.timeline_setCueLandings === 'function',
     'timeline_setCueLandings is exported');
  ok(typeof addon.timeline_reflowCueLandings === 'function',
     'timeline_reflowCueLandings is exported');

  // ──────────────────────────────────────────────────────────────────────────
  // Part A — the RPC contract
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[ A: set / reflow / read-back ]');
  addon.setBPM(120);

  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
  const trackC = addon.timeline_addTrack({ name: 'C', volume: 1.0, order: 2 });
  const trackD = addon.timeline_addTrack({ name: 'D', volume: 1.0, order: 3 });

  const slotOf = (trackId, gridX, gridY, spanX = FULL, spanY = FULL) =>
    ({ trackId, gridX, gridY, spanX, spanY, opacity: 1.0, zOrder: 0 });

  // Base (the default snapshot): 2x1 — A on the left, D on the right.
  const baseId = addon.timeline_listSnapshots().find((s) => s.active).id;
  addon.timeline_setGridLayout({
    columns: 2, rows: 1, previewFps: 30,
    slots: [slotOf(trackA, 0, 0), slotOf(trackD, FULL, 0)],
  });
  // Alt: 2x2 — A top-left, C top-right, B bottom-right, D keeps its exact rect
  // only if the geometry matched (it does not: 2x1 -> 2x2), so D moves too.
  const altId = addon.timeline_createSnapshot('Alt');
  addon.timeline_setGridLayout({
    columns: 2, rows: 2, previewFps: 30,
    slots: [slotOf(trackA, 0, 0), slotOf(trackC, FULL, 0), slotOf(trackB, FULL, FULL),
            slotOf(trackD, 0, FULL)],
  });
  addon.timeline_setActiveSnapshot(baseId);
  ok(baseId && altId && baseId !== altId, 'created two snapshots (Base 2x1, Alt 2x2)');

  const pinTick = 8 * PPQ;
  let cues = addon.timeline_addCue(pinTick, altId);
  let cue = cues.find((c) => c.tick === pinTick);
  ok(cue && !Object.prototype.hasOwnProperty.call(cue, 'landings'),
     'a cue without landings has no landings key (its shape is unchanged)');

  // Set: every field authored.
  const authored = [
    { trackId: trackA, leadInTicks: 1920, from: 'whereItWas', edgeAngleDeg: 90,
      custom: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, fromOpacity: 0.7,
      easing: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 } },
    { trackId: trackB, leadInTicks: 480, from: 'edge', edgeAngleDeg: 180,
      custom: { x: 0, y: 0, w: 0, h: 0 }, fromOpacity: 1,
      easing: { x1: 0, y1: 0, x2: 1, y2: 1 } },
    { trackId: trackC, leadInTicks: 240, from: 'custom', edgeAngleDeg: 0,
      custom: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }, fromOpacity: 0,
      easing: { x1: 0.22, y1: 1, x2: 0.36, y2: 1 } },
    { trackId: trackD, leadInTicks: 0, from: 'grow' },
  ];
  cues = addon.timeline_setCueLandings(pinTick, authored);
  ok(Array.isArray(cues) && cues.length === 1, 'setCueLandings returns the cue list');
  cue = cues.find((c) => c.tick === pinTick);
  const got = cue?.landings ?? [];
  ok(got.length === 4, 'all four landings are stored, in order');
  ok(got[0]?.trackId === trackA && got[0]?.leadInTicks === 1920 && got[0]?.from === 'whereItWas'
     && got[0]?.edgeAngleDeg === 90 && near(got[0]?.fromOpacity, 0.7)
     && near(got[0]?.custom?.x, 0.1) && near(got[0]?.custom?.y, 0.2)
     && near(got[0]?.custom?.w, 0.3) && near(got[0]?.custom?.h, 0.4)
     && near(got[0]?.easing?.x1, 0.65) && got[0]?.easing?.y1 === 0
     && near(got[0]?.easing?.x2, 0.35) && got[0]?.easing?.y2 === 1,
     'read-back shape: { trackId, leadInTicks, from, edgeAngleDeg, custom{x,y,w,h}, fromOpacity, easing{x1,y1,x2,y2} }');
  ok(got[1]?.from === 'edge' && got[1]?.edgeAngleDeg === 180 && got[1]?.leadInTicks === 480
     && got[1]?.easing?.x1 === 0 && got[1]?.easing?.x2 === 1,
     'a Linear easing and an edge angle round-trip');
  ok(got[2]?.from === 'custom' && got[2]?.fromOpacity === 0 && near(got[2]?.custom?.w, 0.25),
     'a custom rect and fromOpacity 0 round-trip');
  ok(got[3]?.from === 'grow' && got[3]?.leadInTicks === 0
     && got[3]?.edgeAngleDeg === 270 && got[3]?.fromOpacity === 1
     && near(got[3]?.easing?.x1, 0.22) && got[3]?.easing?.y1 === 1,
     'omitted fields come back as their defaults');
  ok(JSON.stringify(addon.timeline_listCues()) === JSON.stringify(cues),
     'listCues returns the same cue list setCueLandings returned');

  // An entry that names only its track is the default landing.
  cues = addon.timeline_setCueLandings(pinTick, [{ trackId: trackB }]);
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue?.landings?.length === 1 && isDefaultLanding(cue.landings[0], trackB),
     'an entry with only a trackId round-trips as the default landing (1 beat, edge 270, no fade, Land)');

  // Normalization happens engine-side.
  cues = addon.timeline_setCueLandings(pinTick, [{
    trackId: trackA, leadInTicks: 999999999, from: 'teleport', edgeAngleDeg: -90,
    custom: { x: -1, y: 2, w: Number.NaN, h: 5 }, fromOpacity: 7,
    easing: { x1: 3, y1: -1, x2: Number.NaN, y2: 2 },
  }, {
    trackId: trackB, leadInTicks: -50, edgeAngleDeg: 720, fromOpacity: -1,
  }]);
  cue = cues.find((c) => c.tick === pinTick);
  const n0 = cue?.landings?.[0], n1 = cue?.landings?.[1];
  ok(n0?.leadInTicks === 960 * 16, 'lead-in is clamped to the 4-bar maximum');
  ok(n0?.from === 'edge', 'an unknown from string reads as edge');
  ok(near(n0?.edgeAngleDeg, 270, 1e-3), 'the edge angle is wrapped into [0, 360)');
  ok(n0?.custom?.x === 0 && n0?.custom?.y === 1 && n0?.custom?.w === 0 && n0?.custom?.h === 1,
     'the custom rect is clamped to [0,1]; a non-finite field keeps its default');
  ok(n0?.fromOpacity === 1, 'fromOpacity is clamped to [0,1]');
  ok(n0?.easing?.x1 === 1 && n0?.easing?.y1 === 0 && near(n0?.easing?.x2, 0.36) && n0?.easing?.y2 === 1,
     'easing control points are clamped; a non-finite one keeps its default');
  ok(n1?.leadInTicks === 0 && near(n1?.edgeAngleDeg, 0, 1e-3) && n1?.fromOpacity === 0,
     'negative lead-in / opacity clamp to 0 and 720 degrees wraps to 0');

  // De-duplication: the later entry for a track wins, at the earlier position.
  cues = addon.timeline_setCueLandings(pinTick, [
    { trackId: trackA, from: 'edge', leadInTicks: 100 },
    { trackId: trackB, from: 'grow' },
    { trackId: trackA, from: 'custom', leadInTicks: 300 },
    { from: 'grow' },                 // no trackId: dropped
    'not an object',                  // dropped
    { trackId: -4, from: 'grow' },    // invalid trackId: dropped
  ]);
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue?.landings?.length === 2
     && cue.landings[0].trackId === trackA && cue.landings[0].from === 'custom'
     && cue.landings[0].leadInTicks === 300 && cue.landings[1].trackId === trackB,
     'a duplicate trackId collapses (later wins) and entries without a track are dropped');

  // Cap at 16.
  const twenty = [];
  for (let i = 0; i < 20; i++) twenty.push({ trackId: 1000 + i, from: 'grow' });
  cues = addon.timeline_setCueLandings(pinTick, twenty);
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue?.landings?.length === 16 && cue.landings[15].trackId === 1015,
     'the list is capped at 16; the extra entries are rejected');

  // No cue at the tick: no-op, and the list is still returned.
  cues = addon.timeline_setCueLandings(pinTick + 7, [{ trackId: trackA }]);
  ok(Array.isArray(cues) && cues.length === 1 && cues[0].landings.length === 16,
     'setCueLandings on a tick without a cue changes nothing');

  // Clearing removes the key again.
  cues = addon.timeline_setCueLandings(pinTick, []);
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue && !Object.prototype.hasOwnProperty.call(cue, 'landings'),
     'an empty list clears the landings and the key');

  // Bad arguments throw (same contract as setCueTransition).
  let threw = false;
  try { addon.timeline_setCueLandings(pinTick, { trackId: trackA }); } catch (_) { threw = true; }
  ok(threw, 'setCueLandings(tick, non-array) throws a TypeError');

  // Reflow. A is in Base and Alt at different rects; D likewise; B and C are
  // only in Alt. An existing landing for C must survive.
  console.log('\n[ A: reflow ]');
  addon.timeline_setCueLandings(pinTick, [{ trackId: trackC, from: 'edge', leadInTicks: 480, fromOpacity: 0.5 }]);
  cues = addon.timeline_reflowCueLandings(pinTick, 960);
  cue = cues.find((c) => c.tick === pinTick);
  const byTrack = new Map((cue?.landings ?? []).map((l) => [l.trackId, l]));
  ok(cue?.landings?.length === 3, 'reflow adds a landing for each track whose rect changes (A and D)');
  ok(byTrack.get(trackA)?.from === 'whereItWas' && byTrack.get(trackA)?.leadInTicks === 960
     && byTrack.get(trackD)?.from === 'whereItWas' && byTrack.get(trackD)?.leadInTicks === 960,
     'reflowed landings are whereItWas with the given lead-in');
  ok(!byTrack.has(trackB), 'a track in the cue snapshot but not in the outgoing one is left alone');
  ok(byTrack.get(trackC)?.from === 'edge' && byTrack.get(trackC)?.leadInTicks === 480
     && near(byTrack.get(trackC)?.fromOpacity, 0.5) && cue.landings[0].trackId === trackC,
     'an existing landing for another track is kept as it was');

  cues = addon.timeline_reflowCueLandings(pinTick);       // lead-in omitted -> 1 beat
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue?.landings?.length === 3
     && cue.landings.find((l) => l.trackId === trackA)?.leadInTicks === 960,
     'reflow without a lead-in uses one beat, and a second reflow adds nothing');
  cues = addon.timeline_reflowCueLandings(pinTick, 1920);
  cue = cues.find((c) => c.tick === pinTick);
  ok(cue?.landings?.find((l) => l.trackId === trackA)?.leadInTicks === 1920,
     'a second reflow replaces the landing it made');
  cues = addon.timeline_reflowCueLandings(pinTick + 7, 960);
  ok(Array.isArray(cues) && cues.length === 1, 'reflow on a tick without a cue changes nothing');

  // Landings (and the transition) travel with a moved cue.
  console.log('\n[ A: move + persistence ]');
  addon.timeline_setCueTransition(pinTick, {
    enabled: true, startOffsetTicks: 480, endOffsetTicks: 720, type: 'push', geomAngleDeg: 0,
  });
  const movedTick = pinTick + 2 * PPQ;
  ok(addon.timeline_moveCue(pinTick, movedTick) === true, 'moveCue relocates the cue');
  cues = addon.timeline_listCues();
  cue = cues.find((c) => c.tick === movedTick);
  ok(cues.length === 1 && cue?.landings?.length === 3, 'the moved cue keeps its landings');
  ok(cue?.transition?.enabled === true && cue.transition.type === 'push'
     && cue.transition.startOffsetTicks === 480 && cue.transition.endOffsetTicks === 720,
     'the moved cue keeps its transition');
  ok(addon.timeline_moveCue(movedTick, pinTick) === true, 'move the cue back');
  addon.timeline_setCueTransition(pinTick, { enabled: false });

  // Save -> load round trip.
  const PROJECT_DIR = path.join(os.tmpdir(), 'xleth-landing-contract-project');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  const beforeSave = JSON.stringify(addon.timeline_listCues());
  let persisted = false;
  try {
    const created = addon.project_create(PROJECT_DIR, 'LandingContract');
    if (created === true) {
      // project_create starts a fresh project: re-author the same cue on it.
      const t1 = addon.timeline_addTrack({ name: 'P1', volume: 1.0, order: 0 });
      const t2 = addon.timeline_addTrack({ name: 'P2', volume: 1.0, order: 1 });
      const pBase = addon.timeline_listSnapshots().find((s) => s.active).id;
      addon.timeline_setGridLayout({ columns: 2, rows: 1, previewFps: 30,
        slots: [slotOf(t1, 0, 0), slotOf(t2, FULL, 0)] });
      const pAlt = addon.timeline_createSnapshot('Alt');
      addon.timeline_setGridLayout({ columns: 2, rows: 2, previewFps: 30,
        slots: [slotOf(t1, 0, 0), slotOf(t2, FULL, FULL)] });
      addon.timeline_setActiveSnapshot(pBase);
      addon.timeline_addCue(pinTick, pAlt);
      addon.timeline_setCueLandings(pinTick, [
        { trackId: t1, from: 'whereItWas', leadInTicks: 960, fromOpacity: 0.7 },
        { trackId: t2, from: 'edge', edgeAngleDeg: 270, leadInTicks: 480,
          easing: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 } },
      ]);
      const savedCues = JSON.stringify(addon.timeline_listCues());
      ok(addon.project_save() === true, 'project_save() succeeds with landings authored');
      const projectJson = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
      const savedCue = projectJson?.timeline?.gridLayout?.cues?.[0]
        ?? projectJson?.gridLayout?.cues?.[0];
      ok(Array.isArray(savedCue?.landings) && savedCue.landings.length === 2
         && savedCue.landings[0].from === 'whereItWas',
         'project.json carries the landings on their cue');
      ok(addon.project_load(PROJECT_DIR) === true, 'project_load() reloads the project');
      ok(JSON.stringify(addon.timeline_listCues()) === savedCues,
         'landings survive a save -> load round trip unchanged');
      persisted = true;
    }
  } catch (e) {
    console.error('  persistence section threw:', e.message);
  }
  ok(persisted, 'the persistence section ran to the end');
  void beforeSave;

  // ──────────────────────────────────────────────────────────────────────────
  // Part B — the live preview seam
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n[ B: live preview seam ]');
  const ffmpeg = findFfmpeg();
  const diag0 = addon.diag_getVisualPreviewDiagnostic();
  const tmpDir = path.join(os.tmpdir(), 'xleth-landing-contract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const RED   = path.join(tmpDir, 'red-v1.mp4');
  const BLUE  = path.join(tmpDir, 'blue-v1.mp4');
  const GREEN = path.join(tmpDir, 'lime-v1.mp4');
  let canRender = !!ffmpeg && diag0.compositorReady === true;
  if (canRender) {
    canRender = makeSolidVideo(ffmpeg, 'red', RED)
      && makeSolidVideo(ffmpeg, 'blue', BLUE)
      && makeSolidVideo(ffmpeg, 'lime', GREEN);
  }
  if (!canRender) {
    console.log('  [SKIP] Part B needs a D3D11 GPU and ffmpeg on PATH; neither assertion ran.');
  } else {
    await runPreviewSeam(addon, { RED, BLUE, GREEN });
  }

  addon.shutdown();
  ok(true, 'shutdown() completed');

  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

async function runPreviewSeam(addon, clips) {
  addon.project_newBlank?.();
  addon.timeline_setPreviewPosterMode(false);
  addon.setBPM(120);

  const sidRed   = addon.project_importSource(clips.RED);
  const sidBlue  = addon.project_importSource(clips.BLUE);
  const sidGreen = addon.project_importSource(clips.GREEN);
  ok(sidRed >= 0 && sidBlue >= 0 && sidGreen >= 0, 'imported three video sources');

  const tA = addon.timeline_addTrack({ name: 'Red', volume: 1.0, order: 0 });
  const tB = addon.timeline_addTrack({ name: 'Blue', volume: 1.0, order: 1 });
  const tC = addon.timeline_addTrack({ name: 'Green', volume: 1.0, order: 2 });
  const region = (sourceId, name) => addon.timeline_addRegion(
    { name, label: name, sourceId, startTime: 0, endTime: 2 });
  const rRed = region(sidRed, 'R'), rBlue = region(sidBlue, 'B'), rGreen = region(sidGreen, 'G');
  for (const [trackId, regionId] of [[tA, rRed], [tB, rBlue], [tC, rGreen]]) {
    addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: 24 * PPQ, velocity: 1.0 });
  }

  const slotOf = (trackId, gridX, gridY) =>
    ({ trackId, gridX, gridY, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 });

  // Base: one full-frame cell, red. Alt: 2x2 — red top-left, green top-right,
  // blue bottom-right, bottom-left empty.
  const baseId = addon.timeline_listSnapshots().find((s) => s.active).id;
  addon.timeline_setGridLayout({ columns: 1, rows: 1, previewFps: 30, gapScale: 0,
    slots: [slotOf(tA, 0, 0)] });
  const altId = addon.timeline_createSnapshot('Alt');
  addon.timeline_setGridLayout({ columns: 2, rows: 2, previewFps: 30, gapScale: 0,
    slots: [slotOf(tA, 0, 0), slotOf(tC, FULL, 0), slotOf(tB, FULL, FULL)] });
  addon.timeline_setActiveSnapshot(baseId);

  const pinTick = 8 * PPQ;
  addon.timeline_addCue(pinTick, altId);

  // Build the video-event set (it is rebuilt inside Play), then stop so
  // stopped-preview frames publish.
  addon.play();
  await sleep(150);
  addon.stop();
  await sleep(100);

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

  const beforeTick = 5 * PPQ;                 // before any lead-in
  const midTick    = 7 * PPQ;                 // red halfway in; blue at its start
  const lateTick   = 7 * PPQ + PPQ / 2;       // red 3/4 in; blue halfway up

  // Warm the decoder / proxies first: the very first frame of a fresh project
  // can be decoded from the source and later ones from a proxy.
  await seekSettle(beforeTick, 'warm-1');
  await seekSettle(pinTick, 'warm-2');
  await seekSettle(midTick, 'warm-3');
  await sleep(300);

  // References WITHOUT landings.
  const refBefore = await seekSettle(beforeTick, 'ref-before');
  const refMid    = await seekSettle(midTick, 'ref-mid');
  const refPin    = await seekSettle(pinTick, 'ref-pin');
  ok(isRed(colorAtUV(refBefore, 0.5, 0.5)) && isRed(colorAtUV(refMid, 0.9, 0.9)),
     'without landings: Base is a full red frame up to the cut');
  ok(isRed(colorAtUV(refPin, 0.25, 0.25)) && isGreen(colorAtUV(refPin, 0.75, 0.25))
     && isBlue(colorAtUV(refPin, 0.75, 0.75)) && isBlack(colorAtUV(refPin, 0.25, 0.75)),
     'without landings: the pin frame is Alt (red TL, green TR, blue BR, empty BL)');

  // Landings: red from where it was over 2 beats, blue from the bottom edge
  // over 1 beat, both Linear so the in-flight rects are easy to state. Green
  // has none.
  const linear = { x1: 0, y1: 0, x2: 1, y2: 1 };
  addon.timeline_setCueLandings(pinTick, [
    { trackId: tA, from: 'whereItWas', leadInTicks: 2 * PPQ, easing: linear },
    { trackId: tB, from: 'edge', edgeAngleDeg: 270, leadInTicks: PPQ, easing: linear },
  ]);

  const before = await seekSettle(beforeTick, 'before');
  ok(frameHash(before) === frameHash(refBefore),
     'before the lead-in the frame is byte-identical with and without landings');

  // Halfway: red is at (0, 0, 0.75, 0.75); blue has not started (off-canvas).
  const mid = await seekSettle(midTick, 'mid');
  const midIn = colorAtUV(mid, 0.6, 0.6), midOut = colorAtUV(mid, 0.9, 0.9);
  console.log(`  mid: inside ${cstr(midIn)}  vacated ${cstr(midOut)}`);
  ok(isRed(midIn), 'mid lead-in: red is drawn at its in-flight rect');
  ok(isBlack(midOut), 'mid lead-in: the part of Base the move has left is empty (red is drawn once)');
  ok(isBlack(colorAtUV(mid, 0.9, 0.4)), 'mid lead-in: green has no landing and is not drawn before the cut');
  ok(frameHash(mid) !== frameHash(refMid), 'mid lead-in: the frame differs from the one without landings');

  // Three quarters: red at (0, 0, 0.625, 0.625); blue halfway up, its top at 0.75.
  const late = await seekSettle(lateTick, 'late');
  const lateBlue = colorAtUV(late, 0.75, 0.9), lateGap = colorAtUV(late, 0.75, 0.69);
  console.log(`  late: blue ${cstr(lateBlue)}  gap ${cstr(lateGap)}`);
  ok(isRed(colorAtUV(late, 0.3, 0.3)), 'late lead-in: red is still on its way to the top-left');
  ok(isBlue(lateBlue), 'late lead-in: blue is rising from the bottom edge');
  ok(isBlack(lateGap), 'late lead-in: blue has not reached its slot yet');
  ok(isBlack(colorAtUV(late, 0.75, 0.25)), 'late lead-in: green is still not drawn');

  // The pin frame is plain Alt, byte-identical to the frame without landings.
  const pin = await seekSettle(pinTick, 'pin');
  ok(frameHash(pin) === frameHash(refPin),
     'the pin frame is byte-identical with and without landings (green appears on the downbeat)');

  // Seek determinism: back into the lead-in.
  const lateAgain = await seekSettle(lateTick, 'late-again');
  ok(frameHash(lateAgain) === frameHash(late),
     'seeking back into the lead-in reproduces the same mid-move frame');

  // A crossfade around the pin. After the pin the landed tracks are carried
  // over the blend at full strength; green, with no landing, is still fading in.
  addon.timeline_setCueTransition(pinTick, {
    enabled: true, startOffsetTicks: PPQ, endOffsetTicks: PPQ, type: 'crossfade',
  });
  const fade = await seekSettle(pinTick + PPQ / 2, 'fade');
  const fadeRed = colorAtUV(fade, 0.25, 0.25), fadeBlue = colorAtUV(fade, 0.75, 0.75);
  const fadeGreen = colorAtUV(fade, 0.75, 0.25);
  console.log(`  crossfade: red ${cstr(fadeRed)}  blue ${cstr(fadeBlue)}  green ${cstr(fadeGreen)}`);
  ok(isRed(fadeRed) && isBlue(fadeBlue),
     'inside the crossfade the landed tracks are at full strength (carried over the blend)');
  ok(fadeGreen.g > 90 && fadeGreen.g < 235 && fadeGreen.r < 70,
     'inside the crossfade the track without a landing is still fading in');

  // The same frame without landings dims blue, which proves the carry did it.
  addon.timeline_setCueLandings(pinTick, []);
  const fadePlain = await seekSettle(pinTick + PPQ / 2, 'fade-plain');
  const plainBlue = colorAtUV(fadePlain, 0.75, 0.75);
  console.log(`  crossfade without landings: blue cell ${cstr(plainBlue)}`);
  ok(plainBlue.b < 235 && plainBlue.r > 30,
     'without landings the same crossfade frame still has Base (red) mixed into the blue cell');
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
