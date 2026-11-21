'use strict';
//
// bridge/test_frame_shm_capacity.js
//
// Regression test for the permanently-dead video preview.
//
// A Windows named section's size is fixed when it is created. Passing a larger
// size to CreateFileMapping for a name that already exists is silently ignored
// — you get the existing object back with ERROR_ALREADY_EXISTS — and the
// reader process (preload.js via shm_helper.node, which has no close) keeps
// that object alive across the engine's own close/re-create. Mapping a view
// larger than the section then fails with ERROR_ACCESS_DENIED (5).
//
// So a session that created the mapping at a reduced previewResolutionScale
// could never grow it again: the first time the auto-resolution governor
// climbed back towards 100%, initVideoSharedMemory threw and the preview was
// dead until the app restarted. Observed in the wild as an endless 2s loop of
//   [FrameOutput] MapViewOfFile failed: 5
//   [VideoPreview] Resolution reconcile poll failed: ... initSharedMemory failed
//
// The fix: size the SECTION for the capacity (100% scale) once and let
// width/height move the live frame around inside it. This test locks in that
// the section never resizes and that a grow with a reader attached succeeds.
//

const fs = require('fs');
const path = require('path');

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
  path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/debug/bin'),
  path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin'),
].filter((dir) => fs.existsSync(dir));
process.env.PATH = `${dllDirs.join(';')};${process.env.PATH}`;
process.env.XLETH_BRIDGE_DISABLE_PREVIEW_GPU = '1';

const addon = require(native.addonPath);

// The reader half. Optional: without it the section is never pinned, which is
// the precondition for the bug, so those cases report as skipped rather than
// passing vacuously.
let shmHelper = null;
for (const config of ['Release', 'Debug']) {
  const p = path.resolve(__dirname, '../shm_helper/build', config, 'shm_helper.node');
  if (fs.existsSync(p)) { shmHelper = require(p); break; }
}

// Must match FRAME_SHM_BASE_W/H in ui/main.js and BASE_CANVAS_W/H in
// ui/src/components/VideoPreview.jsx — previewResolutionScale is a fraction
// OF this, so it is the largest frame the preview can ever ask for.
const BASE_W = 960;
const BASE_H = 540;
const CONTROL_BYTES = 64;

const sectionBytes = (w, h) => w * h * 4 * 2 + CONTROL_BYTES;

let passed = 0;
let failed = 0;
let skipped = 0;

function ok(condition, label) {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function skip(label, why) {
  console.log(`  SKIP  ${label} (${why})`);
  skipped += 1;
}

function main() {
  addon.initialize();

  const name = `XlethFrameBufferTest_${process.pid}`;

  // ── 1. Born small, as a laptop restoring a persisted 0.75 scale does ──────
  const small = addon.initVideoSharedMemory(name, 720, 405, BASE_W, BASE_H);
  ok(small.width === 720 && small.height === 405, 'live frame is 720x405');
  ok(small.totalSize === sectionBytes(BASE_W, BASE_H),
     `section is sized for ${BASE_W}x${BASE_H}, not the live frame`);
  ok(small.indexOffset === 720 * 405 * 4 * 2, 'indexOffset follows the LIVE frame');
  ok(small.bufferSize === 720 * 405 * 4, 'bufferSize is the LIVE frame');
  ok(small.capacityBufferSize === BASE_W * BASE_H * 4,
     'capacityBufferSize is one half of the section');

  // ── 2. A reader pins the section, exactly as preload.js does ─────────────
  let handle = null;
  let dst = null;
  if (shmHelper) {
    handle = shmHelper.openSharedMemory(small.name, small.totalSize);
    ok(handle >= 0, 'reader mapped the section at capacity');
    dst = new Uint8Array(small.capacityBufferSize);
  } else {
    skip('reader mapped the section at capacity', 'shm_helper.node not built');
  }

  // ── 3. Grow while the reader holds it. THIS is the regression. ───────────
  let grown = null;
  try {
    grown = addon.initVideoSharedMemory(name, BASE_W, BASE_H, BASE_W, BASE_H);
    ok(true, 'grow 720x405 -> 960x540 with a reader attached');
  } catch (e) {
    ok(false, `grow 720x405 -> 960x540 with a reader attached (${e.message})`);
  }

  if (grown) {
    ok(grown.totalSize === small.totalSize, 'section size unchanged across the reframe');
    ok(grown.indexOffset === BASE_W * BASE_H * 4 * 2,
       'indexOffset moved to the grown frame');

    // The view the reader opened before the grow must still cover the frame.
    // If bufA/bufB were sized by bufferSize instead of capacityBufferSize,
    // readBytes would throw "out of range" here.
    if (shmHelper) {
      try {
        shmHelper.readInt32(handle, grown.indexOffset);
        shmHelper.readBytes(handle, dst, grown.bufferSize, grown.bufferSize);
        ok(true, 'the pre-existing reader view still covers the grown frame');
      } catch (e) {
        ok(false, `the pre-existing reader view still covers the grown frame (${e.message})`);
      }
    } else {
      skip('the pre-existing reader view still covers the grown frame', 'shm_helper.node not built');
    }
  }

  // ── 4. And back down, the direction that always worked ───────────────────
  try {
    const shrunk = addon.initVideoSharedMemory(name, 480, 270, BASE_W, BASE_H);
    ok(shrunk.totalSize === small.totalSize, 'shrink to 480x270 also leaves the section alone');
    if (shmHelper) shmHelper.readBytes(handle, dst, shrunk.bufferSize, shrunk.bufferSize);
  } catch (e) {
    ok(false, `shrink back to 480x270 still works (${e.message})`);
  }

  // ── 5. Asking for more than the section holds must fail loudly, not
  //       corrupt the mapping ────────────────────────────────────────────────
  let threw = false;
  try { addon.initVideoSharedMemory(name, 1920, 1080, BASE_W, BASE_H); }
  catch (_) { threw = true; }
  ok(threw, 'a frame larger than the section capacity is rejected');

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  process.exit(failed ? 1 : 0);
}

main();
