'use strict';
//
// bridge/test_snapshot_landing_acceptance.js
//
// The Landing acceptance scenario (docs/XLETH_LANDING_SPEC.md §1 and §9,
// "Manual acceptance"), run through the real xleth_native.node addon: the live
// preview seam AND a real export, compared with each other.
//
//   Snapshot 1: two cells side by side. Chords (red) left, bass (green) right.
//   Snapshot 2: chords small top-left, bass small top-right, lead (blue) big in
//               the centre, two percussion tracks (yellow, magenta) small at
//               the bottom.
//   Cue at bar 9 -> snapshot 2.
//   Landings:  chords and bass "Where it was", lead-in 1 beat, from opacity 70 %;
//              lead "Edge" 270, lead-in half a beat; percussion none.
//
// Run once with a hard cut and once with a Push of one beat each side, it checks
// what the spec asks to see:
//   • chords and bass shrink from their halves into their cells before the cut,
//     the lead rises from below, percussion appears on the downbeat;
//   • chords, bass and lead do not pop at the pin;
//   • the lead is never split or dimmed across the Push;
//   • scrubbing into the lead-in shows the mid-move frame;
//   • PREVIEW AND EXPORT MATCH, frame for frame, at every sampled frame.
//
// Preview frames come from the stopped-preview seek; export frames are read
// back out of the rendered file with ffmpeg. The two are different sizes and
// one has been through a video codec, so "match" is measured on a coarse grid
// of block averages with a small tolerance, plus the same semantic checks on
// both. Needs a D3D11 GPU and ffmpeg on PATH; SKIPs (exit 0) without them.
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

const PPQ = 960;
const FULL = 8;
const BPM = 120;                       // one 30 fps frame = 64 ticks exactly
const FPS = 30;
const TICKS_PER_FRAME = (PPQ * BPM) / (60 * FPS);
const PIN_BEAT = 32;                   // bar 9 in 4/4
const PIN_TICK = PIN_BEAT * PPQ;
const EXPORT_START_BEAT = 28;
const EXPORT_END_BEAT = 36;
const EXPORT_W = 480, EXPORT_H = 270;
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
  if (fs.existsSync(outPath)) return true;
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=64x64:d=4:r=30`,
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', outPath,
  ], { stdio: 'ignore' });
  return !r.error && r.status === 0 && fs.existsSync(outPath);
}

// ── frame helpers: a frame is { width, height, data: RGBA } ─────────────────
const TRACK_COLORS = {
  chords:  (c) => c.r > 150 && c.g < 90 && c.b < 90,                  // red
  bass:    (c) => c.g > 150 && c.r < 90 && c.b < 90,                  // lime
  lead:    (c) => c.b > 150 && c.r < 90 && c.g < 90,                  // blue
  perc1:   (c) => c.r > 150 && c.g > 150 && c.b < 90,                 // yellow
  perc2:   (c) => c.r > 150 && c.b > 150 && c.g < 90,                 // magenta
};
const isBlack = (c) => c.r < 28 && c.g < 28 && c.b < 28;
const cstr = (c) => `(${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)})`;

function colorAtUV(fr, u, v) {
  const { width, height, data } = fr;
  const rad = Math.max(1, Math.round(width / 240));
  const cx = Math.min(width - 1, Math.floor(u * width)), cy = Math.min(height - 1, Math.floor(v * height));
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

// Share of the frame a track's colour covers (0..1), sampled on a fixed lattice
// so a 960x540 preview frame and a 480x270 export frame are measured alike.
function coverage(fr, test) {
  const COLS = 160, ROWS = 90;
  let hits = 0;
  for (let j = 0; j < ROWS; j++) {
    for (let i = 0; i < COLS; i++) {
      const x = Math.floor(((i + 0.5) / COLS) * fr.width);
      const y = Math.floor(((j + 0.5) / ROWS) * fr.height);
      const o = (y * fr.width + x) * 4;
      if (test({ r: fr.data[o], g: fr.data[o + 1], b: fr.data[o + 2] })) hits += 1;
    }
  }
  return hits / (COLS * ROWS);
}

// Block averages on a coarse grid: the common ground between two frames of
// different sizes, one of which has been through a codec.
function blockGrid(fr, cols = 32, rows = 18) {
  const out = new Float64Array(cols * rows * 3);
  for (let j = 0; j < rows; j++) {
    const y0 = Math.floor((j / rows) * fr.height), y1 = Math.floor(((j + 1) / rows) * fr.height);
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor((i / cols) * fr.width), x1 = Math.floor(((i + 1) / cols) * fr.width);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * fr.width + x) * 4;
          r += fr.data[o]; g += fr.data[o + 1]; b += fr.data[o + 2]; n += 1;
        }
      }
      const k = (j * cols + i) * 3;
      out[k] = r / n; out[k + 1] = g / n; out[k + 2] = b / n;
    }
  }
  return out;
}
function gridDiff(a, b) {
  let sum = 0, max = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    sum += d;
    if (d > max) max = d;
  }
  return { mean: sum / a.length, max };
}

async function main() {
  console.log(`=== xleth landing acceptance: the reference scenario, preview vs export (${native.config}) ===\n`);

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found on PATH.');

  const tmpDir = path.join(os.tmpdir(), 'xleth-landing-acceptance');
  fs.mkdirSync(tmpDir, { recursive: true });
  const CLIPS = { chords: 'red', bass: 'lime', lead: 'blue', perc1: 'yellow', perc2: 'magenta' };
  for (const [name, color] of Object.entries(CLIPS)) {
    if (!makeSolidVideo(ffmpeg, color, path.join(tmpDir, `${name}-v1.mp4`))) {
      skip('ffmpeg failed to produce the test clips.');
    }
  }

  const addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'initialize() returns true');
  if (!addon.diag_getVisualPreviewDiagnostic().compositorReady) {
    addon.shutdown();
    skip('GPU preview compositor did not initialise (no usable D3D11 device).');
  }
  addon.timeline_setPreviewPosterMode(false);
  addon.setBPM(BPM);

  // ── The reference scenario ────────────────────────────────────────────────
  const track = {};
  let order = 0;
  for (const name of Object.keys(CLIPS)) {
    const sourceId = addon.project_importSource(path.join(tmpDir, `${name}-v1.mp4`));
    track[name] = addon.timeline_addTrack({ name, volume: 1.0, order: order++ });
    const regionId = addon.timeline_addRegion({ name, label: name, sourceId, startTime: 0, endTime: 2 });
    addon.timeline_addClip({
      trackId: track[name], regionId, positionTicks: 0, durationTicks: 48 * PPQ, velocity: 1.0,
    });
  }
  const slotOf = (name, gridX, gridY, spanX = FULL, spanY = FULL) =>
    ({ trackId: track[name], gridX, gridY, spanX, spanY, opacity: 1.0, zOrder: 0 });

  const oneId = addon.timeline_listSnapshots().find((s) => s.active).id;
  addon.timeline_setGridLayout({ columns: 2, rows: 1, previewFps: FPS, gapScale: 0,
    slots: [slotOf('chords', 0, 0), slotOf('bass', FULL, 0)] });
  const twoId = addon.timeline_createSnapshot('Snapshot 2');
  addon.timeline_setGridLayout({ columns: 4, rows: 4, previewFps: FPS, gapScale: 0, slots: [
    slotOf('chords', 0, 0), slotOf('bass', 3 * FULL, 0),
    slotOf('lead', FULL, FULL, 2 * FULL, 2 * FULL),
    slotOf('perc1', 0, 3 * FULL), slotOf('perc2', 3 * FULL, 3 * FULL),
  ] });
  addon.timeline_setActiveSnapshot(oneId);
  addon.timeline_addCue(PIN_TICK, twoId);

  const cues = addon.timeline_setCueLandings(PIN_TICK, [
    { trackId: track.chords, from: 'whereItWas', leadInTicks: PPQ, fromOpacity: 0.7 },
    { trackId: track.bass,   from: 'whereItWas', leadInTicks: PPQ, fromOpacity: 0.7 },
    { trackId: track.lead,   from: 'edge', edgeAngleDeg: 270, leadInTicks: PPQ / 2 },
  ]);
  ok(cues.find((c) => c.tick === PIN_TICK)?.landings?.length === 3,
     'the reference landings are authored (chords, bass, lead; percussion has none)');

  addon.play();
  await sleep(150);
  addon.stop();
  await sleep(100);

  async function seekSettle(tick) {
    const r = addon.video_requestPreviewFrameAtTimelinePosition({ ticks: tick });
    if (!r.accepted) throw new Error(`seek(${tick}) not accepted`);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      if (d.stoppedPreview && d.stoppedPreview.publishedSeq >= r.seq) break;
      await sleep(30);
    }
    const fr = addon.getCurrentFrame();
    return { width: fr.width, height: fr.height, data: Buffer.from(fr.data) };
  }

  // Export the window around the cue and read every frame back.
  async function exportFrames(label) {
    const outPath = path.join(tmpDir, `landing-${label}.mp4`);
    try { fs.unlinkSync(outPath); } catch { /* first run */ }
    const started = addon.video_exportStart({
      outputPath: outPath, videoCodec: 'h264', rateControl: 'crf', crf: 10,
      width: EXPORT_W, height: EXPORT_H, fpsNum: FPS, fpsDen: 1,
      startBeat: EXPORT_START_BEAT, endBeat: EXPORT_END_BEAT,
    });
    ok(started === true, `[${label}] export started`);
    if (!started) return null;
    const deadline = Date.now() + 180000;
    let prog = null;
    while (Date.now() < deadline) {
      prog = addon.video_exportGetProgress();
      if (prog && (prog.complete || prog.failed)) break;
      await sleep(150);
    }
    if (prog && prog.failed) console.error(`  export failed: ${prog.error}`);
    ok(!!(prog && prog.complete && !prog.failed), `[${label}] export completed`);
    if (!fs.existsSync(outPath)) return null;
    const rawPath = path.join(tmpDir, `landing-${label}.rgba`);
    // passthrough: one output frame per encoded frame. ffmpeg's default
    // constant-rate output would duplicate a frame near the start (the file's
    // video timestamps are not on an exact 1/30 s grid) and shift every index.
    spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', outPath,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', rawPath], { stdio: 'ignore' });
    if (!fs.existsSync(rawPath)) return null;
    const raw = fs.readFileSync(rawPath);
    fs.unlinkSync(rawPath);
    const frameBytes = EXPORT_W * EXPORT_H * 4;
    const count = Math.floor(raw.length / frameBytes);
    return {
      count,
      at: (n) => ({ width: EXPORT_W, height: EXPORT_H,
        data: raw.subarray(n * frameBytes, (n + 1) * frameBytes) }),
    };
  }

  const frameTick = (n) => EXPORT_START_BEAT * PPQ + n * TICKS_PER_FRAME;
  const PIN_FRAME = (PIN_TICK - EXPORT_START_BEAT * PPQ) / TICKS_PER_FRAME;      // 60
  ok(Number.isInteger(TICKS_PER_FRAME) && Number.isInteger(PIN_FRAME),
     `frames fall on whole ticks (${TICKS_PER_FRAME} ticks per frame; the pin is export frame ${PIN_FRAME})`);

  // Wait until the preview really shows the project: a seek is published even
  // while a clip's first decode (or its proxy) is still on the way, and such a
  // frame is missing that cell. On a busy machine that takes a while. Both
  // snapshots have to be complete before anything is measured.
  const complete = async () => {
    const one = await seekSettle(frameTick(10));
    const two = await seekSettle(frameTick(PIN_FRAME + 30));
    return Math.abs(coverage(one, TRACK_COLORS.chords) - 0.5) < 0.02
      && Math.abs(coverage(one, TRACK_COLORS.bass) - 0.5) < 0.02
      && Math.abs(coverage(two, TRACK_COLORS.lead) - 0.25) < 0.01
      && Math.abs(coverage(two, TRACK_COLORS.perc1) - 0.0625) < 0.01
      && Math.abs(coverage(two, TRACK_COLORS.perc2) - 0.0625) < 0.01;
  };
  let ready = false;
  for (let attempt = 0; attempt < 60 && !ready; attempt++) {
    ready = await complete();
    if (!ready) await sleep(500);
  }
  ok(ready, 'the preview shows every clip of both snapshots before anything is measured');
  await sleep(400);          // let any proxy swap that is still pending land

  // Preview against export at each sampled frame.
  async function compareWithExport(label, exported, frames) {
    let worstMean = 0, worstMax = 0, compared = 0, semantic = true;
    for (const n of frames) {
      if (n >= exported.count) continue;
      const preview = await seekSettle(frameTick(n));
      const exportFrame = exported.at(n);
      const d = gridDiff(blockGrid(preview), blockGrid(exportFrame));
      worstMean = Math.max(worstMean, d.mean);
      worstMax = Math.max(worstMax, d.max);
      compared += 1;
      // The same picture, track by track: each track covers the same share of
      // the frame in the preview and in the export.
      for (const [name, test] of Object.entries(TRACK_COLORS)) {
        const a = coverage(preview, test), b = coverage(exportFrame, test);
        if (Math.abs(a - b) > 0.02) {
          semantic = false;
          console.error(`    frame ${n}: ${name} covers ${(a * 100).toFixed(1)} % in preview, ${(b * 100).toFixed(1)} % in export`);
        }
      }
    }
    console.log(`  [${label}] preview vs export over ${compared} frames: worst block mean ${worstMean.toFixed(2)}, worst block ${worstMax.toFixed(1)} (of 255)`);
    ok(compared === frames.length, `[${label}] every sampled frame was in the export`);
    ok(worstMean < 6 && worstMax < 64,
       `[${label}] preview and export match at every sampled frame (block averages)`);
    ok(semantic, `[${label}] every track covers the same share of the frame in preview and export`);
  }

  // The picture the spec describes, checked on one stream of frames.
  // `frameAt(n)` returns the frame for export-frame index n.
  async function checkStory(label, frameAt, { push }) {
    const cov = async (n) => {
      const fr = await frameAt(n);
      const out = {};
      for (const [name, test] of Object.entries(TRACK_COLORS)) out[name] = coverage(fr, test);
      return { fr, ...out };
    };

    // Well before the lead-in: snapshot 1.
    const before = await cov(20);
    ok(Math.abs(before.chords - 0.5) < 0.02 && Math.abs(before.bass - 0.5) < 0.02
       && before.lead === 0 && before.perc1 === 0 && before.perc2 === 0,
       `[${label}] before the lead-in: chords and bass fill their halves, nothing else is on screen`);

    // Lead-in: chords/bass start at frame 45 (beat 31), lead at 52.5 (beat 31.5).
    // With "Land" most of the move happens early, so sample soon after each start.
    const early = await cov(47);
    ok(early.chords < before.chords - 0.02 && early.chords > 0.0625 + 0.01
       && early.bass < before.bass - 0.02 && early.bass > 0.0625 + 0.01,
       `[${label}] in the lead-in chords and bass are between their half and their cell `
       + `(${(early.chords * 100).toFixed(1)} % / ${(early.bass * 100).toFixed(1)} %)`);
    if (!push) {
      ok(early.lead === 0, `[${label}] the lead has not started: it is still below the frame`);
      ok(early.perc1 === 0 && early.perc2 === 0, `[${label}] percussion is not drawn before the cut`);
    }
    // The lead starts at frame 52.5. "Land" is a strong ease-out, so one frame
    // in it is already a third of the way up and partly in frame; a frame later
    // it is wholly in frame but still below its slot.
    const rising = await cov(53);
    ok(rising.lead > 0.02 && rising.lead < 0.25 - 0.005,
       `[${label}] the lead is rising from below (${(rising.lead * 100).toFixed(1)} % of the frame is lead, 25 % when landed)`);
    const leadTop = (fr) => {
      for (let j = 0; j < 180; j++) {
        if (TRACK_COLORS.lead(colorAtUV(fr, 0.5, (j + 0.5) / 180))) return j / 180;
      }
      return 1;
    };
    const top53 = leadTop(rising.fr);
    const top54 = leadTop((await cov(54)).fr);
    ok(top53 > 0.5 && top54 < top53 && top54 > 0.25 + 0.01,
       `[${label}] it enters from the bottom edge and climbs (top edge at ${top53.toFixed(2)}, then ${top54.toFixed(2)}; its slot starts at 0.25)`);

    // No pop at the pin: the last frame before it and the pin frame show each
    // landing track in the same place at the same strength.
    const last = await cov(PIN_FRAME - 1);
    const pin = await cov(PIN_FRAME);
    for (const name of ['chords', 'bass', 'lead']) {
      const target = name === 'lead' ? 0.25 : 0.0625;
      ok(Math.abs(last[name] - pin[name]) < 0.012 && Math.abs(pin[name] - target) < 0.012,
         `[${label}] ${name} does not pop at the pin `
         + `(${(last[name] * 100).toFixed(1)} % -> ${(pin[name] * 100).toFixed(1)} %, cell ${(target * 100).toFixed(2)} %)`);
    }
    const cells = { chords: [0.125, 0.125], bass: [0.875, 0.125], lead: [0.5, 0.5] };
    for (const [name, [u, v]] of Object.entries(cells)) {
      ok(TRACK_COLORS[name](colorAtUV(last.fr, u, v)) && TRACK_COLORS[name](colorAtUV(pin.fr, u, v)),
         `[${label}] ${name} is in its snapshot-2 cell on both sides of the pin`);
    }

    if (!push) {
      ok(last.perc1 === 0 && last.perc2 === 0 && Math.abs(pin.perc1 - 0.0625) < 0.01
         && Math.abs(pin.perc2 - 0.0625) < 0.01,
         `[${label}] percussion appears on the downbeat`);
    } else {
      // Across the whole Push (frames 45..75): from its landing on, the lead is
      // whole and at full strength in its cell; chords and bass likewise.
      let leadWhole = true, othersWhole = true;
      const corners = [[0.5, 0.5], [0.27, 0.27], [0.73, 0.27], [0.27, 0.73], [0.73, 0.73]];
      for (let n = PIN_FRAME; n <= PIN_FRAME + 15; n += 3) {
        const fr = await frameAt(n);
        for (const [u, v] of corners) {
          if (!TRACK_COLORS.lead(colorAtUV(fr, u, v))) {
            leadWhole = false;
            console.error(`    frame ${n}: lead at (${u},${v}) is ${cstr(colorAtUV(fr, u, v))}`);
          }
        }
        if (!TRACK_COLORS.chords(colorAtUV(fr, 0.125, 0.125)) || !TRACK_COLORS.bass(colorAtUV(fr, 0.875, 0.125))) {
          othersWhole = false;
        }
      }
      ok(leadWhole, `[${label}] the lead is never split or dimmed across the Push`);
      ok(othersWhole, `[${label}] chords and bass stay whole in their cells across the Push`);
      // Percussion has no landing: it comes in WITH the Push, so mid-window it
      // is not yet sitting whole in both of its cells.
      const mid = await cov(PIN_FRAME + 4);
      ok(mid.perc1 + mid.perc2 > 0 && mid.perc1 + mid.perc2 < 0.125 - 0.005,
         `[${label}] percussion (no landing) is still being pushed in mid-window`);
    }

    // After everything: plain snapshot 2.
    const after = await cov(push ? 100 : 80);
    ok(Math.abs(after.chords - 0.0625) < 0.01 && Math.abs(after.bass - 0.0625) < 0.01
       && Math.abs(after.lead - 0.25) < 0.01 && Math.abs(after.perc1 - 0.0625) < 0.01
       && Math.abs(after.perc2 - 0.0625) < 0.01,
       `[${label}] afterwards the frame is snapshot 2`);
  }

  const previewAt = (n) => seekSettle(frameTick(n));

  // ── Run 1: hard cut ───────────────────────────────────────────────────────
  console.log('\n[ hard cut ]');
  await checkStory('preview, hard cut', previewAt, { push: false });
  const cutExport = await exportFrames('hard-cut');
  if (cutExport) {
    ok(cutExport.count >= 118, `the hard-cut export has ${cutExport.count} frames`);
    await checkStory('export, hard cut', async (n) => cutExport.at(n), { push: false });
    await compareWithExport('hard cut', cutExport,
      [20, 44, 45, 46, 47, 48, 50, 52, 53, 54, 56, 58, 59, 60, 61, 70, 100]);
  } else {
    ok(false, 'the hard-cut export could not be read back');
  }

  // Scrubbing: a frame inside the lead-in is the same whether it is reached
  // from before, from after, or first.
  const scrubTick = frameTick(48);
  const fromBefore = await (async () => { await seekSettle(frameTick(10)); return seekSettle(scrubTick); })();
  const fromAfter = await (async () => { await seekSettle(frameTick(100)); return seekSettle(scrubTick); })();
  ok(Buffer.compare(fromBefore.data, fromAfter.data) === 0,
     'scrubbing into the lead-in from either side shows the same mid-move frame');
  ok(coverage(fromBefore, TRACK_COLORS.chords) < 0.45 && coverage(fromBefore, TRACK_COLORS.chords) > 0.07,
     'and that frame really is mid-move');

  // ── Run 2: the same cue with a Push, one beat each side ───────────────────
  console.log('\n[ push, 1 beat each side ]');
  addon.timeline_setCueTransition(PIN_TICK, {
    enabled: true, startOffsetTicks: PPQ, endOffsetTicks: PPQ, type: 'push', geomAngleDeg: 0,
  });
  const afterPush = addon.timeline_listCues().find((c) => c.tick === PIN_TICK);
  ok(afterPush?.transition?.type === 'push' && afterPush?.landings?.length === 3,
     'switching the transition to Push keeps the landings');
  await checkStory('preview, push', previewAt, { push: true });
  const pushExport = await exportFrames('push');
  if (pushExport) {
    await checkStory('export, push', async (n) => pushExport.at(n), { push: true });
    await compareWithExport('push', pushExport,
      [20, 45, 46, 48, 50, 53, 55, 58, 59, 60, 61, 63, 66, 70, 74, 75, 76, 100]);
  } else {
    ok(false, 'the push export could not be read back');
  }

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
