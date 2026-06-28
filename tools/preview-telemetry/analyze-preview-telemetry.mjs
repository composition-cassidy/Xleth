#!/usr/bin/env node
// analyze-preview-telemetry.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Parses one or more "Xleth — Visual Preview Diagnostic Log" .txt files
// (Settings → Graphics → Export Visual Preview Diagnostic Log) and prints a
// ranked per-stage perf verdict — AND detects the "frozen preview" case where
// the compositor barely runs (a gating/stall bug, not a throughput problem).
//
// Usage:
//   node analyze-preview-telemetry.mjs <file-or-folder> [more files...]
//
// No dependencies. Node 16+ (ESM).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node analyze-preview-telemetry.mjs <file-or-folder> [more...]');
  process.exit(1);
}

function collectFiles(paths) {
  const out = [];
  for (const p of paths) {
    let st;
    try { st = statSync(p); } catch { console.error(`! skip (not found): ${p}`); continue; }
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) {
        if (extname(f).toLowerCase() === '.txt') out.push(join(p, f));
      }
    } else { out.push(p); }
  }
  return out;
}

// Stage timing rows: "  5. readback   last 2.345 ms   avg 3.100 ms   max 12.000 ms"
const STAGE_RE = /^\s*(\d+[a-z]?)\.\s+(.+?)\s{2,}last\s+([\d.]+)\s*ms\s+avg\s+([\d.]+)\s*ms\s+max\s+([\d.]+)\s*ms/i;
const STAGE_LABELS = {
  '1': 'collectRequests', '2': 'dedup + resolve', '3': 'decode-miss loop',
  '4': 'compositeFrame', '5': 'readback', '6': 'swizzle+shm copy', '7': 'WHOLE TICK',
};

function num(re, text, dflt = null) { const m = text.match(re); return m ? Number(m[1]) : dflt; }
function str(re, text, dflt = null) { const m = text.match(re); return m ? m[1].trim() : dflt; }

function parseLog(path) {
  const raw = readFileSync(path, 'utf8');
  const stages = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(STAGE_RE);
    if (m) stages[m[1]] = { id: m[1], label: STAGE_LABELS[m[1]] || m[2].trim(), last: +m[3], avg: +m[4], max: +m[5] };
  }

  const deliveredFps = num(/Delivered FPS \(real 1s window\):\s*([\d.]+)/, raw);
  const cellsM = raw.match(/Active cells this tick:\s*(\d+)\s*\(peak\s*(\d+)\)/);
  const grid = raw.match(/Grid layout:\s*(\d+)\s*cols\s*[×x]?\s*(\d+)\s*rows\s*@\s*([\d.]+)\s*fps/);
  const compRT = raw.match(/Compositor RT:\s*(\d+)\s*[×x]\s*(\d+)/);
  const readbackDim = raw.match(/Last readback:\s*(\d+)\s*[×x]\s*(\d+)/);

  // ── compositor / readback health counters (section 4) ──
  const videoTicks = num(/Video tick count:\s*(\d+)/, raw);
  const compositorEntered = num(/Compositor path entered:\s*(\d+)/, raw);
  const compositeCalls = num(/compositeFrame\(\) calls:\s*(\d+)/, raw);
  const readbackValid = num(/readback\(\) valid:\s*(\d+)/, raw);
  const readbackNotReady = num(/readback\(\) not-ready:\s*(\d+)/, raw);
  const readbackPolicy = str(/Readback policy:\s*(.+?)\s*$/m, raw);
  const policyReason = str(/Policy switch reason:\s*(.+?)\s*$/m, raw);
  const readbackHResult = str(/lastReadbackHRESULT:\s*(.+?)\s*$/m, raw);

  const previewTimeS = num(/Preview time used:\s*([\d.]+)\s*s/, raw);
  const framesReceived = num(/frames received:\s*(\d+)/, raw);
  const lastTickAction = str(/last tick action:\s*([\w-]+)/, raw);
  const isPlayingHint = previewTimeS; // advancing preview time ⇒ playhead moved

  return {
    path, file: basename(path), stages, deliveredFps,
    cells: cellsM ? +cellsM[1] : null, cellsPeak: cellsM ? +cellsM[2] : null,
    targetFps: grid ? +grid[3] : num(/@\s*([\d.]+)\s*fps/, raw),
    cols: grid ? +grid[1] : null, rows: grid ? +grid[2] : null,
    resScale: num(/previewResolutionScale:\s*([\d.]+)/, raw),
    effectsBypass: /previewEffectsBypass:\s*yes/i.test(raw),
    compRT: compRT ? `${compRT[1]}×${compRT[2]}` : null,
    readbackDim: readbackDim ? `${readbackDim[1]}×${readbackDim[2]}` : null,
    decodeMiss: num(/Decode requests \(misses\):\s*(\d+)/, raw),
    cpu: str(/CPU:\s*(.+?)\s*$/m, raw),
    glRenderer: str(/UNMASKED_RENDERER_WEBGL:\s*(.+?)\s*$/m, raw),
    mode: str(/mode \(component reports\):\s*(.+?)\s*$/m, raw),
    videoTicks, compositorEntered, compositeCalls, readbackValid, readbackNotReady,
    readbackPolicy, policyReason, readbackHResult, previewTimeS, framesReceived, lastTickAction,
    poster: posterFromName(basename(path)),
  };
}

function posterFromName(f) {
  const n = f.toLowerCase();
  if (/poster[-_]?on|posteron/.test(n)) return true;
  if (/poster[-_]?off|posteroff/.test(n)) return false;
  return null;
}

// formatting
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
const ms = (v) => (v == null ? '   n/a' : v.toFixed(3));
const bar = (frac, w = 24) => '█'.repeat(Math.max(0, Math.min(w, Math.round(frac * w)))) + '·'.repeat(w - Math.max(0, Math.min(w, Math.round(frac * w))));
const sep = '─'.repeat(78);

function isStalled(d) {
  const lowFps = d.deliveredFps != null && d.deliveredFps < 5;
  const ratio = (d.videoTicks && d.compositorEntered != null) ? d.compositorEntered / d.videoTicks : null;
  const lowRatio = ratio != null && ratio < 0.10;
  return { stalled: lowFps || lowRatio, ratio };
}

function reportOne(d) {
  console.log(sep);
  console.log(`FILE: ${d.file}`);
  console.log(sep);
  const ctx = [];
  if (d.cpu) ctx.push(`CPU ${d.cpu}`);
  if (d.glRenderer) ctx.push(`GPU ${d.glRenderer}`);
  if (ctx.length) console.log('  ' + ctx.join('  |  '));
  const gridStr = (d.cols && d.rows) ? `${d.cols}×${d.rows}` : 'n/a';
  console.log(`  grid ${gridStr}  |  active cells ${d.cells ?? '?'} (peak ${d.cellsPeak ?? '?'})  |  resScale ${d.resScale ?? '?'}  |  effectsBypass ${d.effectsBypass ? 'ON' : 'off'}  |  poster ${d.poster == null ? '?(label file!)' : d.poster ? 'ON' : 'off'}`);
  console.log(`  compositor RT ${d.compRT ?? '?'}  |  readback ${d.readbackDim ?? '?'}  |  preview time ${d.previewTimeS ?? '?'} s  |  mode ${d.mode ?? '?'}`);

  const target = d.targetFps || 30;
  const budget = 1000 / target;
  const whole = d.stages['7'];
  const { stalled, ratio } = isStalled(d);

  console.log('');
  console.log('  PIPELINE HEALTH (cumulative since launch):');
  console.log(`    video ticks ${d.videoTicks ?? '?'}  →  compositor entered ${d.compositorEntered ?? '?'}  →  composite() ${d.compositeCalls ?? '?'}  →  readback valid ${d.readbackValid ?? '?'} (not-ready ${d.readbackNotReady ?? '?'})`);
  console.log(`    frames delivered to renderer: ${d.framesReceived ?? '?'}   |   delivered FPS: ${d.deliveredFps ?? '?'}   |   renderer last action: ${d.lastTickAction ?? '?'}`);
  if (d.readbackPolicy) console.log(`    readback policy: ${d.readbackPolicy}${d.policyReason ? ` (switched: ${d.policyReason})` : ''}   |   last readback HRESULT: ${d.readbackHResult ?? '?'}`);
  if (ratio != null) console.log(`    compositor-entry ratio: ${(ratio * 100).toFixed(2)}% of ticks actually composited`);

  if (stalled) {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════════════════╗');
    console.log('  ║  ⛔ PREVIEW STALLED — this is a GATING/SYNC bug, NOT a throughput wall ║');
    console.log('  ╚══════════════════════════════════════════════════════════════════════╝');
    console.log(`     The compositor ran ${d.compositorEntered ?? '?'} times across ${d.videoTicks ?? '?'} ticks and delivered`);
    console.log(`     ${d.framesReceived ?? '?'} frames (${d.deliveredFps ?? '?'} fps). The video thread is spinning but the`);
    console.log('     render gate is almost always FALSE. Per the engine, the gate is:');
    console.log('         (isPlaying || forceRender) && !events.empty()');
    console.log(`     events is non-empty (visual content present), so the failing term is`);
    console.log('     (isPlaying || forceRender): the preview is NOT being told to render');
    console.log('     during playback. Stage timings below are near-zero precisely BECAUSE');
    console.log('     the tick early-exits — they are not the bottleneck. Fix the gate first.');
    if (d.readbackNotReady && d.readbackValid && d.readbackNotReady >= d.readbackValid) {
      console.log('     SECONDARY: readback not-ready ≥ valid + policy "map-stall-too-slow" →');
      console.log('     the GPU→CPU staging map also stalls on this adapter (fix after the gate).');
    }
    console.log('');
    console.log('  Stage timings (shown for completeness — NOT the bottleneck while stalled):');
  } else {
    console.log('');
    console.log(`  Target ${target} fps → budget ${budget.toFixed(2)} ms/frame  |  delivered ${d.deliveredFps ?? '?'} fps`);
    if (whole) console.log(`  Whole tick avg ${ms(whole.avg)} ms (max ${ms(whole.max)} ms)  →  ${whole.avg > budget ? 'OVER budget — tick is the wall' : 'within budget'}`);
    console.log('');
  }

  const slices = ['1','2','3','4','5','6'].map((id) => d.stages[id]).filter(Boolean);
  if (slices.length) {
    // When stalled, avg≈0 is meaningless; rank by MAX (the cost when it DOES run).
    const key = stalled ? 'max' : 'avg';
    const denom = slices.reduce((a, s) => a + s[key], 0);
    console.log(`  Stage                  avg ms     max ms   ${stalled ? '% of max-tick' : '% of tick'}   share`);
    const ranked = [...slices].sort((a, b) => b[key] - a[key]);
    for (const s of ranked) {
      const frac = denom > 0 ? s[key] / denom : 0;
      console.log(`  ${pad(s.label, 20)} ${padL(ms(s.avg), 8)} ${padL(ms(s.max), 9)} ${padL((frac * 100).toFixed(1) + '%', 11)}  ${bar(frac)}`);
    }
    if (!stalled) {
      const top = ranked[0];
      const frac = denom > 0 ? top.avg / denom : 0;
      console.log('');
      console.log(`  ▶ DOMINANT STAGE: "${top.label}" at ${(frac * 100).toFixed(0)}% of the tick (${ms(top.avg)} ms avg).`);
      console.log(`    ${verdictForStage(top.id, frac)}`);
    } else {
      const top = ranked[0];
      console.log('');
      console.log(`  ▶ When it DOES composite, the costliest stage is "${top.label}" (max ${ms(top.max)} ms).`);
      console.log('    Relevant only after the gate is fixed and frames actually flow.');
    }
  }
  console.log('');
}

function verdictForStage(id, frac) {
  const big = frac > 0.4;
  switch (id) {
    case '5': return big ? 'Readback dominates → kill the GPU→CPU round trip (shared D3D11 texture / DXGI keyed-mutex into ANGLE, or native swapchain child window).' : 'Readback present but not dominant.';
    case '3': return big ? 'Decode dominates → proxies (intra-frame), raise MAX_OPEN_CONTEXTS, decode at preview res. Poster ON should slash this.' : 'Decode modest (dedup working).';
    case '4': return big ? 'Composite dominates → effect chains heavy; test effectsBypass; cache static-cell composites.' : 'Composite modest.';
    case '1': case '2': return big ? 'Collect/resolve dominates → CPU per-tick bookkeeping; profile for O(cells²)/allocs.' : 'Collect/resolve cheap (expected).';
    case '6': return big ? 'Swizzle+shm copy dominates → move format conversion to GPU / eliminate copy with shared textures.' : 'Swizzle/copy modest.';
    default: return '';
  }
}

function compare(files) {
  console.log(sep); console.log('COMPARISON'); console.log(sep);
  const rowNames = [
    ['video ticks', (f) => f.videoTicks],
    ['compositor entered', (f) => f.compositorEntered],
    ['readback valid', (f) => f.readbackValid],
    ['frames delivered', (f) => f.framesReceived],
    ['delivered fps', (f) => f.deliveredFps],
    ['preview time (s)', (f) => f.previewTimeS],
  ];
  console.log('  ' + pad('Metric', 22) + files.map((f) => padL(short(f.file), 16)).join(''));
  for (const [label, fn] of rowNames)
    console.log('  ' + pad(label, 22) + files.map((f) => padL(fn(f) ?? 'n/a', 16)).join(''));
  console.log('');
  const allStalled = files.every((f) => isStalled(f).stalled);
  if (allStalled) {
    console.log('  ▶ BOTH captures are STALLED (compositor barely runs, ~0 fps). Poster ON vs OFF');
    console.log('    is irrelevant until the render gate is fixed — neither is decode-bound.');
    console.log('    The preview is frozen during playback, not slow. Fix the gate, re-capture.');
  }
  console.log('');
}

const short = (n) => n.replace(/\.txt$/i, '').slice(-15);

const files = collectFiles(args).map((p) => {
  try { return parseLog(p); } catch (e) { console.error(`! parse failed: ${p}: ${e.message}`); return null; }
}).filter(Boolean);

if (files.length === 0) { console.error('No parseable logs.'); process.exit(1); }

console.log('');
console.log('  XLETH PREVIEW TELEMETRY ANALYSIS');
console.log(`  ${files.length} log(s)`);
console.log('');
for (const d of files) reportOne(d);
if (files.length > 1) compare(files);
console.log(sep);
console.log('Counters are cumulative since launch. "compositor entered ≪ video ticks" means the');
console.log('preview is gated OFF (stall), not slow. Stage timings only matter once frames flow.');
console.log(sep);
