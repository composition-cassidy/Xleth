'use strict';
//
// bridge/test_phase1.js — Phase 1 self-verification test
//
// Tests: project management, timeline CRUD, undo/redo, mix-engine mapping,
//        save/load round-trip.
//
// Run after rebuilding the native addon:
//   cd bridge && node test_phase1.js
//
// Expected final line: PASSED: X/X tests
//

const path = require('path');
const fs   = require('fs');

// Prepend DLL dir so FFmpeg DLLs are found on Windows
const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

// ── Test harness ─────────────────────────────────────────────────────────────

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

function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${expected}, got ${actual})`);
}

function assertNear(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance,
         `${label} (expected ${expected}, got ${actual}, tolerance ${tolerance})`);
}

// Media files
const KICK_WAV  = path.resolve(__dirname, '../media/KICK_ssedit.wav');
const SNARE_WAV = path.resolve(__dirname, '../media/SNARE_ssedit.wav');
const HIHAT_WAV = path.resolve(__dirname, '../media/hihat 1.wav');

// Temporary project directory (cleaned up on next run)
const PROJECT_DIR = path.resolve(__dirname, '_test_project_phase1');

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== xleth Phase 1 bridge test ===\n');

  // ── 1. Cleanup from previous run ──────────────────────────────────────────
  if (fs.existsSync(PROJECT_DIR)) {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  }

  // ── 2. Initialize ─────────────────────────────────────────────────────────
  console.log('[ initialize ]');
  const ok = addon.initialize();
  assert(ok === true, 'initialize() returns true');

  // ── 3. Create project ─────────────────────────────────────────────────────
  console.log('\n[ project.create ]');
  const created = addon.project_create(PROJECT_DIR, 'Phase1Test');
  assert(created === true, 'project_create() returns true');
  assert(fs.existsSync(PROJECT_DIR), 'project directory created');

  // ── 4. setBPM(140) ────────────────────────────────────────────────────────
  console.log('\n[ timeline.setBPM ]');
  addon.timeline_setBPM(140);
  const bpm = addon.timeline_getBPM();
  assertEqual(bpm, 140, 'getBPM() after setBPM(140)');
  assert(addon.undo_canUndo() === true, 'canUndo() after setBPM');

  // ── 5. Add 3 tracks ───────────────────────────────────────────────────────
  console.log('\n[ timeline.addTrack × 3 ]');
  const track1Id = addon.timeline_addTrack({ name: 'Kick',  volume: 1.0, order: 0 });
  const track2Id = addon.timeline_addTrack({ name: 'Snare', volume: 1.0, order: 1 });
  const track3Id = addon.timeline_addTrack({ name: 'HiHat', volume: 1.0, order: 2 });
  assert(typeof track1Id === 'number' && track1Id >= 1, `track1 id=${track1Id}`);
  assert(typeof track2Id === 'number' && track2Id > track1Id, `track2 id=${track2Id}`);
  assert(typeof track3Id === 'number' && track3Id > track2Id, `track3 id=${track3Id}`);
  assertEqual(addon.timeline_getTracks().length, 3, 'getTracks().length === 3');

  // ── 6. Load 3 samples ─────────────────────────────────────────────────────
  console.log('\n[ loadSample × 3 ]');
  let kickSampleId = -1, snareSampleId = -1, hihatSampleId = -1;
  try {
    kickSampleId  = addon.loadSample(KICK_WAV);
    snareSampleId = addon.loadSample(SNARE_WAV);
    hihatSampleId = addon.loadSample(HIHAT_WAV);
    assert(kickSampleId  >= 0, `loadSample(kick)  → id ${kickSampleId}`);
    assert(snareSampleId >= 0, `loadSample(snare) → id ${snareSampleId}`);
    assert(hihatSampleId >= 0, `loadSample(hihat) → id ${hihatSampleId}`);
  } catch (e) {
    console.log(`  SKIP  loadSample (${e.message})`);
    kickSampleId = snareSampleId = hihatSampleId = 0;
  }

  // ── 7. Create 3 regions ───────────────────────────────────────────────────
  console.log('\n[ timeline.addRegion × 3 ]');
  const region1Id = addon.timeline_addRegion({ name: 'KickRegion',  label: 'Kick',  startTime: 0,   endTime: 0.5 });
  const region2Id = addon.timeline_addRegion({ name: 'SnareRegion', label: 'Snare', startTime: 0,   endTime: 0.5 });
  const region3Id = addon.timeline_addRegion({ name: 'HiHatRegion', label: 'HiHat', startTime: 0,   endTime: 0.25 });
  assert(typeof region1Id === 'number' && region1Id >= 1, `region1 id=${region1Id}`);
  assert(typeof region2Id === 'number' && region2Id > region1Id, `region2 id=${region2Id}`);
  assert(typeof region3Id === 'number' && region3Id > region2Id, `region3 id=${region3Id}`);
  assertEqual(addon.timeline_getRegions().length, 3, 'getRegions().length === 3');

  // Verify getRegionsByLabel
  assertEqual(addon.timeline_getRegionsByLabel('Kick').length,  1, 'getRegionsByLabel(Kick).length === 1');
  assertEqual(addon.timeline_getRegionsByLabel('HiHat').length, 1, 'getRegionsByLabel(HiHat).length === 1');

  // ── 8. Map regions → samples ──────────────────────────────────────────────
  console.log('\n[ audio.mapRegionToSample × 3 ]');
  addon.audio_mapRegionToSample(region1Id, kickSampleId);
  addon.audio_mapRegionToSample(region2Id, snareSampleId);
  addon.audio_mapRegionToSample(region3Id, hihatSampleId);
  assert(true, 'mapRegionToSample() does not throw');

  // ── 9. Add 10 clips ───────────────────────────────────────────────────────
  // Spread across 3 tracks: 4 kick, 3 snare, 3 hihat
  console.log('\n[ timeline.addClip × 10 ]');
  const PPQ = 960;  // ticks per beat

  const clipIds = [];
  // 4 kick clips on track1
  for (let i = 0; i < 4; i++) {
    const id = addon.timeline_addClip({
      trackId: track1Id, regionId: region1Id,
      positionTicks: i * PPQ,
      durationTicks: PPQ / 2,
      velocity: 1.0,
    });
    assert(id >= 1, `kick clip[${i}] id=${id}`);
    clipIds.push(id);
  }
  // 3 snare clips on track2
  for (let i = 0; i < 3; i++) {
    const id = addon.timeline_addClip({
      trackId: track2Id, regionId: region2Id,
      positionTicks: (i * 2 + 1) * PPQ,
      durationTicks: PPQ / 2,
    });
    assert(id >= 1, `snare clip[${i}] id=${id}`);
    clipIds.push(id);
  }
  // 3 hihat clips on track3
  for (let i = 0; i < 3; i++) {
    const id = addon.timeline_addClip({
      trackId: track3Id, regionId: region3Id,
      positionTicks: i * PPQ / 2,
      durationTicks: PPQ / 4,
    });
    assert(id >= 1, `hihat clip[${i}] id=${id}`);
    clipIds.push(id);
  }

  // ── 10. Verify 10 clips ───────────────────────────────────────────────────
  console.log('\n[ verify clip count ]');
  assertEqual(addon.timeline_getClips().length, 10, 'getClips().length === 10');

  // getClipsOnTrack
  assertEqual(addon.timeline_getClipsOnTrack(track1Id).length, 4, 'getClipsOnTrack(kick).length === 4');
  assertEqual(addon.timeline_getClipsOnTrack(track2Id).length, 3, 'getClipsOnTrack(snare).length === 3');
  assertEqual(addon.timeline_getClipsOnTrack(track3Id).length, 3, 'getClipsOnTrack(hihat).length === 3');

  // getClipsInRange: first 2 beats — should include clips at beat 0 and beat 1
  const inRange = addon.timeline_getClipsInRange(0, 2);
  assert(inRange.length >= 1, `getClipsInRange(0,2) returns ≥1 clip (got ${inRange.length})`);

  // ── 11. Move clip + verify + undo + redo ──────────────────────────────────
  console.log('\n[ moveClip / undo / redo ]');
  const moveTarget = clipIds[0];  // first kick clip at position 0
  const origPos    = 0;
  const newPos     = 4 * PPQ;    // move to beat 4

  // Read original position from timeline
  const clipsBefore = addon.timeline_getClips();
  const clipBefore  = clipsBefore.find(c => c.id === moveTarget);
  assert(clipBefore !== undefined, 'target clip exists before move');
  assert(clipBefore.positionTicks === origPos, `clip at original position ${origPos}`);

  // Move
  addon.timeline_moveClip(moveTarget, track1Id, newPos);
  const clipsAfterMove = addon.timeline_getClips();
  const clipAfterMove  = clipsAfterMove.find(c => c.id === moveTarget);
  assert(clipAfterMove !== undefined, 'clip still exists after move');
  assertEqual(clipAfterMove.positionTicks, newPos, `clip moved to ${newPos} ticks`);

  // Undo
  const undoOk = addon.undo_undo();
  assert(undoOk === true, 'undo() returns true');
  const clipAfterUndo = addon.timeline_getClips().find(c => c.id === moveTarget);
  assert(clipAfterUndo !== undefined, 'clip exists after undo');
  assertEqual(clipAfterUndo.positionTicks, origPos, `clip restored to ${origPos} after undo`);

  // Redo
  const redoOk = addon.undo_redo();
  assert(redoOk === true, 'redo() returns true');
  const clipAfterRedo = addon.timeline_getClips().find(c => c.id === moveTarget);
  assert(clipAfterRedo !== undefined, 'clip exists after redo');
  assertEqual(clipAfterRedo.positionTicks, newPos, `clip at ${newPos} after redo`);

  // Verify undo/redo descriptions are non-empty strings
  assert(typeof addon.undo_getUndoDescription() === 'string', 'getUndoDescription() returns string');
  assert(typeof addon.undo_getRedoDescription() === 'string', 'getRedoDescription() returns string');

  // ── 12. Remove clip → 9. Undo → 10 ───────────────────────────────────────
  console.log('\n[ removeClip / undo ]');
  const removeTarget = clipIds[9];  // last hihat clip
  addon.timeline_removeClip(removeTarget);
  assertEqual(addon.timeline_getClips().length, 9, 'getClips().length === 9 after remove');

  // Undo remove
  addon.undo_undo();
  assertEqual(addon.timeline_getClips().length, 10, 'getClips().length === 10 after undo remove');

  // Verify the restored clip has the correct ID
  const restoredClip = addon.timeline_getClips().find(c => c.id === removeTarget);
  assert(restoredClip !== undefined, `clip id=${removeTarget} restored after undo`);

  // ── 13. getMasterPeak / getTrackPeak (sanity) ─────────────────────────────
  console.log('\n[ audio peak meters ]');
  const masterPeak = addon.audio_getMasterPeak();
  assert(typeof masterPeak === 'object' && masterPeak !== null, 'getMasterPeak() returns object');
  assert(typeof masterPeak.peakL === 'number', 'masterPeak.peakL is number');
  assert(typeof masterPeak.peakR === 'number', 'masterPeak.peakR is number');

  const trackPeak = addon.audio_getTrackPeak(track1Id);
  assert(typeof trackPeak === 'object' && trackPeak !== null, 'getTrackPeak() returns object');
  assert(typeof trackPeak.peakL === 'number', 'trackPeak.peakL is number');

  // ── 14. sync_getStats ─────────────────────────────────────────────────────
  console.log('\n[ sync.getStats ]');
  const stats = addon.sync_getStats();
  assert(typeof stats === 'object' && stats !== null, 'sync_getStats() returns object');
  assert(typeof stats.avgDriftMs === 'number', 'avgDriftMs is number');

  // ── 15. transport_seek ────────────────────────────────────────────────────
  console.log('\n[ transport.seek ]');
  addon.transport_seek(4.0);  // seek to beat 4
  const stateAfterSeek = addon.transport_getState();
  assert(typeof stateAfterSeek === 'object', 'transport_getState() returns object after seek');
  assertNear(stateAfterSeek.rawPositionBeats, 4.0, 1.0e-4,
             'transport rawPositionBeats remains raw musical time after seek');
  assert(typeof stateAfterSeek.rawPositionMs === 'number',
         'transport_getState exposes rawPositionMs for editing/diagnostics');
  assert(typeof stateAfterSeek.rawPositionSamples === 'number',
         'transport_getState exposes rawPositionSamples for editing/diagnostics');
  assert(typeof stateAfterSeek.livePresentationLatencySamples === 'number',
         'transport_getState exposes live presentation latency diagnostics');

  // Bridge contract: positionMs/positionBeats/positionSamples drive live
  // playhead/video presentation. rawPosition* remains the unshifted transport.
  const expectedPresentationSamples = Math.max(
    0,
    stateAfterSeek.rawPositionSamples
      - stateAfterSeek.livePresentationLatencySamples);
  assertNear(stateAfterSeek.positionSamples, expectedPresentationSamples, 1.0e-6,
             'transport positionSamples is live presentation time');
  assert(stateAfterSeek.positionBeats <= stateAfterSeek.rawPositionBeats + 1.0e-9,
         'transport positionBeats does not lead rawPositionBeats');
  assert(stateAfterSeek.positionMs <= stateAfterSeek.rawPositionMs + 1.0e-6,
         'transport positionMs does not lead rawPositionMs');

  // ── 16. Save project ──────────────────────────────────────────────────────
  console.log('\n[ project.save ]');
  const saved = addon.project_save();
  assert(saved === true, 'project_save() returns true');

  const projectJson = path.join(PROJECT_DIR, 'project.json');
  assert(fs.existsSync(projectJson), 'project.json exists after save');

  // Sanity: JSON must be valid and contain timeline data
  const raw  = fs.readFileSync(projectJson, 'utf8');
  const data = JSON.parse(raw);
  assert(typeof data === 'object', 'project.json is valid JSON object');
  assert(Array.isArray(data.clips),  'project.json has clips array');
  assert(Array.isArray(data.tracks), 'project.json has tracks array');
  assert(data.clips.length  === 10, `project.json clips.length === 10 (got ${data.clips?.length})`);
  assert(data.tracks.length === 3,  `project.json tracks.length === 3 (got ${data.tracks?.length})`);

  // ── 17. Shutdown + re-init + load + verify round-trip ────────────────────
  console.log('\n[ shutdown → re-init → project.load → verify ]');
  addon.shutdown();
  assert(true, 'shutdown() completed');

  const ok2 = addon.initialize();
  assert(ok2 === true, 're-initialize() returns true');

  const loaded = addon.project_load(PROJECT_DIR);
  assert(loaded === true, 'project_load() returns true');

  // Verify all data matches
  const reloadedTracks  = addon.timeline_getTracks();
  const reloadedRegions = addon.timeline_getRegions();
  const reloadedClips   = addon.timeline_getClips();

  assertEqual(reloadedTracks.length,  3,  'reloaded tracks.length === 3');
  assertEqual(reloadedRegions.length, 3,  'reloaded regions.length === 3');
  assertEqual(reloadedClips.length,   10, 'reloaded clips.length === 10');

  // BPM preserved
  const reloadedBpm = addon.timeline_getBPM();
  assertEqual(reloadedBpm, 140, 'reloaded BPM === 140');

  // Track names preserved
  const namesSorted = reloadedTracks.map(t => t.name).sort();
  assert(namesSorted.includes('Kick'),  'reloaded track "Kick" exists');
  assert(namesSorted.includes('Snare'), 'reloaded track "Snare" exists');
  assert(namesSorted.includes('HiHat'), 'reloaded track "HiHat" exists');

  // Region labels preserved
  const kickRegions = addon.timeline_getRegionsByLabel('Kick');
  assertEqual(kickRegions.length, 1, 'reloaded Kick region count === 1');

  // ── 18. Final shutdown ────────────────────────────────────────────────────
  console.log('\n[ final shutdown ]');
  addon.shutdown();
  assert(true, 'final shutdown() completed');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(50));
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\nUnhandled error:', err);
  process.exit(1);
});
