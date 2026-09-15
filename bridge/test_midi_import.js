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
//   - midi_getReimportTargets lists Pattern tracks only, with the right shape
//   - re-import (mode=update) rewrites notes in place, preserving trackId,
//     track name, visualOnly, block position and the region binding
//   - an untrimmed block follows the new pattern length; a trimmed one does not
//   - a mixed update+create commit is ONE undo step that restores everything
//   - update into a Clip track hard-fails the row instead of creating a track
//   - per-output-track transpose clamps at both pitch boundaries, counts clamps
//   - transpose applies AFTER drum-split routing (routing keys on the original note)
//   - re-import with transpose bakes into notes; undo restores pre-transpose notes
//   - trim leading silence shifts note starts to 0, note count unchanged
//   - positionTicks places the first Create block there
//   - tile-to-fill places contiguous blocks to cover the project end; undo removes all
//   - tile-to-fill on an empty project places exactly one block
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

// ── Audio fixture ────────────────────────────────────────────────────────────
// This harness used to load a repo-level test.wav that was removed when media
// was purged from the tree, which left every scenario failing at
// project_importSource with "unsupported or unreadable media file". Generate a
// real 16-bit PCM WAV instead so the harness owns its own fixture.
function writeTestWav(filePath, { seconds = 1, sampleRate = 44100 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    // 440 Hz sine at -6 dBFS; content is irrelevant, decodability is not.
    data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16384), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);        // PCM fmt chunk size
  header.writeUInt16LE(1, 20);         // format = PCM
  header.writeUInt16LE(1, 22);         // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);         // block align
  header.writeUInt16LE(16, 34);        // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, data]));
}

let testWavPath = null;

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

// Same single track NAME as the clamp fixture, so a name match resolves to it,
// but with three notes at different pitches/positions and a much longer extent
// (bar 3) so the pattern length -- and therefore the block cascade -- changes.
function writeReimportFixture(filePath) {
  writeMidiFile(filePath, {
    format: 0,
    tpq: 96,
    tracks: [
      buildTrack('Clamp Track', [
        { delta: 0, bytes: [0x90, 64, 100] },
        { delta: 96, bytes: [0x80, 64, 0] },
        { delta: 96, bytes: [0x90, 67, 80] },
        { delta: 96, bytes: [0x80, 67, 0] },
        // Starts at tick 768/96 quarters = bar 3 at 960 PPQ, pushing the
        // recalculated pattern length past the 1-bar minimum.
        { delta: 576, bytes: [0x90, 72, 120] },
        { delta: 96, bytes: [0x80, 72, 0] },
      ]),
    ],
  });
}

// Two single-note tracks near the pitch extremes, for transpose-clamp coverage.
function writeTransposeFixture(filePath) {
  writeMidiFile(filePath, {
    format: 1,
    tpq: 96,
    tracks: [
      buildTrack('Low Track', [
        { delta: 0, bytes: [0x90, 4, 100] },
        { delta: 96, bytes: [0x80, 4, 0] },
      ]),
      buildTrack('High Track', [
        { delta: 0, bytes: [0x90, 120, 100] },
        { delta: 96, bytes: [0x80, 120, 0] },
      ]),
    ],
  });
}

// One drum-channel track, two notes, for drum-split-routing + transpose coverage.
function writeDrumTransposeFixture(filePath) {
  writeMidiFile(filePath, {
    format: 0,
    tpq: 96,
    tracks: [
      buildTrack('Drums', [
        { delta: 0,  bytes: [0x99, 36, 100] }, // channel 10 (0x9 nibble = ch9 0-based = ch10 1-based)
        { delta: 48, bytes: [0x89, 36, 0] },
        { delta: 0,  bytes: [0x99, 38, 90] },
        { delta: 48, bytes: [0x89, 38, 0] },
      ]),
    ],
  });
}

// A single track with 500 ticks of leading silence before its first note, for
// trim-leading-silence coverage.
function writeTrimFixture(filePath) {
  writeMidiFile(filePath, {
    format: 0,
    tpq: 96,
    tracks: [
      buildTrack('Trim Track', [
        { delta: 480, bytes: [0x90, 60, 100] },
        { delta: 96,  bytes: [0x80, 60, 0] },
        { delta: 96,  bytes: [0x90, 64, 90] },
        { delta: 96,  bytes: [0x80, 64, 0] },
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
  const sourceId = addon.project_importSource(testWavPath);
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

// ─────────────────────────────────────────────────────────────────────────────
// Re-import (mode = update)
// ─────────────────────────────────────────────────────────────────────────────

function noteSignature(pattern) {
  return (pattern?.notes || [])
    .map(n => `${n.positionTicks}:${n.durationTicks}:${n.pitch}`)
    .sort()
    .join('|');
}

function runReimportTargetsScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 5 - midi_getReimportTargets shape ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'targets'));

  const emptyTargets = addon.midi_getReimportTargets();
  assert(Array.isArray(emptyTargets), 'getReimportTargets returns an array');
  eq(emptyTargets.length, 0, 'no Pattern tracks yet');

  const { summary, imported } = importMidi(clampMidiPath, [0]);
  executeImport(imported, summary, [
    { outputTrackIndex: 0, name: 'Targets Pattern', visualOnly: false, regionId },
  ]);

  // A Clip track must never be offered as an update target.
  const clipTrackId = addon.timeline_addTrack({ name: 'A Clip Track' });
  assert(clipTrackId >= 0, 'added a Clip track');

  const targets = addon.midi_getReimportTargets();
  eq(targets.length, 1, 'only the Pattern track is listed');
  const target = targets[0];
  eq(target.name, 'Targets Pattern', 'target name');
  eq(target.patternCount, 1, 'target carries one pattern');
  eq(target.blockCount, 1, 'target carries one block');
  eq(target.regionId, regionId, 'target reports its pattern binding');
  eq(target.eligible, true, 'single-pattern track is eligible');
  assert(target.patternId >= 0, 'target reports its patternId');
  assert(!targets.some(t => t.trackId === clipTrackId), 'Clip track is not offered');
}

function runReimportUpdateScenario(projectRoot, clampMidiPath, reimportMidiPath) {
  console.log('\n[ Scenario 6 - re-import rewrites notes in place ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'reimport'));

  // ── First import: the "composed in FL, imported once" state ───────────────
  const first = importMidi(clampMidiPath, [0]);
  const initial = executeImport(first.imported, first.summary, [
    { outputTrackIndex: 0, name: 'Lead', visualOnly: true, regionId },
  ]);
  eq(initial.tracks.length, 1, 'first import created one track');
  const trackId = initial.tracks[0].id;
  const patternId = initial.patterns[0].id;
  const untrimmedBlockId = initial.blocks[0].id;
  const originalLength = initial.patterns[0].lengthTicks ?? initial.patterns[0].length;
  const originalNoteSig = noteSignature(initial.patterns[0]);

  // ── The user then works on the project ────────────────────────────────────
  // Rename the track, move the block off tick 0, add a SECOND block of the same
  // pattern and trim it, so we can prove the cascade only touches the untrimmed
  // one.
  assert(addon.timeline_setTrackName(trackId, 'My Renamed Lead') !== false,
         'renamed the track');
  assert(addon.timeline_movePatternBlock(untrimmedBlockId, trackId, 7680) !== false,
         'moved the block off tick 0');

  const trimmedBlockId = addon.timeline_addPatternBlock({
    trackId, patternId, positionTicks: 30720, durationTicks: 1920, offsetTicks: 0,
  });
  assert(trimmedBlockId >= 0, 'added a second, trimmed block of the same pattern');

  const beforeBlocks = addon.timeline_getPatternBlocks();
  const untrimmedBefore = beforeBlocks.find(b => b.id === untrimmedBlockId);
  const trimmedBefore = beforeBlocks.find(b => b.id === trimmedBlockId);
  eq(untrimmedBefore.durationTicks, originalLength,
     'untrimmed block duration equals the pattern length');
  eq(trimmedBefore.durationTicks, 1920, 'trimmed block is shorter than the pattern');

  // ── Re-import: same track, new notes ──────────────────────────────────────
  const second = importMidi(reimportMidiPath, [0]);
  const after = executeImport(second.imported, second.summary, [
    {
      outputTrackIndex: 0,
      name: 'Name From The MIDI File',
      visualOnly: false,
      regionId: -1,            // "leave the existing binding alone"
      mode: 'update',
      targetTrackId: trackId,
    },
  ]);

  eq(after.tracks.length, 1, 're-import created NO new track');
  eq(after.patterns.length, 1, 're-import created NO new pattern');
  eq(after.blocks.length, 2, 're-import created NO new block');

  const updatedTrack = after.tracks.find(t => t.id === trackId);
  assert(updatedTrack != null, 'the original track still exists');
  eq(updatedTrack.name, 'My Renamed Lead', "the user's track name is preserved");
  eq(updatedTrack.visualOnly, true, 'visualOnly is preserved');

  const updatedPattern = after.patterns.find(p => p.id === patternId);
  assert(updatedPattern != null, 'the original pattern still exists');
  eq(updatedPattern.regionId, regionId, 'region binding is preserved');
  eq(updatedPattern.notes.length, 3, 'notes were replaced with the new set');
  assert(noteSignature(updatedPattern) !== originalNoteSig, 'the note set actually changed');
  assert(!updatedPattern.notes.some(n => n.pitch === 60),
         'no note from the previous import survived');

  // The clamp fixture carries a 480000-tick note, so the re-import fixture is
  // the SHORTER of the two: the length must move, in either direction, or the
  // cascade below would be vacuously satisfied.
  const newLength = updatedPattern.lengthTicks ?? updatedPattern.length;
  assert(newLength !== originalLength,
         `pattern length recalculated (${originalLength} -> ${newLength})`);

  const afterBlocks = addon.timeline_getPatternBlocks();
  const untrimmedAfter = afterBlocks.find(b => b.id === untrimmedBlockId);
  const trimmedAfter = afterBlocks.find(b => b.id === trimmedBlockId);
  eq(untrimmedAfter.positionTicks, 7680, 'block position is preserved');
  eq(untrimmedAfter.durationTicks, newLength, 'untrimmed block follows the new length');
  eq(trimmedAfter.durationTicks, 1920, 'trimmed block is left alone');

  eq(addon.undo_getUndoDescription(), 'Re-import MIDI', 'undo label');

  // ── Undo restores the pre-re-import state exactly ─────────────────────────
  assert(addon.undo_undo() === true, 'undo_undo()');

  const undonePattern = addon.timeline_getPattern(patternId);
  assert(undonePattern != null, 'the pattern survives undo');
  eq(noteSignature(undonePattern), originalNoteSig, 'undo restores the original notes');
  eq(undonePattern.regionId, regionId, 'undo keeps the region binding');
  eq(undonePattern.lengthTicks ?? undonePattern.length, originalLength,
     'undo restores the pattern length');

  const undoneBlocks = addon.timeline_getPatternBlocks();
  eq(undoneBlocks.length, 2, 'undo removed no blocks');
  eq(undoneBlocks.find(b => b.id === untrimmedBlockId).durationTicks, originalLength,
     'undo restores the untrimmed block duration');
  eq(undoneBlocks.find(b => b.id === trimmedBlockId).durationTicks, 1920,
     'undo leaves the trimmed block duration alone');
  eq(addon.timeline_getTracks().find(t => t.id === trackId).name, 'My Renamed Lead',
     'undo does not touch the track name');
}

function runMixedReimportScenario(projectRoot, clampMidiPath, mixedMidiPath) {
  console.log('\n[ Scenario 7 - mixed update + create is ONE undo step ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'mixed_reimport'));

  const first = importMidi(clampMidiPath, [0]);
  executeImport(first.imported, first.summary, [
    { outputTrackIndex: 0, name: 'Existing', visualOnly: false, regionId },
  ]);
  const existingTrackId = addon.timeline_getTracks()[0].id;
  const existingPatternId = addon.timeline_getAllPatterns()[0].id;
  const originalSig = noteSignature(addon.timeline_getPattern(existingPatternId));

  const second = importMidi(mixedMidiPath, [0, 0]);
  const after = executeImport(second.imported, second.summary, [
    {
      outputTrackIndex: 0, name: 'Updated Row', visualOnly: false, regionId: -1,
      mode: 'update', targetTrackId: existingTrackId,
    },
    { outputTrackIndex: 1, name: 'Brand New Row', visualOnly: false, regionId: -1 },
  ]);

  eq(after.tracks.length, 2, 'mixed re-import created exactly one new track');
  eq(after.patterns.length, 2, 'mixed re-import created exactly one new pattern');
  const updated = after.patterns.find(p => p.id === existingPatternId);
  const created = after.patterns.find(p => p.name === 'Brand New Row');
  assert(updated != null, 'updated pattern still exists');
  assert(created != null, 'created pattern exists');
  eq(updated.notes.length, 1, 'updated pattern took the new note set');
  assert(noteSignature(updated) !== originalSig, 'updated pattern actually changed');
  eq(created.notes.length, 1, 'created pattern has its notes');

  // ONE undo step undoes BOTH halves.
  assert(addon.undo_undo() === true, 'mixed re-import undo_undo()');
  eq(addon.timeline_getTracks().length, 1, 'undo removed the created track');
  eq(addon.timeline_getAllPatterns().length, 1, 'undo removed the created pattern');
  eq(noteSignature(addon.timeline_getPattern(existingPatternId)), originalSig,
     'the same undo restored the updated pattern notes');
}

function runInvalidTargetScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 8 - update into an invalid target hard-fails the row ]');
  createProject(path.join(projectRoot, 'invalid_target'));

  const clipTrackId = addon.timeline_addTrack({ name: 'Not A Pattern Track' });
  assert(clipTrackId >= 0, 'added a Clip track');
  const tracksBefore = addon.timeline_getTracks().length;

  const { summary, imported } = importMidi(clampMidiPath, [0]);
  const after = executeImport(imported, summary, [
    {
      outputTrackIndex: 0, name: 'Should Not Appear', visualOnly: false,
      regionId: -1, mode: 'update', targetTrackId: clipTrackId,
    },
  ]);

  eq(after.tracks.length, tracksBefore, 'no track was created as a fallback');
  eq(after.patterns.length, 0, 'no pattern was created');
  eq(after.blocks.length, 0, 'no block was created');

  // A target id that does not exist at all.
  const after2 = executeImport(imported, summary, [
    {
      outputTrackIndex: 0, name: 'Should Not Appear Either', visualOnly: false,
      regionId: -1, mode: 'update', targetTrackId: 99999,
    },
  ]);
  eq(after2.patterns.length, 0, 'unknown targetTrackId creates nothing');

  // mode=update without a targetTrackId is a hard type error, not a silent create.
  let threw = false;
  try {
    addon.midi_executeImport(Buffer.from(imported.noteData), JSON.stringify({
      tempoOverride: false, sourceBPM: 120, projectTPQ: 960,
      outputTracks: [{ outputTrackIndex: 0, name: 'x', regionId: -1, mode: 'update' }],
    }));
  } catch (_) {
    threw = true;
  }
  assert(threw, 'mode=update without targetTrackId throws');
}

// ─────────────────────────────────────────────────────────────────────────────
// Transpose
// ─────────────────────────────────────────────────────────────────────────────

function runTransposeClampScenario(projectRoot, transposeMidiPath) {
  console.log('\n[ Scenario 9 - transpose clamps at both pitch boundaries ]');
  createProject(path.join(projectRoot, 'transpose_clamp'));

  const summary = JSON.parse(addon.midi_parseSummary(transposeMidiPath));
  assert(summary.ok === true, 'transpose fixture parseSummary ok');

  const baseOptions = {
    enabledTrackIndices: summary.tracks.map(t => t.index),
    perTrackOptions: Object.fromEntries(
      summary.tracks.map(t => [String(t.index), { splitDrums: false, enabledSubNotes: [] }])
    ),
    tempoOverride: true,
    projectTPQ: 960,
    projectBPM: summary.sourceTempo || 120,
    maxNoteLengthByOutputTrack: [0, 0],
  };

  const imported = addon.midi_importFull(transposeMidiPath, JSON.stringify({
    ...baseOptions,
    transposeByOutputTrack: [-24, 24],
  }));
  const meta = JSON.parse(imported.metadata);
  const packedNotes = readPackedNotes(imported.noteData);

  eq(packedNotes.length, 2, 'transpose clamp scenario packed note count');
  const lowNote = packedNotes.find(n => n.outputTrackIndex === 0);
  const highNote = packedNotes.find(n => n.outputTrackIndex === 1);
  assert(lowNote != null, 'low note present');
  assert(highNote != null, 'high note present');
  eq(lowNote.note, 0, 'note 4 transposed by -24 (=-20) clamps to 0');
  eq(highNote.note, 127, 'note 120 transposed by +24 (=144) clamps to 127');
  eq(meta.transposeClampCount, 2, 'metadata reports 2 clamped notes');

  // No transpose: sanity baseline, nothing clamps.
  const untransposed = addon.midi_importFull(transposeMidiPath, JSON.stringify(baseOptions));
  const untransposedMeta = JSON.parse(untransposed.metadata);
  const untransposedNotes = readPackedNotes(untransposed.noteData);
  eq(untransposedNotes.find(n => n.outputTrackIndex === 0).note, 4, 'no transpose leaves note 4 unchanged');
  eq(untransposedNotes.find(n => n.outputTrackIndex === 1).note, 120, 'no transpose leaves note 120 unchanged');
  eq(untransposedMeta.transposeClampCount, 0, 'no transpose clamps nothing');

  // Out-of-range transpose values are rejected at parse time, same as the
  // other per-output-track validated arrays.
  const rejected = addon.midi_importFull(transposeMidiPath, JSON.stringify({
    ...baseOptions,
    transposeByOutputTrack: [25, 0],
  }));
  const rejectedMeta = JSON.parse(rejected.metadata);
  eq(rejectedMeta.ok, false, 'transposeByOutputTrack entry outside [-24,24] is rejected');
}

function runDrumSplitTransposeScenario(projectRoot, drumMidiPath) {
  console.log('\n[ Scenario 10 - transpose applies AFTER drum-split routing; routing unaffected ]');
  createProject(path.join(projectRoot, 'drum_transpose'));

  const summary = JSON.parse(addon.midi_parseSummary(drumMidiPath));
  assert(summary.ok === true, 'drum transpose fixture parseSummary ok');
  eq(summary.tracks.length, 1, 'drum transpose fixture has one track');
  assert(summary.tracks[0].isDrum, 'drum transpose fixture track flagged as drum');

  const importOptions = {
    enabledTrackIndices: [0],
    perTrackOptions: { '0': { splitDrums: true, enabledSubNotes: [36, 38] } },
    tempoOverride: true,
    projectTPQ: 960,
    projectBPM: summary.sourceTempo || 120,
    maxNoteLengthByOutputTrack: [0, 0],
    transposeByOutputTrack: [12, -12],
  };

  const imported = addon.midi_importFull(drumMidiPath, JSON.stringify(importOptions));
  const meta = JSON.parse(imported.metadata);
  const packedNotes = readPackedNotes(imported.noteData);

  eq(meta.outputTracks.length, 2, 'drum split created two output tracks');
  eq(meta.outputTracks[0].drumPitch, 36, 'output track 0 routes the kick (note 36)');
  eq(meta.outputTracks[1].drumPitch, 38, 'output track 1 routes the snare (note 38)');

  eq(packedNotes.length, 2, 'drum transpose scenario packed note count');
  const kickNote = packedNotes.find(n => n.outputTrackIndex === 0);
  const snareNote = packedNotes.find(n => n.outputTrackIndex === 1);
  assert(kickNote != null, 'kick note routed to output track 0 (routing unaffected by transpose)');
  assert(snareNote != null, 'snare note routed to output track 1 (routing unaffected by transpose)');
  eq(kickNote.note, 48, 'kick note transposed +12 (36 -> 48) while staying routed to output track 0');
  eq(snareNote.note, 26, 'snare note transposed -12 (38 -> 26) while staying routed to output track 1');
  eq(meta.transposeClampCount, 0, 'neither drum note needed clamping');
}

function runReimportTransposeUndoScenario(projectRoot, clampMidiPath, reimportMidiPath) {
  console.log('\n[ Scenario 11 - re-import with transpose bakes into notes; undo restores pre-transpose notes ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'reimport_transpose_undo'));

  const first = importMidi(clampMidiPath, [0]);
  const initial = executeImport(first.imported, first.summary, [
    { outputTrackIndex: 0, name: 'Lead', visualOnly: false, regionId },
  ]);
  const trackId = initial.tracks[0].id;
  const patternId = initial.patterns[0].id;
  const originalSig = noteSignature(initial.patterns[0]);

  const summary = JSON.parse(addon.midi_parseSummary(reimportMidiPath));
  const importOptions = {
    enabledTrackIndices: summary.tracks.map(t => t.index),
    perTrackOptions: Object.fromEntries(
      summary.tracks.map(t => [String(t.index), { splitDrums: false, enabledSubNotes: [] }])
    ),
    tempoOverride: true,
    projectTPQ: 960,
    projectBPM: summary.sourceTempo || 120,
    maxNoteLengthByOutputTrack: [0],
    transposeByOutputTrack: [7],
  };
  const imported = addon.midi_importFull(reimportMidiPath, JSON.stringify(importOptions));

  addon.midi_executeImport(Buffer.from(imported.noteData), JSON.stringify({
    tempoOverride: true,
    sourceBPM: summary.sourceTempo || 120,
    projectTPQ: 960,
    outputTracks: [
      { outputTrackIndex: 0, name: 'Lead', visualOnly: false, regionId: -1, mode: 'update', targetTrackId: trackId },
    ],
  }));

  // reimportFixture carries pitches 64/67/72 -- transposed +7 that's 71/74/79.
  const afterPattern = addon.timeline_getPattern(patternId);
  assert(afterPattern.notes.some(n => n.pitch === 71), 'transposed note (64+7=71) present after re-import');
  assert(!afterPattern.notes.some(n => n.pitch === 64), 'pre-transpose pitch is gone after re-import');

  assert(addon.undo_undo() === true, 'reimport-transpose undo_undo()');
  const undonePattern = addon.timeline_getPattern(patternId);
  eq(noteSignature(undonePattern), originalSig, 'undo restores the pre-transpose note set exactly');
}

// ─────────────────────────────────────────────────────────────────────────────
// Trim leading silence
// ─────────────────────────────────────────────────────────────────────────────

function runTrimScenario(projectRoot, trimMidiPath) {
  console.log('\n[ Scenario 12 - trim leading silence shifts note starts, note count unchanged ]');
  createProject(path.join(projectRoot, 'trim'));

  const summary = JSON.parse(addon.midi_parseSummary(trimMidiPath));
  assert(summary.ok === true, 'trim fixture parseSummary ok');

  const baseOptions = {
    enabledTrackIndices: [0],
    perTrackOptions: { '0': { splitDrums: false, enabledSubNotes: [] } },
    tempoOverride: true,
    projectTPQ: 960,
    projectBPM: summary.sourceTempo || 120,
    maxNoteLengthByOutputTrack: [0],
  };

  const untrimmed = addon.midi_importFull(trimMidiPath, JSON.stringify(baseOptions));
  const untrimmedMeta = JSON.parse(untrimmed.metadata);
  const untrimmedNotes = readPackedNotes(untrimmed.noteData);
  eq(untrimmedNotes.length, 2, 'untrimmed note count');
  eq(untrimmedMeta.trimOffsetTicks, 0, 'untrimmed metadata reports zero offset');
  eq(Math.min(...untrimmedNotes.map(n => n.tick)), 4800, 'untrimmed earliest note keeps its original (scaled) tick');

  const trimmed = addon.midi_importFull(trimMidiPath, JSON.stringify({ ...baseOptions, trimLeadingSilence: true }));
  const trimmedMeta = JSON.parse(trimmed.metadata);
  const trimmedNotes = readPackedNotes(trimmed.noteData);

  eq(trimmedNotes.length, 2, 'trim does not change note count');
  eq(trimmedMeta.trimOffsetTicks, 4800, 'metadata reports the computed trim offset');
  const sortedTicks = trimmedNotes.map(n => n.tick).sort((a, b) => a - b);
  eq(sortedTicks[0], 0, 'earliest trimmed note lands at tick 0');
  eq(sortedTicks[1], 1920, 'second note shifted by the same offset as the first');
}

// ─────────────────────────────────────────────────────────────────────────────
// Placement: position + tile-to-fill
// ─────────────────────────────────────────────────────────────────────────────

function runPositionScenario(projectRoot, clampMidiPath) {
  console.log('\n[ Scenario 13 - resolved positionTicks places the first block there ]');
  createProject(path.join(projectRoot, 'position'));

  const { summary, imported } = importMidi(clampMidiPath, [0]);
  addon.midi_executeImport(Buffer.from(imported.noteData), JSON.stringify({
    tempoOverride: true,
    sourceBPM: summary.sourceTempo || 120,
    projectTPQ: 960,
    positionTicks: 15360, // 4 bars at 960 PPQ
    outputTracks: [
      { outputTrackIndex: 0, name: 'At Playhead Row', visualOnly: false, regionId: -1 },
    ],
  }));

  const blocks = addon.timeline_getPatternBlocks();
  eq(blocks.length, 1, 'position scenario created one block');
  eq(blocks[0].positionTicks, 15360, 'block placed at the resolved position tick');
}

function runTileToFillScenario(projectRoot, clampMidiPath, mixedMidiPath) {
  console.log('\n[ Scenario 14 - tile-to-fill places sequential blocks to cover the project end ]');
  const regionId = createProjectWithRegion(path.join(projectRoot, 'tile_fill'));

  // First import establishes "existing project content" to tile against.
  const first = importMidi(clampMidiPath, [0]);
  const firstState = executeImport(first.imported, first.summary, [
    { outputTrackIndex: 0, name: 'Existing Content', visualOnly: false, regionId },
  ]);
  const existingPattern = firstState.patterns[0];
  const projectEndTicks = existingPattern.lengthTicks ?? existingPattern.length;
  assert(projectEndTicks > 0, 'existing pattern has a nonzero length to tile against');

  const beforeSecondImport = {
    tracks: addon.timeline_getTracks().length,
    patterns: addon.timeline_getAllPatterns().length,
    blocks: addon.timeline_getPatternBlocks().length,
  };

  // Second import: a short single-note pattern, tiled to fill up to projectEndTicks.
  const second = importMidi(mixedMidiPath, [0, 0]);
  addon.midi_executeImport(Buffer.from(second.imported.noteData), JSON.stringify({
    tempoOverride: true,
    sourceBPM: second.summary.sourceTempo || 120,
    projectTPQ: 960,
    positionTicks: 0,
    tileToFillProject: true,
    outputTracks: [
      { outputTrackIndex: 0, name: 'Tiled Row', visualOnly: false, regionId: -1 },
    ],
  }));

  const tracks = addon.timeline_getTracks();
  const patterns = addon.timeline_getAllPatterns();
  const blocks = addon.timeline_getPatternBlocks();

  const tiledTrack = tracks.find(t => t.name === 'Tiled Row');
  assert(tiledTrack != null, 'tiled track created');
  const tiledPattern = patterns.find(p => p.name === 'Tiled Row');
  assert(tiledPattern != null, 'tiled pattern created');
  const tiledBlocks = blocks.filter(b => b.trackId === tiledTrack.id);

  const blockDuration = tiledPattern.lengthTicks ?? tiledPattern.length;
  assert(blockDuration > 0, 'tiled pattern has a nonzero length');

  let expectedCount = 1;
  let nextPos = blockDuration;
  while (nextPos < projectEndTicks) {
    expectedCount++;
    nextPos += blockDuration;
  }

  eq(tiledBlocks.length, expectedCount, 'tile-to-fill placed the expected number of blocks');
  const sortedBlocks = tiledBlocks.slice().sort((a, b) => a.positionTicks - b.positionTicks);
  eq(sortedBlocks[0].positionTicks, 0, 'first tiled block sits at the resolved position');
  for (let i = 1; i < sortedBlocks.length; i++) {
    eq(sortedBlocks[i].positionTicks, sortedBlocks[i - 1].positionTicks + blockDuration,
       `tiled block ${i} is contiguous with the previous one`);
  }
  assert(sortedBlocks[sortedBlocks.length - 1].positionTicks + blockDuration >= projectEndTicks,
         'tiled blocks cover the project end');

  // Undo removes the track, the pattern, and EVERY tiled block in one step.
  assert(addon.undo_undo() === true, 'tile-to-fill undo_undo()');
  eq(addon.timeline_getTracks().length, beforeSecondImport.tracks, 'undo removes the tiled track');
  eq(addon.timeline_getAllPatterns().length, beforeSecondImport.patterns, 'undo removes the tiled pattern');
  eq(addon.timeline_getPatternBlocks().length, beforeSecondImport.blocks, 'undo removes ALL tiled blocks');
}

function runTileEmptyProjectScenario(projectRoot, mixedMidiPath) {
  console.log('\n[ Scenario 15 - tile-to-fill on an empty project places exactly one block ]');
  createProject(path.join(projectRoot, 'tile_empty'));

  const { summary, imported } = importMidi(mixedMidiPath, [0, 0]);
  addon.midi_executeImport(Buffer.from(imported.noteData), JSON.stringify({
    tempoOverride: true,
    sourceBPM: summary.sourceTempo || 120,
    projectTPQ: 960,
    positionTicks: 0,
    tileToFillProject: true,
    outputTracks: [
      { outputTrackIndex: 0, name: 'Empty Project Row', visualOnly: false, regionId: -1 },
    ],
  }));

  const blocks = addon.timeline_getPatternBlocks();
  eq(blocks.length, 1, 'tile-to-fill on an empty project places exactly one block');
  eq(blocks[0].positionTicks, 0, 'the single block sits at the resolved position');
}

async function main() {
  const projectRoot = path.resolve(__dirname, '_test_midi_import');
  const clampMidiPath = path.join(projectRoot, 'clamp_fixture.mid');
  const mixedMidiPath = path.join(projectRoot, 'mixed_fixture.mid');
  const reimportMidiPath = path.join(projectRoot, 'reimport_fixture.mid');
  const transposeMidiPath = path.join(projectRoot, 'transpose_fixture.mid');
  const drumTransposeMidiPath = path.join(projectRoot, 'drum_transpose_fixture.mid');
  const trimMidiPath = path.join(projectRoot, 'trim_fixture.mid');

  cleanupDir(projectRoot);
  ensureDir(projectRoot);
  writeClampFixture(clampMidiPath);
  writeMixedFixture(mixedMidiPath);
  writeReimportFixture(reimportMidiPath);
  writeTransposeFixture(transposeMidiPath);
  writeDrumTransposeFixture(drumTransposeMidiPath);
  writeTrimFixture(trimMidiPath);
  testWavPath = path.join(projectRoot, 'fixture.wav');
  writeTestWav(testWavPath);

  try {
    assert(addon.initialize() === true, 'initialize()');

    runAssignedScenario(projectRoot, clampMidiPath);
    runDeferredAssignmentScenario(projectRoot, clampMidiPath);
    runMixedScenario(projectRoot, mixedMidiPath);
    runClampScenario(projectRoot, clampMidiPath);
    runReimportTargetsScenario(projectRoot, clampMidiPath);
    runReimportUpdateScenario(projectRoot, clampMidiPath, reimportMidiPath);
    runMixedReimportScenario(projectRoot, clampMidiPath, mixedMidiPath);
    runInvalidTargetScenario(projectRoot, clampMidiPath);
    runTransposeClampScenario(projectRoot, transposeMidiPath);
    runDrumSplitTransposeScenario(projectRoot, drumTransposeMidiPath);
    runReimportTransposeUndoScenario(projectRoot, clampMidiPath, reimportMidiPath);
    runTrimScenario(projectRoot, trimMidiPath);
    runPositionScenario(projectRoot, clampMidiPath);
    runTileToFillScenario(projectRoot, clampMidiPath, mixedMidiPath);
    runTileEmptyProjectScenario(projectRoot, mixedMidiPath);
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
