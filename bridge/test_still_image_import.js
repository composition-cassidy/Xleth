'use strict';
//
// bridge/test_still_image_import.js
//
// Still images (JPEG/BMP/WebP) import as one-frame video sources and a clip
// holds that frame for its whole length, in preview AND export. A transparent
// BMP (what PNGs and colour sources become) composites over the layer behind
// it with its alpha intact. GIFs import as ordinary animated video. Before the fix a still reported duration 0, its
// preview proxy encoded empty, and every frame after the first was black.
//
// Needs a GPU (D3D11) and ffmpeg (PATH or vendor/ffmpeg/bin); SKIPs otherwise.
//

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const addonPath = ['Release', 'Debug']
  .map((c) => path.resolve(__dirname, 'build', c, 'xleth_native.node'))
  .find((p) => fs.existsSync(p));
if (!addonPath) throw new Error('xleth_native.node not found in bridge/build/{Release,Debug}');
process.env.PATH = [
  path.dirname(addonPath),
  path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin'),
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
].filter((d) => fs.existsSync(d)).join(';') + ';' + process.env.PATH;

const PPQ = 960;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failed += 1; };
const skip = (msg) => { console.log(`[SKIP] ${msg}`); process.exit(0); };

function findFfmpeg() {
  for (const c of ['ffmpeg', path.resolve(__dirname, '../vendor/ffmpeg/bin/ffmpeg.exe')]) {
    const r = spawnSync(c, ['-version'], { stdio: 'ignore' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

const at = (fr, fx) => {
  const o = ((fr.height >> 1) * fr.width + Math.round(fr.width * fx)) * 4;
  return [fr.data[o], fr.data[o + 1], fr.data[o + 2]];
};
const isBlue = ([r, g, b]) => b > 180 && r < 60 && g < 60;
const isRed = ([r, g, b]) => r > 180 && g < 60 && b < 60;

// 320x180 top-down 32-bit BMP: left half opaque red, right half fully transparent.
function writeHalfTransparentBmp(file) {
  const w = 320, h = 180, px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) { const i = (y * w + x) * 4; px[i + 2] = 255; px[i + 3] = 255; }
  const hd = Buffer.alloc(54);
  hd.write('BM', 0, 'ascii'); hd.writeUInt32LE(54 + px.length, 2); hd.writeUInt32LE(54, 10); hd.writeUInt32LE(40, 14);
  hd.writeInt32LE(w, 18); hd.writeInt32LE(-h, 22); hd.writeUInt16LE(1, 26); hd.writeUInt16LE(32, 28); hd.writeUInt32LE(px.length, 34);
  fs.writeFileSync(file, Buffer.concat([hd, px]));
}

async function main() {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) skip('ffmpeg not found');
  const dir = path.join(os.tmpdir(), 'xleth-still-image-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const JPG = path.join(dir, 'blue.jpg');
  const GIF = path.join(dir, 'anim.gif');
  spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=1', '-frames:v', '1', JPG]);
  spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=2:r=10', GIF]);
  if (!fs.existsSync(JPG) || !fs.existsSync(GIF)) skip('ffmpeg could not make the test images');
  const BMP = path.join(dir, 'half.bmp');
  writeHalfTransparentBmp(BMP);

  // Proxies go to <cwd>/proxies when there is no project folder.
  process.chdir(dir);
  const addon = require(addonPath);
  addon.initialize({});
  if (!addon.diag_getVisualPreviewDiagnostic().compositorReady) { addon.shutdown(); skip('no D3D11 compositor'); }
  addon.timeline_setPreviewPosterMode(false);
  addon.setBPM(120);

  const sid = addon.project_importSource(JPG);
  const src = addon.timeline_getSources().find((s) => s.id === sid);
  ok(sid >= 0 && src.hasVideo, 'JPEG imports as a video source');
  ok(src.duration > 0 && src.duration <= 0.05, `JPEG is one frame long (duration=${src.duration})`);

  const gid = addon.project_importSource(GIF);
  const gsrc = addon.timeline_getSources().find((s) => s.id === gid);
  ok(gid >= 0 && Math.abs(gsrc.duration - 2) < 0.05, `GIF imports as 2 s of video (duration=${gsrc && gsrc.duration})`);

  const bid = addon.project_importSource(BMP);
  const bsrc = addon.timeline_getSources().find((s) => s.id === bid);
  ok(bid >= 0 && bsrc.hasVideo, 'transparent BMP imports as a video source');

  // The half-transparent still is a grid cell; the blue JPEG is a fullscreen
  // layer behind it, visible only through the transparent half.
  const track = addon.timeline_addTrack({ name: 'Still', volume: 1, order: 0 });
  const behind = addon.timeline_addTrack({ name: 'Behind', volume: 1, order: 1 });
  const reg = addon.timeline_addRegion({ name: 'S', label: 'S', sourceId: bid, startTime: 0, endTime: bsrc.duration });
  const regB = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sid, startTime: 0, endTime: src.duration });
  addon.timeline_addClip({ trackId: track, regionId: reg, positionTicks: 0, durationTicks: 8 * PPQ, velocity: 1 });
  addon.timeline_addClip({ trackId: behind, regionId: regB, positionTicks: 0, durationTicks: 8 * PPQ, velocity: 1 });
  addon.timeline_setGridLayout({
    columns: 1, rows: 1, previewFps: 30,
    slots: [{ trackId: track, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1, zOrder: 0 }],
    fullscreenLayers: [{ trackId: behind, opacity: 1, placement: 'behind' }],
  });

  async function frameAt(ticks) {
    const r = addon.video_requestPreviewFrameAtTimelinePosition({ ticks });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      if (d.stoppedPreview && d.stoppedPreview.publishedSeq >= r.seq) break;
      await sleep(40);
    }
    return addon.getCurrentFrame();
  }
  // Ask twice: the first request also kicks off (and now skips) proxy builds.
  for (const t of [0, 2 * PPQ, 6 * PPQ]) await frameAt(t);
  for (const t of [0, 2 * PPQ, 6 * PPQ]) {
    const fr = await frameAt(t);
    ok(isRed(at(fr, 0.25)), `preview holds the still's opaque half at tick ${t} (${at(fr, 0.25)})`);
    ok(isBlue(at(fr, 0.75)), `preview shows the layer behind through the transparent half at tick ${t} (${at(fr, 0.75)})`);
  }

  const out = path.join(dir, 'still-export.mp4');
  const started = addon.video_exportStart({
    outputPath: out, videoCodec: 'h264', rateControl: 'crf', crf: 18,
    width: 320, height: 180, fpsNum: 30, fpsDen: 1, startBeat: 0, endBeat: 4,
  });
  ok(started === true, 'export starts');
  let prog = null;
  const deadline = Date.now() + 120000;
  while (started && Date.now() < deadline) {
    prog = addon.video_exportGetProgress();
    if (prog && (prog.complete || prog.failed)) break;
    await sleep(200);
  }
  ok(!!(prog && prog.complete && !prog.failed), `export completes${prog && prog.error ? `: ${prog.error}` : ''}`);
  const raw = path.join(dir, 'frame.rgba');
  spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', out, '-vf', 'select=eq(n\\,45)', '-vframes', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', raw]);
  const buf = fs.existsSync(raw) ? fs.readFileSync(raw) : null;
  const ef = buf && buf.length >= 320 * 180 * 4 ? { width: 320, height: 180, data: buf } : null;
  ok(!!ef && isRed(at(ef, 0.25)), `export holds the still's opaque half 1.5 s in (${ef && at(ef, 0.25)})`);
  ok(!!ef && isBlue(at(ef, 0.75)), `export keeps the transparent half see-through (${ef && at(ef, 0.75)})`);

  addon.shutdown();
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
