'use strict';
//
// bridge/test_chroma_key_contract.js
//
// Contract test for the Chroma Key visual effect, driven through the REAL
// xleth_native.node addon on a REAL D3D11 device. It composites an actual
// green-screen clip over a solid blue fullscreen-behind layer and reads the
// composited pixels back, so a keyer whose output alpha is ignored (green
// rectangle), whose matte is inverted, or which silently no-ops in fast preview
// all fail here rather than looking fine in a unit test.
//
// Scene: a 2-second 640x360 clip that is chroma-key green (#00B140) with a
// solid RED square in the middle, placed as a full 1x1 grid cell, drawn on top
// of a BLUE fullscreen-behind layer.
//
//   correct keying  → centre stays RED, corners turn BLUE (behind layer shows through)
//   broken alpha    → corners stay GREEN
//   inverted matte  → centre turns BLUE
//
// What it verifies:
//   (b) alpha gate     — the composite honours per-pixel alpha
//   (d) params         — each of the six params changes the composite
//   (e) bypass exempt  — the keyer still runs under setPreviewEffectsBypass(true)
//   (f) undo/redo      — add / remove / reorder / set-param all round-trip
//   (g) race stress    — chain mutation during playback does not crash
//
// Needs a GPU (D3D11) and ffmpeg on PATH; SKIPs (exit 0) otherwise, matching
// the environment-gating the other GPU contract tests use.
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

// Canonical ChromaKey param indices — mirrors the layout documented on
// VisualEffect in engine/src/model/TimelineTypes.h.
const P_KEY_R = 0, P_KEY_G = 1, P_KEY_B = 2;
const P_TOLERANCE = 3, P_SOFTNESS = 4, P_SPILL = 5, P_CHOKE = 6, P_BLUR = 7;
const FX_CHROMA_KEY = 5;

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

// Green screen with a centred red square. The red square is deliberately large
// (200 of 360 px tall) so the centre sample sits well inside it and edge
// treatment (choke/blur) never reaches the sample point.
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
const centreColor = (fr) => avgColor(fr, fr.width >> 1, fr.height >> 1, 4);
// Sample well inside the frame but far from the red square: 12% in from the
// top-left. On a full-bleed 1x1 cell this is solidly green-screen territory.
const bgColor = (fr) => avgColor(fr,
  Math.round(fr.width * 0.12), Math.round(fr.height * 0.12), 4);

const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;
const isRed   = (c) => c.r > 140 && c.g < 90 && c.b < 90;
const isBlue  = (c) => c.b > 140 && c.r < 90 && c.g < 90;
const isGreen = (c) => c.g > 110 && c.r < 110 && c.b < 110;

function frameHash(fr) {
  let h = 0x811c9dc5 >>> 0;
  const d = fr.data;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

async function main() {
  console.log(`=== xleth chroma-key contract (${native.config}) ===\n`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found on PATH — cannot synthesise the test clips.');

  const tmpDir = path.join(os.tmpdir(), 'xleth-chroma-key-contract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const GREEN = path.join(tmpDir, 'greenscreen.mp4');
  const BLUE  = path.join(tmpDir, 'blue.mp4');
  if (!makeGreenScreenVideo(ffmpeg, GREEN) || !makeSolidVideo(ffmpeg, 'blue', BLUE)) {
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

  // Live decode path, not the static-poster preview.
  addon.timeline_setPreviewPosterMode(false);
  addon.setBPM(120);

  // ── Author the scene ──────────────────────────────────────────────────────
  const sidGreen = addon.project_importSource(GREEN);
  const sidBlue  = addon.project_importSource(BLUE);
  ok(sidGreen >= 0 && sidBlue >= 0, 'imported the green-screen and behind-layer sources');

  const trackKey    = addon.timeline_addTrack({ name: 'Key',    volume: 1.0, order: 0 });
  const trackBehind = addon.timeline_addTrack({ name: 'Behind', volume: 1.0, order: 1 });

  const regGreen = addon.timeline_addRegion({ name: 'G', label: 'G', sourceId: sidGreen, startTime: 0, endTime: 2 });
  const regBlue  = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sidBlue,  startTime: 0, endTime: 2 });

  addon.timeline_addClip({ trackId: trackKey,    regionId: regGreen, positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackBehind, regionId: regBlue,  positionTicks: 0, durationTicks: 16 * PPQ, velocity: 1.0 });

  // Green-screen track is a full-bleed 1x1 grid cell; blue is a fullscreen
  // layer BEHIND it (negative zOrder), so it is only ever visible through
  // pixels the keyer made transparent.
  const FULL = 8;
  addon.timeline_setGridLayout({
    columns: 1, rows: 1, previewFps: 30,
    slots: [{ trackId: trackKey, gridX: 0, gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 }],
    // zOrder deliberately omitted so the engine assigns canonical
    // behind < grid < front banding (assignCanonicalFullscreenZOrders).
    fullscreenLayers: [{ trackId: trackBehind, opacity: 1.0, placement: 'behind' }],
  });

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

  // ── Baseline: no keyer yet ────────────────────────────────────────────────
  const fBefore = await seekSettle(TICK);
  const bgBefore = bgColor(fBefore), ctrBefore = centreColor(fBefore);
  console.log(`  [baseline] background=${cstr(bgBefore)} centre=${cstr(ctrBefore)}`);
  ok(isGreen(bgBefore), `without a keyer the background is GREEN ${cstr(bgBefore)}`);
  ok(isRed(ctrBefore),  `without a keyer the centre is RED ${cstr(ctrBefore)}`);

  // ── Add the Chroma Key ────────────────────────────────────────────────────
  const fxIdx = addon.timeline_addVisualEffect(trackKey, FX_CHROMA_KEY);
  ok(fxIdx === 0, `timeline_addVisualEffect(type=5) accepted → index ${fxIdx} (range guard widened)`);

  const chain0 = addon.timeline_getVisualEffectChain(trackKey);
  ok(Array.isArray(chain0) && chain0.length === 1 && chain0[0].type === FX_CHROMA_KEY,
     'chain reports one ChromaKey effect');
  ok(Math.abs(chain0[0].params[P_KEY_G] - 0.694) < 1e-3,
     'ChromaKey defaults to standard chroma green, not an all-zero (black) key');

  // ── (b) THE ALPHA GATE ────────────────────────────────────────────────────
  const fKeyed = await seekSettle(TICK);
  const bgKeyed = bgColor(fKeyed), ctrKeyed = centreColor(fKeyed);
  console.log(`  [keyed]    background=${cstr(bgKeyed)} centre=${cstr(ctrKeyed)}`);
  ok(isBlue(bgKeyed),
     `ALPHA GATE: keyed background reveals the BLUE behind-layer ${cstr(bgKeyed)}`);
  ok(!isGreen(bgKeyed),
     'ALPHA GATE: no green survives in the keyed region (alpha is not stomped)');
  ok(isRed(ctrKeyed),
     `foreground subject survives keying, still RED ${cstr(ctrKeyed)}`);

  // ── (e) bypass exemption ──────────────────────────────────────────────────
  addon.timeline_setPreviewEffectsBypass(true);
  ok(addon.timeline_getPreviewEffectsBypass() === true, 'preview effects bypass is ON');
  const fBypass = await seekSettle(TICK);
  const bgBypass = bgColor(fBypass), ctrBypass = centreColor(fBypass);
  console.log(`  [bypass]   background=${cstr(bgBypass)} centre=${cstr(ctrBypass)}`);
  ok(isBlue(bgBypass),
     `BYPASS EXEMPT: keyer still runs under setEffectsBypass(true) ${cstr(bgBypass)}`);
  ok(isRed(ctrBypass), 'BYPASS EXEMPT: foreground still intact under bypass');
  addon.timeline_setPreviewEffectsBypass(false);
  await seekSettle(TICK);

  // ── (d) every param moves the composite ───────────────────────────────────
  // Tolerance/softness: collapsing both to ~0 must stop the key entirely
  // (nothing is within the key's core), bringing the green background back.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_TOLERANCE, 0.0);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_SOFTNESS,  0.001);
  const fNoKey = await seekSettle(TICK);
  ok(isGreen(bgColor(fNoKey)),
     `PARAM tolerance/softness: zeroed thresholds stop keying, green returns ${cstr(bgColor(fNoKey))}`);

  // A very wide tolerance keys everything, including the red subject.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_TOLERANCE, 1.2);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_SOFTNESS,  1.3);
  const fAllKey = await seekSettle(TICK);
  ok(isBlue(centreColor(fAllKey)),
     `PARAM tolerance: a huge tolerance keys even the subject ${cstr(centreColor(fAllKey))}`);

  // Restore a sane key and confirm we are back to the good composite.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_TOLERANCE, 0.10);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_SOFTNESS,  0.22);
  const fRestored = await seekSettle(TICK);
  ok(isBlue(bgColor(fRestored)) && isRed(centreColor(fRestored)),
     'PARAM: restoring tolerance/softness restores the correct composite');
  const hashRestored = frameHash(fRestored);

  // Spill / choke / blur each have to change SOME pixel. They act on the matte
  // edge, so assert on a whole-frame hash rather than on a point sample.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_SPILL, 1.0);
  const hSpill = frameHash(await seekSettle(TICK));
  ok(hSpill !== hashRestored, 'PARAM spill suppression changes the composite');
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_SPILL, 0.5);

  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_CHOKE, 6.0);
  const hChoke = frameHash(await seekSettle(TICK));
  ok(hChoke !== hashRestored, 'PARAM matte choke changes the composite');
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_CHOKE, 0.0);

  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_BLUR, 6.0);
  const hBlur = frameHash(await seekSettle(TICK));
  ok(hBlur !== hashRestored, 'PARAM edge blur changes the composite');
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_BLUR, 0.0);

  // Key colour: keying on RED instead of green must invert which part survives.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_R, 1.0);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_G, 0.0);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_B, 0.0);
  const fRedKey = await seekSettle(TICK);
  console.log(`  [red key]  background=${cstr(bgColor(fRedKey))} centre=${cstr(centreColor(fRedKey))}`);
  ok(isBlue(centreColor(fRedKey)),
     `PARAM key colour: keying on RED removes the subject instead ${cstr(centreColor(fRedKey))}`);
  ok(isGreen(bgColor(fRedKey)),
     `PARAM key colour: the green background survives a red key ${cstr(bgColor(fRedKey))}`);

  // Back to green.
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_R, 0.0);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_G, 0.694);
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_KEY_B, 0.251);
  await seekSettle(TICK);

  // ── (f) undo / redo ───────────────────────────────────────────────────────
  const paramBefore = addon.timeline_getVisualEffectChain(trackKey)[0].params[P_TOLERANCE];
  addon.timeline_setVisualEffectParam(trackKey, fxIdx, P_TOLERANCE, 0.42);
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackKey)[0].params[P_TOLERANCE] - 0.42) < 1e-4,
     'UNDO: set-param applied');
  addon.undo_undo();
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackKey)[0].params[P_TOLERANCE] - paramBefore) < 1e-4,
     'UNDO: set-param undone');
  addon.undo_redo();
  ok(Math.abs(addon.timeline_getVisualEffectChain(trackKey)[0].params[P_TOLERANCE] - 0.42) < 1e-4,
     'REDO: set-param redone');
  addon.undo_undo();

  // Reorder needs a second effect present.
  addon.timeline_addVisualEffect(trackKey, 0); // Desaturation
  ok(addon.timeline_getVisualEffectChain(trackKey).length === 2, 'UNDO: second effect added');

  // Reorder via setTrackVisualEffectChainOrder — this is the call the chain UI
  // actually makes (VisualFXSection.handleChainReorder), not the single-element
  // timeline_reorderVisualEffect RPC.
  addon.timeline_setTrackVisualEffectChainOrder(trackKey, [1, 0]);
  ok(addon.timeline_getVisualEffectChain(trackKey)[0].type === 0, 'UNDO: reorder applied');
  addon.undo_undo();
  ok(addon.timeline_getVisualEffectChain(trackKey)[0].type === FX_CHROMA_KEY,
     'UNDO: reorder undone (ChromaKey back at index 0)');
  addon.undo_redo();
  ok(addon.timeline_getVisualEffectChain(trackKey)[0].type === 0, 'REDO: reorder redone');
  addon.undo_undo();

  // PRE-EXISTING BUG, unrelated to Chroma Key and deliberately not asserted as a
  // pass here: undoing timeline_reorderVisualEffect is a no-op. Both the command
  // and Timeline::reorderVisualEffect apply the same "adjust for the erase"
  // correction, so undo re-derives the position it is already at. Reproduces
  // with Desaturation + Tint and no ChromaKey in the chain. The chain UI does
  // not use this RPC, so it does not affect this feature.
  {
    const probe = addon.timeline_addTrack({ name: 'ReorderProbe', volume: 1.0, order: 9 });
    addon.timeline_addVisualEffect(probe, 0);
    addon.timeline_addVisualEffect(probe, 1);
    addon.timeline_reorderVisualEffect(probe, 1, 0);
    const afterReorder = addon.timeline_getVisualEffectChain(probe).map((f) => f.type).join(',');
    addon.undo_undo();
    const afterUndo = addon.timeline_getVisualEffectChain(probe).map((f) => f.type).join(',');
    console.log(`  [known pre-existing] reorderVisualEffect undo: ${afterReorder} -> ${afterUndo} (want 0,1)`);
  }

  addon.timeline_removeVisualEffect(trackKey, 1);
  ok(addon.timeline_getVisualEffectChain(trackKey).length === 1, 'UNDO: remove applied');
  addon.undo_undo();
  ok(addon.timeline_getVisualEffectChain(trackKey).length === 2, 'UNDO: remove undone');
  addon.undo_redo();
  ok(addon.timeline_getVisualEffectChain(trackKey).length === 1, 'REDO: remove redone');

  // The keyer must still be doing its job after all that history churn.
  const fAfterUndo = await seekSettle(TICK);
  ok(isBlue(bgColor(fAfterUndo)) && isRed(centreColor(fAfterUndo)),
     'composite is still correctly keyed after the undo/redo sequence');

  // ── Project save/load round-trip ──────────────────────────────────────────
  // visualEffectTypeToString / visualEffectParamsToNamedJson in Track.cpp are a
  // second hand-maintained per-type table. Miss it and the effect saves as
  // "Desaturation" with empty params — the chain silently degrades on reload.
  {
    const projDir = path.join(tmpDir, 'proj-roundtrip');
    fs.rmSync(projDir, { recursive: true, force: true });

    // Distinctive param values so a table miss cannot pass by coincidence.
    const want = { [P_KEY_R]: 0.125, [P_KEY_G]: 0.625, [P_KEY_B]: 0.375,
                   [P_TOLERANCE]: 0.17, [P_SOFTNESS]: 0.31, [P_SPILL]: 0.62,
                   [P_CHOKE]: 2.5, [P_BLUR]: 3.25 };
    for (const [pi, v] of Object.entries(want)) {
      addon.timeline_setVisualEffectParam(trackKey, fxIdx, Number(pi), v);
    }

    const saved = addon.project_saveAs(projDir, 'ChromaRoundTrip');
    ok(!!saved, 'SAVE/LOAD: project_saveAs succeeded');

    if (saved) {
      const projFile = typeof saved === 'string' ? saved : path.join(projDir, 'project.json');
      // Prove the named-key block reached disk, not just that save returned true.
      const onDisk = fs.existsSync(projFile) ? fs.readFileSync(projFile, 'utf8') : '';
      ok(onDisk.includes('ChromaKey'),
         'SAVE/LOAD: effect persists under its own type name, not "Desaturation"');
      ok(onDisk.includes('tolerance') && onDisk.includes('edgeBlur'),
         'SAVE/LOAD: ChromaKey params persist as named keys');

      // project_load takes the project DIRECTORY, not the .json inside it.
      ok(addon.project_load(projDir) !== false, 'SAVE/LOAD: project_load succeeded');
      const reloaded = addon.timeline_getVisualEffectChain(trackKey);
      const fx = Array.isArray(reloaded) ? reloaded.find((e) => e.type === FX_CHROMA_KEY) : null;
      ok(!!fx, 'SAVE/LOAD: ChromaKey survives the round-trip as type 5');
      if (fx) {
        const bad = Object.entries(want)
          .filter(([pi, v]) => Math.abs(fx.params[Number(pi)] - v) > 1e-3)
          .map(([pi]) => pi);
        ok(bad.length === 0,
           `SAVE/LOAD: all 8 ChromaKey params round-trip${bad.length ? ` (wrong: ${bad.join(',')})` : ''}`);
      }
    }
  }

  // ── (h) export keys the same way preview does ─────────────────────────────
  // Preview decodes the DNxHR 4:2:2 proxy; export decodes the ORIGINAL. Slight
  // edge differences are expected, so this asserts the keying DECISION matches
  // (background transparent → blue behind-layer, subject preserved), not that
  // the frames are byte-identical.
  const exportPath = path.join(tmpDir, 'chroma-export.mp4');
  try { fs.unlinkSync(exportPath); } catch { /* first run */ }

  const started = addon.video_exportStart({
    outputPath: exportPath,
    videoCodec: 'h264', rateControl: 'crf', crf: 18,
    width: 640, height: 360, fpsNum: 30, fpsDen: 1,
    startBeat: 0, endBeat: 2,
  });
  ok(started === true, 'EXPORT: video_exportStart accepted');

  if (started) {
    // Poll until complete/failed. Deliberately does NOT treat running===false as
    // done: the renderer needs a moment to spin up and would otherwise look
    // finished on the very first poll.
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
      // Pull one frame back out with ffmpeg and sample the same two points.
      const framePng = path.join(tmpDir, 'export-frame.rawvideo');
      spawnSync(ffmpeg, [
        '-y', '-loglevel', 'error', '-i', exportPath,
        '-vf', 'select=eq(n\\,10)', '-vframes', '1',
        '-f', 'rawvideo', '-pix_fmt', 'rgba', framePng,
      ], { stdio: 'ignore' });

      if (fs.existsSync(framePng) && fs.statSync(framePng).size >= 640 * 360 * 4) {
        const buf = fs.readFileSync(framePng);
        const exFrame = { width: 640, height: 360, data: buf };
        const exBg = bgColor(exFrame), exCtr = centreColor(exFrame);
        console.log(`  [export]   background=${cstr(exBg)} centre=${cstr(exCtr)}`);
        ok(isBlue(exBg),
           `EXPORT: keyed background shows the behind-layer, same as preview ${cstr(exBg)}`);
        ok(isRed(exCtr),
           `EXPORT: subject preserved, same as preview ${cstr(exCtr)}`);
        ok(!isGreen(exBg), 'EXPORT: no green screen survives into the rendered file');
      } else {
        ok(false, 'EXPORT: could not read back a frame from the exported file');
      }
    }
  }

  // ── (g) race stress: mutate the chain hard while playing ──────────────────
  // The preview loop copies this track's chain under syncEventsMutex every
  // tick; these handlers take the same lock. Hammering them during playback is
  // what would surface a regression in that locking.
  addon.play();
  const stressDeadline = Date.now() + 3000;
  let mutations = 0;
  while (Date.now() < stressDeadline) {
    const i = addon.timeline_addVisualEffect(trackKey, FX_CHROMA_KEY);
    addon.timeline_setVisualEffectParam(trackKey, i, P_TOLERANCE, Math.random());
    addon.timeline_setVisualEffectBypassed(trackKey, i, true);
    addon.timeline_setVisualEffectBypassed(trackKey, i, false);
    if (i > 0) addon.timeline_reorderVisualEffect(trackKey, i, 0);
    addon.timeline_removeVisualEffect(trackKey, 0);
    mutations += 1;
    await sleep(2);
  }
  addon.stop();
  await sleep(120);
  ok(mutations > 50, `RACE STRESS: ${mutations} chain mutation cycles during playback, no crash`);

  const diagEnd = addon.diag_getVisualPreviewDiagnostic();
  ok(diagEnd.compositorReady === true, 'RACE STRESS: compositor still healthy afterwards');

  addon.shutdown();

  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nFATAL', e);
  process.exit(1);
});
