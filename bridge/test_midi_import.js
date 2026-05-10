'use strict';
//
// bridge/test_midi_import.js - MIDI import regression coverage
//
// Tests:
//   - assigned row imports normally
//   - unassigned row (regionId = -1) imports successfully
//   - imported unassigned patterns stay unassigned until explicitly assigned
//   - mixed assigned + unassigned rows both import
//   - long notes clamp in importFull
//   - short notes remain unchanged
//   - clamp disabled preserves duration
//   - clamped durations survive midi_executeImport
//
// Run:
//   cd bridge && node test_midi_import.js
//

const path = require('path');
const fs = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

let passed = 0;
let failed = 0;
let total = 0;

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

function eq(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${expected}, got ${actual})`);
}

function sortedNoteSignature(pattern) {
  return (pattern?.notes || [])
    .map((note) => `${note.positionTicks}:${note.durationTicks}:${note.pitch}`)
    .sort()
    .join('|');
}

function cleanupDir(dirPath) {
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function u16be(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value);
  return buf;
}

function u32be(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
}

function vlq(value) {
  let v = value >>> 0;
  const bytes = [v & 0x7f];
  while ((v >>= 7) > 0) {
    bytes.unshift((v & 0x7f) | 0x80);
  }
  return Buffer.from(bytes);
}

function metaTrackName(name) {
  const text = Buffer.from(name, 'utf8');
  return Buffer.concat([Buffer.from([0xff, 0x03, text.length]), text]);
}

function buildTrack(name, events) {
  const chunks = [
    Buffer.from([0x00]),
    metaTrackName(name),
  ];

  for (const event of events) {
    chunks.push(vlq(event.delta));
    chunks.push(Buffer.from(event.bytes));
  }

  chunks.push(Buffer.from([0x00, 0xff, 0x2f, 0x00]));
  const trackData = Buffer.concat(chunks);
  return Buffer.concat([
    Buffer.from('MTrk'),
    u32be(trackData.length),
    trackData,
  ]);
}

function writeMidiFile(filePath, { format, tpq, tracks }) {
  const header = Buffer.concat([
    Buffer.from('MThd'),
    u32be(6),
    u16be(format),
    u16be(tracks.length),
    u16be(tpq),
  ]);
  fs.writeFileSync(filePath, Buffer.concat([header, ...tracks]));
}

function writeClampFixture(filePath) {
  writeMidiFile(filePath, {
    format: 0,
    tpq: 96,
    tracks: [
      buildTrack('Clamp Track', [
        { delta: 0, bytes: [0x90, 60, 100] },
        { delta: 48000, bytes: [0x80, 60, 0] },
        { delta: 96, bytes: [0x90, 62, 90] },
        { delta: 12, bytes: [0x80, 62, 0] },
      ]),
    ],
  });
}

function writeMixedFixture(filePath) {
  writeMidiFile(filePath, {
    format: 1,
    tpq: 96,
    tracks: [
      buildTrack('Assigned Track', [
        { delta: 0, bytes: [0x90, 60, 100] },
        { delta: 96, bytes: [0x80, 60, 0] },
      ]),
      buildTrack('Unassigned Track', [
        { delta: 0, bytes: [0x90, 67, 100] },
        { delta: 96, bytes: [0x80, 67, 0] },
      ]),
    ],
  });
}

function readPackedNotes(noteData) {
  const buf = Buffer.from(noteData);
  const notes = [];
  for (let i = 0; i < buf.length; i += 12) {
    notes.push({
      tick: buf.readUInt32LE(i + 0),
      duration: buf.readUInt32LE(i + 4),
      note: buf[i + 8],
      velocity: buf[i + 9],
      outputTrackIndex: buf[i + 10],
      flags: buf[i + 11],
    });
  }
  return notes;
}

function buildImportOptions(summary, maxNoteLengthByOutputTrack) {
  return {
    enabledTrackIndices: summary.tracks.map(t => t.index),
    perTrackOptions: Object.fromEntries(
      summary.tracks.map(t => [
        String(t.index),
        { splitDrums: false, enabledSubNotes: [] },
      ])
    ),
    tempoOverride: true,
    projectTPQ: 960,
    projectBPM: summary.sourceTempo || 120,
    maxNoteLengthByOutputTrack,
  };
}

function createProject(projectDir) {
  cleanupDir(projectDir);
  ensureDir(projectDir);

  const reset = addon.project_newBlank();
  assert(reset != null && reset.ok === true, `${path.basename(projectDir)} project_newBlank()`);

  assert(addon.project_create(projectDir, path.basename(projectDir)) === true, `${path.basename(projectDir)} project_create()`);
}

function addTestRegion(projectDir) {
  const sourceId = addon.project_importSource(path.resolve(__dirname, '..', 'test.wav'));
  assert(sourceId >= 0, `${path.basename(projectDir)} project_importSource()`);

  const regionId = addon.timeline_addRegion({
    sourceId,
    name: 'Test Region',
    label: 'Custom',
    startTime: 0,
    endTime: 1.0,
  });
  assert(regionId >= 0, `${path.basename(projectDir)} timeline_addRegion()`);

  return regionId;
}

function createProjectWithRegion(projectDir) {
  createProject(projectDir);
  return addTestRegion(projectDir);
}

function importMidi(filePath, maxNoteLengthByOutputTrack) {
  const summary = JSON.parse(addon.midi_parseSummary(filePath));
  assert(summary.ok === true, `${path.basename(filePath)} parseSummary ok`);

  const importOptions = buildImportOptions(summary, maxNoteLengthByOutputTrack);
  const imported = addon.midi_importFull(filePath, JSON.stringify(importOptions));
  const meta = JSON.parse(imported.metadata);
  const packedNotes = readPackedNotes(imported.noteData);

  return { summary, meta, imported, packedNotes };
}

function executeImport(imported, summary, outputTracks) {
  addon.midi_executeImport(Buffer.from(imported.noteData), JSON.stringify({
    tempoOverride: true,
    sourceBPM: summary.sourceTempo || 120,
    projectTPQ: 960,
    outputTracks,
  }));

  return {
    tracks: addon.timeline_getTracks(),
    patterns: addon.timeline_getAllPatterns(),
    blocks: addon.timeline_getPatternBlocks(),
  };
}

function runAssignedScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 1 - assigned row imports normally ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'assigned'));
  const { summary, meta, imported, packedNotes } = importMidi(clampMidiPath, [0]);

  eq(meta.outputTracks.length, 1, 'assigned scenario output track count');
  eq(packedNotes.length, 2, 'assigned scenario packed note count');
  eq(packedNotes[0].duration, 480000, 'clamp disabled preserves long packed duration');
  eq(packedNotes[1].duration, 120, 'clamp disabled preserves short packed duration');

  const patternName = 'Assigned Import Scenario 1';
  const state = executeImport(imported, summary, [
    { outputTrackIndex: 0, name: patternName, visualOnly: false, regionId },
  ]);

  eq(state.tracks.length, 1, 'assigned scenario created one track');
  eq(state.patterns.length, 1, 'assigned scenario created one pattern');
  eq(state.blocks.length, 1, 'assigned scenario created one block');
  const assignedPattern = state.patterns.find(p => p.name === patternName);
  assert(assignedPattern != null, 'assigned scenario pattern exists');
  if (assignedPattern) {
    eq(assignedPattern.regionId, regionId, 'assigned pattern keeps assigned region');
    eq(assignedPattern.notes.length, 2, 'assigned pattern note count');
  }
}

function runDeferredAssignmentScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 2 - imported unassigned patterns stay unassigned until explicitly assigned ]');
  const projectDir = path.join(projectRoot, 'deferred_assign');
  createProject(projectDir);

  const { summary, imported } = importMidi(clampMidiPath, [0]);
  const patternName = 'Deferred Assign Scenario 2';
  const initialState = executeImport(imported, summary, [
    { outputTrackIndex: 0, name: patternName, visualOnly: false, regionId: -1 },
  ]);

  eq(initialState.patterns.length, 1, 'deferred assignment created one pattern');
  const initialPattern = initialState.patterns.find(p => p.name === patternName);
  assert(initialPattern != null, 'deferred assignment pattern exists after import');
  if (!initialPattern) return;

  const importedSignature = sortedNoteSignature(initialPattern);
  eq(initialPattern.regionId, -1, 'deferred assignment starts unassigned');
  eq(initialPattern.notes.length, 2, 'deferred assignment keeps imported notes');

  const regionId = addTestRegion(projectDir);
  const afterRegionAdd = addon.timeline_getPattern(initialPattern.id);
  eq(afterRegionAdd.regionId, -1, 'adding a region does not auto-assign the imported pattern');
  eq(sortedNoteSignature(afterRegionAdd), importedSignature, 'adding a region keeps imported notes intact');

  addon.timeline_setPatternRegion(initialPattern.id, regionId);
  const assignedPattern = addon.timeline_getPattern(initialPattern.id);
  eq(assignedPattern.regionId, regionId, 'explicit selection assigns the existing pattern');
  eq(sortedNoteSignature(assignedPattern), importedSignature, 'explicit assignment keeps imported notes intact');

  assert(addon.project_save() === true, 'deferred assignment project_save()');
  const reset = addon.project_newBlank();
  assert(reset != null && reset.ok === true, 'deferred assignment project_newBlank() before load');
  assert(addon.project_load(projectDir) === true, 'deferred assignment project_load()');

  const reloadedPattern = addon.timeline_getAllPatterns().find(p => p.name === patternName);
  assert(reloadedPattern != null, 'deferred assignment pattern exists after reload');
  if (!reloadedPattern) return;

  eq(reloadedPattern.regionId, regionId, 'assigned region persists after reload');
  eq(sortedNoteSignature(reloadedPattern), importedSignature, 'reloaded pattern keeps imported notes intact');

  addon.timeline_setPatternRegion(reloadedPattern.id, -1);
  const unassignedAgain = addon.timeline_getPattern(reloadedPattern.id);
  eq(unassignedAgain.regionId, -1, 'explicitly setting None returns the pattern to unassigned');
  eq(sortedNoteSignature(unassignedAgain), importedSignature, 'notes remain intact after returning to unassigned');
}

function runMixedScenario(projectRoot, mixedMidiPath) {
  console.log('\n[ Scenario 3 - mixed assigned + unassigned rows import ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'mixed'));
  const { summary, meta, imported } = importMidi(mixedMidiPath, [0, 0]);

  eq(meta.outputTracks.length, 2, 'mixed scenario output track count');

  const assignedName = 'Assigned Import Scenario 2';
  const unassignedName = 'Unassigned Import Scenario 2';
  const state = executeImport(imported, summary, [
    { outputTrackIndex: 0, name: assignedName, visualOnly: false, regionId },
    { outputTrackIndex: 1, name: unassignedName, visualOnly: false, regionId: -1 },
  ]);

  eq(state.tracks.length, 2, 'mixed scenario created two tracks');
  eq(state.patterns.length, 2, 'mixed scenario created two patterns');
  eq(state.blocks.length, 2, 'mixed scenario created two blocks');

  const assignedPattern = state.patterns.find(p => p.name === assignedName);
  const unassignedPattern = state.patterns.find(p => p.name === unassignedName);
  assert(assignedPattern != null, 'mixed scenario assigned pattern exists');
  assert(unassignedPattern != null, 'mixed scenario unassigned pattern exists');
  if (assignedPattern) {
    eq(assignedPattern.regionId, regionId, 'mixed scenario assigned pattern regionId');
    eq(assignedPattern.notes.length, 1, 'mixed scenario assigned note count');
  }
  if (unassignedPattern) {
    eq(unassignedPattern.regionId, -1, 'mixed scenario unassigned pattern keeps regionId=-1');
    eq(unassignedPattern.notes.length, 1, 'mixed scenario unassigned note count');
  }
}

function runClampScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 4 - clamped durations survive midi_executeImport ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'clamped'));
  const { summary, imported, packedNotes } = importMidi(clampMidiPath, [240]);

  eq(packedNotes.length, 2, 'clamp scenario packed note count');
  eq(packedNotes[0].duration, 240, 'long note clamps in importFull');
  eq(packedNotes[1].duration, 120, 'short note remains unchanged in importFull');

  const patternName = 'Clamped Import Scenario 3';
  const state = executeImport(imported, summary, [
    { outputTrackIndex: 0, name: patternName, visualOnly: false, regionId },
  ]);

  eq(state.patterns.length, 1, 'clamp scenario created one pattern');
  const clampedPattern = state.patterns.find(p => p.name === patternName);
  assert(clampedPattern != null, 'clamp scenario pattern exists');
  if (clampedPattern) {
    const durations = clampedPattern.notes
      .map(note => note.durationTicks)
      .sort((a, b) => a - b);
    eq(durations.length, 2, 'clamp scenario committed two notes');
    eq(durations[0], 120, 'short note remains unchanged after executeImport');
    eq(durations[1], 240, 'clamped duration survives executeImport');
  }
}

async function main() {
  const projectRoot = path.resolve(__dirname, '_test_midi_import');
  const clampMidiPath = path.join(projectRoot, 'clamp_fixture.mid');
  const mixedMidiPath = path.join(projectRoot, 'mixed_fixture.mid');

  cleanupDir(projectRoot);
  ensureDir(projectRoot);
  writeClampFixture(clampMidiPath);
  writeMixedFixture(mixedMidiPath);

  try {
    assert(addon.initialize() === true, 'initialize()');

    runAssignedScenario(projectRoot, clampMidiPath);
    runDeferredAssignmentScenario(projectRoot, clampMidiPath);
    runMixedScenario(projectRoot, mixedMidiPath);
    runClampScenario(projectRoot, clampMidiPath);
  } finally {
    try { addon.shutdown(); } catch (_) { /* ignore */ }
    cleanupDir(projectRoot);
  }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests (${failed} failed)`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
