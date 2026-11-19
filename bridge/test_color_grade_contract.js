'use strict';
//
// bridge/test_color_grade_contract.js — end-to-end contract test for Color Grade
// (engine/src/model/ColorGrade.h), through the real addon on a real D3D11 device.
//
// The four-layer bridge fails silently when a link is missing (the renderer's
// optional chaining swallows it), so every assertion reads the result BACK: out
// of the engine, out of the composited preview frame, out of the exported file,
// or off disk. Nothing trusts a setter's return value alone.
//
// Spec acceptance criteria covered (docs: xleth-color-grade-spec.md §8):
//   A1  neutral at every level = the same frame
//   A2  one source on two tracks AND a pattern track: all show the Source grade
//   A3  Source -> Clip -> Layer -> Master order (swapping two changes the picture)
//   A4  editing one level / one clip never changes another
//   A5  Master reaches the empty area of the frame
//   A6  preview frame vs exported frame
//   A7  bypass at any level, and hold-to-compare, restore the prior look exactly
//   A8  one drag = one undo step; a Source edit undoes everywhere; bulk = one step
//   A9  save / load keeps every value at all four levels, incl. curve points
//   A11 a duplicated clip carries its grade, then is independent
//   A12 bulk apply across sources
//   A13 Auto on faded footage (real decode): corrects it, deterministic
//   A15 edits while playing do not crash
//
// Needs a GPU (D3D11) and ffmpeg on PATH; SKIPs (exit 0) otherwise, like the
// other render contract tests.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_color_grade_contract.js
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
  // A bridge rebuild wipes the FFmpeg DLLs out of build/Release; the engine
  // tree's copy is the one that stays.
  path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;

const PPQ = 960;
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

function findFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return (!r.error && r.status === 0) ? 'ffmpeg' : null;
}

function makeSolidVideo(ffmpeg, color, outPath) {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=4:r=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '14', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

// A test pattern degraded the way aged footage is: the whole range squeezed
// (milky blacks, dim whites) with the blue channel lifted in the shadows.
function makeFadedVideo(ffmpeg, outPath) {
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=4:r=30',
    '-vf', 'colorlevels=romin=0.20:gomin=0.20:bomin=0.27:romax=0.75:gomax=0.75:bomax=0.75,eq=saturation=0.45,format=yuv420p',
    '-c:v', 'libx264', '-crf', '14', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0;
}

// ── frame helpers (getCurrentFrame → { width, height, data:RGBA }) ──────────
function avg(fr, fx, fy, rad = 6) {
  const { width, height, data } = fr;
  const cx = Math.round(fx * (width - 1));
  const cy = Math.round(fy * (height - 1));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = cy - rad; y <= cy + rad; y++) {
    for (let x = cx - rad; x <= cx + rad; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const o = (y * width + x) * 4;
      r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
    }
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}
const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;
const close = (a, b, tol) => Math.abs(a.r - b.r) <= tol && Math.abs(a.g - b.g) <= tol && Math.abs(a.b - b.b) <= tol;
const sameFrame = (a, b) => a.width === b.width && a.height === b.height && Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) === 0;

const NEUTRAL = Object.freeze({
  bypassed: false, exposure: 0, contrast: 0, saturation: 0, vibrance: 0, temperature: 0, tint: 0, hue: 0,
  lift: { x: 0, y: 0, lum: 0 }, gamma: { x: 0, y: 0, lum: 0 }, gain: { x: 0, y: 0, lum: 0 },
  curves: { master: [], r: [], g: [], b: [] },
  lut: { path: '', amount: 1 },
});
const grade = (patch) => JSON.parse(JSON.stringify({ ...NEUTRAL, ...patch }));
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol;

function gradeMatches(got, want) {
  if (!got) return false;
  for (const k of ['exposure', 'contrast', 'saturation', 'vibrance', 'temperature', 'tint', 'hue']) {
    if (!near(got[k], want[k])) return false;
  }
  if (got.bypassed !== want.bypassed) return false;
  for (const k of ['lift', 'gamma', 'gain']) {
    if (!near(got[k].x, want[k].x) || !near(got[k].y, want[k].y) || !near(got[k].lum, want[k].lum)) return false;
  }
  for (const k of ['master', 'r', 'g', 'b']) {
    const a = got.curves[k] || [], b = want.curves[k] || [];
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!near(a[i][0], b[i][0]) || !near(a[i][1], b[i][1])) return false;
  }
  return got.lut.path === want.lut.path && near(got.lut.amount, want.lut.amount);
}

const METHODS = [
  'colorGrade_get', 'colorGrade_getAll', 'colorGrade_preview', 'colorGrade_commit', 'colorGrade_cancel',
  'colorGrade_setMany', 'colorGrade_analyze', 'colorGrade_setCompare', 'colorGrade_checkLut',
];

async function main() {
  console.log(`=== xleth Color Grade contract (${native.config}) ===\n`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found on PATH — cannot synthesise the test clips.');

  const tmpDir = path.join(os.tmpdir(), 'xleth-color-grade-contract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const RED = path.join(tmpDir, 'red.mp4');          // (200,60,60): a colour every control visibly moves
  const TEAL = path.join(tmpDir, 'teal.mp4');
  const FADED = path.join(tmpDir, 'faded.mp4');
  if (!makeSolidVideo(ffmpeg, '0xC83C3C', RED) || !makeSolidVideo(ffmpeg, '0x3C96A0', TEAL)
      || !makeFadedVideo(ffmpeg, FADED)) {
    skip('ffmpeg failed to produce the test clips.');
  }

  const addon = require(native.addonPath);

  console.log('[ addon surface ]');
  for (const m of METHODS) ok(typeof addon[m] === 'function', `addon exports ${m}`);

  ok(addon.initialize({}) === true, 'initialize() returns true');
  const diag0 = addon.diag_getVisualPreviewDiagnostic();
  if (!diag0.compositorReady) {
    addon.shutdown();
    skip('GPU preview compositor did not initialise (no usable D3D11 device).');
  }
  addon.timeline_setPreviewPosterMode(false);
  addon.setBPM(120);

  // ── Scene: one source on two clip tracks and a pattern track ─────────────
  // 2x2 grid with a gap: A = top-left (clip track), B = top-right (clip track,
  // same source), P = bottom-left (pattern track, same source). Bottom-right
  // and the gaps are empty, which is where the Master grade has to reach.
  const sidRed = addon.project_importSource(RED);
  const sidTeal = addon.project_importSource(TEAL);
  const sidFaded = addon.project_importSource(FADED);
  ok(sidRed >= 0 && sidTeal >= 0 && sidFaded >= 0, 'imported the sources');

  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
  const trackP = addon.timeline_addTrack({ name: 'P', volume: 1.0, order: 2, type: 'Pattern' });
  // addTrack ignores `type`; a Pattern Track is made by converting one.
  if (typeof addon.timeline_convertToPatternTrack === 'function') addon.timeline_convertToPatternTrack(trackP);
  ok(addon.timeline_getTracks().find((t) => t.id === trackP).type === 'Pattern', 'track P is a Pattern Track');

  const regA = addon.timeline_addRegion({ name: 'RA', label: 'RA', sourceId: sidRed, startTime: 0, endTime: 2 });
  const regP = addon.timeline_addRegion({ name: 'RP', label: 'RP', sourceId: sidRed, startTime: 0, endTime: 2 });

  const clipA = addon.timeline_addClip({ trackId: trackA, regionId: regA, positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  const clipB = addon.timeline_addClip({ trackId: trackB, regionId: regA, positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  const patternId = addon.timeline_addPattern({ name: 'P', regionId: regP, lengthTicks: 16 * PPQ });
  addon.timeline_addNote(patternId, { positionTicks: 0, durationTicks: 16 * PPQ, pitch: 60, velocity: 1 });
  addon.timeline_addPatternBlock({ trackId: trackP, patternId, positionTicks: 0, durationTicks: 16 * PPQ, offsetTicks: 0 });

  const FULL = 8;
  addon.timeline_setGridLayout({
    columns: 2, rows: 2, previewFps: 30, gapScale: 0.2,
    slots: [
      { trackId: trackA, gridX: 0,    gridY: 0,    spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 },
      { trackId: trackB, gridX: FULL, gridY: 0,    spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 1 },
      { trackId: trackP, gridX: 0,    gridY: FULL, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 2 },
    ],
    fullscreenLayers: [],
  });

  addon.play();
  await sleep(250);
  addon.stop();
  await sleep(150);

  async function seekSettle(tick) {
    const r = addon.video_requestPreviewFrameAtTimelinePosition({ ticks: tick });
    if (!r.accepted) throw new Error(`seek(${tick}) not accepted`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      if (d.stoppedPreview && d.stoppedPreview.publishedSeq >= r.seq) break;
      await sleep(40);
    }
    return addon.getCurrentFrame();
  }
  const TICK = 2 * PPQ;
  const frame = () => seekSettle(TICK);
  // Sample points, as fractions of the frame.
  const A = [0.25, 0.25], B = [0.75, 0.25], P = [0.25, 0.75], EMPTY = [0.75, 0.75];
  const at = (fr, p) => avg(fr, p[0], p[1]);
  const undoCount = () => addon.sandbox_getHistory().undoCount;

  const T = {
    source: { level: 'source', id: sidRed },
    clipA: { level: 'clip', id: clipA },
    clipB: { level: 'clip', id: clipB },
    region: { level: 'region', id: regP },
    layerA: { level: 'layer', id: trackA },
    layerB: { level: 'layer', id: trackB },
    master: { level: 'master' },
  };

  // ── Baseline ──────────────────────────────────────────────────────────────
  console.log('\n[ neutral: nothing graded ]');
  const fBase = await frame();
  const baseA = at(fBase, A);
  console.log(`  frame ${fBase.width}x${fBase.height}, cell A ${cstr(baseA)}, empty ${cstr(at(fBase, EMPTY))}`);
  ok(baseA.r > 150 && baseA.g < 110 && baseA.b < 110, `the source plays in cell A ${cstr(baseA)}`);
  ok(close(at(fBase, B), baseA, 3) && close(at(fBase, P), baseA, 3), 'the same source plays in cell B and on the pattern track');
  ok(at(fBase, EMPTY).r < 4 && at(fBase, EMPTY).g < 4, 'the empty area is black');

  const all0 = addon.colorGrade_getAll();
  ok(all0.sources.length === 0 && all0.clips.length === 0 && all0.regions.length === 0
     && all0.layers.length === 0 && all0.master === null, 'getAll: nothing is graded');
  for (const [name, t] of Object.entries(T)) {
    const g = addon.colorGrade_get(t);
    ok(g.exists === true && g.isDefault === true, `${name}: a fresh grade is the default`);
  }
  ok(addon.colorGrade_get({ level: 'clip', id: 987654 }).exists === false, 'an unknown owner reports exists=false');

  // A neutral commit at every level writes nothing and changes no pixel (A1).
  const u0 = undoCount();
  for (const t of Object.values(T)) addon.colorGrade_commit(t, grade({}));
  ok(undoCount() === u0, 'committing a neutral grade leaves no undo entry');
  ok(sameFrame(await frame(), fBase), 'neutral at all levels: the frame is identical, byte for byte (A1)');

  // ── Source: inherited everywhere (A2) ─────────────────────────────────────
  console.log('\n[ source grade: every use of the source ]');
  const gSource = grade({ saturation: -1 });       // greyscale: unmistakable
  let res = addon.colorGrade_commit(T.source, gSource);
  ok(res.changed === true && gradeMatches(res.grade, gSource), 'commit returns the stored grade');
  ok(undoCount() === u0 + 1, 'a source edit is ONE undo entry, however many placements show it');
  let f = await frame();
  const grey = (c) => Math.abs(c.r - c.g) < 5 && Math.abs(c.g - c.b) < 5;
  console.log(`  A ${cstr(at(f, A))}  B ${cstr(at(f, B))}  P ${cstr(at(f, P))}`);
  ok(grey(at(f, A)), 'clip track A shows the source grade');
  ok(grey(at(f, B)), 'clip track B shows the source grade');
  ok(grey(at(f, P)), 'the pattern track shows the source grade, with no extra step');
  ok(addon.colorGrade_getAll().sources.length === 1 && addon.colorGrade_getAll().sources[0].id === sidRed,
     'getAll lists the graded source');

  addon.undo_undo();
  f = await frame();
  ok(sameFrame(f, fBase), 'undo restores every placement at once (A8)');
  addon.undo_redo();
  f = await frame();
  ok(grey(at(f, A)) && grey(at(f, B)) && grey(at(f, P)), 'redo brings the source grade back everywhere');
  addon.undo_undo();

  // ── Clip, region, layer: independence (A4) ────────────────────────────────
  console.log('\n[ clip, sample and layer grades: each its own ]');
  addon.colorGrade_commit(T.clipA, grade({ hue: 120 }));           // red -> green, clip A only
  f = await frame();
  console.log(`  clip A hue+120: A ${cstr(at(f, A))}  B ${cstr(at(f, B))}  P ${cstr(at(f, P))}`);
  ok(at(f, A).g > at(f, A).r + 40, 'the clip grade changes its own clip');
  ok(close(at(f, B), baseA, 3), 'its sibling clip (same region, same source) is untouched');
  ok(close(at(f, P), baseA, 3), 'the pattern track is untouched');
  ok(addon.colorGrade_get(T.clipB).isDefault && addon.colorGrade_get(T.source).isDefault
     && addon.colorGrade_get(T.layerA).isDefault, 'no other level’s values moved');
  ok(addon.timeline_getClips().find((c) => c.id === clipA).colorGrade !== undefined
     && addon.timeline_getClips().find((c) => c.id === clipB).colorGrade === undefined,
     'timeline_getClips carries colorGrade on the graded clip only');

  addon.colorGrade_commit(T.region, grade({ hue: -120 }));         // red -> blue, the pattern's sample
  f = await frame();
  console.log(`  sample hue-120: P ${cstr(at(f, P))}`);
  ok(at(f, P).b > at(f, P).r + 40, 'the sample grade shows on the pattern track');
  ok(close(at(f, B), baseA, 3), 'and not on a clip track');

  addon.colorGrade_commit(T.layerB, grade({ saturation: -1 }));    // layer B greyscale
  f = await frame();
  ok(grey(at(f, B)), 'the layer grade changes its own cell');
  ok(at(f, A).g > at(f, A).r + 40 && at(f, P).b > at(f, P).r + 40, 'the other cells keep their own look');

  // ── Order: Source -> Clip -> Layer -> Master (A3) ─────────────────────────
  console.log('\n[ order of levels ]');
  const crush = grade({ curves: { master: [[0, 0], [0.5, 0.15], [1, 1]], r: [], g: [], b: [] } });
  const wash = grade({ saturation: -0.7, lift: { x: 0, y: 0, lum: 0.6 } });
  addon.colorGrade_setMany([
    { ...T.clipA, grade: grade({}) }, { ...T.region, grade: grade({}) }, { ...T.layerB, grade: grade({}) },
    { ...T.source, grade: crush }, { ...T.layerA, grade: wash },
  ], 'order setup');
  const fSourceThenLayer = await frame();
  addon.colorGrade_setMany([{ ...T.source, grade: wash }, { ...T.layerA, grade: crush }], 'order swapped');
  const fLayerThenSource = await frame();
  const o1 = at(fSourceThenLayer, A), o2 = at(fLayerThenSource, A);
  console.log(`  crush then wash ${cstr(o1)}  vs  wash then crush ${cstr(o2)}`);
  ok(!close(o1, o2, 6), 'swapping Source and Layer gives a different picture');
  // The swap moved the Source grade, which cell B shares; cell B has no layer
  // grade, so it shows each Source grade on its own.
  ok(!close(at(fSourceThenLayer, B), at(fLayerThenSource, B), 6), 'the Source grade is the first thing every cell gets');

  addon.colorGrade_setMany([{ ...T.source, grade: crush }, { ...T.layerA, grade: grade({}) }, { ...T.master, grade: wash }], 'master order');
  const fSourceThenMaster = await frame();
  ok(close(at(fSourceThenMaster, A), o1, 4), 'Master applies to the result of the per-cell levels (same as Source then Layer here)');
  addon.colorGrade_setMany([{ ...T.source, grade: grade({}) }, { ...T.master, grade: grade({}) }], 'clear');
  ok(sameFrame(await frame(), fBase), 'everything reset: back to the identical baseline frame');

  // ── Master: the whole frame (A5) ──────────────────────────────────────────
  console.log('\n[ master grade ]');
  const gMaster = grade({ lift: { x: 0, y: 0, lum: 0.6 } });
  addon.colorGrade_commit(T.master, gMaster);
  f = await frame();
  const empty = at(f, EMPTY);
  console.log(`  empty area under a lifting master grade ${cstr(empty)}; cell A ${cstr(at(f, A))}`);
  ok(empty.r > 30 && grey(empty), 'the Master grade reaches the empty area of the frame');
  ok(at(f, A).g > baseA.g + 15, 'and grades the cells too');
  ok(addon.colorGrade_getAll().master !== null && addon.colorGrade_getAll().master.active === true, 'getAll reports the master grade');
  const fMaster = f;

  // ── Compare and bypass (A7) ───────────────────────────────────────────────
  console.log('\n[ hold to compare, bypass ]');
  addon.colorGrade_setCompare(true);
  ok(sameFrame(await frame(), fBase), 'compare: the picture without any grade is exactly the ungraded frame');
  ok(addon.colorGrade_getAll().compare === true && gradeMatches(addon.colorGrade_get(T.master).grade, gMaster),
     'compare changes no stored value');
  addon.colorGrade_setCompare(false);
  ok(sameFrame(await frame(), fMaster), 'releasing compare brings the graded frame back exactly');

  const uB = undoCount();
  addon.colorGrade_commit(T.master, { ...gMaster, bypassed: true });
  ok(sameFrame(await frame(), fBase), 'bypassing the level restores the prior look exactly');
  ok(undoCount() === uB + 1, 'a bypass is one undo step');
  const gb = addon.colorGrade_get(T.master);
  ok(gb.grade.bypassed === true && near(gb.grade.lift.lum, 0.6) && gb.isDefault === false, 'a bypassed grade keeps its values');
  ok(addon.colorGrade_getAll().master.active === false, 'getAll reports it as present but not active');
  addon.colorGrade_commit(T.master, gMaster);
  ok(sameFrame(await frame(), fMaster), 'switching it back on is the same graded frame');

  // ── A drag: live picture, one undo step (A8) ──────────────────────────────
  console.log('\n[ a drag: preview, commit, cancel ]');
  addon.colorGrade_commit(T.master, grade({}));
  const uD = undoCount();
  const before = addon.colorGrade_get(T.layerA).grade;
  for (const e of [0.3, 0.6, 0.9, 1.2]) addon.colorGrade_preview(T.layerA, grade({ exposure: e }));
  ok(undoCount() === uD, 'previews leave no undo entry');
  f = await frame();
  ok(at(f, A).r > baseA.r + 10 || at(f, A).g > baseA.g + 15, `the picture moved during the drag ${cstr(at(f, A))}`);
  ok(near(addon.colorGrade_get(T.layerA).grade.exposure, 1.2), 'the engine holds the previewed value');

  addon.colorGrade_cancel(T.layerA);
  ok(gradeMatches(addon.colorGrade_get(T.layerA).grade, before) && undoCount() === uD, 'cancel puts back what was there, with no undo entry');
  ok(sameFrame(await frame(), fBase), 'and the picture is back, exactly');

  for (const e of [0.2, 0.5, 0.8]) addon.colorGrade_preview(T.layerA, grade({ exposure: e }));
  res = addon.colorGrade_commit(T.layerA, grade({ exposure: 0.8 }));
  ok(res.changed === true && undoCount() === uD + 1, 'the whole drag commits as exactly ONE undo step');
  addon.undo_undo();
  ok(gradeMatches(addon.colorGrade_get(T.layerA).grade, before), 'undoing the drag returns to the value from before it began');
  ok(sameFrame(await frame(), fBase), 'and to the frame from before it began');
  addon.undo_redo();
  ok(near(addon.colorGrade_get(T.layerA).grade.exposure, 0.8), 'redo returns to the committed value');
  addon.undo_undo();

  // A drag left open is abandoned by undo, never committed by accident.
  addon.colorGrade_preview(T.layerA, grade({ exposure: 2 }));
  addon.colorGrade_commit(T.source, grade({ contrast: 0.1 }));
  addon.undo_undo();
  ok(addon.colorGrade_get(T.layerA).isDefault, 'undo abandons a drag still in flight (its preview is not left in the picture)');

  // Out-of-range values are clamped on the way in.
  res = addon.colorGrade_commit(T.layerA, { ...grade({}), exposure: 99, saturation: -9, hue: 999 });
  ok(near(res.grade.exposure, 4) && near(res.grade.saturation, -1) && near(res.grade.hue, 180), 'values are clamped into range');
  addon.undo_undo();

  // ── Duplicate a clip (A11) ────────────────────────────────────────────────
  console.log('\n[ duplicating a clip ]');
  const gClip = grade({ hue: 120, curves: { master: [], r: [[0, 0.1], [0.5, 0.6], [1, 0.9]], g: [], b: [] } });
  addon.colorGrade_commit(T.clipA, gClip);
  const src = addon.timeline_getClips().find((c) => c.id === clipA);
  // What paste / duplicate do: rebuild the clip from its JS form.
  const copyId = addon.timeline_addClip({ ...src, id: undefined, positionTicks: 32 * PPQ });
  const copied = addon.colorGrade_get({ level: 'clip', id: copyId });
  ok(copied.exists && gradeMatches(copied.grade, gClip), 'a duplicated clip carries its grade, curve points included');
  addon.colorGrade_commit({ level: 'clip', id: copyId }, grade({ tint: 0.5 }));
  ok(gradeMatches(addon.colorGrade_get(T.clipA).grade, gClip), 'editing the copy leaves the original alone');
  addon.colorGrade_commit(T.clipA, grade({}));

  // ── Bulk apply (A12) ──────────────────────────────────────────────────────
  console.log('\n[ bulk apply across sources ]');
  const gBulk = grade({ contrast: 0.3, vibrance: 0.2 });
  const uM = undoCount();
  res = addon.colorGrade_setMany([sidRed, sidTeal, sidFaded].map((id) => ({ level: 'source', id, grade: gBulk })),
                                 'Apply color grade to 3 sources');
  ok(res.changed === 3, 'setMany reports three changed');
  ok(undoCount() === uM + 1, 'the whole batch is ONE undo entry');
  ok([sidRed, sidTeal, sidFaded].every((id) => gradeMatches(addon.colorGrade_get({ level: 'source', id }).grade, gBulk)),
     'every source got the grade');
  ok(addon.undo_getUndoDescription() === 'Apply color grade to 3 sources', 'the undo entry is named for what it did');
  addon.undo_undo();
  ok([sidRed, sidTeal, sidFaded].every((id) => addon.colorGrade_get({ level: 'source', id }).isDefault),
     'one undo reverts the whole batch');
  res = addon.colorGrade_setMany([{ level: 'source', id: sidRed, grade: grade({}) }], 'noop');
  ok(res.changed === 0 && undoCount() === uM, 'a batch that changes nothing leaves no undo entry');

  // ── LUT import ────────────────────────────────────────────────────────────
  console.log('\n[ LUT import ]');
  const lutPath = path.join(tmpDir, 'swap.cube');
  {
    let s = 'TITLE "Swap red and blue"\nLUT_3D_SIZE 2\n';
    for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) s += `${b} ${g} ${r}\n`;
    fs.writeFileSync(lutPath, s);
  }
  const chk = addon.colorGrade_checkLut(lutPath);
  ok(chk.ok === true && chk.size === 2 && chk.title === 'Swap red and blue', 'checkLut accepts a .cube file');
  const bad = path.join(tmpDir, 'bad.cube');
  fs.writeFileSync(bad, 'LUT_1D_SIZE 4\n0 0 0\n1 1 1\n');
  ok(addon.colorGrade_checkLut(bad).ok === false && !!addon.colorGrade_checkLut(bad).error, 'checkLut refuses a 1D LUT, with a reason');
  ok(addon.colorGrade_checkLut(path.join(tmpDir, 'missing.cube')).ok === false, 'checkLut refuses a missing file');

  addon.colorGrade_commit(T.layerA, grade({ lut: { path: lutPath, amount: 1 } }));
  f = await frame();
  console.log(`  cell A through the swap LUT ${cstr(at(f, A))}`);
  ok(at(f, A).b > 150 && at(f, A).r < 110, 'the LUT is applied: red and blue swap');
  ok(close(at(f, B), baseA, 3), 'on its own level only');
  ok(addon.colorGrade_get(T.layerA).lutError === '', 'no LUT error is reported');
  addon.colorGrade_commit(T.layerA, grade({ lut: { path: path.join(tmpDir, 'missing.cube'), amount: 1 } }));
  ok(addon.colorGrade_get(T.layerA).lutError !== '', 'a missing LUT file is reported, and the grade is kept');
  ok(sameFrame(await frame(), fBase), 'and renders as no change rather than a broken picture');
  addon.colorGrade_commit(T.layerA, grade({}));

  // ── Auto (A13): a real faded file, decoded ────────────────────────────────
  console.log('\n[ Auto ]');
  const tFaded = { level: 'source', id: sidFaded };
  const a1 = addon.colorGrade_analyze(tFaded);
  ok(a1.ok === true, `analyze decodes the source${a1.ok ? '' : ` (${a1.error})`}`);
  if (a1.ok) {
    console.log(`  faded source: black ${a1.analysis.blackPoint.toFixed(3)}, white ${a1.analysis.whitePoint.toFixed(3)}, `
      + `frames ${a1.analysis.frames}; auto lift ${a1.auto.lift.lum}, gain ${a1.auto.gain.lum}, `
      + `vibrance ${a1.auto.vibrance}, saturation ${a1.auto.saturation}`);
    ok(a1.analysis.frames >= 12 && a1.analysis.luma.length === 256, 'it looked at many frames of the whole source');
    ok(a1.analysis.blackPoint > 0.08, 'the footage really has lifted blacks');
    ok(a1.auto.lift.lum < -0.1, 'Auto pulls the lifted blacks down');
    ok(a1.auto.gain.lum > 0.05, 'Auto brings the dim highlights up');
    ok(a1.auto.exposure === 0 && a1.auto.contrast === 0 && a1.auto.curves.master.length === 0 && a1.auto.lut.path === '',
       'Auto proposes ordinary controls only (wheels, saturation, vibrance)');
    const a2 = addon.colorGrade_analyze(tFaded, { refresh: true });
    ok(a2.ok && JSON.stringify(a2.auto) === JSON.stringify(a1.auto), 'the same source gives the same result (analysed again from the file)');

    // Applied as ordinary controls, the footage measures better: analyse the
    // clip THROUGH the new source grade.
    const regFaded = addon.timeline_addRegion({ name: 'RF', label: 'RF', sourceId: sidFaded, startTime: 0, endTime: 4 });
    const beforeAuto = addon.colorGrade_analyze({ level: 'region', id: regFaded });
    const uA = undoCount();
    addon.colorGrade_commit(tFaded, a1.auto, 'Auto color grade');
    ok(undoCount() === uA + 1, 'applying Auto is one undo step');
    const afterAuto = addon.colorGrade_analyze({ level: 'region', id: regFaded });
    ok(beforeAuto.ok && afterAuto.ok, 'a sample is analysed through its source grade');
    if (beforeAuto.ok && afterAuto.ok) {
      const b = beforeAuto.analysis, a = afterAuto.analysis;
      console.log(`  through Auto: black ${b.blackPoint.toFixed(3)} -> ${a.blackPoint.toFixed(3)}, `
        + `white ${b.whitePoint.toFixed(3)} -> ${a.whitePoint.toFixed(3)}`);
      ok(a.blackPoint < b.blackPoint - 0.05 && a.blackPoint < 0.06, 'black level is measurably better');
      ok((a.whitePoint - a.blackPoint) > (b.whitePoint - b.blackPoint) * 1.3, 'contrast (tonal range) is measurably wider');
      const again = addon.colorGrade_analyze({ level: 'region', id: regFaded });
      ok(again.ok && autoSize(again.auto) < autoSize(a1.auto) * 0.35,
         'footage Auto has already corrected is near no-change the second time');
    }
    addon.undo_undo();
    ok(addon.colorGrade_get(tFaded).isDefault, 'and Auto undoes in one step');
  }
  ok(addon.colorGrade_analyze({ level: 'source', id: 424242 }).ok === false, 'analyze of a missing source fails cleanly');
  const layerAuto = addon.colorGrade_analyze(T.layerA);
  ok(layerAuto.ok === true, 'analyze works at the Layer level (the sources that track plays)');
  const masterAuto = addon.colorGrade_analyze(T.master);
  ok(masterAuto.ok === true && masterAuto.analysis.frames > 0, 'analyze works at the Master level (every video source)');

  // ── Edits while playing (A15) ─────────────────────────────────────────────
  console.log('\n[ editing during playback ]');
  addon.play();
  for (let i = 0; i < 60; i++) {
    const v = Math.sin(i / 6);
    addon.colorGrade_preview(T.source, grade({ exposure: v, hue: v * 90, curves: { master: [[0, 0], [0.5, 0.5 + v * 0.3], [1, 1]], r: [], g: [], b: [] } }));
    addon.colorGrade_preview(T.master, grade({ contrast: v * 0.5, lift: { x: v * 0.3, y: -v * 0.3, lum: v * 0.2 } }));
    if (i % 10 === 0) addon.colorGrade_setCompare(i % 20 === 0);
    await sleep(16);
  }
  addon.colorGrade_setCompare(false);
  addon.colorGrade_cancel(T.source);
  addon.colorGrade_cancel(T.master);
  addon.stop();
  await sleep(150);
  const dPlay = addon.diag_getVisualPreviewDiagnostic();
  ok(dPlay.compositorReady === true, 'sixty live edits at two levels during playback: the preview is still running');
  ok(addon.colorGrade_get(T.source).isDefault && addon.colorGrade_get(T.master).isDefault, 'cancelling both drags left nothing behind');
  ok(sameFrame(await frame(), fBase), 'and the frame is the baseline again');

  // ── Preview vs export (A6) ────────────────────────────────────────────────
  console.log('\n[ preview vs export ]');
  const final = {
    source: grade({ temperature: 0.4, gain: { x: 0.1, y: 0.2, lum: -0.2 } }),
    clipA: grade({ hue: 60, curves: { master: [[0, 0], [0.4, 0.5], [1, 1]], r: [], g: [[0, 0.05], [1, 0.9]], b: [] } }),
    region: grade({ saturation: -0.5, vibrance: 0.3 }),
    layerB: grade({ contrast: 0.4, tint: -0.3, lift: { x: -0.2, y: 0.1, lum: 0.1 } }),
    master: grade({ exposure: 0.2, gamma: { x: 0.1, y: -0.1, lum: 0.15 } }),
  };
  addon.colorGrade_setMany([
    { ...T.source, grade: final.source }, { ...T.clipA, grade: final.clipA }, { ...T.region, grade: final.region },
    { ...T.layerB, grade: final.layerB }, { ...T.master, grade: final.master },
  ], 'all four levels');
  // "Just after a drag release": the last thing before the export is a drag.
  addon.colorGrade_preview(T.layerA, grade({ saturation: 0.5 }));
  addon.colorGrade_commit(T.layerA, grade({ saturation: 0.3 }));
  final.layerA = grade({ saturation: 0.3 });

  const fPreview = await frame();
  const pv = { A: at(fPreview, A), B: at(fPreview, B), P: at(fPreview, P), E: at(fPreview, EMPTY) };
  console.log(`  [preview]  A ${cstr(pv.A)}  B ${cstr(pv.B)}  P ${cstr(pv.P)}  empty ${cstr(pv.E)}`);
  ok(!close(pv.A, pv.B, 6) && !close(pv.B, pv.P, 6), 'all four levels are in play (the three cells differ)');

  const exportPath = path.join(tmpDir, 'color-grade-export.mp4');
  try { fs.unlinkSync(exportPath); } catch { /* first run */ }
  const started = addon.video_exportStart({
    outputPath: exportPath,
    videoCodec: 'h264', rateControl: 'crf', crf: 12,
    width: fPreview.width, height: fPreview.height, fpsNum: 30, fpsDen: 1,
    startBeat: 0, endBeat: 4,
  });
  ok(started === true, 'video_exportStart accepted');
  if (started) {
    const deadline = Date.now() + 120000;
    let prog = null;
    while (Date.now() < deadline) {
      prog = addon.video_exportGetProgress();
      if (prog && (prog.complete || prog.failed)) break;
      await sleep(200);
    }
    if (prog && prog.failed) console.error(`  export failed: ${prog.error}`);
    ok(!!(prog && prog.complete && !prog.failed), 'the export completed');
    const exported = fs.existsSync(exportPath) && fs.statSync(exportPath).size > 0;
    ok(exported, 'the export produced a file');
    if (exported) {
      const W = fPreview.width, H = fPreview.height;
      for (const n of [5, 30, 55]) {
        const raw = path.join(tmpDir, `export-frame-${n}.rawvideo`);
        try { fs.unlinkSync(raw); } catch { /* first run */ }
        spawnSync(ffmpeg, [
          '-y', '-loglevel', 'error', '-i', exportPath,
          '-vf', `select=eq(n\\,${n})`, '-vframes', '1',
          '-f', 'rawvideo', '-pix_fmt', 'rgba', raw,
        ], { stdio: 'ignore' });
        if (fs.existsSync(raw) && fs.statSync(raw).size >= W * H * 4) {
          const ex = { width: W, height: H, data: fs.readFileSync(raw) };
          const e = { A: at(ex, A), B: at(ex, B), P: at(ex, P), E: at(ex, EMPTY) };
          console.log(`  [export ${String(n).padStart(2)}] A ${cstr(e.A)}  B ${cstr(e.B)}  P ${cstr(e.P)}  empty ${cstr(e.E)}`);
          // H.264 through yuv420 and back: a few 8-bit steps of rounding.
          const tol = 6;
          ok(close(e.A, pv.A, tol) && close(e.B, pv.B, tol) && close(e.P, pv.P, tol) && close(e.E, pv.E, tol),
             `frame ${n}: the exported picture matches the preview within encoder rounding`);
        } else {
          ok(false, `frame ${n}: could not read a frame back from the exported file`);
        }
      }
    }
  }

  // ── Save / load (A9) ──────────────────────────────────────────────────────
  console.log('\n[ save and load ]');
  {
    const projDir = path.join(tmpDir, 'proj-roundtrip');
    fs.rmSync(projDir, { recursive: true, force: true });
    // Left open on purpose: a drag in flight must not be what gets saved.
    addon.colorGrade_preview(T.layerB, grade({ exposure: 3 }));
    const saved = addon.project_saveAs(projDir, 'ColorGradeRoundTrip');
    ok(!!saved, 'project_saveAs succeeded');
    if (saved) {
      const onDisk = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8'));
      ok(!!onDisk.masterColorGrade, 'the master grade is in project.json');
      const dSrc = onDisk.sources.find((s) => s.id === sidRed);
      const dTeal = onDisk.sources.find((s) => s.id === sidTeal);
      ok(!!dSrc && !!dSrc.colorGrade, 'the source grade is in project.json');
      ok(!!dTeal && dTeal.colorGrade === undefined, 'an ungraded source writes no grade key at all');
      const dTrackB = onDisk.tracks.find((t) => t.id === trackB);
      ok(!!dTrackB && near(dTrackB.colorGrade.exposure, 0) && near(dTrackB.colorGrade.contrast, 0.4),
         'the file holds the committed layer grade, not the drag left in flight');

      ok(addon.project_load(projDir) !== false, 'project_load succeeded');
      ok(gradeMatches(addon.colorGrade_get(T.source).grade, final.source), 'source grade survives save/load');
      ok(gradeMatches(addon.colorGrade_get(T.clipA).grade, final.clipA), 'clip grade survives, every curve point');
      ok(gradeMatches(addon.colorGrade_get(T.region).grade, final.region), 'sample grade survives');
      ok(gradeMatches(addon.colorGrade_get(T.layerA).grade, final.layerA), 'layer grade survives');
      ok(gradeMatches(addon.colorGrade_get(T.layerB).grade, final.layerB), 'second layer grade survives');
      ok(gradeMatches(addon.colorGrade_get(T.master).grade, final.master), 'master grade survives');
      const all = addon.colorGrade_getAll();
      ok(all.sources.length === 1 && all.regions.length === 1 && all.layers.length === 2 && all.master !== null,
         'getAll after load lists exactly the graded owners');
      ok(addon.undo_canUndo() === false, 'a loaded project starts with a clean undo history');
    }
  }

  addon.shutdown();
  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

function autoSize(g) {
  return Math.abs(g.lift.lum) + Math.abs(g.lift.x) + Math.abs(g.lift.y) + Math.abs(g.gamma.lum)
       + Math.abs(g.gain.lum) + Math.abs(g.gain.x) + Math.abs(g.gain.y)
       + Math.abs(g.saturation) + Math.abs(g.vibrance);
}

main().catch((err) => {
  console.error('\nUNCAUGHT:', err && err.stack ? err.stack : err);
  process.exit(1);
});
