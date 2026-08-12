'use strict';
//
// bridge/test_mangle_bridge.js — end-to-end contract test for the MANGLE chain,
// the ordered per-note per-slot warp-FX stack.
//
// Covers the failure mode this four-layer bridge is prone to: a field that
// exists on the C++ struct but never actually crosses one of the four layers,
// which the renderer's optional chaining (window.xleth?.timeline?.foo?.())
// turns into a silent no-op. Every assertion below reads the value BACK out of
// the engine — or off disk — rather than trusting a setter's return value.
//
//   1. the addon exports the entry point the panel calls,
//   2. a fresh slot reports an EMPTY chain, so every pre-MANGLE project is
//      unchanged,
//   3. a whole ordered chain (mode/amount/mix/bypass per instance) round-trips
//      per slot via timeline_getRegions(), ORDER preserved,
//   4. the chain is genuinely PER SLOT — writing slot 1 leaves slot 0 alone,
//   5. out-of-range writes are rejected (mode -> Off), clamped (amount/mix) and
//      capped (a >4-instance chain is truncated to 4),
//   6. undo/redo restores the exact prior chain,
//   7. save -> load round-trips it, and project.json really carries mangleChain,
//   8. a LEGACY project file (single mangleMode/amount/mix, no mangleChain)
//      migrates on load to a one-instance chain, and a slot with no MANGLE keys
//      at all loads as an empty chain — the backward-compatibility guarantee.
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

const MANGLE_MAX = 4;   // mirrors xleth::mangle::kMaxInstances

function slotsOf(addon, regionId) {
  const r = addon.timeline_getRegions().find((x) => x.id === regionId);
  return (r && Array.isArray(r.slots)) ? r.slots : [];
}

// The slot's MANGLE chain as an array of { mode, amount, mix, bypass }.
function chainOf(addon, regionId, slotIndex) {
  const s = slotsOf(addon, regionId)[slotIndex];
  if (!s) return null;
  return Array.isArray(s.mangleChain) ? s.mangleChain : null;
}

function ci(mode, amount = 0, mix = 1, bypass = false) {
  return { mode, amount, mix, bypass };
}

function setChain(addon, regionId, slotIndex, chain) {
  addon.timeline_updateSamplerSettings(regionId, { slotIndex, mangleChain: chain });
}

function setSlotKey(addon, regionId, slotIndex, patch) {
  addon.timeline_updateSamplerSettings(regionId, Object.assign({ slotIndex }, patch));
}

// Deep-equal a read-back chain against an expected one (order-sensitive).
function chainEquals(got, expected) {
  if (!Array.isArray(got) || got.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) {
    const a = got[i], b = expected[i];
    if (!a || a.mode !== b.mode || !!a.bypass !== !!b.bypass) return false;
    if (Math.abs(a.amount - b.amount) > 1e-5) return false;
    if (Math.abs(a.mix - b.mix) > 1e-5) return false;
  }
  return true;
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
  const def = chainOf(addon, regionId, 0);
  assert(def !== null, 'the region exposes a slots array with slot 0 carrying a mangleChain');
  assert(Array.isArray(def) && def.length === 0,
    `a fresh slot defaults to an EMPTY chain (got ${JSON.stringify(def)})`);

  // ── 3. Whole-chain round-trip, order preserved ────────────────────────────
  console.log('\n[ set -> read-back through the engine ]');
  const chainA = [
    ci(MODE_TUBE, 0.8, 1.0, false),
    ci(MODE_LPF,  0.3, 0.9, false),
    ci(MODE_RM,   0.5, 0.7, true),
  ];
  setChain(addon, regionId, 0, chainA);
  {
    const got = chainOf(addon, regionId, 0);
    assert(chainEquals(got, chainA),
      `a 3-instance chain round-trips in order (got ${JSON.stringify(got)})`);
    assert(got[2].bypass === true, 'the bypass flag round-trips per instance');
  }

  // Reorder is just a different array — the engine keeps whatever order it is given.
  const chainReordered = [chainA[1], chainA[0], chainA[2]];
  setChain(addon, regionId, 0, chainReordered);
  assert(chainEquals(chainOf(addon, regionId, 0), chainReordered),
    'reordering the chain round-trips with the new order');

  // A partial patch to an unrelated key must not disturb the chain.
  setSlotKey(addon, regionId, 0, { rootNote: 55 });
  {
    const got = chainOf(addon, regionId, 0);
    assert(chainEquals(got, chainReordered),
      'patching an unrelated slot key leaves the MANGLE chain untouched');
    assert(slotsOf(addon, regionId)[0].rootNote === 55, 'the unrelated key itself still applied');
  }

  // ── 4. Per-slot isolation ─────────────────────────────────────────────────
  console.log('\n[ per-slot isolation ]');
  const twoSlots = slotsOf(addon, regionId).slice();
  twoSlots.push(Object.assign({}, twoSlots[0], { mangleChain: [] }));
  addon.timeline_updateSamplerSettings(regionId, { slots: twoSlots });
  assert(slotsOf(addon, regionId).length === 2, 'the region now has two slots');

  const slot1Chain = [ci(MODE_SYNC, 0.2, 0.9, false)];
  setChain(addon, regionId, 1, slot1Chain);
  {
    const s0 = chainOf(addon, regionId, 0);
    const s1 = chainOf(addon, regionId, 1);
    assert(chainEquals(s1, slot1Chain), `slot 1 took the write (got ${JSON.stringify(s1)})`);
    assert(chainEquals(s0, chainReordered),
      `slot 0's chain was NOT disturbed by a slot-1 write (got ${JSON.stringify(s0)})`);
  }

  // ── 5. Validation: bad ids, clamping and the 4-instance cap ───────────────
  console.log('\n[ out-of-range input + cap ]');
  setChain(addon, regionId, 0, [ci(9999, 0.5, 0.5)]);
  assert(chainOf(addon, regionId, 0)[0].mode === MODE_OFF,
    'an unknown mode id falls back to Off rather than picking some other effect');

  setChain(addon, regionId, 0, [ci(MODE_TUBE, 5, -3)]);
  {
    const got = chainOf(addon, regionId, 0)[0];
    assert(got.mode === MODE_TUBE, 'a valid mode applies');
    near(got.amount, 1, 1e-6, 'amount above 1 clamps to 1');
    near(got.mix,    0, 1e-6, 'mix below 0 clamps to 0');
  }

  const sixChain = [];
  for (let i = 0; i < 6; i++) sixChain.push(ci(MODE_LPF, 0.5, 1.0));
  setChain(addon, regionId, 0, sixChain);
  assert(chainOf(addon, regionId, 0).length === MANGLE_MAX,
    `a >4-instance chain is capped to ${MANGLE_MAX} (got ${chainOf(addon, regionId, 0).length})`);

  // ── 6. Undo / redo ────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  const beforeChain = [ci(MODE_SYNC, 0.5, 1.0)];
  setChain(addon, regionId, 0, beforeChain);
  assert(chainEquals(chainOf(addon, regionId, 0), beforeChain), 'set(SYNC chain) applied');

  const afterChain = [ci(MODE_QUANTIZE, 0.9, 0.3), ci(MODE_TUBE, 0.4, 1.0)];
  setChain(addon, regionId, 0, afterChain);
  assert(chainEquals(chainOf(addon, regionId, 0), afterChain), 'set(2-instance chain) applied');

  addon.undo_undo();
  assert(chainEquals(chainOf(addon, regionId, 0), beforeChain),
    `undo restores the prior chain (got ${JSON.stringify(chainOf(addon, regionId, 0))})`);

  addon.undo_redo();
  assert(chainEquals(chainOf(addon, regionId, 0), afterChain),
    `redo re-applies the chain (got ${JSON.stringify(chainOf(addon, regionId, 0))})`);

  // ── 7. Persistence ────────────────────────────────────────────────────────
  console.log('\n[ save -> load round-trip ]');
  const persistChain = [ci(MODE_TUBE, 0.62, 0.81, false), ci(MODE_LPF, 0.4, 1.0, true)];
  setChain(addon, regionId, 0, persistChain);
  assert(addon.project_save() === true, 'project_save() returns true');

  const projectJsonPath = path.join(PROJECT_DIR, 'project.json');
  const saved = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  const savedRegion = (saved.regions || []).find((r) => r.id === regionId);
  const savedSlot = savedRegion && savedRegion.slots && savedRegion.slots[0];
  assert(!!savedSlot, 'project.json carries the region slots array');
  assert(savedSlot && Array.isArray(savedSlot.mangleChain) && savedSlot.mangleChain.length === 2,
    `project.json persists the mangleChain array (got ${savedSlot && JSON.stringify(savedSlot.mangleChain)})`);
  assert(savedSlot && savedSlot.mangleChain[0].mode === MODE_TUBE
    && savedSlot.mangleChain[1].bypass === true,
    'project.json preserves per-instance mode + bypass');
  assert(saved.schema_version >= 5, `project.json schema_version is >= 5 (got ${saved.schema_version})`);

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() returns true');
  {
    const got = chainOf(addon, regionId, 0);
    assert(chainEquals(got, persistChain),
      `the chain survives save -> load (got ${JSON.stringify(got)})`);
    // Slot 1's own chain must have survived independently.
    assert(chainEquals(chainOf(addon, regionId, 1), slot1Chain),
      `slot 1 keeps its own chain across save -> load (got ${JSON.stringify(chainOf(addon, regionId, 1))})`);
  }

  // ── 8. Backward compatibility + migration ─────────────────────────────────
  // A schema<=4 project stored ONE MANGLE as flat mangleMode/amount/mix keys.
  // Loading migrates that to a one-instance chain with identical values; a slot
  // with NO mangle keys at all migrates to an empty chain.
  console.log('\n[ legacy single-MANGLE migrates to a one-instance chain ]');
  const legacy = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  legacy.regions.forEach((r, ri) => {
    (r.slots || []).forEach((s, si) => {
      delete s.mangleChain;
      if (ri === 0 && si === 0) {
        // Slot 0: a legacy single MANGLE.
        s.mangleMode = MODE_TUBE; s.mangleAmount = 0.62; s.mangleMix = 0.81;
      }
      // Every other slot: no mangle keys at all (pre-MANGLE).
    });
  });
  fs.writeFileSync(projectJsonPath, JSON.stringify(legacy, null, 2), 'utf8');
  assert(addon.project_load(PROJECT_DIR) === true,
    'project_load() of the legacy state returns true');
  {
    const got = chainOf(addon, regionId, 0);
    assert(chainEquals(got, [ci(MODE_TUBE, 0.62, 0.81, false)]),
      `a legacy single MANGLE migrates to a one-instance chain (got ${JSON.stringify(got)})`);
    const s1 = chainOf(addon, regionId, 1);
    assert(Array.isArray(s1) && s1.length === 0,
      `a slot with no mangle keys migrates to an empty chain (got ${JSON.stringify(s1)})`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  if (fs.existsSync(PROJECT_DIR)) {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  }
  process.exit(failed === 0 ? 0 : 1);
}

main();
