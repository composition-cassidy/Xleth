'use strict';
//
// bridge/test_outline_dropshadow_contract.js
//
// Contract test for the Outline and Drop Shadow visual effects, driven through
// the REAL xleth_native.node addon on a REAL D3D11 device.
//
// These two effects are unlike every other chainable effect in one specific way,
// and that is what this test is built around: they draw OUTSIDE the source's own
// bounds. A pass that renders into a cell-sized target the source already fills
// has nowhere to put a stroke or an offset shadow, so the engine runs them in
// PADDED targets and grows the cell's composite rect to match. Nothing else in
// the pipeline changes that rect, so a regression there shows up as "the effect
// is invisible" or "the cell moved", neither of which a unit test would catch.
//
// Scene: a 640x360 clip that is chroma-key green (#00B140) with a solid RED
// square in the middle, placed as a 1x1 grid cell with gapScale 0.4 — so the
// cell occupies the middle 60% of the canvas and there is real estate outside it
// for the decoration to land in. A solid BLUE fullscreen layer sits behind.
//
// Exact geometry the assertions rely on (at output WxH, canvas-fit identity):
//   cell rect            x in [0.2W, 0.8W], y in [0.2H, 0.8H]
//   red square (keyed)   the source's centre 200x200 of 640x360, mapped into
//                        that rect: x in [0.34375, 0.65625] of the cell, etc.
//
// What it verifies:
//   (a) geometry     — the stroke lands OUTSIDE the cell rect, in the gap
//   (b) silhouette   — with a keyer active the stroke follows the CUTOUT, not
//                      the cell rectangle
//   (c) params       — every Outline and Drop Shadow param moves the composite,
//                      with point-sampled proof for colour/thickness/opacity/
//                      distance/angle/size
//   (d) blend modes  — Normal / Multiply / Darken / Linear Burn each produce the
//                      arithmetic they claim, against a grey backdrop chosen so
//                      all four separate
//   (e) terminal     — position in the chain does not change the result
//   (f) bypass       — both are skipped under setPreviewEffectsBypass(true)
//   (g) undo/redo    — add / set-param / remove round-trip
//   (h) save/load    — both persist under their own type names with named params
//   (i) export       — the rendered file matches the preview
//
// Needs a GPU (D3D11) and ffmpeg on PATH; SKIPs (exit 0) otherwise, matching the
// environment-gating the other GPU contract tests use.
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

const PPQ = 960;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Canonical param indices — mirror the layouts documented on VisualEffect in
// engine/src/model/TimelineTypes.h.
const FX_CHROMA_KEY = 5;
const FX_OUTLINE    = 6;
const FX_SHADOW     = 7;

const O_R = 0, O_G = 1, O_B = 2, O_THICK = 3, O_SOFT = 4, O_OPACITY = 5, O_CUTOFF = 6;

const S_R = 0, S_G = 1, S_B = 2, S_DIST = 3, S_ANGLE = 4, S_SIZE = 5,
      S_SOFT = 6, S_OPACITY = 7, S_BLEND = 8, S_CUTOFF = 9;

const BLEND_NORMAL = 0, BLEND_MULTIPLY = 1, BLEND_DARKEN = 2, BLEND_LINEAR_BURN = 3;

// gapScale for the scene. Big enough that the stroke and the shadow have room to
// land outside the cell and still be sampled a comfortable distance from any
// edge. Engine-side gapScale is validated to [0, 0.5].
const GAP = 0.4;

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

// Green screen with a centred red square, same generator as the chroma-key
// contract so the two tests reason about the same geometry.
function makeGreenScreenVideo(ffmpeg, outPath) {
  if (fs.existsSync(outPath)) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x00B140:s=640x360:d=4:r=30',
    '-f', 'lavfi', '-i', 'color=c=0xFF0000:s=200x200:d=4:r=30',
    '-filter_complex', '[0:v][1:v]overlay=(W-w)/2:(H-h)/2,format=yuv420p',
    '-c:v', 'libx264', '-crf', '18', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

function makeSolidVideo(ffmpeg, color, outPath) {
  if (fs.existsSync(outPath)) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=4:r=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

// ── frame helpers (getCurrentFrame → { width, height, data:RGBA }) ──────────
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
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}

// rad=1 (a 3x3 average) rather than the chroma test's 4: these samples sit only
// a few pixels from a deliberately hard edge, so a wide average would straddle it.
const at = (fr, xPx, yPx, rad = 1) => avgColor(fr, Math.round(xPx), Math.round(yPx), rad);

// The cell's rect in output pixels, derived from gapScale exactly the way
// GridCompositor::compositeFrame derives it (shrink symmetrically by rw*gap/2).
function cellRect(fr) {
  return {
    x0: (GAP / 2) * fr.width,  x1: (1 - GAP / 2) * fr.width,
    y0: (GAP / 2) * fr.height, y1: (1 - GAP / 2) * fr.height,
    midX: fr.width / 2, midY: fr.height / 2,
  };
}

// The keyed red square's rect in output pixels: the source's centred 200x200 of
// 640x360, mapped through the cell rect.
function redSquareRect(fr) {
  const c = cellRect(fr);
  const w = c.x1 - c.x0, h = c.y1 - c.y0;
  return {
    x0: c.x0 + (220 / 640) * w, x1: c.x0 + (420 / 640) * w,
    y0: c.y0 + (80 / 360) * h,  y1: c.y0 + (280 / 360) * h,
  };
}

// A point on the green screen INSIDE the cell: 90% down the cell, which is below
// the red square (it ends at 77.8% of the cell height) and above the bottom edge.
// Expressed as a fraction of the cell, not a pixel offset — the preview renders
// at the project's output resolution, which is not the clips' 640x360.
function greenPointInCell(fr) {
  const c = cellRect(fr);
  return [c.midX, c.y0 + 0.90 * (c.y1 - c.y0)];
}

const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;
const isRed     = (c) => c.r > 140 && c.g < 90 && c.b < 90;
const isBlue    = (c) => c.b > 140 && c.r < 90 && c.g < 90;
const isGreen   = (c) => c.g > 110 && c.r < 110 && c.b < 110;
const isYellow  = (c) => c.r > 150 && c.g > 150 && c.b < 90;
const isCyan    = (c) => c.g > 150 && c.b > 150 && c.r < 90;
const isMagenta = (c) => c.r > 150 && c.b > 150 && c.g < 90;
const isDark    = (c) => c.r < 60 && c.g < 60 && c.b < 60;
const lum       = (c) => (c.r + c.g + c.b) / 3;

function frameHash(fr) {
  let h = 0x811c9dc5 >>> 0;
  const d = fr.data;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

async function main() {
  console.log(`=== xleth outline + drop-shadow contract (${native.config}) ===\n`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found on PATH — cannot synthesise the test clips.');

  const tmpDir = path.join(os.tmpdir(), 'xleth-outline-shadow-contract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const GREEN = path.join(tmpDir, 'greenscreen.mp4');
  const BLUE  = path.join(tmpDir, 'blue.mp4');
  const GREY  = path.join(tmpDir, 'grey.mp4');
  if (!makeGreenScreenVideo(ffmpeg, GREEN) ||
      !makeSolidVideo(ffmpeg, 'blue', BLUE) ||
      !makeSolidVideo(ffmpeg, '0x808080', GREY)) {
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

  addon.timeline_setPreviewPosterMode(false);   // live decode, not static poster
  addon.setBPM(120);

  // ── Author the scene ──────────────────────────────────────────────────────
  const sidGreen = addon.project_importSource(GREEN);
  const sidBlue  = addon.project_importSource(BLUE);
  const sidGrey  = addon.project_importSource(GREY);
  ok(sidGreen >= 0 && sidBlue >= 0 && sidGrey >= 0, 'imported all three sources');

  const trackCell   = addon.timeline_addTrack({ name: 'Cell',   volume: 1.0, order: 0 });
  const trackBehind = addon.timeline_addTrack({ name: 'Behind', volume: 1.0, order: 1 });
  const trackGrey   = addon.timeline_addTrack({ name: 'Grey',   volume: 1.0, order: 2 });

  const regGreen = addon.timeline_addRegion({ name: 'G', label: 'G', sourceId: sidGreen, startTime: 0, endTime: 2 });
  const regBlue  = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sidBlue,  startTime: 0, endTime: 2 });
  const regGrey  = addon.timeline_addRegion({ name: 'Y', label: 'Y', sourceId: sidGrey,  startTime: 0, endTime: 2 });

  addon.timeline_addClip({ trackId: trackCell,   regionId: regGreen, positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackBehind, regionId: regBlue,  positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackGrey,   regionId: regGrey,  positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });

  const FULL = 8;
  // gapScale 0.4 shrinks the single cell to the middle 60% of the canvas. That
  // margin is the whole point: it is where an outline or an offset shadow has to
  // land, and with gap 0 there would be nowhere for either to show.
  const baseLayout = (behindTrackId) => ({
    columns: 1, rows: 1, previewFps: 30, gapScale: GAP,
    slots: [{ trackId: trackCell, gridX: 0, gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 }],
    fullscreenLayers: [{ trackId: behindTrackId, opacity: 1.0, placement: 'behind' }],
  });
  addon.timeline_setGridLayout(baseLayout(trackBehind));

  addon.play();
  await sleep(200);
  addon.stop();
  await sleep(120);

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
  const setP = (trackId, fxIdx, pi, v) => addon.timeline_setVisualEffectParam(trackId, fxIdx, pi, v);

  // ── Baseline: bare cell, no effects ───────────────────────────────────────
  const fBase = await seekSettle(TICK);
  const rect = cellRect(fBase);
  console.log(`  frame ${fBase.width}x${fBase.height}, cell x=[${rect.x0.toFixed(0)},${rect.x1.toFixed(0)}] y=[${rect.y0.toFixed(0)},${rect.y1.toFixed(0)}]`);

  ok(isGreen(at(fBase, ...greenPointInCell(fBase))),
     `baseline: inside the cell is the green-screen video ${cstr(at(fBase, ...greenPointInCell(fBase)))}`);
  ok(isBlue(at(fBase, rect.x0 - 24, rect.midY)),
     `baseline: the gap outside the cell shows the BLUE behind-layer ${cstr(at(fBase, rect.x0 - 24, rect.midY))}`);

  // ── (a) GEOMETRY: the stroke lands outside the cell rect ──────────────────
  // With no keyer the silhouette is exactly the cell rectangle, which makes this
  // the one place the geometry can be asserted to the pixel.
  const oIdx = addon.timeline_addVisualEffect(trackCell, FX_OUTLINE);
  ok(oIdx === 0, `timeline_addVisualEffect(type=6) accepted → index ${oIdx} (range guard widened to 0-7)`);

  const chainO = addon.timeline_getVisualEffectChain(trackCell);
  ok(Array.isArray(chainO) && chainO.length === 1 && chainO[0].type === FX_OUTLINE,
     'chain reports one Outline effect');
  ok(Math.abs(chainO[0].params[O_THICK] - 3.0) < 1e-3 &&
     Math.abs(chainO[0].params[O_OPACITY] - 1.0) < 1e-3,
     'Outline defaults to a visible 3 px stroke at full opacity, not an invisible zero-width one');
  ok(Math.abs(chainO[0].params[O_CUTOFF] - 0.95) < 1e-3,
     'Outline defaults to a 95% alpha cutoff, per the spec');

  setP(trackCell, oIdx, O_R, 1.0);
  setP(trackCell, oIdx, O_G, 1.0);
  setP(trackCell, oIdx, O_B, 0.0);      // yellow — distinguishable from every scene colour
  setP(trackCell, oIdx, O_THICK, 12.0);
  setP(trackCell, oIdx, O_SOFT, 0.0);   // hard edge, so the band has crisp bounds

  const fStroke = await seekSettle(TICK);
  const pStrokeL = at(fStroke, rect.x0 - 6, rect.midY);      // 6 px outside the left edge
  const pStrokeT = at(fStroke, rect.midX,   rect.y0 - 6);    // 6 px above the top edge
  const pOutside = at(fStroke, rect.x0 - 24, rect.midY);     // beyond the 12 px stroke
  const pInside  = at(fStroke, ...greenPointInCell(fStroke)); // the video itself
  console.log(`  [stroke]   left=${cstr(pStrokeL)} top=${cstr(pStrokeT)} beyond=${cstr(pOutside)} inside=${cstr(pInside)}`);

  ok(isYellow(pStrokeL),
     `GEOMETRY: the stroke is drawn OUTSIDE the cell rect, in the gap ${cstr(pStrokeL)}`);
  ok(isYellow(pStrokeT),
     `GEOMETRY: the stroke surrounds the cell on the top edge too ${cstr(pStrokeT)}`);
  ok(isBlue(pOutside),
     `GEOMETRY: the stroke has a finite thickness — 24 px out is still the behind-layer ${cstr(pOutside)}`);
  ok(isGreen(pInside),
     `GEOMETRY: the video inside the cell is untouched by the stroke ${cstr(pInside)}`);

  // ── (c) Outline params ────────────────────────────────────────────────────
  setP(trackCell, oIdx, O_THICK, 3.0);
  const fThin = await seekSettle(TICK);
  ok(isBlue(at(fThin, rect.x0 - 6, rect.midY)),
     `PARAM thickness: at 3 px the same sample point is outside the stroke ${cstr(at(fThin, rect.x0 - 6, rect.midY))}`);
  setP(trackCell, oIdx, O_THICK, 12.0);

  setP(trackCell, oIdx, O_G, 1.0);
  setP(trackCell, oIdx, O_R, 0.0);
  setP(trackCell, oIdx, O_B, 1.0);      // cyan
  const fCyan = await seekSettle(TICK);
  ok(isCyan(at(fCyan, rect.x0 - 6, rect.midY)),
     `PARAM colour: the stroke takes the chosen colour ${cstr(at(fCyan, rect.x0 - 6, rect.midY))}`);
  setP(trackCell, oIdx, O_R, 1.0);
  setP(trackCell, oIdx, O_B, 0.0);      // back to yellow

  setP(trackCell, oIdx, O_OPACITY, 0.0);
  const fNoOp = await seekSettle(TICK);
  ok(isBlue(at(fNoOp, rect.x0 - 6, rect.midY)),
     `PARAM opacity: at 0% the stroke is gone entirely ${cstr(at(fNoOp, rect.x0 - 6, rect.midY))}`);
  setP(trackCell, oIdx, O_OPACITY, 1.0);

  const fHard = await seekSettle(TICK);
  const hardStroke = at(fHard, rect.x0 - 10, rect.midY);   // near the stroke's outer edge
  setP(trackCell, oIdx, O_SOFT, 1.0);
  const fSoft = await seekSettle(TICK);
  const softStroke = at(fSoft, rect.x0 - 10, rect.midY);
  console.log(`  [softness] hard=${cstr(hardStroke)} soft=${cstr(softStroke)}`);
  ok(lum(softStroke) < lum(hardStroke) - 15,
     `PARAM softness: at 100% the stroke's outer edge has faded toward a glow (${lum(hardStroke).toFixed(0)} → ${lum(softStroke).toFixed(0)})`);
  setP(trackCell, oIdx, O_SOFT, 0.0);

  // ── (b) SILHOUETTE: with a keyer the stroke follows the cutout ────────────
  const kIdx = addon.timeline_addVisualEffect(trackCell, FX_CHROMA_KEY);
  ok(kIdx === 1, 'Chroma Key added after the Outline');
  setP(trackCell, oIdx, O_THICK, 16.0);   // extra margin: the keyed edge is soft

  const fKeyed = await seekSettle(TICK);
  const sq = redSquareRect(fKeyed);
  const pRing   = at(fKeyed, (sq.x0 + sq.x1) / 2, sq.y0 - 8);    // just above the red square
  const pGapKey = at(fKeyed, (sq.x0 + sq.x1) / 2, sq.y0 - 30);   // keyed-away region
  const pSubj   = at(fKeyed, (sq.x0 + sq.x1) / 2, (sq.y0 + sq.y1) / 2);
  const pCellEdge = at(fKeyed, rect.x0 - 6, rect.midY);
  console.log(`  [keyed]    ring=${cstr(pRing)} gap=${cstr(pGapKey)} subject=${cstr(pSubj)} cellEdge=${cstr(pCellEdge)}`);

  ok(isYellow(pRing),
     `SILHOUETTE: the stroke traces the KEYED cutout, not the cell rect ${cstr(pRing)}`);
  ok(isBlue(pGapKey),
     `SILHOUETTE: the keyed-away area still reveals the behind-layer ${cstr(pGapKey)}`);
  ok(isRed(pSubj),
     `SILHOUETTE: the subject survives keying and is not painted over ${cstr(pSubj)}`);
  ok(isBlue(pCellEdge),
     `SILHOUETTE: no stroke around the cell rect any more — the green edge was keyed away ${cstr(pCellEdge)}`);

  // ── (e) TERMINAL: chain position does not change the result ───────────────
  const hashOutlineLast = frameHash(await seekSettle(TICK));
  addon.timeline_setTrackVisualEffectChainOrder(trackCell, [1, 0]);   // keyer first → outline first
  const reordered = addon.timeline_getVisualEffectChain(trackCell);
  ok(reordered[0].type === FX_CHROMA_KEY && reordered[1].type === FX_OUTLINE,
     'TERMINAL: chain reordered so the Outline now sits after the keyer');
  const hashOutlineFirstOrder = frameHash(await seekSettle(TICK));
  ok(hashOutlineFirstOrder === hashOutlineLast,
     'TERMINAL: the composite is identical either way — Outline runs after the whole chain regardless of index');

  // Drop the keyer; the shadow phases want the exact cell-rectangle silhouette.
  const keyerAt = addon.timeline_getVisualEffectChain(trackCell)
    .findIndex((f) => f.type === FX_CHROMA_KEY);
  addon.timeline_removeVisualEffect(trackCell, keyerAt);
  addon.timeline_removeVisualEffect(trackCell, 0);
  ok(addon.timeline_getVisualEffectChain(trackCell).length === 0, 'chain cleared for the shadow phases');

  // ── (c) Drop Shadow geometry: distance and angle ──────────────────────────
  const sIdx = addon.timeline_addVisualEffect(trackCell, FX_SHADOW);
  ok(sIdx === 0, `timeline_addVisualEffect(type=7) accepted → index ${sIdx}`);

  const chainS = addon.timeline_getVisualEffectChain(trackCell);
  ok(Math.abs(chainS[0].params[S_DIST] - 8.0) < 1e-3 &&
     Math.abs(chainS[0].params[S_ANGLE] - 45.0) < 1e-3 &&
     Math.abs(chainS[0].params[S_BLEND] - BLEND_MULTIPLY) < 1e-3,
     'Drop Shadow defaults to 8 px down-right on Multiply, not an invisible zero-offset shadow');

  setP(trackCell, sIdx, S_DIST, 24.0);
  setP(trackCell, sIdx, S_ANGLE, 0.0);    // straight right
  setP(trackCell, sIdx, S_SIZE, 0.0);
  setP(trackCell, sIdx, S_SOFT, 0.0);
  setP(trackCell, sIdx, S_OPACITY, 1.0);
  setP(trackCell, sIdx, S_BLEND, BLEND_MULTIPLY);
  setP(trackCell, sIdx, S_R, 0.0); setP(trackCell, sIdx, S_G, 0.0); setP(trackCell, sIdx, S_B, 0.0);

  const fRight = await seekSettle(TICK);
  const pShadowR = at(fRight, rect.x1 + 12, rect.midY);   // inside the 24 px offset band
  const pFarR    = at(fRight, rect.x1 + 40, rect.midY);   // past the shadow entirely
  const pShadowL = at(fRight, rect.x0 - 12, rect.midY);   // opposite side — must be clean
  console.log(`  [shadow →] right=${cstr(pShadowR)} far=${cstr(pFarR)} left=${cstr(pShadowL)}`);

  ok(isDark(pShadowR),
     `GEOMETRY: the shadow falls OUTSIDE the cell, on the behind-layer ${cstr(pShadowR)}`);
  ok(isBlue(pFarR),
     `PARAM distance: the shadow stops at the offset — 40 px out is clean ${cstr(pFarR)}`);
  ok(isBlue(pShadowL),
     `PARAM angle: at 0° nothing is cast to the LEFT ${cstr(pShadowL)}`);

  setP(trackCell, sIdx, S_ANGLE, 180.0);
  const fLeft = await seekSettle(TICK);
  console.log(`  [shadow ←] right=${cstr(at(fLeft, rect.x1 + 12, rect.midY))} left=${cstr(at(fLeft, rect.x0 - 12, rect.midY))}`);
  ok(isDark(at(fLeft, rect.x0 - 12, rect.midY)),
     `PARAM angle: at 180° the shadow moves to the LEFT ${cstr(at(fLeft, rect.x0 - 12, rect.midY))}`);
  ok(isBlue(at(fLeft, rect.x1 + 12, rect.midY)),
     `PARAM angle: at 180° the right side is clean again ${cstr(at(fLeft, rect.x1 + 12, rect.midY))}`);

  // ── (c) Drop Shadow: size (inflate) ──────────────────────────────────────
  // Distance 0 puts the shadow entirely behind the cell, so anything visible
  // outside the cell rect can ONLY have come from the inflate.
  setP(trackCell, sIdx, S_DIST, 0.0);
  setP(trackCell, sIdx, S_ANGLE, 0.0);
  setP(trackCell, sIdx, S_SIZE, 0.0);
  const fNoSize = await seekSettle(TICK);
  ok(isBlue(at(fNoSize, rect.x1 + 6, rect.midY)),
     `PARAM size: at 0% with no offset the shadow is exactly the subject's shape and hides behind it ${cstr(at(fNoSize, rect.x1 + 6, rect.midY))}`);

  setP(trackCell, sIdx, S_SIZE, 0.5);    // 0.5 * kMaxShadowInflatePx = 16 px
  const fSized = await seekSettle(TICK);
  ok(isDark(at(fSized, rect.x1 + 6, rect.midY)),
     `PARAM size: raising it bulges the shadow out past the subject ${cstr(at(fSized, rect.x1 + 6, rect.midY))}`);
  ok(isBlue(at(fSized, rect.x1 + 30, rect.midY)),
     `PARAM size: the bulge is bounded, not a flood fill ${cstr(at(fSized, rect.x1 + 30, rect.midY))}`);

  // Softness feathers that bulge: the same point drops in coverage.
  const sizedEdge = at(fSized, rect.x1 + 13, rect.midY);
  setP(trackCell, sIdx, S_SOFT, 0.6);
  const fSoftShadow = await seekSettle(TICK);
  const softEdge = at(fSoftShadow, rect.x1 + 13, rect.midY);
  console.log(`  [shadow soft] hard=${cstr(sizedEdge)} soft=${cstr(softEdge)}`);
  ok(lum(softEdge) > lum(sizedEdge) + 10,
     `PARAM softness: feathering lightens the shadow's outer edge (${lum(sizedEdge).toFixed(0)} → ${lum(softEdge).toFixed(0)})`);
  setP(trackCell, sIdx, S_SOFT, 0.0);

  setP(trackCell, sIdx, S_OPACITY, 0.0);
  const fNoShadow = await seekSettle(TICK);
  ok(isBlue(at(fNoShadow, rect.x1 + 6, rect.midY)),
     `PARAM opacity: at 0% the shadow is gone entirely ${cstr(at(fNoShadow, rect.x1 + 6, rect.midY))}`);
  setP(trackCell, sIdx, S_OPACITY, 1.0);

  // Alpha cutoff: at a cutoff of 1.0 nothing counts as foreground, so an opaque
  // cell stops casting a shadow at all. Proves the param reaches the shader.
  setP(trackCell, sIdx, S_CUTOFF, 1.0);
  const fCutoff = await seekSettle(TICK);
  ok(isBlue(at(fCutoff, rect.x1 + 6, rect.midY)),
     `PARAM alpha cutoff: at 100% even a fully opaque cell counts as background and casts nothing ${cstr(at(fCutoff, rect.x1 + 6, rect.midY))}`);
  setP(trackCell, sIdx, S_CUTOFF, 0.95);

  // ── (d) BLEND MODES ───────────────────────────────────────────────────────
  // Against a mid-grey backdrop with a LIGHTER (0.75) shadow, all four modes
  // separate: Normal lightens, Multiply darkens proportionally, Darken is a
  // no-op because the shadow is lighter than the backdrop, and Linear Burn
  // subtracts and so goes darkest.
  addon.timeline_setGridLayout(baseLayout(trackGrey));
  setP(trackCell, sIdx, S_R, 0.75); setP(trackCell, sIdx, S_G, 0.75); setP(trackCell, sIdx, S_B, 0.75);
  setP(trackCell, sIdx, S_SIZE, 0.5);   // 16 px of bulge to sample in

  const probeX = rect.x1 + 6, probeY = rect.midY;
  const modeLum = {};
  for (const [name, mode] of [['normal', BLEND_NORMAL], ['multiply', BLEND_MULTIPLY],
                              ['darken', BLEND_DARKEN], ['linearBurn', BLEND_LINEAR_BURN]]) {
    setP(trackCell, sIdx, S_BLEND, mode);
    const f = await seekSettle(TICK);
    modeLum[name] = lum(at(f, probeX, probeY));
    // Backdrop luminance sampled far from the shadow on the same frame.
    modeLum[`${name}Backdrop`] = lum(at(f, rect.x1 + 40, probeY));
  }
  const backdrop = modeLum.multiplyBackdrop;
  console.log(`  [blend] backdrop=${backdrop.toFixed(0)} normal=${modeLum.normal.toFixed(0)} ` +
              `multiply=${modeLum.multiply.toFixed(0)} darken=${modeLum.darken.toFixed(0)} ` +
              `linearBurn=${modeLum.linearBurn.toFixed(0)}`);

  ok(modeLum.normal > backdrop + 25,
     `BLEND Normal: paints the shadow colour over the backdrop, so a light shadow LIGHTENS (${backdrop.toFixed(0)} → ${modeLum.normal.toFixed(0)})`);
  ok(modeLum.multiply < backdrop - 15,
     `BLEND Multiply: darkens the real backdrop (${backdrop.toFixed(0)} → ${modeLum.multiply.toFixed(0)})`);
  ok(Math.abs(modeLum.darken - backdrop) < 14,
     `BLEND Darken: a shadow lighter than the backdrop is a no-op, as min() requires (${backdrop.toFixed(0)} → ${modeLum.darken.toFixed(0)})`);
  ok(modeLum.linearBurn < modeLum.multiply - 15,
     `BLEND Linear Burn: subtracts, so it goes darker than Multiply (${modeLum.multiply.toFixed(0)} → ${modeLum.linearBurn.toFixed(0)})`);

  // Restore the blue backdrop and a plain black Multiply shadow.
  addon.timeline_setGridLayout(baseLayout(trackBehind));
  setP(trackCell, sIdx, S_R, 0.0); setP(trackCell, sIdx, S_G, 0.0); setP(trackCell, sIdx, S_B, 0.0);
  setP(trackCell, sIdx, S_BLEND, BLEND_MULTIPLY);

  // ── (f) BYPASS: both are cosmetic, so fast preview drops them ─────────────
  // Deliberately the opposite of Chroma Key, which is bypass-EXEMPT because it
  // decides which pixels exist. These only add decoration, so skipping them
  // leaves the composite correct rather than wrong.
  const oIdx2 = addon.timeline_addVisualEffect(trackCell, FX_OUTLINE);
  setP(trackCell, oIdx2, O_R, 1.0); setP(trackCell, oIdx2, O_G, 1.0); setP(trackCell, oIdx2, O_B, 0.0);
  setP(trackCell, oIdx2, O_THICK, 12.0);
  setP(trackCell, oIdx2, O_SOFT, 0.0);
  setP(trackCell, sIdx, S_DIST, 24.0);
  setP(trackCell, sIdx, S_SIZE, 0.0);
  setP(trackCell, sIdx, S_ANGLE, 0.0);

  const fBoth = await seekSettle(TICK);
  ok(isYellow(at(fBoth, rect.x0 - 6, rect.midY)),
     `BOTH: outline and shadow coexist — stroke present ${cstr(at(fBoth, rect.x0 - 6, rect.midY))}`);
  ok(isDark(at(fBoth, rect.x1 + 26, rect.midY)),
     `BOTH: the shadow is cast by the OUTLINED shape, so it reaches past the stroke ${cstr(at(fBoth, rect.x1 + 26, rect.midY))}`);

  addon.timeline_setPreviewEffectsBypass(true);
  ok(addon.timeline_getPreviewEffectsBypass() === true, 'preview effects bypass is ON');
  const fBypass = await seekSettle(TICK);
  console.log(`  [bypass]   stroke=${cstr(at(fBypass, rect.x0 - 6, rect.midY))} shadow=${cstr(at(fBypass, rect.x1 + 12, rect.midY))}`);
  ok(isBlue(at(fBypass, rect.x0 - 6, rect.midY)),
     `BYPASS: the stroke is skipped in fast preview ${cstr(at(fBypass, rect.x0 - 6, rect.midY))}`);
  ok(isBlue(at(fBypass, rect.x1 + 12, rect.midY)),
     `BYPASS: the shadow is skipped in fast preview ${cstr(at(fBypass, rect.x1 + 12, rect.midY))}`);
  addon.timeline_setPreviewEffectsBypass(false);
  const fUnbypass = await seekSettle(TICK);
  ok(isYellow(at(fUnbypass, rect.x0 - 6, rect.midY)),
     'BYPASS: both come back when fast preview is turned off');

  // ── (g) undo / redo ───────────────────────────────────────────────────────
  const thickBefore = addon.timeline_getVisualEffectChain(trackCell)[oIdx2].params[O_THICK];
  setP(trackCell, oIdx2, O_THICK, 7.5);
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackCell)[oIdx2].params[O_THICK] - 7.5) < 1e-4,
     'UNDO: set-param applied');
  addon.undo_undo();
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackCell)[oIdx2].params[O_THICK] - thickBefore) < 1e-4,
     'UNDO: set-param undone');
  addon.undo_redo();
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackCell)[oIdx2].params[O_THICK] - 7.5) < 1e-4,
     'REDO: set-param redone');
  addon.undo_undo();

  const lenBefore = addon.timeline_getVisualEffectChain(trackCell).length;
  addon.timeline_removeVisualEffect(trackCell, oIdx2);
  ok(addon.timeline_getVisualEffectChain(trackCell).length === lenBefore - 1, 'UNDO: remove applied');
  addon.undo_undo();
  const restored = addon.timeline_getVisualEffectChain(trackCell);
  ok(restored.length === lenBefore && restored[oIdx2].type === FX_OUTLINE,
     'UNDO: remove undone, Outline back at its index');
  ok(Math.abs(restored[oIdx2].params[O_THICK] - 12.0) < 1e-3,
     'UNDO: the restored Outline kept its params, not the defaults');

  // ── (i) EXPORT matches preview ────────────────────────────────────────────
  // Preview and export share FrameCollector + GridCompositor, so this is really
  // asserting that the padded stages do not depend on anything preview-only —
  // notably that the rect expansion happens inside compositeFrame rather than in
  // the preview's own plumbing.
  {
    const chainNow = addon.timeline_getVisualEffectChain(trackCell) || [];
    const eO = chainNow.findIndex((f) => f.type === FX_OUTLINE);
    const eS = chainNow.findIndex((f) => f.type === FX_SHADOW);
    if (eO >= 0) {
      setP(trackCell, eO, O_R, 1.0); setP(trackCell, eO, O_G, 1.0); setP(trackCell, eO, O_B, 0.0);
      setP(trackCell, eO, O_THICK, 12.0); setP(trackCell, eO, O_SOFT, 0.0);
      setP(trackCell, eO, O_OPACITY, 1.0); setP(trackCell, eO, O_CUTOFF, 0.95);
    }
    if (eS >= 0) {
      setP(trackCell, eS, S_R, 1.0); setP(trackCell, eS, S_G, 0.0); setP(trackCell, eS, S_B, 1.0);
      setP(trackCell, eS, S_DIST, 30.0); setP(trackCell, eS, S_ANGLE, 0.0);
      setP(trackCell, eS, S_SIZE, 0.0); setP(trackCell, eS, S_SOFT, 0.0);
      setP(trackCell, eS, S_OPACITY, 1.0); setP(trackCell, eS, S_BLEND, BLEND_NORMAL);
      setP(trackCell, eS, S_CUTOFF, 0.95);
    }

    const fPreview = await seekSettle(TICK);
    const prevStroke = at(fPreview, rect.x0 - 6, rect.midY);
    const prevShadow = at(fPreview, rect.x1 + 20, rect.midY);
    console.log(`  [preview]  stroke=${cstr(prevStroke)} shadow=${cstr(prevShadow)}`);
    ok(isYellow(prevStroke), `EXPORT setup: preview shows the yellow stroke ${cstr(prevStroke)}`);
    ok(isMagenta(prevShadow),
       `EXPORT setup: preview shows a Normal-mode magenta shadow ${cstr(prevShadow)}`);

    const exportPath = path.join(tmpDir, 'outline-shadow-export.mp4');
    try { fs.unlinkSync(exportPath); } catch { /* first run */ }

    const started = addon.video_exportStart({
      outputPath: exportPath,
      videoCodec: 'h264', rateControl: 'crf', crf: 18,
      width: 640, height: 360, fpsNum: 30, fpsDen: 1,
      startBeat: 0, endBeat: 2,
    });
    ok(started === true, 'EXPORT: video_exportStart accepted');

    if (started) {
      // Deliberately does NOT treat running===false as done: the renderer needs a
      // moment to spin up and would look finished on the first poll.
      const deadline = Date.now() + 120000;
      let prog = null;
      while (Date.now() < deadline) {
        prog = addon.video_exportGetProgress();
        if (prog && (prog.complete || prog.failed)) break;
        await sleep(200);
      }
      if (prog && prog.failed) console.error(`  export failed: ${prog.error}`);
      ok(!!(prog && prog.complete && !prog.failed),
         `EXPORT: render completed (${prog ? prog.currentFrame : '?'}/${prog ? prog.totalFrames : '?'} frames)`);

      const exported = fs.existsSync(exportPath) && fs.statSync(exportPath).size > 0;
      ok(exported, `EXPORT: produced ${exportPath}`);

      if (exported) {
        const raw = path.join(tmpDir, 'export-frame.rawvideo');
        spawnSync(ffmpeg, [
          '-y', '-loglevel', 'error', '-i', exportPath,
          '-vf', 'select=eq(n\\,10)', '-vframes', '1',
          '-f', 'rawvideo', '-pix_fmt', 'rgba', raw,
        ], { stdio: 'ignore' });

        if (fs.existsSync(raw) && fs.statSync(raw).size >= 640 * 360 * 4) {
          const exFrame = { width: 640, height: 360, data: fs.readFileSync(raw) };
          const exRect = cellRect(exFrame);
          const exStroke = at(exFrame, exRect.x0 - 6, exRect.midY);
          const exShadow = at(exFrame, exRect.x1 + 20, exRect.midY);
          console.log(`  [export]   stroke=${cstr(exStroke)} shadow=${cstr(exShadow)}`);
          ok(isYellow(exStroke),
             `EXPORT: the stroke renders into the file, same as preview ${cstr(exStroke)}`);
          ok(isMagenta(exShadow),
             `EXPORT: the shadow renders into the file, same as preview ${cstr(exShadow)}`);
        } else {
          ok(false, 'EXPORT: could not read back a frame from the exported file');
        }
      }
    }
  }

  // ── (h) SAVE / LOAD round-trip ────────────────────────────────────────────
  // Track.cpp's four per-type tables are hand-maintained with no registry. Miss
  // one and the effect saves as "Desaturation" with empty params, which fails
  // silently on reload rather than erroring anywhere.
  {
    const projDir = path.join(tmpDir, 'proj-roundtrip');
    fs.rmSync(projDir, { recursive: true, force: true });

    const wantO = { [O_R]: 0.125, [O_G]: 0.375, [O_B]: 0.875, [O_THICK]: 9.5,
                    [O_SOFT]: 0.42, [O_OPACITY]: 0.81, [O_CUTOFF]: 0.88 };
    const wantS = { [S_R]: 0.25, [S_G]: 0.5, [S_B]: 0.125, [S_DIST]: 13.5,
                    [S_ANGLE]: 217.0, [S_SIZE]: 0.33, [S_SOFT]: 0.66,
                    [S_OPACITY]: 0.44, [S_BLEND]: BLEND_LINEAR_BURN, [S_CUTOFF]: 0.91 };
    for (const [pi, v] of Object.entries(wantO)) setP(trackCell, oIdx2, Number(pi), v);
    for (const [pi, v] of Object.entries(wantS)) setP(trackCell, sIdx,  Number(pi), v);

    const saved = addon.project_saveAs(projDir, 'OutlineShadowRoundTrip');
    ok(!!saved, 'SAVE/LOAD: project_saveAs succeeded');

    if (saved) {
      const projFile = typeof saved === 'string' ? saved : path.join(projDir, 'project.json');
      const onDisk = fs.existsSync(projFile) ? fs.readFileSync(projFile, 'utf8') : '';
      ok(onDisk.includes('"Outline"'),
         'SAVE/LOAD: Outline persists under its own type name, not "Desaturation"');
      ok(onDisk.includes('"DropShadow"'),
         'SAVE/LOAD: DropShadow persists under its own type name');
      ok(onDisk.includes('thickness') && onDisk.includes('alphaThreshold'),
         'SAVE/LOAD: Outline params persist as named keys');
      ok(onDisk.includes('blendMode') && onDisk.includes('distance'),
         'SAVE/LOAD: DropShadow params persist as named keys');

      ok(addon.project_load(projDir) !== false, 'SAVE/LOAD: project_load succeeded');
      const reloaded = addon.timeline_getVisualEffectChain(trackCell) || [];
      const rO = reloaded.find((e) => e.type === FX_OUTLINE);
      const rS = reloaded.find((e) => e.type === FX_SHADOW);
      ok(!!rO, 'SAVE/LOAD: Outline survives the round-trip as type 6');
      ok(!!rS, 'SAVE/LOAD: DropShadow survives the round-trip as type 7');
      if (rO) {
        const bad = Object.entries(wantO)
          .filter(([pi, v]) => Math.abs(rO.params[Number(pi)] - v) > 1e-3).map(([pi]) => pi);
        ok(bad.length === 0,
           `SAVE/LOAD: all 7 Outline params round-trip${bad.length ? ` (wrong: ${bad.join(',')})` : ''}`);
      }
      if (rS) {
        const bad = Object.entries(wantS)
          .filter(([pi, v]) => Math.abs(rS.params[Number(pi)] - v) > 1e-3).map(([pi]) => pi);
        ok(bad.length === 0,
           `SAVE/LOAD: all 10 DropShadow params round-trip${bad.length ? ` (wrong: ${bad.join(',')})` : ''}`);
      }
    }
  }

  const diagEnd = addon.diag_getVisualPreviewDiagnostic();
  ok(diagEnd.compositorReady === true, 'compositor still healthy at the end');

  addon.shutdown();

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(1);
});
