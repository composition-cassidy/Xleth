'use strict';
//
// bridge/test_sampler_mod_ui_smoke.js — verifies the EXACT config shapes the
// modulation UI editors produce survive a set → save → load → get round trip.
//
// The UI store (ui/src/stores/samplerModulationStore.js) forwards a full config
// object to window.xleth.timeline.setSamplerModulation, which is wired from the
// RPC manifest to this addon. This test drives the addon directly with the same
// shapes LfoEditor / CurveEditor / EnvEditor emit, so a mismatch between what
// the UI sends and what the engine accepts fails loudly here rather than as a
// silent optional-chaining no-op in the renderer.
//
// Smoke, per the task: a stepped LFO at 1/4 BPM with RISE persists after reload,
// and VELO curve edits persist.
//
//   node bridge/test_sampler_mod_ui_smoke.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0;
const ok = (cond, label) => { if (cond) { console.log(`  PASS  ${label}`); passed++; } else { console.error(`  FAIL  ${label}`); failed++; } };
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;

// Enum indices, mirroring modConstants.js.
const SEG_STEP = 0, SEG_LINE = 1;
const BEHAVIOR_RETRIG = 1;
const NOTEVAL_QUARTER = 8;

(async () => {
  console.log('=== sampler modulation UI-shape smoke ===');

  ok(typeof addon.timeline_setSamplerModulation === 'function', 'timeline_setSamplerModulation exported');
  ok(typeof addon.timeline_getSamplerModulation === 'function', 'timeline_getSamplerModulation exported');
  ok(typeof addon.timeline_getBPM === 'function', 'timeline_getBPM exported');

  try { addon.initialize(); } catch (e) {
    console.error(`Engine init failed (needs an audio device): ${e.message}`);
    console.error('SKIPPING.');
    process.exit(0);
  }

  const regionId = addon.timeline_addRegion({ name: 'mod-ui-smoke', startTime: 0, endTime: 1 });
  ok(regionId >= 0, `region created id=${regionId}`);

  // ── The exact shape LfoEditor emits for: square/stepped starter, Retrig,
  //    BPM rate = 1/4, RISE set. (square preset = two STEP points.) ───────────
  const steppedLfo = {
    points: [
      { t: 0, v: 1, seg: SEG_STEP, tension: 0 },
      { t: 0.5, v: -1, seg: SEG_STEP, tension: 0 },
    ],
    tempoSync: true,
    rateHz: 1,
    syncRate: { ms: 0, noteValue: NOTEVAL_QUARTER, triplet: false, dotted: false },
    rise: { ms: 250, noteValue: 0, triplet: false, dotted: false },
    delay: { ms: 0, noteValue: 0, triplet: false, dotted: false },
    smooth: 0,
    phase: 0,
    behavior: BEHAVIOR_RETRIG,
    mono: false,
    outputAmount: 1,
  };

  // The store sends the full config; here we patch just lfos[0] + velo (the
  // setter is a per-field patch, so unspecified sources keep their defaults).
  const lfos = Array.from({ length: 6 }, () => ({}));
  lfos[0] = steppedLfo;

  // ── The exact shape CurveEditor emits for a VELO curve (3 points) ──────────
  const velo = {
    points: [
      { x: 0, y: 0.1, tension: 0 },
      { x: 0.5, y: 0.85, tension: 0.3 },
      { x: 1, y: 1, tension: 0 },
    ],
    outputAmount: 0.9,
  };

  const setRes = addon.timeline_setSamplerModulation(regionId, { lfos, velo });
  ok(setRes && setRes.rejectedRoutes === 0, `no routes rejected (rejected=${setRes && setRes.rejectedRoutes})`);

  // Read back before save.
  let cfg = addon.timeline_getSamplerModulation(regionId);
  ok(cfg && cfg.lfos[0].behavior === BEHAVIOR_RETRIG, 'LFO behavior stored (Retrig)');
  ok(cfg.lfos[0].tempoSync === true && cfg.lfos[0].syncRate.noteValue === NOTEVAL_QUARTER, 'LFO rate = 1/4 BPM stored');
  ok(near(cfg.lfos[0].rise.ms, 250), 'LFO RISE stored');
  ok(cfg.lfos[0].points.length === 2 && cfg.lfos[0].points[0].seg === SEG_STEP && cfg.lfos[0].points[1].seg === SEG_STEP,
     'LFO shape is two STEP points');
  ok(cfg.velo.points.length === 3 && near(cfg.velo.points[1].y, 0.85) && near(cfg.velo.points[1].tension, 0.3),
     'VELO curve stored (3 points, tension)');

  // ── Save → load → verify persistence ──────────────────────────────────────
  const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-modui-'));
  addon.project_saveAs(projDir, 'modui');
  const jsonPath = path.join(projDir, 'project.json');
  ok(fs.existsSync(jsonPath), 'project.json written');
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  ok(raw.schema_version === 3, `schema_version = 3 (got ${raw.schema_version})`);

  addon.project_load(projDir);
  cfg = addon.timeline_getSamplerModulation(regionId);

  ok(cfg && cfg.lfos[0].behavior === BEHAVIOR_RETRIG, 'AFTER RELOAD: LFO behavior persists');
  ok(cfg.lfos[0].tempoSync === true && cfg.lfos[0].syncRate.noteValue === NOTEVAL_QUARTER, 'AFTER RELOAD: stepped LFO at 1/4 BPM persists');
  ok(near(cfg.lfos[0].rise.ms, 250), 'AFTER RELOAD: LFO RISE persists');
  ok(cfg.lfos[0].points.length === 2 && cfg.lfos[0].points[0].seg === SEG_STEP,
     'AFTER RELOAD: stepped shape persists');
  ok(cfg.velo.points.length === 3 && near(cfg.velo.points[1].y, 0.85) && near(cfg.velo.points[1].tension, 0.3),
     'AFTER RELOAD: VELO curve edits persist');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('UNCAUGHT:', e); process.exit(1); });
