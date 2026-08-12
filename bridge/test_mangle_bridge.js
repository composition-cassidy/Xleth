'use strict';
//
// bridge/test_mangle_bridge.js — end-to-end contract test for MANGLE, the
// per-note per-slot warp FX.
//
// Covers the failure mode this four-layer bridge is prone to: a field that
// exists on the C++ struct but never actually crosses one of the four layers,
// which the renderer's optional chaining (window.xleth?.timeline?.foo?.())
// turns into a silent no-op. Every assertion below reads the value BACK out of
// the engine — or off disk — rather than trusting a setter's return value.
//
//   1. the addon exports the entry point the panel calls,
//   2. a fresh slot reports the documented defaults (Off / 0 / fully wet), so
//      every pre-MANGLE project is unchanged,
//   3. mode / amount / mix round-trip per slot via timeline_getRegions(),
//   4. MANGLE is genuinely PER SLOT — writing slot 1 leaves slot 0 alone,
//   5. out-of-range writes are rejected (mode -> Off) or clamped (amount/mix),
//   6. undo/redo restores the exact prior triple,
//   7. save -> load round-trips it, and project.json really carries the keys,
//   8. a project file with slots but NO mangle keys loads as Off — the
//      backward-compatibility guarantee for existing projects.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_mangle_bridge.js
//

const path = require('path');
const fs   = require('fs');

// The addon links FFmpeg from the main engine build's vcpkg tree; a bare
// require() fails with ERR_DLOPEN_FAILED without those on PATH.
const repoRoot = path.resolve(__dirname, '..');
const dllDirs = [
  path.join(__dirname, 'build', 'Release'),
  path.join(repoRoot, 'build', 'vcpkg_installed', 'x64-windows', 'bin'),
  path.join(repoRoot, 'build', 'engine', 'Release'),
].filter((d) => fs.existsSync(d));
process.env.PATH = dllDirs.join(';') + ';' + process.env.PATH;

let passed = 0;
let failed = 0;
let total  = 0;

function assert(condition, label) {
  total++;
  if (condition) { console.log(`  PASS  ${label}`); passed++; }
  else           { console.error(`  FAIL  ${label}`); failed++; }
}

function near(actual, expected, tol, label) {
  assert(typeof actual === 'number' && Math.abs(actual - expected) <= tol,
    `${label} (expected ~${expected}, got ${actual})`);
}

// Resolve an addon export or THROW. The renderer swallows a missing method
// silently, so the one place that must not is this file.
function mustFn(addon, name) {
  const fn = addon[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `MISSING EXPORT: addon.${name} is ${typeof fn}. ` +
      `Add it to ui/rpc-manifest.js and re-run scripts/generate-rpc-registries.js.`);
  }
  return fn.bind(addon);
}

// Mode ids mirror xleth::mangle::Mode (engine/src/audio/MangleDsp.h).
const MODE_OFF        = 0;
const MODE_SYNC       = 1;
const MODE_QUANTIZE   = 11;
const MODE_LPF        = 14;
const MODE_TUBE       = 18;
const MODE_RM         = 35;
const MODE_COUNT      = 36;

function slotsOf(addon, regionId) {
  const r = addon.timeline_getRegions().find((x) => x.id === regionId);
  return (r && Array.isArray(r.slots)) ? r.slots : [];
}

function mangleOf(addon, regionId, slotIndex) {
  const s = slotsOf(addon, regionId)[slotIndex];
  if (!s) return null;
  return { mode: s.mangleMode, amount: s.mangleAmount, mix: s.mangleMix };
}

function setMangle(addon, regionId, slotIndex, patch) {
  addon.timeline_updateSamplerSettings(regionId, Object.assign({ slotIndex }, patch));
}

function main() {
  console.log('=== MANGLE bridge contract test ===\n');

  const addon = require('./build/Release/xleth_native.node');

  // ── 1. Addon surface ──────────────────────────────────────────────────────
  console.log('[ addon surface ]');
  const updateSampler = mustFn(addon, 'timeline_updateSamplerSettings');
  mustFn(addon, 'timeline_getRegions');
  mustFn(addon, 'timeline_addRegion');
  assert(typeof updateSampler === 'function',
    'addon exports timeline_updateSamplerSettings');

  assert(addon.initialize() === true, 'initialize() returns true');

  const PROJECT_DIR = path.resolve(__dirname, '_test_mangle');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.project_create(PROJECT_DIR, 'MangleTest') === true,
    'project_create() returns true');

  const regionId = addon.timeline_addRegion({ name: 'Mangle', startTime: 0, endTime: 2 });
  assert(regionId >= 0, `timeline_addRegion() -> regionId ${regionId}`);

  // ── 2. Defaults ───────────────────────────────────────────────────────────
  console.log('\n[ defaults on a fresh slot ]');
  const def = mangleOf(addon, regionId, 0);
  assert(def !== null, 'the region exposes a slots array with slot 0');
  assert(def && def.mode === MODE_OFF,
    `a fresh slot defaults to Off (got ${def && def.mode})`);
  assert(def && def.amount === 0,
    `a fresh slot defaults to amount 0 (got ${def && def.amount})`);
  assert(def && def.mix === 1,
    `a fresh slot defaults to fully wet mix 1 (got ${def && def.mix})`);

  // ── 3. Round-trip ─────────────────────────────────────────────────────────
  console.log('\n[ set -> read-back through the engine ]');
  for (const mode of [MODE_SYNC, MODE_QUANTIZE, MODE_LPF, MODE_TUBE, MODE_RM]) {
    setMangle(addon, regionId, 0, { mangleMode: mode });
    const got = mangleOf(addon, regionId, 0);
    assert(got && got.mode === mode,
      `mangleMode ${mode} round-trips (got ${got && got.mode})`);
  }

  setMangle(addon, regionId, 0, { mangleAmount: 0.75, mangleMix: 0.4 });
  {
    const got = mangleOf(addon, regionId, 0);
    near(got.amount, 0.75, 1e-6, 'mangleAmount 0.75 round-trips');
    near(got.mix,    0.40, 1e-6, 'mangleMix 0.4 round-trips');
    assert(got.mode === MODE_RM,
      `a partial patch leaves the other MANGLE keys alone (mode still ${MODE_RM}, got ${got.mode})`);
  }

  // A partial patch must not disturb unrelated slot state either.
  setMangle(addon, regionId, 0, { rootNote: 55 });
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got.mode === MODE_RM && Math.abs(got.amount - 0.75) < 1e-6,
      'patching an unrelated slot key leaves MANGLE untouched');
    assert(slotsOf(addon, regionId)[0].rootNote === 55,
      'the unrelated key itself still applied');
  }

  // ── 4. Per-slot isolation ─────────────────────────────────────────────────
  // MANGLE is per SLOT, so a second layer must carry its own settings. This is
  // the assertion that would fail if slotIndex were ignored and every write
  // landed on slot 0.
  console.log('\n[ per-slot isolation ]');
  const twoSlots = slotsOf(addon, regionId).slice();
  twoSlots.push(Object.assign({}, twoSlots[0], {
    mangleMode: MODE_OFF, mangleAmount: 0, mangleMix: 1,
  }));
  addon.timeline_updateSamplerSettings(regionId, { slots: twoSlots });
  assert(slotsOf(addon, regionId).length === 2, 'the region now has two slots');

  setMangle(addon, regionId, 1, { mangleMode: MODE_LPF, mangleAmount: 0.2, mangleMix: 0.9 });
  {
    const s0 = mangleOf(addon, regionId, 0);
    const s1 = mangleOf(addon, regionId, 1);
    assert(s1.mode === MODE_LPF, `slot 1 took the write (got ${s1.mode})`);
    near(s1.amount, 0.2, 1e-6, 'slot 1 amount');
    near(s1.mix,    0.9, 1e-6, 'slot 1 mix');
    assert(s0.mode === MODE_RM,
      `slot 0 was NOT disturbed by a slot-1 write (expected ${MODE_RM}, got ${s0.mode})`);
    near(s0.amount, 0.75, 1e-6, 'slot 0 amount was not disturbed');
  }

  // ── 5. Validation ─────────────────────────────────────────────────────────
  console.log('\n[ out-of-range input ]');
  setMangle(addon, regionId, 0, { mangleMode: 9999 });
  assert(mangleOf(addon, regionId, 0).mode === MODE_OFF,
    'an unknown mode id falls back to Off rather than picking some other effect');

  setMangle(addon, regionId, 0, { mangleMode: MODE_COUNT });
  assert(mangleOf(addon, regionId, 0).mode === MODE_OFF,
    'the one-past-the-end id is rejected too');

  setMangle(addon, regionId, 0, { mangleMode: -1 });
  assert(mangleOf(addon, regionId, 0).mode === MODE_OFF,
    'a negative mode id is rejected');

  setMangle(addon, regionId, 0, { mangleMode: MODE_TUBE, mangleAmount: 5, mangleMix: -3 });
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got.mode === MODE_TUBE, 'a valid mode still applies alongside bad neighbours');
    near(got.amount, 1, 1e-6, 'amount above 1 clamps to 1');
    near(got.mix,    0, 1e-6, 'mix below 0 clamps to 0');
  }

  // ── 6. Undo / redo ────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  setMangle(addon, regionId, 0, { mangleMode: MODE_SYNC, mangleAmount: 0.5, mangleMix: 1 });
  const before = mangleOf(addon, regionId, 0);
  assert(before.mode === MODE_SYNC, 'set(SYNC) applied');

  setMangle(addon, regionId, 0, { mangleMode: MODE_QUANTIZE, mangleAmount: 0.9, mangleMix: 0.3 });
  assert(mangleOf(addon, regionId, 0).mode === MODE_QUANTIZE, 'set(QUANTIZE) applied');

  addon.undo_undo();
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got.mode === before.mode, `undo restores the mode (got ${got.mode})`);
    near(got.amount, before.amount, 1e-6, 'undo restores the amount');
    near(got.mix,    before.mix,    1e-6, 'undo restores the mix');
  }

  addon.undo_redo();
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got.mode === MODE_QUANTIZE, `redo re-applies the mode (got ${got.mode})`);
    near(got.amount, 0.9, 1e-6, 'redo re-applies the amount');
    near(got.mix,    0.3, 1e-6, 'redo re-applies the mix');
  }

  // ── 7. Persistence ────────────────────────────────────────────────────────
  console.log('\n[ save -> load round-trip ]');
  setMangle(addon, regionId, 0, { mangleMode: MODE_TUBE, mangleAmount: 0.62, mangleMix: 0.81 });
  assert(addon.project_save() === true, 'project_save() returns true');

  const projectJsonPath = path.join(PROJECT_DIR, 'project.json');
  const saved = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  const savedRegion = (saved.regions || []).find((r) => r.id === regionId);
  const savedSlot = savedRegion && savedRegion.slots && savedRegion.slots[0];
  assert(!!savedSlot, 'project.json carries the region slots array');
  assert(savedSlot && savedSlot.mangleMode === MODE_TUBE,
    `project.json persists mangleMode (got ${savedSlot && savedSlot.mangleMode})`);
  near(savedSlot ? savedSlot.mangleAmount : NaN, 0.62, 1e-5,
    'project.json persists mangleAmount');
  near(savedSlot ? savedSlot.mangleMix : NaN, 0.81, 1e-5,
    'project.json persists mangleMix');

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() returns true');
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got && got.mode === MODE_TUBE,
      `mangleMode survives save -> load (got ${got && got.mode})`);
    near(got.amount, 0.62, 1e-5, 'mangleAmount survives save -> load');
    near(got.mix,    0.81, 1e-5, 'mangleMix survives save -> load');
    // Slot 1's own MANGLE must have survived independently.
    const s1 = mangleOf(addon, regionId, 1);
    assert(s1 && s1.mode === MODE_LPF,
      `slot 1 keeps its own mode across save -> load (got ${s1 && s1.mode})`);
  }

  // ── 8. Backward compatibility ─────────────────────────────────────────────
  // The real guarantee: a project written before MANGLE existed has no mangle
  // keys at all, and must load as Off — a genuine bypass, not some mode 0
  // that happens to do something.
  console.log('\n[ legacy project (no mangle keys) loads as Off ]');
  const legacy = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  for (const r of legacy.regions || []) {
    for (const s of r.slots || []) {
      delete s.mangleMode;
      delete s.mangleAmount;
      delete s.mangleMix;
    }
  }
  fs.writeFileSync(projectJsonPath, JSON.stringify(legacy, null, 2), 'utf8');
  assert(addon.project_load(PROJECT_DIR) === true,
    'project_load() of the legacy state returns true');
  {
    const got = mangleOf(addon, regionId, 0);
    assert(got && got.mode === MODE_OFF,
      `a slot with no mangle keys loads as Off (got ${got && got.mode})`);
    assert(got && got.amount === 0,
      `...with amount 0 (got ${got && got.amount})`);
    assert(got && got.mix === 1,
      `...and the fully-wet mix default (got ${got && got.mix})`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  if (fs.existsSync(PROJECT_DIR)) {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
