'use strict';
//
// bridge/test_hold_last_frame_threshold.js — end-to-end contract test for the
// per-track Hold Last Frame threshold (videoHoldLastFrameThresholdBeats).
//
// Covers the failure mode the four-layer bridge is prone to: a manifest entry
// that exists but never reaches the engine, which optional chaining in the
// renderer swallows silently. Every assertion here reads the value BACK out of
// the engine (or off disk) rather than trusting the setter's return.
//
//   1. the addon exports the new method,
//   2. set -> timeline_getTracks() reflects the new threshold,
//   3. unlimited is the sentinel for negative input and the default for a
//      freshly created track,
//   4. undo/redo restores the exact prior value including the sentinel,
//   5. save -> load round-trips the threshold,
//   6. a project file with videoHoldLastFrame but NO threshold key loads as
//      unlimited (the backward-compatibility guarantee for existing projects).
//
// Run after rebuilding the native addon:
//   cd bridge && node test_hold_last_frame_threshold.js
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

const UNLIMITED = -1;

function thresholdOf(addon, trackId) {
  const t = addon.timeline_getTracks().find(x => x.id === trackId);
  return t ? t.videoHoldLastFrameThresholdBeats : undefined;
}

async function main() {
  console.log('=== Hold Last Frame threshold contract test ===\n');

  const addon = require('./build/Release/xleth_native.node');

  console.log('[ addon surface ]');
  assert(typeof addon.timeline_setVideoHoldLastFrameThreshold === 'function',
    'addon exports timeline_setVideoHoldLastFrameThreshold');

  assert(addon.initialize() === true, 'initialize() returns true');

  const PROJECT_DIR = path.resolve(__dirname, '_test_hold_threshold');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.project_create(PROJECT_DIR, 'HoldThresholdTest') === true,
    'project_create() returns true');

  // ── 2/3. Set + read back through the real engine ─────────────────────────
  console.log('\n[ set -> read-back through the engine ]');
  const trackId = addon.timeline_addTrack({ name: 'Hold', order: 0 });

  assert(thresholdOf(addon, trackId) === UNLIMITED,
    `a new track defaults to unlimited (got ${thresholdOf(addon, trackId)})`);

  addon.timeline_setVideoHoldLastFrame(trackId, true);
  addon.timeline_setVideoHoldLastFrameThreshold(trackId, 4);
  assert(thresholdOf(addon, trackId) === 4,
    `set(4) -> getTracks() reports 4 (got ${thresholdOf(addon, trackId)})`);

  addon.timeline_setVideoHoldLastFrameThreshold(trackId, 0.5);
  assert(thresholdOf(addon, trackId) === 0.5,
    `fractional beats survive the round-trip (got ${thresholdOf(addon, trackId)})`);

  addon.timeline_setVideoHoldLastFrameThreshold(trackId, -7);
  assert(thresholdOf(addon, trackId) === UNLIMITED,
    `any negative input normalizes to the unlimited sentinel (got ${thresholdOf(addon, trackId)})`);

  addon.timeline_setVideoHoldLastFrameThreshold(trackId, 0);
  assert(thresholdOf(addon, trackId) === 0,
    `0 is a valid finite threshold, not unlimited (got ${thresholdOf(addon, trackId)})`);

  // ── 4. Undo / redo ────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  addon.timeline_setVideoHoldLastFrameThreshold(trackId, 8);
  assert(thresholdOf(addon, trackId) === 8, 'set(8) applied');
  addon.undo_undo();
  assert(thresholdOf(addon, trackId) === 0,
    `undo restores the prior value (expected 0, got ${thresholdOf(addon, trackId)})`);
  addon.undo_redo();
  assert(thresholdOf(addon, trackId) === 8,
    `redo re-applies (expected 8, got ${thresholdOf(addon, trackId)})`);

  // Undo back across the unlimited sentinel specifically.
  addon.timeline_setVideoHoldLastFrameThreshold(trackId, UNLIMITED);
  assert(thresholdOf(addon, trackId) === UNLIMITED, 'set(unlimited) applied');
  addon.undo_undo();
  assert(thresholdOf(addon, trackId) === 8,
    `undo off the sentinel restores 8 (got ${thresholdOf(addon, trackId)})`);
  addon.undo_redo();
  assert(thresholdOf(addon, trackId) === UNLIMITED,
    `redo restores the sentinel exactly (got ${thresholdOf(addon, trackId)})`);

  // ── 5. Persistence round-trip ─────────────────────────────────────────────
  console.log('\n[ save -> load round-trip ]');
  addon.timeline_setVideoHoldLastFrameThreshold(trackId, 2.5);
  assert(addon.project_save() === true, 'project_save() returns true');

  const projectJsonPath = path.join(PROJECT_DIR, 'project.json');
  const saved = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  const savedTrack = (saved.tracks || []).find(t => t.id === trackId);
  assert(savedTrack && savedTrack.videoHoldLastFrameThresholdBeats === 2.5,
    `project.json persists the threshold (got ${savedTrack && savedTrack.videoHoldLastFrameThresholdBeats})`);

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() returns true');
  assert(thresholdOf(addon, trackId) === 2.5,
    `threshold survives save -> load (got ${thresholdOf(addon, trackId)})`);

  // ── 6. Backward compatibility: legacy project without the key ─────────────
  console.log('\n[ legacy project (no threshold key) loads as unlimited ]');
  const legacy = JSON.parse(fs.readFileSync(projectJsonPath, 'utf8'));
  let strippedCount = 0;
  for (const t of legacy.tracks || []) {
    if ('videoHoldLastFrameThresholdBeats' in t) {
      delete t.videoHoldLastFrameThresholdBeats;
      strippedCount++;
    }
    // Keep hold ON so this exercises the real "existing project with
    // hold-last-frame enabled" case, not just a default-off track.
    t.videoHoldLastFrame = true;
  }
  assert(strippedCount > 0, `stripped the threshold key from ${strippedCount} track(s)`);
  fs.writeFileSync(projectJsonPath, JSON.stringify(legacy, null, 2), 'utf8');

  assert(addon.project_load(PROJECT_DIR) === true, 'project_load() of the legacy file returns true');
  const legacyTrack = addon.timeline_getTracks().find(x => x.id === trackId);
  assert(legacyTrack && legacyTrack.videoHoldLastFrame === true,
    'legacy track still has Hold Last Frame enabled');
  assert(legacyTrack && legacyTrack.videoHoldLastFrameThresholdBeats === UNLIMITED,
    `legacy track loads as unlimited (got ${legacyTrack && legacyTrack.videoHoldLastFrameThresholdBeats})`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n=== ${passed}/${total} passed, ${failed} failed ===`);
  if (fs.existsSync(PROJECT_DIR)) {
    try { fs.rmSync(PROJECT_DIR, { recursive: true, force: true }); } catch { /* leave it */ }
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
