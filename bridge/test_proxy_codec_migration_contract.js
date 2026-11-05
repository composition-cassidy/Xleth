'use strict';
//
// bridge/test_proxy_codec_migration_contract.js
//
// End-to-end contract test for the preview-proxy codec (H.264 vs legacy
// all-intra) and the on-open migration, driven through the REAL
// xleth_native.node — i.e. the same RPC surface the renderer's
// window.xleth.proxy.* wrappers call (see ui/rpc-manifest.js). Nothing is
// mocked: proxies are really encoded, probed with ffprobe, and decoded by the
// live preview.
//
// What it proves:
//   1. proxy_setCodec / proxy_getCodec reach the engine (return values checked —
//      an unexported method would be `undefined`, not a silent success).
//   2. Intra setting → legacy proxies (whole-source MJPEG *.preview.720p.mov,
//      region DNxHR <id>.mxf), exactly as before this change.
//   3. A leftover "*.tmp" from an interrupted generation is removed on open.
//   4. H.264 setting + re-open → background migration: progress is reported,
//      preview keeps working, a mid-migration project re-open cancels cleanly
//      (no .tmp left behind, legacy proxy intact) and the migration resumes.
//   5. After migration: H.264 proxies exist and probe as h264 (not AVdh/mjpeg),
//      the superseded legacy files are deleted, a source whose media is missing
//      keeps its legacy proxy untouched, and project.json references only files
//      that exist.
//   6. A second re-open schedules no further migration.
//   7. Stopped-preview seek latency (request → frame published) for the intra
//      and the H.264 proxy, across GOP boundaries — printed for comparison.
//
// Media: XLETH_PROXY_TEST_MEDIA (main clip, ideally real 1080p footage >= 60 s)
// and XLETH_PROXY_TEST_MEDIA2 (short clip). Both are COPIED into a temp dir;
// the second one is made "missing" mid-test by pointing project.json at a
// nonexistent path. Without them, clips are synthesized
// with vendor/ffmpeg/bin/ffmpeg.exe. Needs a D3D11 GPU; SKIPs (exit 0) without
// one or without ffmpeg.
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
  path.resolve(__dirname, 'build/vcpkg_installed/x64-windows/bin'),
  // Same fallback as ui/addon-worker.js: a bridge-clean leaves the FFmpeg DLLs
  // only in the top-level engine build's vcpkg tree.
  path.resolve(__dirname, '..', 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;

const FFMPEG  = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffmpeg.exe');
const FFPROBE = path.resolve(__dirname, '..', 'vendor', 'ffmpeg', 'bin', 'ffprobe.exe');

const PPQ = 960;
const BPM = 120;                       // 2 beats per second
const secToTicks = (s) => Math.round(s * (BPM / 60) * PPQ);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; console.log(`  PASS  ${label}`); }
  else      { failed += 1; console.error(`  FAIL  ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,codec_tag_string,width,height,nb_frames', '-of', 'json', file],
  { encoding: 'utf8' });
  try { return JSON.parse(r.stdout).streams[0] || {}; } catch { return {}; }
}
function durationSec(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  return parseFloat(r.stdout) || 0;
}
function fpsOf(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=r_frame_rate', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8' });
  const [n, d] = String(r.stdout).trim().split('/').map(Number);
  return d ? n / d : 24;
}
function synth(out, seconds) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=1920x1080:rate=24:duration=${seconds}`, '-vf', 'noise=alls=12:allf=t',
    '-c:v', 'libx264', '-preset', 'veryfast', '-g', '240', '-pix_fmt', 'yuv420p', out]);
  return r.status === 0 && fs.existsSync(out);
}
const tmpFiles = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

async function waitFor(pred, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(250);
  }
  console.error(`  (timed out after ${timeoutMs} ms waiting for: ${label})`);
  return false;
}

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { n: s.length, median: q(0.5), p95: q(0.95), max: s[s.length - 1],
           mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const fmt = (s) => `n=${s.n} median ${s.median.toFixed(1)} ms  p95 ${s.p95.toFixed(1)} ms  max ${s.max.toFixed(1)} ms`;

async function main() {
  console.log(`=== xleth proxy codec + migration contract test (${native.config}) ===\n`);
  if (!fs.existsSync(FFMPEG) || !fs.existsSync(FFPROBE)) {
    console.log('SKIP: vendor/ffmpeg/bin/ffmpeg.exe / ffprobe.exe not found');
    return;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth_proxycodec_'));
  const projDir = path.join(work, 'project');
  const proxiesDir = path.join(projDir, 'proxies');
  const mediaA = path.join(work, 'clipA.mp4');
  const mediaB = path.join(work, 'clipB.mp4');
  if (process.env.XLETH_PROXY_TEST_MEDIA) fs.copyFileSync(process.env.XLETH_PROXY_TEST_MEDIA, mediaA);
  else if (!synth(mediaA, 40)) { console.log('SKIP: could not synthesize test media'); return; }
  if (process.env.XLETH_PROXY_TEST_MEDIA2) fs.copyFileSync(process.env.XLETH_PROXY_TEST_MEDIA2, mediaB);
  else if (!synth(mediaB, 8)) { console.log('SKIP: could not synthesize test media'); return; }
  const durA = durationSec(mediaA);
  const durB = durationSec(mediaB);
  const fpsA = fpsOf(mediaA);
  console.log(`  media A: ${mb(size(mediaA))}, ${durA.toFixed(1)} s @ ${fpsA} fps`);
  console.log(`  media B: ${mb(size(mediaB))}, ${durB.toFixed(1)} s`);

  const addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'initialize() returns true');
  const diag0 = addon.diag_getVisualPreviewDiagnostic();
  const gpuOk = !!(diag0 && diag0.gpuInitialized !== false);

  // ── 1. codec RPC round-trip ────────────────────────────────────────────────
  const initial = addon.proxy_getCodec();
  ok(initial && initial.requested === 'h264', `default codec is h264 (got ${JSON.stringify(initial)})`);
  if (!initial || initial.h264Available !== true) {
    // e.g. Windows Server / N editions without Media Foundation, and an FFmpeg
    // built without libx264: the engine correctly falls back to intra, and
    // there is nothing to migrate to.
    console.log('SKIP: no H.264 encoder opens on this machine (libx264 / h264_mf)');
    addon.shutdown();
    return;
  }
  ok(initial.effective === 'h264', 'an H.264 encoder opens on this machine (libx264 or Media Foundation h264_mf)');
  const setIntra = addon.proxy_setCodec('intra');
  ok(setIntra && setIntra.requested === 'intra' && setIntra.effective === 'intra',
     'proxy_setCodec("intra") reaches the engine and returns its state');
  let threw = false;
  try { addon.proxy_setCodec('av1'); } catch (_) { threw = true; }
  ok(threw, 'proxy_setCodec rejects an unknown codec');

  // ── 2. project with two sources, built under the INTRA setting ─────────────
  addon.setBPM(BPM);
  addon.timeline_setPreviewPosterMode(false);
  ok(addon.project_create(projDir, 'ProxyCodecTest') !== false, 'project_create');
  const sidA = addon.project_importSource(mediaA);
  const sidB = addon.project_importSource(mediaB);
  ok(sidA > 0 && sidB > 0, `imported two sources (${sidA}, ${sidB})`);
  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
  const regA = addon.timeline_addRegion({ name: 'A', label: 'A', sourceId: sidA, startTime: 0, endTime: durA });
  const regB = addon.timeline_addRegion({ name: 'B', label: 'B', sourceId: sidB, startTime: 0, endTime: durB });
  addon.timeline_addClip({ trackId: trackA, regionId: regA, positionTicks: 0, durationTicks: secToTicks(durA), velocity: 1.0 });
  addon.timeline_addClip({ trackId: trackB, regionId: regB, positionTicks: 0, durationTicks: secToTicks(durB), velocity: 1.0 });
  addon.timeline_setGridLayout({ columns: 1, rows: 1, previewFps: 30,
    slots: [{ trackId: trackA, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1.0, zOrder: 0 }] });
  ok(addon.project_save() !== false, 'project_save');

  const h = 720;
  const legacyA = path.join(proxiesDir, `clipA.preview.${h}p.mov`);
  const legacyB = path.join(proxiesDir, `clipB.preview.${h}p.mov`);
  const h264A   = path.join(proxiesDir, `clipA.preview.${h}p.h264.mov`);
  const h264B   = path.join(proxiesDir, `clipB.preview.${h}p.h264.mov`);
  const regLegacyA = path.join(proxiesDir, `${regA}.mxf`);
  const regLegacyB = path.join(proxiesDir, `${regB}.mxf`);
  const regH264A   = path.join(proxiesDir, `${regA}.h264.mov`);
  const regH264B   = path.join(proxiesDir, `${regB}.h264.mov`);

  let t0 = Date.now();
  ok(addon.project_load(projDir) === true, 'project_load (intra setting)');
  await waitFor(() => fs.existsSync(legacyA) && fs.existsSync(legacyB)
                   && fs.existsSync(regLegacyA) && fs.existsSync(regLegacyB)
                   && addon.proxy_getStatus().pending === 0, 20 * 60 * 1000, 'intra proxies');
  const intraBuildSec = (Date.now() - t0) / 1000;
  const pA = probe(legacyA);
  const pR = probe(regLegacyA);
  ok(pA.codec_name === 'mjpeg', `legacy whole-source proxy is MJPEG (got ${pA.codec_name})`);
  ok(pR.codec_name === 'dnxhd' && pR.codec_tag_string === 'AVdh',
     `legacy region proxy is DNxHR/AVdh (got ${pR.codec_name}/${pR.codec_tag_string})`);
  const sizeIntraA = size(legacyA);
  const sizeIntraRegA = size(regLegacyA);
  console.log(`  intra proxies built in ${intraBuildSec.toFixed(1)} s: source A ${mb(sizeIntraA)}, region A ${mb(size(regLegacyA))}`);

  // ── seek timing helper (stopped preview; request → frame published) ───────
  async function seekMs(frame) {
    const ticks = secToTicks((frame + 0.5) / fpsA);
    const start = process.hrtime.bigint();
    const r = addon.video_requestPreviewFrameAtTimelinePosition({ ticks });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const d = addon.diag_getVisualPreviewDiagnostic();
      if (d.stoppedPreview && d.stoppedPreview.publishedSeq >= r.seq) break;
      await sleep(1);
    }
    return Number(process.hrtime.bigint() - start) / 1e6;
  }
  async function seekSuite(label, expectPath) {
    addon.play(); await sleep(300); addon.stop(); await sleep(200);
    await seekMs(10);
    const src = (addon.diag_getVisualPreviewDiagnostic().activeSources || [])
      .find((s) => s.sourceId === sidA) || {};
    ok(path.resolve(src.decodeOpenPath || '') === path.resolve(expectPath),
       `${label}: live preview decodes ${path.basename(expectPath)} (${src.decodePath}, intraOnly=${src.decodeIntraOnly})`);
    const frames = Math.floor(durA * fpsA) - 2;
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const random = [];
    for (let i = 0; i < 40; i++) random.push(await seekMs(Math.floor(rnd() * frames)));
    const base = Math.floor(frames / 2 / 48) * 48;              // an H.264 GOP boundary
    const stepBack = [];
    await seekMs(base + 17);
    for (let f = base + 16; f >= base - 7; f--) stepBack.push(await seekMs(f));
    const stepFwd = [];
    await seekMs(base - 8);
    for (let f = base - 7; f <= base + 16; f++) stepFwd.push(await seekMs(f));
    const scrub = [];
    for (let f = base - 120; f <= base + 120; f += 3) scrub.push(await seekMs(f));
    const scrubBack = [];
    for (let f = base + 120; f >= base - 120; f -= 3) scrubBack.push(await seekMs(f));
    const out = { random: stats(random), stepFwd: stats(stepFwd), stepBack: stats(stepBack),
                  scrub: stats(scrub), scrubBack: stats(scrubBack) };
    console.log(`  [seek ${label}] random    ${fmt(out.random)}`);
    console.log(`  [seek ${label}] stepFwd   ${fmt(out.stepFwd)}`);
    console.log(`  [seek ${label}] stepBack  ${fmt(out.stepBack)}`);
    console.log(`  [seek ${label}] scrubFwd  ${fmt(out.scrub)}`);
    console.log(`  [seek ${label}] scrubBack ${fmt(out.scrubBack)}`);
    return out;
  }
  const seekIntra = gpuOk ? await seekSuite('intra', legacyA) : null;

  // ── 3. crash leftover + missing source ────────────────────────────────────
  const leftover = path.join(proxiesDir, 'clipA.preview.720p.h264.mov.tmp');
  fs.writeFileSync(leftover, Buffer.alloc(1024 * 1024));
  // Source B's media goes missing. The engine holds the real file open, so the
  // project is pointed at the same file name in a directory that doesn't exist
  // (same stem → its legacy proxy still resolves by name).
  {
    const pjPath = path.join(projDir, 'project.json');
    const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
    const sB = pj.sources.find((s) => s.id === sidB);
    sB.filePath = path.join(work, 'gone', 'clipB.mp4');
    fs.writeFileSync(pjPath, JSON.stringify(pj, null, 2));
  }

  // ── 4. switch to H.264 and re-open → migration ────────────────────────────
  const setH264 = addon.proxy_setCodec('h264');
  ok(setH264 && setH264.requested === 'h264' && setH264.effective === 'h264',
     'proxy_setCodec("h264") → effective h264');
  t0 = Date.now();
  ok(addon.project_load(projDir) === true, 'project_load (h264 setting) → migration');
  ok(!fs.existsSync(leftover), 'interrupted *.tmp from a previous run removed on open');
  let st = addon.proxy_getStatus();
  ok(st.migration && st.migration.total >= 2,
     `migration scheduled on open (total=${st.migration && st.migration.total}: source A + region A)`);
  ok(st.codec === 'h264', 'proxy_getStatus reports codec h264');

  // Progress indication + mid-migration project close/re-open.
  let sawProgress = 0;
  await waitFor(() => {
    const m = addon.proxy_getStatus().migration;
    if (m.progress > 0 && m.progress < 1) sawProgress = Math.max(sawProgress, m.progress);
    return m.progress >= 0.15 || !m.active;
  }, 10 * 60 * 1000, 'migration progress >= 15%');
  ok(sawProgress > 0, `migration reports fractional progress (saw ${(sawProgress * 100).toFixed(0)}%)`);
  const partials = tmpFiles(proxiesDir);
  console.log(`  mid-migration partial outputs before re-open: ${partials.join(', ') || '(none)'}`);
  ok(addon.project_load(projDir) === true, 'project re-opened mid-migration');
  const partialsAfter = tmpFiles(proxiesDir);
  ok(partialsAfter.length === 0 || partialsAfter.every((f) => !partials.includes(f)),
     `cancelled migration left no partial file behind (now: ${partialsAfter.join(', ') || 'none'})`);
  ok(fs.existsSync(legacyA), 'legacy proxy intact after the cancelled migration');
  ok(!fs.existsSync(h264A), 'no half-written H.264 proxy under the real name');
  st = addon.proxy_getStatus();
  ok(st.migration.active, 'migration restarted by the re-open');

  await waitFor(() => !addon.proxy_getStatus().migration.active, 30 * 60 * 1000, 'migration done');
  const migSec = (Date.now() - t0) / 1000;
  st = addon.proxy_getStatus();
  ok(st.migration.failed === 0, `migration completed without failures (${st.migration.completed}/${st.migration.total})`);
  // Superseded files are retired on the next video-tick sweeps.
  await waitFor(() => !fs.existsSync(legacyA) && !fs.existsSync(regLegacyA), 20000, 'legacy retired');

  const p264 = probe(h264A);
  ok(p264.codec_name === 'h264' && p264.codec_tag_string !== 'AVdh',
     `migrated whole-source proxy is H.264 (${p264.codec_name}/${p264.codec_tag_string}, ${p264.width}x${p264.height})`);
  const pr264 = probe(regH264A);
  ok(pr264.codec_name === 'h264', `migrated region proxy is H.264 (${pr264.codec_name})`);
  ok(!fs.existsSync(legacyA), 'superseded legacy whole-source proxy deleted');
  ok(!fs.existsSync(regLegacyA), 'superseded legacy region proxy deleted');
  ok(fs.existsSync(legacyB) && !fs.existsSync(h264B), 'missing-media source B keeps its legacy proxy, no migration');
  ok(fs.existsSync(regLegacyB) && !fs.existsSync(regH264B), 'missing-media region B keeps its legacy proxy');
  const sizeH264A = size(h264A);
  console.log(`  migration took ${migSec.toFixed(1)} s (incl. one cancelled attempt)`);
  console.log(`  SIZE source A proxy: intra ${mb(sizeIntraA)} → H.264 ${mb(sizeH264A)} (${(sizeIntraA / sizeH264A).toFixed(1)}x smaller)`);
  console.log(`  SIZE region A proxy: intra ${mb(sizeIntraRegA)} → H.264 ${mb(size(regH264A))}`);
  ok(sizeH264A * 5 < sizeIntraA, 'H.264 proxy is at least 5x smaller than the intra one');

  const seekH264 = gpuOk ? await seekSuite('h264', h264A) : null;

  // ── 5. project.json consistency ───────────────────────────────────────────
  ok(addon.project_save() !== false, 'project_save after migration');
  const pj = JSON.parse(fs.readFileSync(path.join(projDir, 'project.json'), 'utf8'));
  const srcA = pj.sources.find((s) => s.id === sidA);
  ok(srcA && path.resolve(srcA.previewProxyPath) === path.resolve(h264A),
     `project.json source A → ${srcA && path.basename(srcA.previewProxyPath)}`);
  const refs = [
    ...pj.sources.filter((s) => s.previewProxyReady).map((s) => s.previewProxyPath),
    ...pj.regions.filter((r) => r.proxyReady).map((r) => r.proxyPath),
  ];
  ok(refs.length > 0 && refs.every((p) => fs.existsSync(p)),
     `every proxy referenced by project.json exists (${refs.map((p) => path.basename(p)).join(', ')})`);

  // ── 6. idempotent re-open ─────────────────────────────────────────────────
  ok(addon.project_load(projDir) === true, 're-open after migration');
  st = addon.proxy_getStatus();
  ok(st.migration.total === 0, 'no further migration scheduled');

  // ── seek comparison summary ───────────────────────────────────────────────
  if (seekIntra && seekH264) {
    console.log('\n  SEEK (stopped preview, request → published frame), median / p95 ms:');
    for (const k of ['random', 'stepFwd', 'stepBack', 'scrub', 'scrubBack']) {
      const a = seekIntra[k]; const b = seekH264[k];
      console.log(`    ${k.padEnd(9)} intra ${a.median.toFixed(1).padStart(6)} / ${a.p95.toFixed(1).padStart(6)}`
                + `   h264 ${b.median.toFixed(1).padStart(6)} / ${b.p95.toFixed(1).padStart(6)}`);
    }
  }

  addon.shutdown();
  if (!process.env.XLETH_PROXY_TEST_KEEP) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`  kept work dir: ${work}`);

  console.log('\n' + '-'.repeat(50));
  console.log(`PASSED: ${passed}/${passed + failed} tests`);
  if (failed > 0) { console.error(`FAILED: ${failed}`); process.exit(1); }
}

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
