'use strict';
//
// bridge/test_patterns.js — Pattern/Sampler data-model verification
//
// Tests: Pattern CRUD, PatternBlock CRUD, Note CRUD, track conversion,
//        cascades on pattern removal, undo, save/load round-trip,
//        backward compatibility.
//
// Run: cd bridge && node test_patterns.js
//

const path = require('path');
const fs   = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0, total = 0;
function assert(cond, label) {
  total++;
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
function eq(a, b, label) { assert(a === b, `${label} (expected ${b}, got ${a})`); }

const PROJECT_DIR    = path.resolve(__dirname, '_test_patterns');
const OLD_PROJECT_DIR = path.resolve(__dirname, '_test_patterns_old');

async function main() {
  console.log('=== xleth Pattern/Sampler data-model test ===\n');

  if (fs.existsSync(PROJECT_DIR))    fs.rmSync(PROJECT_DIR,    { recursive: true, force: true });
  if (fs.existsSync(OLD_PROJECT_DIR)) fs.rmSync(OLD_PROJECT_DIR, { recursive: true, force: true });

  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'PatternTest') === true, 'project_create()');

  // Create region + tracks needed for patterns.
  const regionId = addon.timeline_addRegion({
    name: 'Lead', label: 'Custom', startTime: 0, endTime: 2.0
  });
  assert(regionId >= 1, `regionId=${regionId}`);

  const trackAId = addon.timeline_addTrack({ name: 'Pat-A', volume: 1.0, order: 0 });
  const trackBId = addon.timeline_addTrack({ name: 'Pat-B', volume: 1.0, order: 1 });
  const clipTrackId = addon.timeline_addTrack({ name: 'Clip', volume: 1.0, order: 2 });
  assert(trackAId >= 1 && trackBId > trackAId && clipTrackId > trackBId,
         `track ids: ${trackAId}, ${trackBId}, ${clipTrackId}`);

  // ── TEST 1 — Round-trip Pattern with 10 notes ──────────────────────────────
  console.log('\n[ Test 1 — Pattern + 10 notes round-trip ]');
  const PPQ = 960;
  const patId = addon.timeline_addPattern({
    name: 'Lead pattern',
    regionId: regionId,
    lengthTicks: 4 * PPQ,
    rootNote: 60,
    attackMs: 5.0,
    decayMs: 20.0,
    sustain: 0.7,
    releaseMs: 100.0,
    loopEnabled: true,
    loopStart: 1000,
    loopEnd: 5000,
    crossfadeEnabled: true,
  });
  assert(patId >= 1, `patternId=${patId}`);

  const noteIds = [];
  for (let i = 0; i < 10; i++) {
    const nid = addon.timeline_addNote(patId, {
      positionTicks: i * 240,
      durationTicks: 200,
      pitch: 60 + i,
      velocity: 0.5 + i * 0.05,
    });
    noteIds.push(nid);
  }
  assert(noteIds.every(id => id >= 1), `all 10 note IDs assigned: [${noteIds.join(',')}]`);

  // Save + reload
  assert(addon.project_save() === true, 'project_save()');
  addon.shutdown();
  assert(addon.initialize() === true, 're-initialize()');
  assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');

  const pats = addon.timeline_getAllPatterns();
  eq(pats.length, 1, 'getAllPatterns.length === 1');
  const p = pats[0];
  eq(p.id, patId, 'id preserved');
  eq(p.name, 'Lead pattern', 'name preserved');
  eq(p.regionId, regionId, 'regionId preserved');
  eq(p.lengthTicks, 4 * PPQ, 'lengthTicks preserved');
  eq(p.rootNote, 60, 'rootNote preserved');
  eq(p.attackMs, 5.0, 'attackMs preserved');
  eq(p.decayMs, 20.0, 'decayMs preserved');
  assert(Math.abs(p.sustain - 0.7) < 1e-5, `sustain ≈ 0.7 (got ${p.sustain})`);
  eq(p.releaseMs, 100.0, 'releaseMs preserved');
  eq(p.loopEnabled, true, 'loopEnabled preserved');
  eq(p.loopStart, 1000, 'loopStart preserved');
  eq(p.loopEnd, 5000, 'loopEnd preserved');
  eq(p.crossfadeEnabled, true, 'crossfadeEnabled preserved');
  eq(p.notes.length, 10, 'notes.length === 10');
  for (let i = 0; i < 10; i++) {
    const n = p.notes[i];
    eq(n.id, noteIds[i], `note[${i}].id preserved`);
    eq(n.positionTicks, i * 240, `note[${i}].positionTicks`);
    eq(n.durationTicks, 200, `note[${i}].durationTicks`);
    eq(n.pitch, 60 + i, `note[${i}].pitch`);
    assert(Math.abs(n.velocity - (0.5 + i * 0.05)) < 1e-5, `note[${i}].velocity`);
  }

  // ── TEST 2 — PatternBlock on timeline ──────────────────────────────────────
  console.log('\n[ Test 2 — PatternBlock add/get ]');
  const blockId = addon.timeline_addPatternBlock({
    trackId: trackAId,
    patternId: patId,
    positionTicks: 1920,
    durationTicks: 7680,
    offsetTicks: 0,
  });
  assert(blockId >= 1, `blockId=${blockId}`);
  const blocks = addon.timeline_getPatternBlocks();
  eq(blocks.length, 1, 'getPatternBlocks.length === 1');
  const b = blocks[0];
  eq(b.id, blockId, 'block id preserved');
  eq(b.trackId, trackAId, 'block trackId');
  eq(b.patternId, patId, 'block patternId');
  eq(b.positionTicks, 1920, 'block positionTicks');
  eq(b.durationTicks, 7680, 'block durationTicks');
  eq(b.offsetTicks, 0, 'block offsetTicks');

  // ── TEST 3 — Track conversion ──────────────────────────────────────────────
  console.log('\n[ Test 3 — convertToPatternTrack ]');
  addon.timeline_convertToPatternTrack(clipTrackId);
  const tracksAfterConvert = addon.timeline_getTracks();
  const convertedTrack = tracksAfterConvert.find(t => t.id === clipTrackId);
  assert(convertedTrack !== undefined, 'clipTrackId still present');
  eq(convertedTrack.type, 'Pattern', 'track.type === "Pattern"');

  // ── TEST 4 — Undo track conversion ─────────────────────────────────────────
  console.log('\n[ Test 4 — undo track conversion ]');
  addon.undo_undo();
  const tracksAfterUndo = addon.timeline_getTracks();
  const restored = tracksAfterUndo.find(t => t.id === clipTrackId);
  eq(restored.type, 'Clip', 'track.type reverted to "Clip"');

  // Redo to leave in Pattern state (we don't need this branch tested further here).
  addon.undo_redo();

  // ── TEST 5 — Pattern-removal cascade ───────────────────────────────────────
  console.log('\n[ Test 5 — pattern removal cascade ]');
  // Add a second block on a different track + assign trackB's assignedPatternId.
  const block2Id = addon.timeline_addPatternBlock({
    trackId: trackBId,
    patternId: patId,
    positionTicks: 0,
    durationTicks: 3840,
    offsetTicks: 0,
  });
  assert(block2Id >= 1, `block2Id=${block2Id}`);
  // Convert trackB to pattern (sample-agnostic container).
  addon.timeline_convertToPatternTrack(trackBId);
  // Now manually set trackB.assignedPatternId to patId via a pattern-type change.
  // We do NOT have a dedicated bridge for assignedPatternId, so we'll exercise
  // the cascade using only block references — this still validates cascade of
  // blocks, and the tracksAssignedTo_ snapshot path stays empty (which is fine).
  const blocksBefore = addon.timeline_getPatternBlocks();
  eq(blocksBefore.length, 2, 'blocks before removal: 2');

  addon.timeline_removePattern(patId);
  const blocksAfter = addon.timeline_getPatternBlocks();
  eq(blocksAfter.length, 0, 'all blocks removed by cascade');
  const patsAfter = addon.timeline_getAllPatterns();
  eq(patsAfter.length, 0, 'pattern removed');

  // Undo restores
  addon.undo_undo();
  const patsRestored = addon.timeline_getAllPatterns();
  eq(patsRestored.length, 1, 'pattern restored');
  eq(patsRestored[0].id, patId, 'restored pattern has original id');
  const blocksRestored = addon.timeline_getPatternBlocks();
  eq(blocksRestored.length, 2, 'both blocks restored');
  const restoredIds = blocksRestored.map(x => x.id).sort((a, b) => a - b);
  const origIds = [blockId, block2Id].sort((a, b) => a - b);
  eq(restoredIds[0], origIds[0], 'first block id preserved');
  eq(restoredIds[1], origIds[1], 'second block id preserved');

  // ── TEST 6 — Bridge surface smoke test ─────────────────────────────────────
  console.log('\n[ Test 6 — bridge surface smoke test ]');
  // Move pattern block
  addon.timeline_movePatternBlock(blockId, trackAId, 480);
  const movedBlocks = addon.timeline_getPatternBlocks();
  const moved = movedBlocks.find(x => x.id === blockId);
  eq(moved.positionTicks, 480, 'movePatternBlock → positionTicks=480');

  // Resize pattern block
  addon.timeline_resizePatternBlock(blockId, 1920);
  const resized = addon.timeline_getPatternBlocks().find(x => x.id === blockId);
  eq(resized.durationTicks, 1920, 'resizePatternBlock → durationTicks=1920');

  // Move note
  const firstNoteId = noteIds[0];
  addon.timeline_moveNote(patId, firstNoteId, 1000, 72);
  const patCheck = addon.timeline_getPattern(patId);
  const movedNote = patCheck.notes.find(n => n.id === firstNoteId);
  eq(movedNote.positionTicks, 1000, 'moveNote → positionTicks=1000');
  eq(movedNote.pitch, 72, 'moveNote → pitch=72');

  // Resize note
  addon.timeline_resizeNote(patId, firstNoteId, 500);
  const resizedNote = addon.timeline_getPattern(patId).notes.find(n => n.id === firstNoteId);
  eq(resizedNote.durationTicks, 500, 'resizeNote → durationTicks=500');

  // Set note velocity
  addon.timeline_setNoteVelocity(patId, firstNoteId, 0.25);
  const vNote = addon.timeline_getPattern(patId).notes.find(n => n.id === firstNoteId);
  assert(Math.abs(vNote.velocity - 0.25) < 1e-5, `setNoteVelocity → 0.25 (got ${vNote.velocity})`);

  // Remove note
  addon.timeline_removeNote(patId, firstNoteId);
  const afterRm = addon.timeline_getPattern(patId);
  eq(afterRm.notes.length, 9, 'removeNote → 9 notes remain');

  // Update sampler settings
  addon.timeline_updateSamplerSettings(patId, { attackMs: 15.5, releaseMs: 250.0 });
  const patAfterSampler = addon.timeline_getPattern(patId);
  assert(Math.abs(patAfterSampler.attackMs - 15.5) < 1e-5,
         `updateSamplerSettings → attackMs=15.5 (got ${patAfterSampler.attackMs})`);
  assert(Math.abs(patAfterSampler.releaseMs - 250.0) < 1e-5,
         `updateSamplerSettings → releaseMs=250 (got ${patAfterSampler.releaseMs})`);
  // Non-overridden fields preserved
  eq(patAfterSampler.rootNote, 60, 'rootNote preserved through partial update');

  // SetVideoFlipMode
  addon.timeline_setVideoFlipMode(trackAId, 'Clockwise');
  const t = addon.timeline_getTracks().find(x => x.id === trackAId);
  eq(t.videoFlipMode, 'Clockwise', 'videoFlipMode === "Clockwise"');

  // Remove pattern block
  addon.timeline_removePatternBlock(blockId);
  const afterBlockRm = addon.timeline_getPatternBlocks();
  eq(afterBlockRm.length, 1, 'removePatternBlock → 1 block remains');

  // convertToClipTrack
  addon.timeline_convertToClipTrack(trackBId);
  const tb = addon.timeline_getTracks().find(x => x.id === trackBId);
  eq(tb.type, 'Clip', 'convertToClipTrack → type="Clip"');
  eq(tb.assignedRegionId, -1, 'convertToClipTrack → assignedRegionId=-1');
  // trackB's block should be cascade-removed.
  const afterClipConvert = addon.timeline_getPatternBlocks();
  eq(afterClipConvert.length, 0, 'cascaded: trackB block removed');

  // Undo clip-track conversion should restore the block.
  addon.undo_undo();
  const afterUndoConvert = addon.timeline_getPatternBlocks();
  eq(afterUndoConvert.length, 1, 'undo convertToClipTrack → block restored');
  const rblocks = addon.timeline_getPatternBlocks();
  eq(rblocks[0].id, block2Id, 'restored block id preserved');

  // ── TEST 7 — Backward compatibility ────────────────────────────────────────
  console.log('\n[ Test 7 — backward compatibility with legacy project ]');
  // Build a legacy-shape project file (no patterns/patternBlocks arrays, no
  // new track fields) and load it.
  addon.shutdown();
  assert(addon.initialize() === true, 'reinit for legacy test');
  fs.mkdirSync(OLD_PROJECT_DIR, { recursive: true });
  const legacyProj = {
    xleth_version: '0.0.1',
    project_name: 'Legacy',
    created_at: '2024-01-01T00:00:00Z',
    modified_at: '2024-01-01T00:00:00Z',
    bpm: 120.0,
    sample_rate: 44100.0,
    time_signature: [4, 4],
    sources:  [],
    regions:  [],
    tracks: [
      { id: 1, name: 'OldTrack', volume: 1.0, pan: 0.0, muted: false, solo: false, order: 0,
        videoX: 0.0, videoY: 0.0, videoW: 1.0, videoH: 1.0,
        videoOpacity: 1.0, videoZOrder: 0 },
    ],
    clips:    [],
    gridLayout: { columns: 3, rows: 3, slots: [], chorusTrackId: -1,
                  crashOverlayEnabled: false, crashOverlayTrackId: -1,
                  crashOverlayOpacity: 1.0, previewFps: 30 },
    custom_labels: []
  };
  fs.writeFileSync(path.join(OLD_PROJECT_DIR, 'project.json'),
                   JSON.stringify(legacyProj, null, 2));
  // Also need a media dir (ProjectManager may require it).
  fs.mkdirSync(path.join(OLD_PROJECT_DIR, 'media'), { recursive: true });

  const loaded = addon.project_load(OLD_PROJECT_DIR);
  assert(loaded === true, 'legacy project_load() returns true');
  const legacyTracks = addon.timeline_getTracks();
  eq(legacyTracks.length, 1, 'legacy: 1 track loaded');
  const ltr = legacyTracks[0];
  eq(ltr.type, 'Clip', 'legacy track defaults to type="Clip"');
  eq(ltr.assignedRegionId, -1, 'legacy track assignedRegionId=-1');
  eq(ltr.assignedPatternId, -1, 'legacy track assignedPatternId=-1');
  eq(ltr.videoFlipMode, 'None', 'legacy track videoFlipMode="None"');
  eq(addon.timeline_getAllPatterns().length, 0, 'legacy: no patterns');
  eq(addon.timeline_getPatternBlocks().length, 0, 'legacy: no blocks');

  addon.shutdown();

  // Cleanup
  if (fs.existsSync(PROJECT_DIR))     fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  if (fs.existsSync(OLD_PROJECT_DIR)) fs.rmSync(OLD_PROJECT_DIR, { recursive: true, force: true });

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
