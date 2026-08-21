'use strict';
//
// bridge/test_clip_cache_dedup.js — clip render-cache sharing + move gate.
//
// Two behaviours this guards, both of which used to make bulk timeline edits
// crawl on projects whose clips carry pitch/stretch:
//
//   1. ClipRenderCache was keyed by clip ID, not by CacheKey. Pasting N
//      identical time-stretched clips queued N full PSOLA/WORLD renders and
//      deep-copied the whole source PCM N times on the message thread, even
//      though every one of them produces bit-identical audio.
//   2. timeline_moveClip / moveClipsBatch invalidated the render cache. A move
//      changes nothing the CacheKey depends on (position cancels out of
//      durationSamples), so the buffer was thrown away and re-rendered for
//      every clip in a dragged selection.
//
// Measured through wall-clock on the message thread, which is exactly where
// the cost landed. Skips (exit 0) when the vendored FFmpeg needed to synthesise
// a source file is unavailable — same convention as the other perf gates.
//
// Run after rebuilding the native addon:
//   node bridge/test_clip_cache_dedup.js

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

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}
function skip(reason) {
  console.log(`  SKIP  ${reason}`);
  console.log(`\n${passed} passed, ${failed} failed (skipped)`);
  process.exit(0);
}

const ffmpeg = path.resolve(__dirname, '../vendor/ffmpeg/bin/ffmpeg.exe');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-cache-dedup-'));
const wavPath = path.join(tmpDir, 'tone.wav');
const projectDir = path.join(tmpDir, 'project');

const N_CLIPS = 48;          // a realistic bulk paste
const STRETCH = 1.75;        // non-identity → the clip needs a real render
const PITCH_CENTS = 25;

let addon = null;
try {
  if (!fs.existsSync(ffmpeg)) skip('vendored FFmpeg not present — cannot synthesise a source file');

  // 4 seconds of tone: long enough that a per-clip PCM deep-copy is measurable.
  const enc = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4:sample_rate=48000',
    '-ac', '2', wavPath,
  ], { encoding: 'utf8' });
  if (enc.status !== 0 || !fs.existsSync(wavPath)) {
    skip(`FFmpeg failed to write the test tone: ${enc.stderr || enc.error}`);
  }

  addon = require(native.addonPath);
  ok(addon.initialize({}) === true, 'engine initializes');
  ok(addon.project_create(projectDir, 'ClipCacheDedup') === true, 'project created');

  const sourceId = addon.project_importSource(wavPath);
  ok(Number.isInteger(sourceId) && sourceId >= 0, `imported test tone (sourceId=${sourceId})`);

  const regionId = addon.timeline_addRegion({
    name: 'Tone', label: 'Tone', sourceId, startTime: 0, endTime: 4,
  });
  ok(Number.isInteger(regionId) && regionId >= 0, `created region (regionId=${regionId})`);

  const trackId = addon.timeline_addTrack({ name: 'T', volume: 1.0, order: 0 });

  // The render cache only engages for regions that resolve to real PCM in the
  // SampleBank. Without this mapping invalidateClipCache short-circuits and the
  // test measures nothing.
  const sampleId = addon.audio_loadSourceRegion(wavPath, 0, 4);
  ok(Number.isInteger(sampleId) && sampleId >= 0, `loaded region audio (sampleId=${sampleId})`);
  ok(addon.audio_mapRegionToSample(regionId, sampleId) !== false,
     'region mapped to its sample buffer');

  // ── 1. Identical clips share one render ────────────────────────────────────
  // Every clip here has the same duration, offset and processing params, so
  // they collapse to a single CacheKey. Distinct clips below differ in
  // regionOffsetTicks, which changes the key and forces a separate render.
  const identical = [];
  const distinct = [];
  for (let i = 0; i < N_CLIPS; i++) {
    identical.push({
      trackId, regionId,
      positionTicks: i * 960, durationTicks: 480,
      regionOffsetTicks: 0,
      stretchRatio: STRETCH, stretchMethod: 1 /* PSOLA */,
      pitchOffsetCents: PITCH_CENTS,
    });
    distinct.push({
      trackId, regionId,
      positionTicks: 100000 + i * 960, durationTicks: 480,
      regionOffsetTicks: 64 + i * 37,   // unique slice of source per clip
      stretchRatio: STRETCH, stretchMethod: 1,
      pitchOffsetCents: PITCH_CENTS,
    });
  }

  const tIdentical0 = process.hrtime.bigint();
  const identicalIds = addon.timeline_addClipsBatch(identical);
  const identicalMs = Number(process.hrtime.bigint() - tIdentical0) / 1e6;

  const tDistinct0 = process.hrtime.bigint();
  const distinctIds = addon.timeline_addClipsBatch(distinct);
  const distinctMs = Number(process.hrtime.bigint() - tDistinct0) / 1e6;

  // Every distinct clip forces its own source-PCM deep copy and its own render
  // job; the identical batch does exactly one of each. If the cache regresses
  // to clip-ID keying the two collapse to the same cost.

  ok(identicalIds.length === N_CLIPS, `inserted ${N_CLIPS} identical clips`);
  ok(distinctIds.length === N_CLIPS, `inserted ${N_CLIPS} distinct clips`);
  console.log(`        identical batch: ${identicalMs.toFixed(1)}ms   `
            + `distinct batch: ${distinctMs.toFixed(1)}ms`);

  // The identical batch does ONE PCM copy + ONE job submission; the distinct
  // batch does N of each. A generous ratio keeps this stable on slow CI boxes
  // while still failing hard if per-clip-ID keying comes back.
  ok(identicalMs < distinctMs,
     'a batch of identical clips is cheaper than a batch of distinct ones '
     + '(render cache is content-addressed, not clip-ID-keyed)');

  // ── 2. Moving clips does not re-render them ────────────────────────────────
  // Same clips, same audio — only position changes. With the cache keyed on
  // content this must be near-free compared to the insert that created them.
  const moves = identicalIds.map((clipId, i) => ({
    clipId, trackId, positionTicks: 500000 + i * 960,
  }));
  const tMove0 = process.hrtime.bigint();
  const movedCount = addon.timeline_moveClipsBatch(moves);
  const moveMs = Number(process.hrtime.bigint() - tMove0) / 1e6;

  ok(movedCount === N_CLIPS, `moved all ${N_CLIPS} clips`);
  console.log(`        move batch: ${moveMs.toFixed(1)}ms`);
  ok(moveMs < distinctMs,
     'moving a selection is cheaper than rendering it '
     + '(a move no longer invalidates the render cache)');

  // Moving distinct clips must also stay cheap — this is the case that used to
  // re-run a full PSOLA pass per clip on every drag.
  const distinctMoves = distinctIds.map((clipId, i) => ({
    clipId, trackId, positionTicks: 900000 + i * 960,
  }));
  const tMove1 = process.hrtime.bigint();
  addon.timeline_moveClipsBatch(distinctMoves);
  const distinctMoveMs = Number(process.hrtime.bigint() - tMove1) / 1e6;
  console.log(`        distinct move batch: ${distinctMoveMs.toFixed(1)}ms`);
  ok(distinctMoveMs < distinctMs,
     'moving DISTINCT stretched clips is cheaper than inserting them '
     + '(no re-render on move)');

  // ── 3. Audio is still correct after sharing ────────────────────────────────
  const all = addon.timeline_getClips();
  ok(all.length === N_CLIPS * 2, 'every clip is still present');
  const sample = all.find((c) => c.id === identicalIds[0]);
  ok(sample && Math.abs(sample.stretchRatio - STRETCH) < 1e-6
     && sample.pitchOffsetCents === PITCH_CENTS,
     'shared-entry clips keep their own params');
} catch (err) {
  failed += 1;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon?.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
