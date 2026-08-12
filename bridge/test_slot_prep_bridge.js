'use strict';
//
// bridge/test_slot_prep_bridge.js — per-slot PREP + loop-mode bridge surface
//
// The four-layer bridge reaches the renderer through optional chaining
// (window.xleth?.timeline?.foo?.()), so a method missing from the manifest is
// `undefined` and every call on it is a silent no-op — a dead UI control that
// looks wired. This file therefore resolves every export through mustFn(),
// which THROWS rather than skipping, and asserts that each new field actually
// round-trips through the engine instead of being quietly dropped.
//
// Verifies:
//   1. timeline_getSlotBakeStatus EXISTS and returns the documented shape
//   2. the five new SampleSlot fields (loopMode, exitLoopOnRelease,
//      prepAlgorithm, prepStretch, prepShiftCents) survive write → read
//   3. they survive a project save → load round trip (the persistence
//      whitelist is hand-maintained; an unlisted key is silently dropped)
//   4. out-of-range values are clamped rather than stored raw
//   5. getRegionAudioInfo reports the new `prepared` flag
//
// Run after rebuilding the native addon:
//   node bridge/test_slot_prep_bridge.js

const path = require('path');
const fs   = require('fs');
const os   = require('os');

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

// ── Setup ───────────────────────────────────────────────────────────────────

group('init');
ok(addon.initialize() === true, 'initialize() returns true');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-slotprep-'));
const projDir = path.join(tmpRoot, 'proj');

const createProject = mustFn('project_create');
const saveProject   = mustFn('project_save');
const loadProject   = mustFn('project_load');
const addRegion     = mustFn('timeline_addRegion');
const getRegions    = mustFn('timeline_getRegions');
const updateSampler = mustFn('timeline_updateSamplerSettings');
const audioInfo     = mustFn('timeline_getRegionAudioInfo');

// The whole point of this file — a missing export throws here, loudly.
const bakeStatus    = mustFn('timeline_getSlotBakeStatus');
ok(true, 'timeline_getSlotBakeStatus is exported by the addon');

ok(createProject(projDir, 'SlotPrepSmoke') === true, 'project_create succeeds');

const regionId = addRegion({ name: 'prep-probe', startTime: 0, endTime: 1 });
ok(typeof regionId === 'number' && regionId >= 0,
   `timeline_addRegion returned a region id (${regionId})`);

const findRegion = () => getRegions().find((r) => r.id === regionId);
const slot0 = () => {
  const r = findRegion();
  return (r && Array.isArray(r.slots) && r.slots[0]) || {};
};

// ── 1. getSlotBakeStatus shape ──────────────────────────────────────────────

group('timeline_getSlotBakeStatus');
{
  const st = bakeStatus(regionId);
  ok(st && typeof st === 'object', 'returns an object');
  ok(Array.isArray(st.pending),    'has a `pending` array');
  ok(typeof st.changed === 'boolean', 'has a `changed` boolean');
  // A region with no audio and bypassed PREP has nothing queued.
  ok(st.pending.length === 0, 'no bakes pending for an untouched region');

  const all = bakeStatus();      // no filter — must not throw
  ok(all && Array.isArray(all.pending), 'callable with no regionId filter');
}

// ── 2. New slot fields round-trip ───────────────────────────────────────────

group('slot field round-trip');
{
  updateSampler(regionId, {
    slotIndex: 0,
    loopMode: 1,                 // PingPong
    exitLoopOnRelease: true,
    prepAlgorithm: 5,            // WORLD
    prepStretch: 1.5,
    prepShiftCents: -350,
  });

  const s = slot0();
  ok(s.loopMode === 1,               `loopMode round-trips (got ${s.loopMode})`);
  ok(s.exitLoopOnRelease === true,   `exitLoopOnRelease round-trips (got ${s.exitLoopOnRelease})`);
  ok(s.prepAlgorithm === 5,          `prepAlgorithm round-trips (got ${s.prepAlgorithm})`);
  ok(Math.abs(s.prepStretch - 1.5) < 1e-5,
     `prepStretch round-trips (got ${s.prepStretch})`);
  ok(Math.abs(s.prepShiftCents - (-350)) < 1e-3,
     `prepShiftCents round-trips (got ${s.prepShiftCents})`);
}

// ── 3. Clamping ─────────────────────────────────────────────────────────────

group('clamping');
{
  updateSampler(regionId, {
    slotIndex: 0,
    loopMode: 99,                // out of range → Forward
    prepAlgorithm: 0,            // Global is not a renderer → clamped up
    prepStretch: 99,             // → 4.0
    prepShiftCents: -99999,      // → -2400
  });
  const s = slot0();
  ok(s.loopMode === 0,       `loopMode 99 clamps to Forward (got ${s.loopMode})`);
  ok(s.prepAlgorithm === 1,  `prepAlgorithm 0 clamps to PSOLA (got ${s.prepAlgorithm})`);
  ok(Math.abs(s.prepStretch - 4.0) < 1e-5,
     `prepStretch 99 clamps to 4.0 (got ${s.prepStretch})`);
  ok(Math.abs(s.prepShiftCents - (-2400)) < 1e-3,
     `prepShiftCents -99999 clamps to -2400 (got ${s.prepShiftCents})`);
}

// ── 4. Persistence ──────────────────────────────────────────────────────────
// project.json serialization is a hand-maintained key list; a field left out
// of it is dropped on save with no error anywhere. This is the check for that.

group('save / load persistence');
{
  updateSampler(regionId, {
    slotIndex: 0,
    loopMode: 2,                 // Reverse
    exitLoopOnRelease: true,
    prepAlgorithm: 3,            // WSOLA
    prepStretch: 0.75,
    prepShiftCents: 1200,
  });
  ok(saveProject() === true, 'project_save succeeds');
  ok(loadProject(projDir) === true, 'project_load succeeds');

  const s = slot0();
  ok(s.loopMode === 2,             `loopMode survives save/load (got ${s.loopMode})`);
  ok(s.exitLoopOnRelease === true, `exitLoopOnRelease survives save/load (got ${s.exitLoopOnRelease})`);
  ok(s.prepAlgorithm === 3,        `prepAlgorithm survives save/load (got ${s.prepAlgorithm})`);
  ok(Math.abs(s.prepStretch - 0.75) < 1e-5,
     `prepStretch survives save/load (got ${s.prepStretch})`);
  ok(Math.abs(s.prepShiftCents - 1200) < 1e-3,
     `prepShiftCents survives save/load (got ${s.prepShiftCents})`);
}

// ── 5. getRegionAudioInfo exposes the prepared flag ─────────────────────────

group('getRegionAudioInfo');
{
  const ai = audioInfo(regionId, 0);
  ok(ai && typeof ai === 'object', 'returns an object');
  ok(typeof ai.prepared === 'boolean',
     `reports a \`prepared\` flag (got ${typeof ai.prepared})`);
  ok('rawNumSamples' in ai, 'reports rawNumSamples alongside numSamples');
  // No PCM is loaded for this synthetic region, so nothing can be baked yet.
  ok(ai.prepared === false, 'prepared=false when the slot has no audio to bake');
}

// ── Teardown ────────────────────────────────────────────────────────────────

group('shutdown');
try { addon.shutdown(); ok(true, 'shutdown() completed'); }
catch (e) { ok(false, `shutdown() threw: ${e.message}`); }

try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

console.log('\n--------------------------------------------------');
console.log(`${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${passed + failed} tests`);
process.exit(failed === 0 ? 0 : 1);
