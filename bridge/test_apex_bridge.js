'use strict';
//
// bridge/test_apex_bridge.js — APEX bridge surface smoke test
//
// Verifies, at the native-addon level (no Electron), that everything the APEX
// editor will need actually crosses the bridge:
//
//   1. Every new export EXISTS. The four-layer bridge reaches the renderer
//      through optional chaining (window.xleth?.audio?.foo?.()), which turns a
//      missing method into `undefined` and a silent no-op. This file therefore
//      resolves every method through mustFn(), which THROWS on a missing
//      export instead of skipping the check — a typo in the manifest has to
//      fail loudly here, or it would only surface as a dead UI control later.
//   2. All 50 APEX parameters set → read back, reported PASS/FAIL per group.
//   3. Curve state (nodes + per-segment tensions) round-trips per band, and
//      the engine's documented sanitisation actually runs.
//   4. audio_getEffectLatency reports LOOKAHEAD, and tracks it when it moves.
//   5. The metering payload arrives as ONE batched ArrayBuffer per drain, with
//      the right type tag / bucket size, at the ~30 Hz cadence the UI polls at.
//   6. Parameters AND curves survive a project save → load round trip.
//
// Run after rebuilding the native addon (FFmpeg DLLs must be on PATH):
//   node bridge/test_apex_bridge.js
//

const path = require('path');
const fs   = require('fs');
const os   = require('os');

// The addon links FFmpeg from the main engine build's vcpkg tree; a bare
// require() fails with ERR_DLOPEN_FAILED without it on PATH.
const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
function group(name) { console.log(`\n=== ${name} ===`); }

// Resolve an addon export or THROW. This is the whole point of the file: the
// renderer-side call chain swallows undefined silently, so the one place that
// must not is the test.
function mustFn(name) {
  const fn = addon[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `MISSING EXPORT: addon.${name} is ${typeof fn}. ` +
      `Add it to ui/rpc-manifest.js and re-run scripts/generate-rpc-registries.js.`);
  }
  return fn.bind(addon);
}

// ── APEX parameter surface (mirrors XlethApexEffect::createLayout) ──────────
//
// Each entry is [paramId, testValue]. Test values are deliberately NOT the
// defaults — a parameter that silently fails to write would otherwise read
// back "correct".

const BAND_PREFIX = ['lo_', 'md_', 'hi_', 'ms_'];
const BAND_NAME   = ['LOW', 'MID', 'HIGH', 'MASTER'];

const GLOBAL_PARAMS = [
  ['lowcut',    45.0],
  ['split_lo', 320.0],
  ['split_hi', 5500.0],
  ['slope_lo',   0.0],   // 0 = LR2 (12 dB/oct)
  ['slope_hi',   0.0],
  ['lookahead', 12.5],
  ['bandmix',   68.0],
];

// [suffix, value, tolerance]. Skewed ranges (att/rel/split) round-trip through
// a 0..1 normalisation, so they get a proportional tolerance rather than an
// absolute one.
function bandParams(bandIndex) {
  const p = [
    ['state',  1.0,    0.01],   // 1 = COMP OFF
    ['pre',   -7.5,    0.05],
    ['post',   4.25,   0.05],
    ['att',   22.0,    0.05],
    ['rel',  240.0,    0.5 ],
    ['sus',   85.0,    0.5 ],
    ['det',    1.0,    0.01],   // 1 = RMS
    ['satth', 62.0,    0.1 ],
    ['satcl', -18.0,   0.05],
    ['sep',   -35.0,   0.1 ],
  ];
  // SOLO is LOW/MID/HIGH only — MASTER has no solo (spec 4.2).
  if (bandIndex < 3) p.unshift(['solo', 1.0, 0.01]);
  return p;
}

function tolFor(id, value) {
  // Skewed NormalisableRanges lose a little precision through the
  // denormalise → normalise → denormalise trip the APVTS does.
  if (/split_(lo|hi)$/.test(id)) return Math.abs(value) * 0.002 + 0.5;
  if (/_att$|_rel$/.test(id))    return Math.abs(value) * 0.002 + 0.05;
  return 0.05;
}

// ── Curve fixtures ──────────────────────────────────────────────────────────

const CURVES = [
  { band: 0, nodes: [{ in: -24, out: -24 }, { in: -12, out: -18 }, { in: 0, out: -9 }, { in: 12, out: -4 }],
             tensions: [0.35, -0.6, 0.15] },
  { band: 1, nodes: [{ in: -24, out: -20 }, { in: -6, out: -10 }, { in: 12, out: 2 }],
             tensions: [-0.8, 0.45] },
  { band: 2, nodes: [{ in: -24, out: -24 }, { in: 12, out: 6 }],
             tensions: [0.9] },
  { band: 3, nodes: [{ in: -24, out: -24 }, { in: -18, out: -20 }, { in: -3, out: -8 },
                     { in: 4, out: -6 }, { in: 12, out: -5 }],
             tensions: [0.1, 0.2, -0.3, 0.4] },
];

function curvesEqual(a, b, eps = 1e-3) {
  if (!a || !b) return false;
  if (!Array.isArray(a.nodes) || !Array.isArray(b.nodes)) return false;
  if (a.nodes.length !== b.nodes.length) return false;
  for (let i = 0; i < a.nodes.length; i++) {
    if (Math.abs(a.nodes[i].in  - b.nodes[i].in)  > eps) return false;
    if (Math.abs(a.nodes[i].out - b.nodes[i].out) > eps) return false;
  }
  const at = a.tensions || [], bt = b.tensions || [];
  if (at.length !== bt.length) return false;
  for (let i = 0; i < at.length; i++) {
    if (Math.abs(at[i] - bt[i]) > eps) return false;
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Main ────────────────────────────────────────────────────────────────────

(async () => {
  // ── 0. Exports must exist (loudly) ────────────────────────────────────────
  group('0. bridge exports resolve (missing export THROWS, never skips)');

  let api;
  try {
    api = {
      init:            mustFn('initialize'),
      addMasterEffect: mustFn('audio_addMasterEffect'),
      removeMaster:    mustFn('audio_removeMasterEffect'),
      getMasterChain:  mustFn('audio_getMasterEffectChain'),
      getParams:       mustFn('audio_getEffectParameters'),
      setParam:        mustFn('audio_setEffectParameter'),
      apexGetCurves:   mustFn('audio_apexGetCurves'),
      apexGetBand:     mustFn('audio_apexGetBandCurve'),
      apexSetBand:     mustFn('audio_apexSetBandCurve'),
      apexResetBand:   mustFn('audio_apexResetBandCurve'),
      getLatency:      mustFn('audio_getEffectLatency'),
      vizEnable:       mustFn('audio_setEffectVisualizationEnabled'),
      vizDrain:        mustFn('audio_drainEffectVizFrames'),
      projectSaveAs:   mustFn('project_saveAs'),
      projectLoad:     mustFn('project_load'),
      play:            mustFn('play'),
      stop:            mustFn('stop'),
    };
    ok(true, 'all 17 required exports resolved');
  } catch (e) {
    console.error(`  FAIL  ${e.message}`);
    process.exit(1);
  }

  // Negative control: mustFn MUST throw for a name that does not exist, or
  // every check above is worthless.
  let threwOnMissing = false;
  try { mustFn('audio_apexThisDoesNotExist'); }
  catch (e) { threwOnMissing = true; }
  ok(threwOnMissing, 'negative control: mustFn() throws on an undefined export');

  try {
    api.init();
  } catch (e) {
    console.error(`Engine init failed (likely no audio device): ${e.message}`);
    console.error('SKIPPING — this test needs an audio device.');
    process.exit(0);
  }

  // ── 1. Instantiate APEX on the master chain ───────────────────────────────
  group('1. APEX instantiation');
  const raw = api.addMasterEffect('apex', 0);
  let nodeId = -1;
  if (typeof raw === 'string')      { try { nodeId = JSON.parse(raw).nodeId; } catch (e) { /* below */ } }
  else if (raw && typeof raw === 'object') nodeId = raw.nodeId;
  else if (typeof raw === 'number')        nodeId = raw;
  ok(nodeId >= 0, `audio_addMasterEffect("apex") → nodeId=${nodeId}`);
  if (nodeId < 0) { console.error('cannot continue without an APEX node'); process.exit(1); }

  const TRACK = -1; // master chain

  function readParams() {
    const json = api.getParams(TRACK, nodeId);
    const arr = JSON.parse(json);
    const map = new Map();
    for (const p of arr) map.set(p.id, p.value);
    return map;
  }

  const baseline = readParams();
  ok(baseline.size === 50,
     `APEX exposes 50 parameters (7 global + 3x11 band + 10 master) — got ${baseline.size}`);

  // ── 2. Parameter round trip, per group ────────────────────────────────────
  group('2. parameters: set from bridge → read back from engine');

  // 2a. Global & crossover (spec 4.1)
  for (const [id, v] of GLOBAL_PARAMS) api.setParam(TRACK, nodeId, id, v);
  {
    const after = readParams();
    let bad = [];
    for (const [id, v] of GLOBAL_PARAMS) {
      const got = after.get(id);
      if (got === undefined || Math.abs(got - v) > tolFor(id, v)) bad.push(`${id}=${got} want ${v}`);
    }
    ok(bad.length === 0,
       `global & crossover (7 params)${bad.length ? ' — ' + bad.join(', ') : ''}`);
  }

  // 2b. Per band (spec 4.2)
  for (let b = 0; b < 4; b++) {
    const params = bandParams(b);
    for (const [suffix, v] of params) api.setParam(TRACK, nodeId, BAND_PREFIX[b] + suffix, v);
    const after = readParams();
    let bad = [];
    for (const [suffix, v] of params) {
      const id = BAND_PREFIX[b] + suffix;
      const got = after.get(id);
      if (got === undefined || Math.abs(got - v) > tolFor(id, v)) bad.push(`${id}=${got} want ${v}`);
    }
    ok(bad.length === 0,
       `${BAND_NAME[b]} band (${params.length} params)${bad.length ? ' — ' + bad.join(', ') : ''}`);
  }

  // 2c. MASTER must have no SOLO — writing one has to fail, not be invented.
  ok(api.setParam(TRACK, nodeId, 'ms_solo', 1.0) === false,
     'MASTER has no SOLO parameter (setEffectParameter returns false)');

  // ── 3. Curve state round trip ─────────────────────────────────────────────
  group('3. curve state (nodes + per-segment tensions) through the bridge');

  for (const c of CURVES) {
    const setOk = api.apexSetBand(TRACK, nodeId, c.band,
      JSON.stringify({ nodes: c.nodes, tensions: c.tensions }));
    const back = JSON.parse(api.apexGetBand(TRACK, nodeId, c.band));
    ok(setOk === true && back.band === c.band && curvesEqual(c, back),
       `${BAND_NAME[c.band]} curve: ${c.nodes.length} nodes + ${c.tensions.length} tensions round-trip`);
  }

  // Batched getter must agree with the per-band getter, band for band.
  {
    const all = JSON.parse(api.apexGetCurves(TRACK, nodeId));
    let agree = Array.isArray(all.bands) && all.bands.length === 4;
    if (agree) {
      for (let b = 0; b < 4; b++) {
        const per = JSON.parse(api.apexGetBand(TRACK, nodeId, b));
        agree = agree && curvesEqual(per, all.bands[b], 0);
      }
    }
    ok(agree, 'audio_apexGetCurves matches audio_apexGetBandCurve for all 4 bands');
  }

  // Sanitisation: unsorted, out-of-range, duplicate-IN nodes must be repaired
  // rather than accepted — the audio thread reads the compiled LUT, so a
  // non-monotonic domain would be a real corruption.
  {
    api.apexSetBand(TRACK, nodeId, 0, JSON.stringify({
      nodes: [{ in: 12, out: 40 }, { in: -150, out: -150 }, { in: 0, out: 0 }, { in: 0, out: 9 }],
      tensions: [5, -5],
    }));
    const s = JSON.parse(api.apexGetBand(TRACK, nodeId, 0));
    const sorted   = s.nodes.every((n, i) => i === 0 || n.in > s.nodes[i - 1].in);
    // Box is [-96, +12] dB: -96 is the silence end, not a working floor.
    const clamped  = s.nodes.every((n) => n.in >= -96.001 && n.in <= 12.001
                                       && n.out >= -96.001 && n.out <= 12.001);
    const tensOk   = s.tensions.length === s.nodes.length - 1
                  && s.tensions.every((t) => t >= -1.001 && t <= 1.001);
    const deduped  = s.nodes.length === 3; // the duplicate in:0 is dropped
    ok(sorted && clamped && tensOk && deduped,
       `sanitisation: sorted=${sorted} clamped=${clamped} tensions=${tensOk} deduped=${deduped}`);
  }

  // Reset returns the band to unity (two pinned end nodes, one zero tension).
  {
    ok(api.apexResetBand(TRACK, nodeId, 0) === true, 'apexResetBandCurve → true');
    const u = JSON.parse(api.apexGetBand(TRACK, nodeId, 0));
    ok(u.nodes.length === 2 && u.nodes[0].in === -96 && u.nodes[0].out === -96
       && u.nodes[1].in === 12 && u.nodes[1].out === 12
       && u.tensions.length === 1 && u.tensions[0] === 0,
       'reset produces the unity curve (-96,-96)→(12,12), tension 0');
    // Put the real curve back for the save/load test below.
    api.apexSetBand(TRACK, nodeId, 0,
      JSON.stringify({ nodes: CURVES[0].nodes, tensions: CURVES[0].tensions }));
  }

  // Non-APEX node must answer, not throw — the UI cannot always know the type.
  {
    const compRaw = api.addMasterEffect('compressor', 0);
    let compId = typeof compRaw === 'string' ? JSON.parse(compRaw).nodeId
               : (compRaw && compRaw.nodeId !== undefined ? compRaw.nodeId : compRaw);
    const s = api.apexGetBand(TRACK, compId, 0);
    ok(s === '{}', `apexGetBandCurve on a non-APEX node returns "{}" (got ${JSON.stringify(s)})`);
    ok(api.apexSetBand(TRACK, compId, 0, '{"nodes":[],"tensions":[]}') === false,
       'apexSetBandCurve on a non-APEX node returns false');
    api.removeMaster(compId);
  }

  // ── 4. Latency surfacing ──────────────────────────────────────────────────
  group('4. LOOKAHEAD latency readable from the bridge');

  {
    const L = api.getLatency(TRACK, nodeId);
    ok(L && typeof L === 'object', 'audio_getEffectLatency returns an object');
    ok(L.ok === true, 'latency.ok === true for a live node');
    ok(L.pluginId === 'apex', `latency.pluginId === "apex" (got "${L.pluginId}")`);
    ok(typeof L.sampleRate === 'number' && L.sampleRate > 0,
       `latency.sampleRate = ${L.sampleRate}`);

    // lookahead is still 12.5 ms from step 2a.
    const expectLookahead = Math.round(12.5 * 0.001 * L.sampleRate);
    ok(Math.abs(L.lookaheadSamples - expectLookahead) <= 1,
       `lookaheadSamples = ${L.lookaheadSamples} (expected ~${expectLookahead} for 12.5 ms @ ${L.sampleRate})`);

    // satth is 62 % on every band → both oversampler stages engaged (47 each).
    ok(L.saturationLatencySamples === 94,
       `saturationLatencySamples = ${L.saturationLatencySamples} (expected 94 = 2 x 47)`);
    ok(L.latencySamples === L.lookaheadSamples + L.saturationLatencySamples,
       `latencySamples (${L.latencySamples}) == lookahead + saturation`);
    ok(Math.abs(L.latencyMs - 1000 * L.latencySamples / L.sampleRate) < 0.01,
       `latencyMs = ${L.latencyMs.toFixed(3)} agrees with latencySamples`);
  }

  // Latency must TRACK the knob, not report a stale snapshot.
  {
    api.setParam(TRACK, nodeId, 'lookahead', 0.0);
    const L0 = api.getLatency(TRACK, nodeId);
    api.setParam(TRACK, nodeId, 'lookahead', 20.0);
    const L20 = api.getLatency(TRACK, nodeId);
    const expect20 = Math.round(20.0 * 0.001 * L20.sampleRate);
    ok(L0.lookaheadSamples === 0, `LOOKAHEAD 0 ms → lookaheadSamples 0 (got ${L0.lookaheadSamples})`);
    ok(Math.abs(L20.lookaheadSamples - expect20) <= 1,
       `LOOKAHEAD 20 ms → lookaheadSamples ${L20.lookaheadSamples} (expected ~${expect20})`);
    api.setParam(TRACK, nodeId, 'lookahead', 12.5);
  }

  // Bogus node answers { ok: false } instead of throwing.
  {
    const L = api.getLatency(TRACK, 99999);
    ok(L && L.ok === false && L.latencySamples === 0,
       'audio_getEffectLatency on a bogus nodeId → { ok:false, latencySamples:0 }');
  }

  // ── 5. Metering payload ───────────────────────────────────────────────────
  group('5. batched metering payload at ~30 Hz');

  const APEX_BUCKET_BYTES = 4192;

  // Before enable: well-formed empty payload, never a throw.
  {
    const r = api.vizDrain(TRACK, nodeId, 8);
    ok(r && typeof r === 'object', 'drain before enable returns an object');
    ok(r.count === 0 && r.frames instanceof ArrayBuffer && r.frames.byteLength === 0,
       'drain before enable → count 0, empty ArrayBuffer');
  }

  ok(api.vizEnable(TRACK, nodeId, true) === true, 'setEffectVisualizationEnabled(true) → true');

  // The transport MUST be rolling. MixEngine::processBlock takes a stopped-state
  // early-out (MixEngine.cpp, "When transport is stopped, render only the
  // dedicated audition samplers") that returns BEFORE the master effect chain is
  // processed — so a stopped engine feeds APEX no audio at all and produces zero
  // buckets. That is existing, deliberate engine behaviour, not an APEX bug; the
  // meter simply has nothing to meter while stopped.
  api.play();
  await sleep(150);   // let the device settle into the playing state

  {
    const r = api.vizDrain(TRACK, nodeId, 8);
    ok(r.type === 'apex', `drain.type === "apex" (got "${r.type}")`);
    ok(r.bucketSize === APEX_BUCKET_BYTES,
       `drain.bucketSize === ${APEX_BUCKET_BYTES} (got ${r.bucketSize})`);
    ok(typeof r.schema === 'number', `drain.schema === ${r.schema}`);
    ok(r.frames instanceof ArrayBuffer, 'drain.frames is an ArrayBuffer (ONE batched payload)');
  }

  // Poll at 30 Hz for a second, exactly as useDynamicsVizSubscription does.
  {
    const TICKS = 30;
    let ticksWithData = 0, totalBuckets = 0, sample = null;
    for (let i = 0; i < TICKS; i++) {
      await sleep(1000 / 30);
      const r = api.vizDrain(TRACK, nodeId, 8);
      if (r.count > 0) {
        ticksWithData++;
        totalBuckets += r.count;
        if (!sample) sample = r;
      }
      if (r.count > 0 && r.frames.byteLength !== r.count * APEX_BUCKET_BYTES) {
        ok(false, `payload size mismatch: ${r.frames.byteLength} != ${r.count} x ${APEX_BUCKET_BYTES}`);
      }
    }

    ok(totalBuckets > 0,
       `metering produced ${totalBuckets} buckets over ${TICKS} ticks (~1 s)`);

    if (totalBuckets > 0) {
      // The engine emits one bucket per >= 1024 samples, rounded up to a block
      // boundary — ~31-47/s across the realistic sample-rate / buffer-size
      // matrix. Anything in 25..70 means the cadence is right: at or above the
      // UI's 30 Hz poll, and not flooding it.
      ok(totalBuckets >= 25 && totalBuckets <= 70,
         `bucket cadence ≈ ${totalBuckets}/s (engine target ~31-47/s, UI polls at 30 Hz)`);
      ok(ticksWithData >= 20,
         `${ticksWithData}/${TICKS} ticks carried data (a 30 Hz UI is never starved)`);

      // ── Decode ONE payload and print it, per the deliverable ─────────────
      const dv = new DataView(sample.frames);
      const LE = true;
      const b = {
        sampleClock:      dv.getBigUint64(0, LE).toString(),
        bucketSamples:    dv.getUint32(8, LE),
        inputPeakDb:      dv.getFloat32(16, LE),
        outputPeakDb:     dv.getFloat32(20, LE),
        bandGrDb:         [0, 1, 2, 3].map((i) => dv.getFloat32(24 + i * 4, LE)),
        bandOutDb:        [0, 1, 2, 3].map((i) => dv.getFloat32(40 + i * 4, LE)),
        bandInDb:         [0, 1, 2, 3].map((i) => dv.getFloat32(56 + i * 4, LE)),
        lookaheadSamples: dv.getFloat32(72, LE),
        latencySamples:   dv.getFloat32(76, LE),
        splitLoHz:        dv.getFloat32(80, LE),
        splitHiHz:        dv.getFloat32(84, LE),
        sampleRate:       dv.getFloat32(88, LE),
        spectrumBins:     dv.getFloat32(92, LE),
      };
      const spectrum = [];
      for (let i = 0; i < 1024; i++) spectrum.push(dv.getFloat32(96 + i * 4, LE));

      console.log('\n  ── sample metering payload (one bucket, decoded) ──');
      console.log('  ' + JSON.stringify({
        ...b,
        bandGrDb:  b.bandGrDb.map((v) => +v.toFixed(2)),
        bandOutDb: b.bandOutDb.map((v) => +v.toFixed(2)),
        bandInDb:  b.bandInDb.map((v) => +v.toFixed(2)),
        spectrum:  `Float32[${spectrum.length}] first8=[${
          spectrum.slice(0, 8).map((v) => v.toFixed(1)).join(', ')}] ...`,
      }, null, 0));
      console.log(`  bytes/bucket=${APEX_BUCKET_BYTES}  buckets in this payload=${sample.count}` +
                  `  total payload bytes=${sample.frames.byteLength}\n`);

      // The engine flushes on the first BLOCK boundary at or past 1024 samples,
      // so a bucket covers 1024..(1024 + blockSize - 1) samples and says so in
      // its header rather than claiming a round number it did not measure.
      // At 441-sample blocks that is 3 blocks = 1323 samples → ~33 Hz.
      ok(b.bucketSamples >= 1024 && b.bucketSamples < 1024 + 2048,
         `bucket covers ${b.bucketSamples} samples (>= 1024, flushed on a block boundary)`);
      ok(Math.abs(b.sampleRate / b.bucketSamples - totalBuckets) < 6,
         `header cadence (${(b.sampleRate / b.bucketSamples).toFixed(1)}/s) matches the ` +
         `${totalBuckets} buckets actually observed in 1 s`);
      ok(b.spectrumBins === 1024, `bucket declares 1024 spectrum bins (got ${b.spectrumBins})`);
      ok(spectrum.length === 1024 && spectrum.every((v) => Number.isFinite(v)),
         'all 1024 spectrum bins decode to finite dB values');
      ok(Math.abs(b.splitLoHz - 320) < 1 && Math.abs(b.splitHiHz - 5500) < 10,
         `crossover frequencies in payload match the params (${b.splitLoHz.toFixed(0)} / ${b.splitHiHz.toFixed(0)} Hz)`);
      ok(Math.abs(b.sampleRate - api.getLatency(TRACK, nodeId).sampleRate) < 1,
         `payload sampleRate ${b.sampleRate} matches the engine`);
      ok(b.bandGrDb.every((v) => v >= 0), 'per-band gain reduction is reported as positive dB');
      // bandInDb is what the curve editor puts its moving dot on: the level the
      // band's transfer curve was actually read at. With a live 0 dBFS-ish tone
      // every band must report a real level, and never a level above the input.
      ok(b.bandInDb.length === 4 && b.bandInDb.every((v) => Number.isFinite(v) && v <= 12),
         `per-band detector level decodes (${b.bandInDb.map((v) => v.toFixed(1)).join(', ')} dB)`);
      // This harness plays an empty timeline, so the honest check is that the
      // detector agrees with the input rather than inventing a level: silence
      // in, silence out; signal in, a MASTER reading at or below that input.
      ok(b.inputPeakDb <= -119 ? b.bandInDb.every((v) => v <= -119)
                               : b.bandInDb[3] <= b.inputPeakDb + 0.5,
         `MASTER detector level tracks the input (in ${b.inputPeakDb.toFixed(1)}, ` +
         `det ${b.bandInDb[3].toFixed(1)} dB)`);
    }
  }

  ok(api.vizEnable(TRACK, nodeId, false) === true, 'setEffectVisualizationEnabled(false) → true');
  {
    // Drain the tail the ring still held, then confirm the stream has stopped.
    api.vizDrain(TRACK, nodeId, 64);
    await sleep(200);
    const r = api.vizDrain(TRACK, nodeId, 64);
    ok(r.count === 0, `no buckets produced after disable (got ${r.count})`);
  }

  // Rapid open/close churn must not corrupt the ring or throw.
  {
    let churnOk = true;
    for (let i = 0; i < 50; i++) {
      try {
        if (api.vizEnable(TRACK, nodeId, true) !== true)  { churnOk = false; break; }
        api.vizDrain(TRACK, nodeId, 8);
        if (api.vizEnable(TRACK, nodeId, false) !== true) { churnOk = false; break; }
        api.vizDrain(TRACK, nodeId, 8);
      } catch (e) { churnOk = false; break; }
    }
    ok(churnOk, '50x viz enable/disable churn completes without throwing');
  }

  api.stop();

  // ── 6. Project save / load round trip ─────────────────────────────────────
  group('6. parameters + curves survive project save → load');

  {
    const before       = readParams();
    const curvesBefore = JSON.parse(api.apexGetCurves(TRACK, nodeId));

    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-apex-'));
    const name = 'apex_roundtrip';
    const saved = api.projectSaveAs(dir, name);
    ok(saved === true, `project_saveAs("${dir}", "${name}") → true`);

    // project_saveAs(dir, name) writes dir/project.json — `name` is the project's
    // display name, not an extra path segment.
    const projPath = path.join(dir, 'project.json');
    const onDisk = fs.existsSync(projPath) ? fs.readFileSync(projPath, 'utf8') : '';
    ok(onDisk.length > 0, 'project.json written to disk');

    // Prove the curve really is inside the FILE, not just still in memory. The
    // effect state is a base64 APVTS blob, so decode it and look for the
    // APEX_CURVES child the effect writes its nodes/tensions into.
    let curveInFile = false;
    try {
      const j = JSON.parse(onDisk);
      const chain = j.masterEffectChain || {};
      for (const n of (chain.nodes || [])) {
        if (!n || typeof n.state !== 'string') continue;
        const xml = Buffer.from(n.state, 'base64').toString('latin1');
        if (xml.includes('APEX_CURVES')) { curveInFile = true; break; }
      }
    } catch (e) { /* reported by the assertion */ }
    ok(curveInFile,
       'project.json carries the APEX_CURVES node/tension state inside the effect state blob');

    // Mutate everything, so a load that silently does nothing cannot pass.
    api.setParam(TRACK, nodeId, 'lookahead', 0.0);
    api.setParam(TRACK, nodeId, 'bandmix', 100.0);
    api.setParam(TRACK, nodeId, 'split_lo', 200.0);
    for (let b = 0; b < 4; b++) api.apexResetBand(TRACK, nodeId, b);
    const wiped = JSON.parse(api.apexGetCurves(TRACK, nodeId));
    ok(!curvesEqual(curvesBefore.bands[3], wiped.bands[3]),
       'pre-load mutation actually changed the curves (the test can fail)');

    const loaded = api.projectLoad(dir);
    ok(loaded === true || (loaded && loaded.ok !== false),
       `project_load → ${JSON.stringify(loaded)}`);

    // The chain is rebuilt on load, so the node id can change. Find APEX again.
    let reloadedId = -1;
    try {
      const chain = JSON.parse(api.getMasterChain());
      const nodes = Array.isArray(chain) ? chain : (chain.nodes || []);
      for (const n of nodes) {
        if (n && (n.pluginId === 'apex' || n.name === 'apex')) { reloadedId = n.nodeId; break; }
      }
    } catch (e) { /* reported below */ }
    ok(reloadedId >= 0, `APEX found in the reloaded master chain (nodeId=${reloadedId})`);

    if (reloadedId >= 0) {
      const json = api.getParams(TRACK, reloadedId);
      const after = new Map(JSON.parse(json).map((p) => [p.id, p.value]));

      let bad = [];
      for (const [id, v] of before) {
        const got = after.get(id);
        if (got === undefined || Math.abs(got - v) > tolFor(id, v)) {
          bad.push(`${id}: ${got} != ${v}`);
        }
      }
      ok(bad.length === 0,
         `all 50 parameters restored${bad.length ? ' — ' + bad.slice(0, 6).join(', ') : ''}`);

      const curvesAfter = JSON.parse(api.apexGetCurves(TRACK, reloadedId));
      let curveBad = [];
      for (let b = 0; b < 4; b++) {
        if (!curvesEqual(curvesBefore.bands[b], curvesAfter.bands[b])) curveBad.push(BAND_NAME[b]);
      }
      ok(curveBad.length === 0,
         `curve nodes + tensions restored for all 4 bands${curveBad.length ? ' — bad: ' + curveBad.join(',') : ''}`);

      // Latency must be restored too, or PDC would be planned on stale data.
      const L = api.getLatency(TRACK, reloadedId);
      const expect = Math.round(12.5 * 0.001 * L.sampleRate);
      ok(Math.abs(L.lookaheadSamples - expect) <= 1,
         `LOOKAHEAD restored: lookaheadSamples=${L.lookaheadSamples} (expected ~${expect})`);

      nodeId = reloadedId;
    }

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  try { api.removeMaster(nodeId); } catch (e) { /* engine may already be torn down */ }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.error('FAILED'); process.exit(1); }
  console.log('ALL TESTS PASSED');
  process.exit(0);
})().catch((e) => {
  console.error('\nUNCAUGHT: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
