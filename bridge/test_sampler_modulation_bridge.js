'use strict';
//
// bridge/test_sampler_modulation_bridge.js — sampler modulation bridge surface
//
// Verifies, at the native-addon level (no Electron), that the modulation
// system actually crosses the bridge:
//
//   1. Every new export EXISTS. The renderer reaches the bridge through
//      optional chaining (window.xleth?.timeline?.foo?.()), which turns a
//      missing method into `undefined` and a SILENT no-op. Every method here is
//      therefore resolved through mustFn(), which THROWS on a missing export —
//      a typo in the manifest has to fail loudly here or it only shows up later
//      as a dead UI control.
//   2. A full config (all 6 envelopes, all 6 LFOs, both response curves, a
//      route list covering every target family) sets and reads back intact.
//   3. The setter is a PATCH: sending one key leaves the rest alone.
//   4. Invalid routes are REJECTED and counted, not silently dropped.
//   5. The whole thing is undoable through the shared UndoManager.
//   6. It survives a project save → load round trip (schema 3).
//
// Run after rebuilding the native addon:
//   node bridge/test_sampler_modulation_bridge.js
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

function mustFn(name) {
  const fn = addon[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `MISSING EXPORT: addon.${name} is ${typeof fn}. ` +
      `Add it to ui/rpc-manifest.js and re-run scripts/generate-rpc-registries.js.`);
  }
  return fn.bind(addon);
}

// Mirrors engine/src/model/SamplerModulationConfig.h. Source indices are one
// flat namespace: ENV 1-6 → 0..5, LFO 1-6 → 6..11, VELO → 12, NOTE → 13.
const SRC = { ENV1: 0, ENV2: 1, ENV6: 5, LFO1: 6, LFO2: 7, LFO3: 8, VELO: 12, NOTE: 13 };
const TGT = {
  None: 0,
  SlotVolume: 1, SlotPan: 2, SlotSem: 3, SlotFine: 4, SlotCoarse: 5,
  SlotMangleAmount: 6, SlotMangleMix: 7,
  MasterVolume: 8, MasterPan: 9,
  SrcRate: 10, SrcPhase: 11, SrcRise: 12, SrcDelay: 13, SrcSmooth: 14, SrcAmount: 15,
  EnvStageTime: 16,
};
const SEG = { Step: 0, Line: 1, Curve: 2 };
const BEH = { Free: 0, Retrig: 1, Envelope: 2 };
const NOTEVAL = { Off: 0, Bars32: 1, Bar1: 6, Quarter: 8, Eighth: 9 };
const STAGE = { Delay: 0, Attack: 1, Hold: 2, Decay: 3, Sustain: 4, Release: 5 };

function near(a, b, tol = 1e-3) { return Math.abs(a - b) <= tol; }

(async () => {
  // ── 0. Exports must exist (loudly) ────────────────────────────────────────
  group('0. bridge exports resolve (missing export THROWS, never skips)');

  let api;
  try {
    api = {
      init:        mustFn('initialize'),
      addRegion:   mustFn('timeline_addRegion'),
      getRegions:  mustFn('timeline_getRegions'),
      setMod:      mustFn('timeline_setSamplerModulation'),
      getMod:      mustFn('timeline_getSamplerModulation'),
      updateSampler: mustFn('timeline_updateSamplerSettings'),
      undo:        mustFn('undo_undo'),
      redo:        mustFn('undo_redo'),
      canUndo:     mustFn('undo_canUndo'),
      undoDesc:    mustFn('undo_getUndoDescription'),
      saveAs:      mustFn('project_saveAs'),
      load:        mustFn('project_load'),
    };
    ok(true, 'all 12 required exports resolved');
  } catch (e) {
    console.error(`  FAIL  ${e.message}`);
    process.exit(1);
  }

  // Negative control: mustFn MUST throw for a name that does not exist, or
  // every check above is worthless.
  let threwOnMissing = false;
  try { mustFn('timeline_setSamplerModulationNope'); } catch (e) { threwOnMissing = true; }
  ok(threwOnMissing, 'negative control: mustFn() throws on an undefined export');

  try {
    api.init();
  } catch (e) {
    console.error(`Engine init failed (likely no audio device): ${e.message}`);
    console.error('SKIPPING — this test needs an audio device.');
    process.exit(0);
  }

  // ── 1. A region to hang the modulation off ────────────────────────────────
  group('1. region setup');
  const regionId = api.addRegion({ name: 'mod-bridge-region', startTime: 0, endTime: 1 });
  ok(typeof regionId === 'number' && regionId >= 0, `timeline_addRegion → id=${regionId}`);
  if (!(regionId >= 0)) process.exit(1);

  // A fresh region must arrive BYPASSED — that is what makes every project
  // written before this system existed render unchanged.
  const fresh = api.getMod(regionId);
  ok(fresh && Array.isArray(fresh.routes) && fresh.routes.length === 0,
     'a fresh region has zero routes (exact bypass)');
  ok(fresh && Array.isArray(fresh.envs) && fresh.envs.length === 6,
     `getSamplerModulation reports 6 envelopes (got ${fresh && fresh.envs && fresh.envs.length})`);
  ok(fresh && Array.isArray(fresh.lfos) && fresh.lfos.length === 6,
     `getSamplerModulation reports 6 LFOs (got ${fresh && fresh.lfos && fresh.lfos.length})`);

  // ── 2. A full config round-trips ──────────────────────────────────────────
  group('2. full config set → get');

  const envs = [];
  for (let i = 0; i < 6; i++) {
    envs.push({
      tempoSync: i % 2 === 0,
      delay:   { ms: 10 + i,  noteValue: NOTEVAL.Off,     triplet: false, dotted: false },
      attack:  { ms: 20 + i,  noteValue: NOTEVAL.Eighth,  triplet: i === 1, dotted: false },
      hold:    { ms: 30 + i,  noteValue: NOTEVAL.Off,     triplet: false, dotted: false },
      decay:   { ms: 40 + i,  noteValue: NOTEVAL.Quarter, triplet: false, dotted: i === 2 },
      release: { ms: 50 + i,  noteValue: NOTEVAL.Bar1,    triplet: false, dotted: false },
      sustainPct: 10 * (i + 1),
      attackTension:  0.1 * i,
      decayTension:  -0.1 * i,
      releaseTension: 0.05 * i,
      outputAmount: 1 - 0.1 * i,
    });
  }

  const lfos = [];
  for (let i = 0; i < 6; i++) {
    lfos.push({
      points: [
        { t: 0.0,  v: -1.0, seg: SEG.Step,  tension: 0.0 },
        { t: 0.25, v:  0.5, seg: SEG.Curve, tension: 0.4 },
        { t: 0.6,  v:  1.0, seg: SEG.Line,  tension: 0.0 },
      ],
      tempoSync: i % 2 === 1,
      rateHz: 0.5 + i,
      syncRate: { ms: 0, noteValue: NOTEVAL.Quarter, triplet: i === 3, dotted: i === 4 },
      rise:     { ms: 100 + i, noteValue: NOTEVAL.Off, triplet: false, dotted: false },
      delay:    { ms: 200 + i, noteValue: NOTEVAL.Off, triplet: false, dotted: false },
      smooth: 10 * i,
      phase:  5 * i,
      behavior: [BEH.Free, BEH.Retrig, BEH.Envelope, BEH.Free, BEH.Retrig, BEH.Envelope][i],
      mono: i % 3 === 0,
      outputAmount: 1 - 0.05 * i,
    });
  }

  // One route per target family, so a whole family failing to cross shows up.
  const routes = [
    { source: SRC.ENV1, target: TGT.SlotVolume,       index: 0, stage: 0, amount:  0.50, bipolar: false },
    { source: SRC.LFO1, target: TGT.SlotPan,          index: 1, stage: 0, amount: -0.25, bipolar: true  },
    { source: SRC.LFO2, target: TGT.SlotSem,          index: 0, stage: 0, amount:  1.00, bipolar: true  },
    { source: SRC.VELO, target: TGT.SlotFine,         index: 2, stage: 0, amount:  0.30, bipolar: false },
    { source: SRC.NOTE, target: TGT.SlotCoarse,       index: 3, stage: 0, amount: -0.40, bipolar: true  },
    { source: SRC.ENV2, target: TGT.SlotMangleAmount, index: 0, stage: 0, amount:  0.60, bipolar: false },
    { source: SRC.ENV2, target: TGT.SlotMangleMix,    index: 0, stage: 0, amount:  0.20, bipolar: false },
    { source: SRC.LFO3, target: TGT.MasterVolume,     index: 0, stage: 0, amount: -0.15, bipolar: true  },
    { source: SRC.ENV6, target: TGT.MasterPan,        index: 0, stage: 0, amount:  0.75, bipolar: true  },
    // Cross-modulation, including a deliberate 2-source cycle.
    { source: SRC.LFO1, target: TGT.SrcRate,   index: SRC.LFO2, stage: 0, amount: 0.5,  bipolar: true },
    { source: SRC.LFO2, target: TGT.SrcRate,   index: SRC.LFO1, stage: 0, amount: 0.5,  bipolar: true },
    { source: SRC.ENV1, target: TGT.SrcPhase,  index: SRC.LFO3, stage: 0, amount: 0.25, bipolar: false },
    { source: SRC.ENV1, target: TGT.SrcRise,   index: SRC.LFO3, stage: 0, amount: 0.30, bipolar: false },
    { source: SRC.ENV1, target: TGT.SrcDelay,  index: SRC.LFO3, stage: 0, amount: 0.35, bipolar: false },
    { source: SRC.ENV1, target: TGT.SrcSmooth, index: SRC.LFO3, stage: 0, amount: 0.40, bipolar: false },
    { source: SRC.LFO1, target: TGT.SrcAmount, index: SRC.ENV2, stage: 0, amount: 0.45, bipolar: true },
    { source: SRC.VELO, target: TGT.EnvStageTime, index: SRC.ENV2, stage: STAGE.Attack,
      amount: 0.55, bipolar: false },
    { source: SRC.NOTE, target: TGT.EnvStageTime, index: SRC.ENV2, stage: STAGE.Release,
      amount: -0.65, bipolar: true },
  ];

  const setResult = api.setMod(regionId, { envs, lfos, routes,
    velo: { points: [{ x: 0, y: 0.1, tension: 0.2 }, { x: 1, y: 0.9, tension: 0 }],
            outputAmount: 0.85 },
    note: { points: [{ x: 0, y: 1.0, tension: 0 }, { x: 0.5, y: 0.3, tension: -0.3 },
                     { x: 1, y: 0.0, tension: 0 }],
            outputAmount: 0.95 },
  });

  ok(setResult && setResult.rejectedRoutes === 0,
     `no valid route was rejected (rejected=${setResult && setResult.rejectedRoutes})`);
  ok(setResult && setResult.routeCount === routes.length,
     `all ${routes.length} routes accepted (got ${setResult && setResult.routeCount})`);

  const got = api.getMod(regionId);

  // Routes, field by field. A target family that silently failed to cross
  // would show up as a single mismatched entry here.
  let routeMismatch = null;
  if (!got || !Array.isArray(got.routes) || got.routes.length !== routes.length) {
    routeMismatch = `route count ${got && got.routes && got.routes.length} != ${routes.length}`;
  } else {
    for (let i = 0; i < routes.length; i++) {
      const a = routes[i], b = got.routes[i];
      if (a.source !== b.source || a.target !== b.target || a.index !== b.index
          || a.stage !== b.stage || !near(a.amount, b.amount) || a.bipolar !== b.bipolar) {
        routeMismatch = `route ${i}: sent ${JSON.stringify(a)} got ${JSON.stringify(b)}`;
        break;
      }
    }
  }
  ok(routeMismatch === null, `every route field round-trips${routeMismatch ? ` — ${routeMismatch}` : ''}`);

  // Envelopes.
  let envMismatch = null;
  for (let i = 0; i < 6 && !envMismatch; i++) {
    const a = envs[i], b = got.envs[i];
    if (!b) { envMismatch = `env ${i} missing`; break; }
    if (a.tempoSync !== b.tempoSync) envMismatch = `env ${i} tempoSync`;
    else if (!near(a.sustainPct, b.sustainPct)) envMismatch = `env ${i} sustainPct`;
    else if (!near(a.outputAmount, b.outputAmount)) envMismatch = `env ${i} outputAmount`;
    else if (!near(a.attackTension, b.attackTension)) envMismatch = `env ${i} attackTension`;
    else if (!near(a.attack.ms, b.attack.ms)) envMismatch = `env ${i} attack.ms`;
    else if (a.attack.noteValue !== b.attack.noteValue) envMismatch = `env ${i} attack.noteValue`;
    else if (a.attack.triplet !== b.attack.triplet) envMismatch = `env ${i} attack.triplet`;
    else if (a.decay.dotted !== b.decay.dotted) envMismatch = `env ${i} decay.dotted`;
    else if (a.release.noteValue !== b.release.noteValue) envMismatch = `env ${i} release.noteValue`;
  }
  ok(envMismatch === null, `all 6 envelopes round-trip${envMismatch ? ` — ${envMismatch}` : ''}`);

  // LFOs, shape points included.
  let lfoMismatch = null;
  for (let i = 0; i < 6 && !lfoMismatch; i++) {
    const a = lfos[i], b = got.lfos[i];
    if (!b) { lfoMismatch = `lfo ${i} missing`; break; }
    if (a.tempoSync !== b.tempoSync) lfoMismatch = `lfo ${i} tempoSync`;
    else if (!near(a.rateHz, b.rateHz)) lfoMismatch = `lfo ${i} rateHz`;
    else if (!near(a.smooth, b.smooth)) lfoMismatch = `lfo ${i} smooth`;
    else if (!near(a.phase, b.phase)) lfoMismatch = `lfo ${i} phase`;
    else if (a.behavior !== b.behavior) lfoMismatch = `lfo ${i} behavior`;
    else if (a.mono !== b.mono) lfoMismatch = `lfo ${i} mono`;
    else if (!near(a.outputAmount, b.outputAmount)) lfoMismatch = `lfo ${i} outputAmount`;
    else if (a.syncRate.noteValue !== b.syncRate.noteValue) lfoMismatch = `lfo ${i} syncRate.noteValue`;
    else if (a.syncRate.triplet !== b.syncRate.triplet) lfoMismatch = `lfo ${i} syncRate.triplet`;
    else if (!near(a.rise.ms, b.rise.ms)) lfoMismatch = `lfo ${i} rise.ms`;
    else if (!near(a.delay.ms, b.delay.ms)) lfoMismatch = `lfo ${i} delay.ms`;
    else if (!Array.isArray(b.points) || b.points.length !== a.points.length)
      lfoMismatch = `lfo ${i} point count ${b.points && b.points.length}`;
    else {
      for (let k = 0; k < a.points.length; k++) {
        const pa = a.points[k], pb = b.points[k];
        if (!near(pa.t, pb.t) || !near(pa.v, pb.v) || pa.seg !== pb.seg
            || !near(pa.tension, pb.tension)) {
          lfoMismatch = `lfo ${i} point ${k}: sent ${JSON.stringify(pa)} got ${JSON.stringify(pb)}`;
          break;
        }
      }
    }
  }
  ok(lfoMismatch === null, `all 6 LFOs round-trip, shape points included${lfoMismatch ? ` — ${lfoMismatch}` : ''}`);

  // Response curves.
  ok(got.velo && got.velo.points.length === 2 && near(got.velo.points[0].y, 0.1)
     && near(got.velo.outputAmount, 0.85), 'VELO response curve round-trips');
  ok(got.note && got.note.points.length === 3 && near(got.note.points[1].y, 0.3)
     && near(got.note.points[1].tension, -0.3), 'NOTE response curve round-trips');

  // The region fetch carries the same config, so a panel can read it without a
  // second call.
  // getRegions hands back live objects on some builds and a JSON string on
  // others; accept either rather than assuming.
  const rawRegions = api.getRegions();
  const regions = typeof rawRegions === 'string' ? JSON.parse(rawRegions) : rawRegions;
  const region = Array.isArray(regions) ? regions.find((r) => r.id === regionId) : null;
  ok(region && region.modulation && region.modulation.routes.length === routes.length,
     'timeline_getRegions carries the modulation config too');

  // ── 3. The setter is a PATCH ──────────────────────────────────────────────
  group('3. patch semantics');

  api.setMod(regionId, { lfos: [{ rateHz: 12.5 }] });
  const patched = api.getMod(regionId);
  ok(near(patched.lfos[0].rateHz, 12.5), 'a one-key patch applies');
  ok(near(patched.lfos[0].smooth, lfos[0].smooth) && patched.lfos[0].behavior === lfos[0].behavior,
     'the rest of the patched LFO is untouched');
  ok(near(patched.lfos[3].rateHz, lfos[3].rateHz), 'the other LFOs are untouched');
  ok(patched.routes.length === routes.length, 'omitting `routes` leaves the route list alone');
  ok(near(patched.envs[2].sustainPct, envs[2].sustainPct), 'omitting `envs` leaves them alone');

  // `routes`, when present, REPLACES the list — a route has no stable identity,
  // so patching one by position would silently retarget it.
  api.setMod(regionId, { routes: [routes[0]] });
  ok(api.getMod(regionId).routes.length === 1, 'sending `routes` replaces the whole list');

  // ── 4. Invalid routes are rejected, not silently dropped ──────────────────
  group('4. route validation');

  const bad = api.setMod(regionId, {
    routes: [
      routes[0],                                                              // valid
      { source: -1, target: TGT.SlotVolume, index: 0, stage: 0, amount: 1, bipolar: false },
      { source: SRC.ENV1, target: TGT.None, index: 0, stage: 0, amount: 1, bipolar: false },
      { source: SRC.ENV1, target: TGT.SlotVolume, index: 99, stage: 0, amount: 1, bipolar: false },
      // RATE belongs to LFOs; an envelope has no rate.
      { source: SRC.ENV1, target: TGT.SrcRate, index: SRC.ENV2, stage: 0, amount: 1, bipolar: false },
      // SUSTAIN is a level, not a time.
      { source: SRC.ENV1, target: TGT.EnvStageTime, index: SRC.ENV2, stage: STAGE.Sustain,
        amount: 1, bipolar: false },
    ],
  });
  ok(bad.routeCount === 1, `only the valid route survives (got ${bad.routeCount})`);
  ok(bad.rejectedRoutes === 5, `all 5 invalid routes are REPORTED (got ${bad.rejectedRoutes})`);

  // ── 5. Undo ───────────────────────────────────────────────────────────────
  group('5. undo');

  api.setMod(regionId, { routes });
  ok(api.getMod(regionId).routes.length === routes.length, 'restored the full route list');
  ok(api.canUndo(), 'the modulation edit is on the undo stack');
  const desc = api.undoDesc();
  ok(typeof desc === 'string' && desc.length > 0, `undo description present ("${desc}")`);

  api.undo();
  ok(api.getMod(regionId).routes.length === 1,
     'undo restores the PREVIOUS route list, not an empty one');
  api.redo();
  ok(api.getMod(regionId).routes.length === routes.length, 'redo re-applies the route list');

  // An unrelated sampler edit must not clobber the modulation config — the
  // whole config rides on the same command, so a missing field in one of the
  // copy sites would show up right here.
  api.updateSampler(regionId, { attackMs: 123.0 });
  ok(api.getMod(regionId).routes.length === routes.length,
     'an unrelated sampler edit preserves the modulation config');

  // ── 6. Project save → load (schema 3) ─────────────────────────────────────
  group('6. project persistence');

  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-modbridge-'));
  let saved = false;
  try { api.saveAs(projDir, 'modbridge'); saved = true; } catch (e) {
    console.error(`  (saveAs threw: ${e.message})`);
  }
  ok(saved, `project_saveAs("${projDir}")`);

  if (saved) {
    const jsonPath = path.join(projDir, 'project.json');
    ok(fs.existsSync(jsonPath), 'project.json written');
    if (fs.existsSync(jsonPath)) {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      ok(raw.schema_version === 3, `schema_version bumped to 3 (got ${raw.schema_version})`);
      const savedRegion = (raw.regions || []).find((r) => r.id === regionId);
      ok(savedRegion && savedRegion.modulation,
         'the region carries a "modulation" block on disk');
      ok(savedRegion && savedRegion.modulation
         && savedRegion.modulation.routes.length === routes.length,
         'every route is on disk');
    }

    let loaded = false;
    try { api.load(projDir); loaded = true; } catch (e) {
      console.error(`  (load threw: ${e.message})`);
    }
    ok(loaded, 'project_load round trip');

    if (loaded) {
      const after = api.getMod(regionId);
      ok(after && after.routes.length === routes.length,
         `route list survives save → load (got ${after && after.routes.length})`);
      let survived = true;
      if (after && after.routes.length === routes.length) {
        for (let i = 0; i < routes.length; i++) {
          const a = routes[i], b = after.routes[i];
          if (a.source !== b.source || a.target !== b.target || a.index !== b.index
              || a.stage !== b.stage || !near(a.amount, b.amount) || a.bipolar !== b.bipolar) {
            survived = false; break;
          }
        }
      }
      ok(survived, 'every route field survives save → load');
      ok(after && after.lfos[2].behavior === BEH.Envelope,
         'LFO behavior survives save → load');
      ok(after && after.lfos[0].points.length === 3
         && after.lfos[0].points[1].seg === SEG.Curve,
         'LFO shape points and segment types survive save → load');
      ok(after && near(after.envs[3].sustainPct, envs[3].sustainPct),
         'envelope settings survive save → load');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
