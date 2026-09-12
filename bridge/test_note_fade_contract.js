'use strict';
//
// bridge/test_note_fade_contract.js — end-to-end contract test for the
// Pattern-track automatic Note Fade (TrackInfo::noteFade).
//
// Covers the failure mode this four-layer bridge is prone to: a manifest entry
// that exists but never reaches the engine, which optional chaining in the
// renderer swallows silently. Every assertion reads the value BACK out of the
// engine (or off disk) rather than trusting the setter's return.
//
//   1. the addon exports the new method,
//   2. a fresh track defaults to disabled with the documented side defaults,
//   3. set -> timeline_getTracks() reflects every field of both sides,
//   4. out-of-range mode / curve values clamp instead of producing garbage,
//   5. a partial patch leaves the untouched side alone,
//   6. undo/redo restores the exact prior config,
//   7. save -> load round-trips the whole object,
//   8. a project file with NO noteFade key loads disabled — the
//      backward-compatibility guarantee for every existing project.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_note_fade_contract.js
//

const path = require('path');
const fs   = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

let passed = 0;
let failed = 0;
let total  = 0;

function assert(condition, label) {
  total++;
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    failed++;
  }
}

// Mirrors NoteFadeSettings / NoteFadeSettings::Side field initialisers.
const MODE_FOLLOW = 0;
const MODE_DIVISION = 1;
const MODE_MS = 2;
const DEFAULT_SIDE = {
  mode: MODE_FOLLOW,
  percent: 10,
  divisionDenominator: 16,
  ms: 60,
  curve: 0,
};

function noteFadeOf(addon, trackId) {
  const t = addon.timeline_getTracks().find(x => x.id === trackId);
  return t ? t.noteFade : undefined;
}

function sideEquals(side, expected) {
  if (!side) return false;
  return side.mode === expected.mode
    && Math.abs(side.percent - expected.percent) < 1e-4
    && side.divisionDenominator === expected.divisionDenominator
    && Math.abs(side.ms - expected.ms) < 1e-4
    && side.curve === expected.curve;
}

async function main() {
  console.log('=== Note Fade contract test ===\n');

  const addon = require('./build/Release/xleth_native.node');

  console.log('[ addon surface ]');
  assert(typeof addon.timeline_setTrackNoteFade === 'function',
    'addon exports timeline_setTrackNoteFade');

  assert(addon.initialize() === true, 'initialize() returns true');

  const PROJECT_DIR = path.resolve(__dirname, '_test_note_fade');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.project_create(PROJECT_DIR, 'NoteFadeTest') === true,
    'project_create() returns true');

  // ── 2. Defaults ───────────────────────────────────────────────────────────
  console.log('\n[ defaults on a fresh track ]');
  const trackId = addon.timeline_addTrack({ name: 'Fade', order: 0, type: 'Pattern' });

  {
    const nf = noteFadeOf(addon, trackId);
    assert(!!nf, 'getTracks() reports a noteFade object');
    assert(nf && nf.enabled === false,
      `a new track has note fade OFF (got ${nf && nf.enabled})`);
    assert(sideEquals(nf && nf.fadeIn, DEFAULT_SIDE),
      `fadeIn defaults match the engine struct (got ${JSON.stringify(nf && nf.fadeIn)})`);
    assert(sideEquals(nf && nf.fadeOut, DEFAULT_SIDE),
      `fadeOut defaults match the engine struct (got ${JSON.stringify(nf && nf.fadeOut)})`);
  }

  // ── 3. Set -> read back through the real engine ───────────────────────────
  console.log('\n[ set -> read-back through the engine ]');
  const configured = {
    enabled: true,
    fadeIn:  { mode: MODE_DIVISION, percent: 33, divisionDenominator: 4,  ms: 120, curve: 1 },
    fadeOut: { mode: MODE_MS,       percent: 45, divisionDenominator: 32, ms: 250, curve: 3 },
  };
  addon.timeline_setTrackNoteFade(trackId, configured);
  {
    const nf = noteFadeOf(addon, trackId);
    assert(nf && nf.enabled === true, 'enabled round-trips');
    assert(sideEquals(nf && nf.fadeIn, configured.fadeIn),
      `every fadeIn field round-trips (got ${JSON.stringify(nf && nf.fadeIn)})`);
    assert(sideEquals(nf && nf.fadeOut, configured.fadeOut),
      `every fadeOut field round-trips (got ${JSON.stringify(nf && nf.fadeOut)})`);
  }

  // Each mode is reachable, including the one the UI shows by default.
  for (const mode of [MODE_FOLLOW, MODE_DIVISION, MODE_MS]) {
    addon.timeline_setTrackNoteFade(trackId, {
      enabled: true,
      fadeIn:  { ...configured.fadeIn, mode },
      fadeOut: configured.fadeOut,
    });
    const nf = noteFadeOf(addon, trackId);
    assert(nf && nf.fadeIn.mode === mode,
      `length mode ${mode} survives the round-trip (got ${nf && nf.fadeIn.mode})`);
  }

  // ── 4. Clamping ───────────────────────────────────────────────────────────
  // The enums arrive as raw numbers from JS; an out-of-range value must land on
  // a valid enumerator rather than being cast into one that does not exist.
  console.log('\n[ out-of-range enum values clamp ]');
  addon.timeline_setTrackNoteFade(trackId, {
    enabled: true,
    fadeIn:  { mode: 99, curve: 99 },
    fadeOut: { mode: -5, curve: -5 },
  });
  {
    const nf = noteFadeOf(addon, trackId);
    assert(nf && nf.fadeIn.mode === MODE_MS,
      `mode 99 clamps to the highest valid mode (got ${nf && nf.fadeIn.mode})`);
    assert(nf && nf.fadeIn.curve === 3,
      `curve 99 clamps to the highest valid curve (got ${nf && nf.fadeIn.curve})`);
    assert(nf && nf.fadeOut.mode === MODE_FOLLOW,
      `mode -5 clamps to 0 (got ${nf && nf.fadeOut.mode})`);
    assert(nf && nf.fadeOut.curve === 0,
      `curve -5 clamps to 0 (got ${nf && nf.fadeOut.curve})`);
  }

  // ── 5. Partial patch ──────────────────────────────────────────────────────
  // An absent key must fall back to the struct default, not to zero — the UI
  // relies on this when it sends only the side the user just touched.
  console.log('\n[ partial patch keeps the untouched fields at their defaults ]');
  addon.timeline_setTrackNoteFade(trackId, { enabled: true, fadeOut: { percent: 40 } });
  {
    const nf = noteFadeOf(addon, trackId);
    assert(sideEquals(nf && nf.fadeIn, DEFAULT_SIDE),
      `an omitted fadeIn falls back to defaults (got ${JSON.stringify(nf && nf.fadeIn)})`);
    assert(nf && Math.abs(nf.fadeOut.percent - 40) < 1e-4,
      `the supplied fadeOut.percent applies (got ${nf && nf.fadeOut.percent})`);
    assert(nf && nf.fadeOut.divisionDenominator === DEFAULT_SIDE.divisionDenominator,
      `omitted sibling keys keep their defaults (got ${nf && nf.fadeOut.divisionDenominator})`);
  }

  // ── 6. Undo / redo ────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  addon.timeline_setTrackNoteFade(trackId, configured);
  assert(noteFadeOf(addon, trackId).enabled === true, 'configured state applied');
  addon.undo_undo();
  {
    const nf = noteFadeOf(addon, trackId);
    assert(nf && Math.abs(nf.fadeOut.percent - 40) < 1e-4,
      `undo restores the prior config (expected fadeOut.percent 40, got ${nf && nf.fadeOut.percent})`);
  }
  addon.undo_redo();
  {
    const nf = noteFadeOf(addon, trackId);
    assert(sideEquals(nf && nf.fadeIn, configured.fadeIn)
        && sideEquals(nf && nf.fadeOut, configured.fadeOut),
      'redo re-applies the whole config');
  }

  // ── 7. Persistence round-trip ─────────────────────────────────────────────
  console.log('\n[ save -> load round-trip ]');
  assert(addon.project_save() === true, 'project_save() returns true');

  const projectJsonPath = path.join(PROJECT_DIR, 'project.json');
  const saved = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  const savedTrack = (saved.tracks || []).find(t => t.id === trackId);
  assert(savedTrack && savedTrack.noteFade && savedTrack.noteFade.enabled === true,
    'project.json persists noteFade.enabled');
  assert(savedTrack && savedTrack.noteFade
      && savedTrack.noteFade.fadeIn.divisionDenominator === 4,
    `project.json persists the division (got ${savedTrack && savedTrack.noteFade
      && savedTrack.noteFade.fadeIn.divisionDenominator})`);

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() returns true');
  {
    const nf = noteFadeOf(addon, trackId);
    assert(nf && nf.enabled === true, 'enabled survives save -> load');
    assert(sideEquals(nf && nf.fadeIn, configured.fadeIn)
        && sideEquals(nf && nf.fadeOut, configured.fadeOut),
      `both sides survive save -> load (got ${JSON.stringify(nf)})`);
  }

  // ── 8. Backward compatibility: legacy project without the key ─────────────
  console.log('\n[ legacy project (no noteFade key) loads disabled ]');
  const legacy = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  let strippedCount = 0;
  for (const t of legacy.tracks || []) {
    if ('noteFade' in t) { delete t.noteFade; strippedCount++; }
  }
  assert(strippedCount > 0, `stripped the noteFade key from ${strippedCount} track(s)`);
  fs.writeFileSync(projectJsonPath, JSON.stringify(legacy, null, 2), 'utf8');

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() of the legacy file returns true');
  {
    const nf = noteFadeOf(addon, trackId);
    assert(nf && nf.enabled === false,
      `a legacy track loads with note fade OFF (got ${nf && nf.enabled})`);
    assert(sideEquals(nf && nf.fadeIn, DEFAULT_SIDE)
        && sideEquals(nf && nf.fadeOut, DEFAULT_SIDE),
      'a legacy track loads the documented side defaults');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  if (fs.existsSync(PROJECT_DIR)) {
    try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch { /* leave it */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
