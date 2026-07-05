'use strict';

// Extracted from ui/main.js (S5 Stage 5 decomposition). Beta-tester-friendly
// .txt export of the live preview / grid pipeline state, plus the six-stage
// pixel-content verification helpers. Pure report-building functions live at
// module scope; the single xleth:diag:exportVisualPreviewLog handler registers
// inside init(). Engine state via ./worker; persisted videoMode via ./settings.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { callWorker } = require('./worker');
const { loadSettings } = require('./settings');
const { userDataPath } = require('../runtimePaths');

let getWin = () => null;

// ─── Visual Preview Diagnostic Log ──────────────────────────────────────────
// Beta-tester-friendly .txt export of the live preview / grid pipeline state.
// Triggered from Settings → Graphics. The renderer passes `extras` containing:
//   - preview:    snapshot of window.__xlethVisualPreviewDiag (the AUTHORITATIVE
//                 state of the live preview canvas, or null if VideoPreview
//                 has not mounted yet)
//   - proxyWebgl: a fresh WebGL context created from the SettingsPanel; only
//                 a *proxy* for the live preview canvas's adapter (Chromium
//                 *usually* shares the GPU process but it is not guaranteed)
// The main process pulls engine state via the diag_getVisualPreviewDiagnostic
// N-API call, formats a plain-text report, and writes it via showSaveDialog
// (or falls back to the user-data folder if the dialog is unavailable).
function pad2(n) { return String(n).padStart(2, '0'); }
function diagnosticTimestamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
function fmtVendorHex(n) {
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return '0x' + n.toString(16).toUpperCase().padStart(4, '0');
}
function fmtHex(n) {
  if (!Number.isFinite(n)) return 'n/a';
  return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
}
function fmtBool(b) { return b ? 'yes' : 'no'; }
function fmtKVLines(obj, indent = '  ') {
  const lines = [];
  for (const [k, v] of Object.entries(obj || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      lines.push(`${indent}${k}:`);
      lines.push(fmtKVLines(v, indent + '  '));
    } else {
      lines.push(`${indent}${k}: ${v == null ? 'n/a' : v}`);
    }
  }
  return lines.join('\n');
}

// ── Pixel-content verification helpers ───────────────────────────────────────
// The six stages are sourced from two places: native stages come from the
// engine N-API snapshot (engine.pixelStats array); renderer stages come from
// the live preview canvas (extras.preview.pixelStats object). This merges both
// into one stage→{observed, sampleCount, latest} lookup the section can render.
const PIXEL_STAGE_ORDER = [
  'post-d3d11-readback',
  'pre-frameoutput-write',
  'post-frameoutput-write',
  'renderer-pre-webgl-upload',
  'renderer-post-webgl-readpixels',
  'export-pre-encode',
];

function buildPixelStageLookup(engine, preview) {
  const lookup = {};
  // Native (array of rows)
  if (engine && Array.isArray(engine.pixelStats)) {
    for (const row of engine.pixelStats) {
      if (row && row.stage) {
        lookup[row.stage] = {
          observed: !!row.observed,
          sampleCount: row.sampleCount || 0,
          dumpCount: row.dumpCount || 0,
          latest: row.latest || null,
          source: 'native',
        };
      }
    }
  }
  // Renderer (object keyed by stage)
  if (preview && preview.pixelStats && typeof preview.pixelStats === 'object') {
    for (const [stage, v] of Object.entries(preview.pixelStats)) {
      if (!v) continue;
      lookup[stage] = {
        observed: !!v.observed,
        sampleCount: v.sampleCount || 0,
        dumpCount: 0,
        latest: v.latest || null,
        source: 'renderer',
      };
    }
  }
  return lookup;
}

// Classify a stage row: 'non-zero' | 'all-zero' | 'not-sampled' | 'failed'.
function interpretPixelStage(entry) {
  if (!entry || !entry.observed) return 'not-sampled';
  const s = entry.latest;
  if (!s || !s.observed || !s.width || !s.height) return 'failed';
  return (s.nonZeroPixels > 0) ? 'non-zero' : 'all-zero';
}

function fmtPixelArr(a) {
  return Array.isArray(a) ? `[${a.join(', ')}]` : 'n/a';
}

function buildVisualPreviewDiagnosticText({ engine, extras, settings, gpuInfo }) {
  const ts = new Date();
  const out = [];
  const sep = '─'.repeat(72);

  out.push('Xleth — Visual Preview Diagnostic Log');
  out.push(sep);
  out.push(`Generated:        ${ts.toISOString()}`);
  out.push(`App version:      ${app.getVersion ? app.getVersion() : 'unknown'}`);
  out.push(`Electron:         ${process.versions.electron || 'n/a'}`);
  out.push(`Chrome:           ${process.versions.chrome || 'n/a'}`);
  out.push(`Node:             ${process.versions.node || 'n/a'}`);
  out.push(`OS:               ${os.type()} ${os.release()} (${os.arch()})`);
  out.push(`OS platform:      ${process.platform}`);
  out.push(`CPU:              ${(os.cpus()[0] || {}).model || 'n/a'} × ${os.cpus().length}`);
  out.push(`Total memory:     ${(os.totalmem() / (1024 * 1024)).toFixed(0)} MB`);
  out.push(`Free memory:      ${(os.freemem() / (1024 * 1024)).toFixed(0)} MB`);
  out.push(`Portable EXE:     ${app.isPackaged ? 'yes' : 'no (dev build)'}`);
  out.push('');

  // ── 1. System / adapter ────────────────────────────────────────────────
  out.push('1. SYSTEM / ADAPTER');
  out.push(sep);
  const adapters = (engine && engine.adapters) || [];
  if (!adapters.length) {
    out.push('  (no adapters reported by engine — DXGI enumeration failed or engine not initialized)');
  } else {
    out.push(`  Detected ${adapters.length} DXGI adapter(s). Active index: ${engine.activeAdapterIndex}`);
    adapters.forEach((a, i) => {
      out.push(`  [${i}] ${a.vendor} — ${a.name}`);
      out.push(`        vendorId=${fmtVendorHex(a.vendorId)} deviceId=${fmtVendorHex(a.deviceId)}`);
      const luid = (a.luidHighPart != null && a.luidLowPart != null)
        ? `${a.luidHighPart.toString(16).toUpperCase().padStart(8, '0')}:${a.luidLowPart.toString(16).toUpperCase().padStart(8, '0')}`
        : 'unavailable';
      out.push(`        LUID=${luid}  (compare against UNMASKED_RENDERER_WEBGL to confirm same adapter)`);
      const shared = (a.sharedSystemMemoryMB == null)
        ? 'unavailable'
        : `${a.sharedSystemMemoryMB} MB`;
      out.push(`        VRAM(dedicated)=${a.vramMB} MB  shared=${shared}`);
      out.push(`        discrete=${fmtBool(a.isDiscrete)}  default=${fmtBool(a.isDefault)}  index=${a.index}`);
    });
  }
  out.push(`  D3D11 device created: ${fmtBool(engine && engine.hasD3D11Device)}`);
  if (engine) {
    out.push(`  D3D feature level:    ${engine.activeFeatureLevel || 'n/a'}`);
    out.push(`  Device type:          ${engine.deviceIsWarp ? 'WARP (software rasterizer — XLETH_D3D11_WARP)' : 'hardware'}`);
    out.push(`  D3D11 debug layer:    ${fmtBool(engine.debugLayerActive)}`);
  }
  out.push(`  Engine compositor backend: D3D11 (GridCompositor) — NOT OpenGL`);
  out.push(`  Renderer (Electron preview canvas) backend: WebGL / Canvas2D`);
  out.push(`  Video encode/decode mode (requested): ${(settings && settings.videoMode) || 'auto'}`);
  // Electron's own GPU view — a third independent signal (engine DXGI list and
  // renderer WebGL unmasked-renderer are the other two). Useful when Chromium
  // falls back to a different adapter than the engine's D3D11 device.
  out.push('');
  out.push('  Electron app.getGPUInfo(\'basic\'):');
  if (!gpuInfo) {
    out.push('    (unavailable)');
  } else if (gpuInfo.error) {
    out.push(`    ✗ getGPUInfo failed: ${gpuInfo.error}`);
  } else {
    const gpus = (gpuInfo.gpuDevice && Array.isArray(gpuInfo.gpuDevice)) ? gpuInfo.gpuDevice : [];
    if (!gpus.length) {
      out.push('    (no gpuDevice entries reported)');
    } else {
      gpus.forEach((g, i) => {
        out.push(`    [${i}] vendorId=${fmtVendorHex(g.vendorId)} deviceId=${fmtVendorHex(g.deviceId)}` +
          `${g.active ? ' ACTIVE' : ''}${g.driverVendor ? ` driverVendor=${g.driverVendor}` : ''}` +
          `${g.driverVersion ? ` driverVersion=${g.driverVersion}` : ''}`);
      });
    }
    if (gpuInfo.auxAttributes && gpuInfo.auxAttributes.glRenderer) {
      out.push(`    glRenderer: ${gpuInfo.auxAttributes.glRenderer}`);
    }
  }
  out.push('');

  // ── 2. Known-good video paths ──────────────────────────────────────────
  out.push('2. KNOWN-GOOD VIDEO PATHS');
  out.push(sep);
  out.push('  Sample Selector preview:    Chromium <video> element via local HTTP server');
  out.push('                              → bypasses native GridCompositor + shared memory entirely.');
  out.push('  Imported-video popup:       Chromium <video> element');
  out.push('                              → bypasses native GridCompositor + shared memory entirely.');
  out.push('  ⚠ A working Chromium video element does NOT prove the native GridCompositor');
  out.push('    or the shared-memory → WebGL preview pipeline is working. Those use entirely');
  out.push('    different code paths (D3D11 composite + Win32 named file mapping + WebGL).');
  out.push('');

  // ── 3. Main preview / grid pipeline state ──────────────────────────────
  out.push('3. MAIN PREVIEW / GRID PIPELINE');
  out.push(sep);
  if (!engine) {
    out.push('  (engine state unavailable — diag_getVisualPreviewDiagnostic returned nothing)');
  } else {
    out.push(`  compositorReady:        ${fmtBool(engine.compositorReady)}`);
    out.push(`  compositorPresent:      ${fmtBool(engine.compositorPresent)}`);
    out.push(`  decoderPresent:         ${fmtBool(engine.decoderPresent)}`);
    out.push(`  collectorPresent:       ${fmtBool(engine.collectorPresent)}`);
    out.push(`  renderCachePresent:     ${fmtBool(engine.renderCachePresent)}`);
    out.push(`  animMgrPresent:         ${fmtBool(engine.animMgrPresent)}`);
    out.push(`  pauseForExport:         ${fmtBool(engine.pauseForExport)}`);
    out.push(`  pauseForVisibility:     ${fmtBool(engine.pauseForVisibility)}`);
    out.push(`  previewResolutionScale: ${engine.previewResolutionScale}`);
    out.push(`  previewEffectsBypass:   ${fmtBool(engine.previewEffectsBypass)}`);
    if (engine.gridLayout) {
      out.push(`  Grid layout:            ${engine.gridLayout.columns} cols × ${engine.gridLayout.rows} rows @ ${engine.gridLayout.previewFps} fps  gapScale=${engine.gridLayout.gapScale}`);
    }
    if (engine.lastTick) {
      const lt = engine.lastTick;
      out.push(`  Last tick:              ${lt.requestCount} cell requests, ${lt.decodeMissCount} decode misses`);
      out.push('');
      out.push('  TIMELINE / COLLECTOR CONTENT (latest preview tick):');
      out.push(`    Preview time used:        ${lt.previewTimeMs != null ? (lt.previewTimeMs / 1000).toFixed(3) + ' s' : 'unavailable'}`);
      out.push(`    Active visual events:     ${lt.activeVisualEvents != null ? lt.activeVisualEvents : 'unavailable'}  (events fed to the collector)`);
      out.push(`    Project has visual events:${lt.activeVisualEvents != null ? (lt.activeVisualEvents > 0 ? ' yes' : ' NO — nothing to render') : ' unavailable'}`);
      out.push(`    Cells requested:          ${lt.requestCount}  (final compositor input count)`);
      out.push(`    Unique decode keys:       ${lt.dedupKeyCount != null ? lt.dedupKeyCount : 'unavailable'}  (after dedup)`);
      out.push(`    Cache hits:               ${lt.cacheHitCount != null ? lt.cacheHitCount : 'unavailable'}`);
      out.push(`    Decode requests (misses): ${lt.decodeMissCount}`);
      out.push(`    Decode successes:         ${lt.decodeSuccessCount != null ? lt.decodeSuccessCount : 'unavailable'}`);
      out.push(`    Decode failures:          ${lt.decodeFailCount != null ? lt.decodeFailCount : 'unavailable'}`);
      out.push(`    Cells skipped (+reason):  unavailable — collectRequests does not currently`);
      out.push(`                              expose a per-cell skip/reject reason list`);
      out.push(`    Paused for export:        ${fmtBool(engine.pauseForExport)}`);
      out.push(`    Paused for visibility:    ${fmtBool(engine.pauseForVisibility)}`);
      if (lt.requestCount === 0) {
        out.push('    ⚠ 0 cells requested → the collector found NO visual content at this');
        out.push('      timeline position. If the project DOES have video on the grid, the');
        out.push('      compositor is rendering an empty (black) scene — the pixels are');
        out.push('      genuinely zero at the source, not lost in transport. This matches a');
        out.push('      PIXEL CONTENT VERIFICATION reading of all-zero at post-d3d11-readback.');
      }
    }
  }
  out.push('');

  // ── 4. Native compositor / readback ────────────────────────────────────
  out.push('4. NATIVE COMPOSITOR (D3D11 GridCompositor)');
  out.push(sep);
  if (engine && engine.lastTick) {
    out.push(`  Init dimensions:        ${engine.lastTick.initWidth} × ${engine.lastTick.initHeight}`);
    out.push(`  Compositor RT:          ${engine.lastTick.compositorWidth} × ${engine.lastTick.compositorHeight}`);
    out.push(`  Last readback:          ${engine.lastTick.readbackWidth} × ${engine.lastTick.readbackHeight}`);
    out.push(`  lastReadbackHRESULT:    ${fmtHex(engine.lastTick.lastReadbackHRESULT)} (${engine.lastTick.lastReadbackHRESULTText})`);
    out.push(`  lastReadbackFailureStage: ${engine.lastTick.lastReadbackFailureStage || 'n/a'}`);
    out.push(`  deviceRemovedReason:    ${fmtHex(engine.lastTick.deviceRemovedReason)} (${engine.lastTick.deviceRemovedReasonText})`);
    out.push(`  Map type / flags:       ${engine.lastTick.readbackMapType} / ${fmtHex(engine.lastTick.readbackMapFlags)}`);
    out.push(`  Map RowPitch:           ${engine.lastTick.mappedRowPitch}`);
    out.push(`  expected bytes:         ${engine.lastTick.expectedBytes}`);
    out.push(`  actual copy bytes:      ${engine.lastTick.actualCopyBytes}`);
    out.push(`  source/staging dimensions match: ${fmtBool(engine.lastTick.sourceStagingDimensionsMatch)}`);
    if (engine.lastTick.sourceTexture) {
      const s = engine.lastTick.sourceTexture;
      out.push(`  Source texture:         ${s.width} × ${s.height} fmt=${s.format} samples=${s.sampleCount}`);
    }
    if (engine.lastTick.stagingTexture) {
      const s = engine.lastTick.stagingTexture;
      out.push(`  Staging texture:        ${s.width} × ${s.height} fmt=${s.format} usage=${s.usage} cpu=${fmtHex(s.cpuAccessFlags)} bind=${fmtHex(s.bindFlags)} misc=${fmtHex(s.miscFlags)} samples=${s.sampleCount}`);
    }
  }
  if (engine && engine.counters) {
    const c = engine.counters;
    out.push(`  Video tick count:           ${c.videoTickCount}`);
    out.push(`  Compositor path entered:    ${c.compositorPathEntered}`);
    // ── Render-gate per-term truth counts ────────────────────────────────────
    // Each counter increments once per tick when that gate sub-condition is true,
    // evaluated independently so short-circuit doesn't hide the false term.
    // Whichever counter is ~0 (vs videoTickCount) is the term shutting the gate.
    const vtc = c.videoTickCount || 1; // avoid divide-by-zero
    const pct = (n) => `${(((n || 0) / vtc) * 100).toFixed(1)}%`;
    out.push(`  gateIsPlayingTrueTicks:     ${c.gateIsPlayingTrueTicks || 0}  (${pct(c.gateIsPlayingTrueTicks)} of video ticks)`);
    out.push(`  gateEventsNonEmptyTicks:    ${c.gateEventsNonEmptyTicks || 0}  (${pct(c.gateEventsNonEmptyTicks)} of video ticks)`);
    out.push(`  gateForceRenderTicks:       ${c.gateForceRenderTicks || 0}  (${pct(c.gateForceRenderTicks)} of video ticks)`);
    out.push(`  gatePreviewPausedTicks:     ${c.gatePreviewPausedTicks || 0}  (${pct(c.gatePreviewPausedTicks)} of video ticks)`);
    out.push(`  gateBlockReachedTicks:      ${c.gateBlockReachedTicks || 0}  (${pct(c.gateBlockReachedTicks)} of video ticks)`);
    out.push(`  gateBlockSkippedNoInit:     ${c.gateBlockSkippedNoInit || 0}  (${pct(c.gateBlockSkippedNoInit)} of video ticks)`);
    out.push(`  compositeFrame() calls:     ${c.compositeFrameCount}`);
    out.push(`  readback() valid:           ${c.readbackValidCount}`);
    out.push(`  readback() not-ready:       ${c.readbackNotReadyCount || 0}`);
    out.push(`  readback() invalid (fatal): ${c.readbackInvalidCount}`);
    out.push(`  Canvas copy count:          ${c.canvasCopyCount}`);
    out.push(`  Black frames written:       ${c.blackFrameCount}`);
    out.push(`  Compositor init failures:   ${c.compositorInitFailures}`);
    const policyStr = c.readbackPolicyActive === 1 ? 'AsyncQueued' : 'FastImmediate';
    const switchReasonMap = {0:'none', 1:'fatal-invalids', 2:'map-stall-too-slow', 3:'poor-yield'};
    out.push(`  Readback policy:            ${policyStr}`);
    out.push(`  Policy switch reason:       ${switchReasonMap[c.readbackPolicySwitchReason || 0] || 'unknown'}`);
    out.push(`  Dropped pending frames:     ${c.droppedPendingFrames || 0}`);
    out.push(`  Pending slots (ring):       ${c.pendingSlotsCount || 0}`);
    out.push(`  Last readback:              ${((c.lastReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push(`  Avg readback (60-frame):    ${((c.avgReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push(`  Max readback:               ${((c.maxReadbackUs||0)/1000).toFixed(2)} ms`);
    out.push('');
    out.push('  Interpretation:');
    const notReady = c.readbackNotReadyCount || 0;
    const policy    = c.readbackPolicyActive === 1 ? 'AsyncQueued' : 'FastImmediate';
    const dropped   = c.droppedPendingFrames || 0;
    const avgMs     = (c.avgReadbackUs || 0) / 1000;
    if (c.compositeFrameCount === 0 && c.compositorPathEntered === 0) {
      out.push('    ✗ Compositor path never entered — engine in CPU fallback or paused.');
    } else if (c.compositeFrameCount === 0) {
      out.push('    ✗ Path entered but compositeFrame() never called — compositor not initialized.');
    } else if (c.readbackInvalidCount > 0) {
      out.push(`    ✗ FATAL readback failures (${c.readbackInvalidCount}). Check HRESULT/stage/deviceRemovedReason.`);
    } else if (policy === 'FastImmediate' && c.canvasCopyCount > 0) {
      const msNote = avgMs > 0 ? ` (avg ${avgMs.toFixed(2)} ms/frame)` : '';
      out.push(`    ✓ FastImmediate healthy — blocking Map, no DO_NOT_WAIT.${msNote}`);
      out.push(`      canvasCopyCount=${c.canvasCopyCount} confirms frames reach the canvas.`);
    } else if (policy === 'AsyncQueued' && c.readbackValidCount > 0) {
      const dropNote = dropped > 0
        ? ` (${dropped} ring drops — GPU behind tick rate)`
        : ' (no ring drops)';
      out.push(`    ✓ AsyncQueued healthy — ring serving valid frames.${dropNote}`);
      out.push(`      FastImmediate switched away: reason=${switchReasonMap[c.readbackPolicySwitchReason||0]||'?'}`);
    } else if (policy === 'AsyncQueued' && notReady > 0 && c.readbackValidCount === 0) {
      out.push('    ⚠ AsyncQueued: ring still priming (notReady ticks, no valid yet).');
      out.push('      Normal for first few frames; if it persists, check GPU load.');
    } else if (c.canvasCopyCount === 0 && c.readbackValidCount > 0) {
      out.push('    ✗ Readback valid but no canvas copy — frameOutput.getBackBuffer() returning null.');
    } else {
      out.push(`    ✓ Engine readback healthy (policy=${policy}).`);
      out.push('      If preview is still blank, inspect section 5 delivery/WebGL counters.');
    }
  }
  out.push('');

  // ── 4b. Preview tick stage timing ──────────────────────────────────────
  // Per-stage wall-clock breakdown of the preview video-thread tick, measured
  // in the engine (instrumentation only). Locates the dominant cost when the
  // preview underperforms despite a fast readback / zero decode misses.
  out.push('4b. PREVIEW TICK STAGE TIMING (per-stage wall clock, video thread)');
  out.push(sep);
  if (engine && engine.counters) {
    const c = engine.counters;
    const ms = (us) => ((us || 0) / 1000).toFixed(3);
    const row = (label, last, avg, max) =>
      out.push(`  ${label.padEnd(22)} last ${ms(last).padStart(8)} ms   avg ${ms(avg).padStart(8)} ms   max ${ms(max).padStart(8)} ms`);
    row('1. collectRequests',   c.lastCollectUs,   c.avgCollectUs,   c.maxCollectUs);
    row('2. dedup + resolve',   c.lastResolveUs,   c.avgResolveUs,   c.maxResolveUs);
    row('3. decode-miss loop',  c.lastDecodeUs,    c.avgDecodeUs,    c.maxDecodeUs);
    row('4. compositeFrame',    c.lastCompositeUs, c.avgCompositeUs, c.maxCompositeUs);
    row('5. readback',          c.lastReadbackUs,  c.avgReadbackUs,  c.maxReadbackUs);
    row('6. swizzle+shm copy',  c.lastSwizzleUs,   c.avgSwizzleUs,   c.maxSwizzleUs);
    row('7. WHOLE TICK',        c.lastTickUs,      c.avgTickUs,      c.maxTickUs);
    out.push('');
    out.push(`  Delivered FPS (real 1s window): ${c.deliveredFps || 0}`);
    out.push(`  Active cells this tick:         ${c.lastCellCount || 0} (peak ${c.maxCellCount || 0})`);
    out.push('');
    out.push('  Note: avg = trailing 60-sample window per stage; the readback avg uses');
    out.push('        a ~1s wallclock window (shared with the readback-policy health gate).');
    out.push('        Stages 1–6 are exclusive slices of the tick; their sum ≈ stage 7.');
    out.push('        Delivered FPS counts frames actually written to the shm back buffer');
    out.push('        per real second — NOT playhead time — so stalls show as a low number.');
  } else {
    out.push('  (no engine counters — preview tick has not run)');
  }
  out.push('');

  // ── 5. Preview delivery to Electron / WebGL ────────────────────────────
  out.push('5. PREVIEW DELIVERY (shared memory → WebGL canvas)');
  out.push(sep);
  if (engine) {
    out.push(`  Engine side:`);
    out.push(`    FrameOutput initialized:    ${fmtBool(engine.frameOutputInitialized)}`);
    out.push(`    FrameOutput dimensions:     ${engine.frameOutputWidth} × ${engine.frameOutputHeight}`);
    out.push(`    FrameOutput buffer size:    ${engine.frameOutputBufferSize} bytes (per half)`);
    out.push(`    FrameOutput current index:  ${engine.frameOutputCurrentIndex} (0 or 1; should change as engine swaps)`);
    out.push(`    Shared-memory name:         ${FRAME_SHM_NAME}`);
  }
  out.push('');

  // ── 5a. Live preview canvas (authoritative renderer state) ─────────────
  out.push('  Renderer side — LIVE PREVIEW CANVAS (authoritative):');
  const preview = extras && extras.preview;
  if (!preview) {
    out.push('    ⚠ VideoPreview component never mounted (or not visible since launch).');
    out.push('      The renderer has not exposed any state for the main preview canvas.');
    out.push('      Re-trigger this export AFTER the preview panel has been visible at least once.');
  } else {
    out.push(`    mode (component reports):   ${preview.mode}`);
    out.push(`    drawApi:                    ${preview.drawApi}  (webgl | canvas2d | none)`);
    out.push(`    last tick action:           ${preview.lastTickAction}  (frame | no-frame | upload-failed | no-shm | none)`);
    out.push(`    last tick:                  ${preview.lastTickAtMsAgo == null ? 'n/a' : preview.lastTickAtMsAgo + ' ms ago'}`);
    out.push(`    shm opened:                 ${fmtBool(preview.shm && preview.shm.opened)}`);
    out.push(`    shm name:                   ${preview.shm && preview.shm.name || 'n/a'}`);
    out.push(`    shm open error:             ${preview.shm && preview.shm.error || 'none'}`);
    out.push(`    last shm index seen:        ${preview.shm && preview.shm.lastIndex}`);
    out.push(`    frames received:            ${preview.shm && preview.shm.framesReceived}`);
    out.push(`    last frame dimensions:      ${preview.shm && preview.shm.lastFrameW} × ${preview.shm && preview.shm.lastFrameH}`);
    out.push(`    texture upload success:     ${preview.texUploadSuccess}`);
    out.push(`    texture upload failures:    ${preview.texUploadFailures}`);
    out.push(`    last texture upload error:  ${preview.lastTexUploadError || 'none'}`);
    out.push(`    WebGL context lost count:   ${preview.contextLostCount}`);
    out.push(`    WebGL context restored:     ${preview.contextRestoredCount}`);
    if (preview.clearColorRgb) {
      const [r, g, b] = preview.clearColorRgb;
      out.push(`    Last fallback clear color:  rgb(${(r*255)|0}, ${(g*255)|0}, ${(b*255)|0})  (this is what fills the canvas when no frame is accepted)`);
    } else {
      out.push(`    Last fallback clear color:  not yet set (drawNoVideo never called) — canvas may show its CSS background`);
    }
    out.push('');
    out.push('    WebGL context info (FROM THE ACTUAL LIVE PREVIEW CANVAS):');
    if (preview.webgl && !preview.webgl.error) {
      const w = preview.webgl;
      out.push(`      GL_VENDOR:                ${w.vendor || 'n/a'}`);
      out.push(`      GL_RENDERER:              ${w.renderer || 'n/a'}`);
      out.push(`      GL_VERSION:               ${w.version || 'n/a'}`);
      out.push(`      GL_SHADING_LANGUAGE_VER:  ${w.glsl || 'n/a'}`);
      out.push(`      UNMASKED_VENDOR_WEBGL:    ${w.unmaskedVendor || 'n/a'}`);
      out.push(`      UNMASKED_RENDERER_WEBGL:  ${w.unmaskedRenderer || 'n/a'}`);
      out.push(`      MAX_TEXTURE_SIZE:         ${w.maxTextureSize || 'n/a'}`);
      if (Array.isArray(w.extensions)) {
        out.push(`      Extensions (${w.extensions.length}):`);
        const ext = w.extensions.slice().sort();
        for (let i = 0; i < ext.length; i += 4) {
          out.push('        ' + ext.slice(i, i + 4).join(', '));
        }
      }
    } else if (preview.webgl && preview.webgl.error) {
      out.push(`      ✗ WebGL context creation failed on the live preview canvas: ${preview.webgl.error}`);
    } else {
      out.push('      (no WebGL info captured — likely Canvas2D fallback or context creation failed)');
    }
  }
  out.push('');

  // ── 5b. Proxy WebGL context (settings-tab probe; weaker signal) ────────
  out.push('  Renderer side — PROXY WEBGL PROBE (Settings tab, NOT the live canvas):');
  out.push('    Chromium usually reuses the same GPU process for both contexts, but this is');
  out.push('    NOT guaranteed. Treat this as a backup only — section 5a above is authoritative.');
  const proxy = extras && extras.proxyWebgl;
  if (!proxy) {
    out.push('    (proxy probe data missing)');
  } else if (proxy.error) {
    out.push(`    ✗ Proxy WebGL context creation failed: ${proxy.error}`);
  } else {
    out.push(`    GL_VENDOR:                ${proxy.vendor || 'n/a'}`);
    out.push(`    GL_RENDERER:              ${proxy.renderer || 'n/a'}`);
    out.push(`    GL_VERSION:               ${proxy.version || 'n/a'}`);
    out.push(`    UNMASKED_VENDOR_WEBGL:    ${proxy.unmaskedVendor || 'n/a'}`);
    out.push(`    UNMASKED_RENDERER_WEBGL:  ${proxy.unmaskedRenderer || 'n/a'}`);
    out.push(`    MAX_TEXTURE_SIZE:         ${proxy.maxTextureSize || 'n/a'}`);
  }
  out.push('');

  // ── 5c. Interpretation (only claims things actually backed by data) ────
  out.push('  Interpretation:');
  if (!preview) {
    out.push('    (cannot interpret renderer health — preview was never mounted)');
  } else {
    const engineWroteFrames = engine && engine.counters && engine.counters.canvasCopyCount > 0;
    const rxFrames = preview.shm ? preview.shm.framesReceived : 0;
    const uploadFails = preview.texUploadFailures || 0;
    const uploadOk = preview.texUploadSuccess || 0;

    if (preview.mode === 'no-shm') {
      out.push('    ✗ openFrameShm() returned nothing → shm_helper.node not loaded or preload failed.');
      out.push('      Preview canvas is showing the WebGL clear color (see "fallback clear color" above)');
      out.push('      OR the underlying CSS background — that explains a white/black/themed surface.');
    } else if (preview.mode === 'shm-error') {
      out.push('    ✗ openFrameShm() threw → OpenFileMappingA failed (engine mapping not created yet,');
      out.push('      or FRAME_SHM_NAME mismatch). Same fallback-color story as no-shm above.');
    } else if (rxFrames === 0 && engineWroteFrames) {
      out.push('    ✗ Engine wrote frames but renderer received ZERO. Either the index never changed');
      out.push('      from the renderer\'s view (stale shared-memory mapping?) or the tick loop never ran.');
    } else if (uploadFails > 0 && uploadOk === 0) {
      out.push('    ✗ Every texture upload FAILED — WebGL/Canvas2D rejected the frame data.');
      out.push(`      Last error: ${preview.lastTexUploadError || 'unknown'}`);
      out.push('      Canvas is filled with the WebGL clear color (above) — that is your white/black surface.');
    } else if (preview.contextLostCount > 0) {
      out.push('    ✗ WebGL context was LOST at least once — AMD driver dropped it (often VRAM pressure).');
      out.push('      Once lost, the canvas paints clear color until the context is restored.');
    } else if (rxFrames > 0 && uploadOk > 0) {
      out.push('    ✓ Renderer is receiving frames AND uploading them successfully.');
      out.push('      If the preview is still blank, the engine may be writing all-zero pixels');
      out.push('      (check section 4 readbackValidCount > 0 vs actual pixel content).');
    } else {
      out.push('    (no clear failure pattern — share this report with the dev team for analysis)');
    }
  }
  out.push('');

  // ── 6. Memory / allocation ─────────────────────────────────────────────
  out.push('6. MEMORY / ALLOCATION');
  out.push(sep);
  if (engine) {
    const bytes = engine.frameOutputBufferSize || 0;
    out.push(`  Per-frame buffer:           ${bytes} bytes (${(bytes / (1024 * 1024)).toFixed(2)} MB)`);
    out.push(`  Shared-memory total:        ~${((bytes * 2 + 64) / (1024 * 1024)).toFixed(2)} MB (2 halves + 64-byte control)`);
  }
  out.push(`  Process memory (rss):       ${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)} MB`);
  out.push('  GPU memory pressure:        not directly available from JS — see vendor tooling');
  out.push('                              (Task Manager → Performance → GPU, or GPU-Z)');
  out.push('');

  // ── 7. Pixel content verification ──────────────────────────────────────
  out.push('7. PIXEL CONTENT VERIFICATION');
  out.push(sep);
  const diagFlags = engine && engine.visualDiagFlags;
  const pixelsOn = diagFlags && diagFlags.pixelsEnabled;
  const rendererPixelsOn = preview && preview.pixelDiagEnabled;
  out.push('  This section proves whether REAL non-zero pixels exist at each stage of');
  out.push('  the pipeline — not just that bytes moved. Native readback is BGRA; the');
  out.push('  shared-memory / WebGL stages are RGBA (channel order is labelled per row,');
  out.push('  so do NOT compare first-bytes across formats blindly).');
  out.push('');
  out.push(`  Native pixel diag (XLETH_VISUAL_DIAG_PIXELS):   ${pixelsOn ? 'ON' : 'OFF'}`);
  out.push(`  Renderer pixel diag (same flag, renderer):     ${rendererPixelsOn ? 'ON' : 'OFF'}`);
  if (diagFlags) {
    out.push(`  Raw frame dumps (XLETH_VISUAL_DIAG_DUMP_FRAMES): ${diagFlags.dumpFramesEnabled ? 'ON' : 'OFF'}` +
      ` (max ${diagFlags.maxDumpFramesPerStage}/stage)`);
    if (diagFlags.dumpFramesEnabled && diagFlags.dumpSessionDir) {
      out.push(`  Dump folder: ${diagFlags.dumpSessionDir}`);
    }
  }
  if (!pixelsOn && !rendererPixelsOn) {
    out.push('');
    out.push('  ⚠ Pixel verification was NOT enabled for this run. To capture it:');
    out.push('      1. Close Xleth.');
    out.push('      2. Relaunch with the environment variable XLETH_VISUAL_DIAG_PIXELS=1');
    out.push('         (PowerShell:  $env:XLETH_VISUAL_DIAG_PIXELS=1 ; .\\Xleth.exe )');
    out.push('      3. Open a project WITH visible video, let the preview run a moment,');
    out.push('         start a short export if render also fails, then export this log again.');
  }
  out.push('');

  const pix = buildPixelStageLookup(engine, preview);
  for (const stage of PIXEL_STAGE_ORDER) {
    const entry = pix[stage];
    const verdict = interpretPixelStage(entry);
    out.push(`  ── ${stage} ──`);
    if (!entry) {
      out.push(`     observed:        no`);
      out.push(`     interpretation:  not-sampled (stage never recorded this run)`);
      out.push('');
      continue;
    }
    const s = entry.latest;
    out.push(`     observed:        ${fmtBool(entry.observed)}   (source: ${entry.source})`);
    out.push(`     frames sampled:  ${entry.sampleCount}${entry.dumpCount ? `   raw dumps: ${entry.dumpCount}` : ''}`);
    if (s && s.observed) {
      out.push(`     format:          ${s.format}`);
      out.push(`     dimensions:      ${s.width} × ${s.height}   rowPitch=${s.rowPitch}   bytes=${s.byteCount}`);
      out.push(`     checksum64:      ${s.checksum64}`);
      out.push(`     nonZeroBytes:    ${s.nonZeroBytes}`);
      out.push(`     nonZeroPixels:   ${s.nonZeroPixels} / ${(s.width * s.height) || 0}`);
      out.push(`     averageLuma:     ${typeof s.averageLuma === 'number' ? s.averageLuma.toFixed(3) : s.averageLuma}  (0..255)`);
      out.push(`     first16Bytes:    ${s.first16Bytes}`);
      out.push(`     centerPixel:     ${fmtPixelArr(s.centerPixel)}  (${s.format})`);
      if (Array.isArray(s.corners)) {
        out.push(`     corners TL/TR/BL/BR: ${s.corners.map(fmtPixelArr).join(' ')}`);
      }
    }
    out.push(`     interpretation:  ${verdict}`);
    out.push('');
  }

  // Plain-English cross-stage diagnosis.
  out.push('  PLAIN-ENGLISH INTERPRETATION:');
  const v = (stage) => interpretPixelStage(pix[stage]);
  const readback   = v('post-d3d11-readback');
  const preFO      = v('pre-frameoutput-write');
  const postFO     = v('post-frameoutput-write');
  const preUpload  = v('renderer-pre-webgl-upload');
  const postDraw   = v('renderer-post-webgl-readpixels');
  const exportPre  = v('export-pre-encode');
  const isZero = (x) => x === 'all-zero';
  const isNon  = (x) => x === 'non-zero';

  const lines = [];
  if (isZero(readback) && (isZero(preFO) || preFO === 'not-sampled')) {
    lines.push('  • Native readback is ALL-ZERO → the engine / compositor / timeline is');
    lines.push('    producing EMPTY frames BEFORE shared memory. The transport and WebGL are');
    lines.push('    innocent — look upstream (cell requests / decode / compositor scene).');
  }
  if (isNon(readback) && (isZero(preUpload) || isZero(postFO))) {
    lines.push('  • Native readback is NON-ZERO but the renderer reads ZERO before upload →');
    lines.push('    FrameOutput / shared-memory transport or buffer-index swap mismatch.');
  }
  if (isNon(preUpload) && isZero(postDraw)) {
    lines.push('  • Renderer pre-upload is NON-ZERO but post-WebGL readPixels is ZERO →');
    lines.push('    WebGL upload / draw / presentation issue (texture, context, or driver).');
  }
  if ((isNon(preUpload) || isNon(postDraw)) && isZero(exportPre)) {
    lines.push('  • Preview pixels are NON-ZERO but export-pre-encode is ZERO →');
    lines.push('    the export path diverges from the preview path (black before encode).');
  }
  if (isZero(readback) && isZero(exportPre)) {
    lines.push('  • BOTH preview readback AND export are ALL-ZERO before encode/upload →');
    lines.push('    upstream timeline / collector / compositor content issue (empty scene).');
    lines.push('    Cross-check section 3 "Last tick: N cell requests" — 0 requests means');
    lines.push('    the collector requested no visual cells (see section 3 below/above).');
  }
  if (isNon(readback) && isNon(preUpload) && isNon(postDraw)) {
    lines.push('  • Every sampled stage has NON-ZERO pixels. If the canvas still looks blank,');
    lines.push('    the problem is presentation/compositing AFTER the WebGL draw (CSS, blend,');
    lines.push('    canvas size, or the window compositor) — not the pixel pipeline.');
  }
  if (!lines.length) {
    if (!pixelsOn && !rendererPixelsOn) {
      lines.push('  • No pixel data captured (diagnostic flag was off — see note above).');
    } else {
      lines.push('  • Not enough stages were sampled to draw a cross-stage conclusion.');
      lines.push('    Ensure the preview was visible (and export ran, if render also fails)');
      lines.push('    while XLETH_VISUAL_DIAG_PIXELS=1, then re-export this log.');
    }
  }
  lines.forEach((l) => out.push(l));
  out.push('');

  // ── Footer ─────────────────────────────────────────────────────────────
  out.push(sep);
  out.push('Notes for the developer reading this report:');
  out.push('  • The Sample Selector and the imported-video popup BOTH use Chromium <video>');
  out.push('    elements served via http://127.0.0.1 — they are completely independent of the');
  out.push('    GridCompositor / shared-memory / WebGL pipeline. They working tells you nothing');
  out.push('    about the main preview path.');
  out.push('  • The "Hardware/Software" video mode setting only affects DECODE/ENCODE; it does');
  out.push('    NOT bypass the D3D11 GridCompositor or the WebGL canvas. There is no full CPU');
  out.push('    fallback for the main preview.');
  out.push('  • If section 4 shows readbackValid > 0 and section 5 shows framesReceived === 0,');
  out.push('    the failure is between the engine writing to the file mapping and the renderer');
  out.push('    reading from it — check shm_helper.node load and FRAME_SHM_NAME match.');
  out.push('  • All GPUs start on FastImmediate (blocking Map, no DO_NOT_WAIT, ~0-2ms on NVIDIA).');
  out.push('    If avgReadbackMs>8, fatalInvalids>3, or yield<25% in a 60-frame window,');
  out.push('    the engine auto-switches to AsyncQueued (DO_NOT_WAIT ring, 5 slots).');
  out.push('    D3D11_MAP_FLAG_DO_NOT_WAIT = 0x00100000 (confirmed in readbackMapFlags log).');
  out.push('  • readbackInvalid(fatal)>0 = descriptor/device issue, not GPU latency.');
  out.push('  • readbackNotReady in AsyncQueued = GPU behind tick rate; previous frame stays visible.');
  out.push('  • droppedPendingFrames in AsyncQueued is non-fatal: oldest frame dropped, preview continues.');
  out.push(sep);
  out.push('End of report.');

  return out.join('\n') + '\n';
}


function init(deps) {
  const { safeHandler, log } = deps;
  if (deps && typeof deps.getWin === 'function') getWin = deps.getWin;

  ipcMain.handle('xleth:diag:exportVisualPreviewLog', safeHandler(async (event, extras) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender) || getWin();

    // Pull engine state. Tolerate the engine not being ready — we still
    // want to produce *some* report so the tester can send something.
    let engine = null;
    let engineError = null;
    try {
      engine = await callWorker('diag_getVisualPreviewDiagnostic', []);
    } catch (e) {
      engineError = e && e.message ? e.message : String(e);
      log(`[diag] engine call failed: ${engineError}`);
    }

    // Carry forward the persisted videoMode setting for context.
    let settings = {};
    try { settings = loadSettings() || {}; } catch {}

    // Electron's own view of the GPU (separate from the engine's DXGI list and
    // the renderer's WebGL context — a third independent signal). 'basic' is
    // cheap; tolerate failure so the report still generates.
    let gpuInfo = null;
    try {
      if (app.getGPUInfo) gpuInfo = await app.getGPUInfo('basic');
    } catch (e) {
      gpuInfo = { error: e && e.message ? e.message : String(e) };
    }

    let body = buildVisualPreviewDiagnosticText({ engine, extras, settings, gpuInfo });
    if (engineError) {
      let engineWarning;
      if (engineError === 'notImplemented') {
        engineWarning =
          'WARNING: engine diag returned "notImplemented" — sections 3 and 4 are empty.\n' +
          '\n' +
          'ROOT CAUSE: The packaged xleth_native.node was compiled BEFORE the\n' +
          'diag_getVisualPreviewDiagnostic function was added. The source code is\n' +
          'correct; the binary is stale.\n' +
          '\n' +
          'FIX (developer): Rebuild xleth_native.node:\n' +
          '  cmake --build build --target xleth_native   (or npm run build:addon)\n' +
          'Then repackage the portable EXE. Do NOT send this build to further\n' +
          'testers until the native addon binary is current.\n' +
          '\n' +
          'Sections 1, 2, 5, and 6 below were assembled from renderer-side data\n' +
          'only and are valid regardless of this error.\n';
      } else {
        engineWarning =
          `WARNING: engine diag call failed: ${engineError}\n` +
          `(sections 3 and 4 are empty; all other sections are renderer-side data)\n`;
      }
      body = engineWarning + '\n' + body;
    }

    const fileName = `xleth-visual-preview-diagnostic-${diagnosticTimestamp()}.txt`;

    // Try save dialog first; fall back to the user-data folder if the dialog
    // is unavailable (headless test, dialog cancelled, etc.).
    let savedPath = null;
    let cancelled = false;
    try {
      const defaultPath = path.join(app.getPath('desktop') || app.getPath('home') || '.', fileName);
      const result = await dialog.showSaveDialog(senderWin, {
        title: 'Export Visual Preview Diagnostic',
        defaultPath,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (result.canceled) {
        cancelled = true;
      } else if (result.filePath) {
        fs.writeFileSync(result.filePath, body, 'utf8');
        savedPath = result.filePath;
      }
    } catch (e) {
      log(`[diag] showSaveDialog failed: ${e.message}`);
    }

    if (cancelled) return { cancelled: true };

    if (!savedPath) {
      // Fallback: write to user data folder
      try {
        const fallback = userDataPath(fileName);
        fs.mkdirSync(path.dirname(fallback), { recursive: true });
        fs.writeFileSync(fallback, body, 'utf8');
        savedPath = fallback;
      } catch (e) {
        return { error: `failed to write diagnostic: ${e.message}` };
      }
    }

    log(`[diag] visual preview diagnostic written: ${savedPath}`);
    return { path: savedPath };
  }));

}

module.exports = { init };
