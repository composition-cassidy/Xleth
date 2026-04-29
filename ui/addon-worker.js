'use strict';

// ── Diagnostic A: worker exit reason ─────────────────────────────────────────
// These handlers must be registered before require(addonPath) so they catch
// failures during module load as well as runtime exits.
//   beforeExit fires   → event loop drained naturally (IPC handle unref'd)
//   exit fires only    → process.exit() or C++ exit() bypassed event loop
//   disconnect fires   → parent closed IPC pipe unexpectedly
process.on('beforeExit', (code) => {
    console.error('[Worker] beforeExit code=' + code);
    console.error('[Worker] beforeExit stack:', new Error().stack);
});
process.on('exit', (code) => {
    console.error('[Worker] exit code=' + code);
});
process.on('uncaughtException', (err) => {
    console.error('[Worker] uncaughtException:', err.message);
    console.error('[Worker] stack:', err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Worker] unhandledRejection:', reason);
});
process.on('disconnect', () => {
    console.error('[Worker] disconnect event fired — parent closed IPC pipe');
});

// This script runs as a standalone Node.js child process (child_process.fork)
// for DLL/ABI isolation from Electron's Chromium runtime. The native addon
// links JUCE/FFmpeg/GLEW which crash in-process under Electron.
//
// The zero-copy video path is built on a Windows named file mapping:
// the addon creates it via FrameOutput::initSharedMemory(); the Electron
// main process / preload opens the same name via shm_helper.node.

const path = require('path');
const fs = require('fs');

// Prepend DLL directories so FFmpeg/GLEW/etc DLLs are found.
const dllDir = process.env.XLETH_BRIDGE_DIR;
if (!dllDir) {
  throw new Error('XLETH_BRIDGE_DIR is required; launch addon-worker.js through ui/main.js');
}
const ffmpegDir = process.env.XLETH_FFMPEG_DIR;
const pathEntries = [dllDir];
if (ffmpegDir && fs.existsSync(ffmpegDir)) pathEntries.push(ffmpegDir);
if (process.env.PATH) pathEntries.push(process.env.PATH);
process.env.PATH = pathEntries.join(path.delimiter);

const addonPath = path.join(dllDir, 'xleth_native.node');
const xleth = require(addonPath);

// Listen for messages from the main process via IPC (child_process.fork)
process.on('message', ({ id, method, args }) => {
  try {
    // Guard: if the native addon doesn't export this method yet (e.g. Phase 1
    // functions before cmake-js rebuild), return null silently instead of
    // throwing "xleth[method] is not a function" and flooding the log.
    if (typeof xleth[method] !== 'function') {
      process.send({ id, result: null, notImplemented: true });
      return;
    }

    let result = xleth[method](...(args || []));

    // getFrameRGBA / getCurrentFrame returns { width, height, data: Buffer }.
    // Send pixel data directly — Node.js v8 serialization handles Buffer
    // natively without JSON inflation. No base64 needed.
    if ((method === 'getCurrentFrame' || method === 'getFrameRGBA') && result && result.data) {
      const buf = result.data;
      if (Buffer.isBuffer(buf) && buf.length > 0) {
        process.send({ id, frame: { w: result.width, h: result.height, data: buf } });
        return;
      }
      process.send({ id, result: { width: 0, height: 0 } });
      return;
    }

    // midi_importFull returns { metadata: string, noteData: ArrayBuffer }.
    // ArrayBuffer can't cross the process IPC boundary — convert to Buffer.
    if (method === 'midi_importFull' && result && result.noteData instanceof ArrayBuffer) {
      process.send({ id, result: { metadata: result.metadata, noteData: Buffer.from(result.noteData) } });
      return;
    }

    // midi_executeImport: noteData arrives as a real Buffer because preload.js
    // converts ArrayBuffer/TypedArray to Buffer and the fork uses
    // serialization:'advanced' which preserves Buffer identity across IPC.
    // The addon's IsBuffer check (XlethAddon.cpp) accepts it directly.
    // Return value is undefined → becomes null on the wire below.

    // getFrameBuffer returns ArrayBuffer which can't cross process boundary.
    // Convert to a Buffer copy + metadata for IPC.
    if (method === 'getFrameBuffer' && result && result.buffer) {
      const ab = result.buffer;
      const idxOffset = result.indexOffset;
      const bufSize = result.bufferSize;
      const idxView = new Int32Array(ab, idxOffset, 1);
      const currentIdx = idxView[0];
      const frameData = Buffer.from(new Uint8Array(ab, currentIdx * bufSize, bufSize));
      process.send({ id, frame: { w: result.width, h: result.height, data: frameData } });
      return;
    }

    // Float32Array / TypedArrays lose their type through IPC serialization.
    // Convert to plain Array so .length and indexing work in the renderer.
    if (ArrayBuffer.isView(result) && !Buffer.isBuffer(result)) {
      process.send({ id, result: Array.from(result) });
      return;
    }

    // Plain objects whose fields are TypedArrays (e.g. { post: Float32Array, pre: null })
    // also lose the typed-array type through JSON IPC serialization — numeric-keyed plain
    // objects with no .length arrive on the other side.  Convert each TypedArray field to
    // a plain Array so the renderer can iterate with .length / integer indexing.
    if (result && typeof result === 'object' && !Buffer.isBuffer(result)) {
      let hadTypedArray = false;
      const out = {};
      for (const [k, v] of Object.entries(result)) {
        if (ArrayBuffer.isView(v) && !Buffer.isBuffer(v)) {
          out[k] = Array.from(v);
          hadTypedArray = true;
        } else {
          out[k] = v;
        }
      }
      if (hadTypedArray) {
        process.send({ id, result: out });
        return;
      }
    }

    process.send({ id, result: result === undefined ? null : result });
  } catch (e) {
    process.send({ id, error: e.message });
  }
});

// Signal ready
process.send({ ready: true });
