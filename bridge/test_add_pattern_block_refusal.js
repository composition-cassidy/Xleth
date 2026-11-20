'use strict';

// timeline_addPatternBlock must say so when the add is refused.
//
// Timeline::addPatternBlock refuses an exact {trackId, patternId, position}
// duplicate (and an unknown track or pattern). The RPC used to answer with
// getAllPatternBlocks().back()->id regardless, so a refused add came back as
// the id of a different, already existing block, and the renderer then moved or
// deleted that block believing it had just made it. A refused add must return
// -1, the same "no id" sentinel loadSample and the other id-returning RPCs use,
// leave the existing block untouched, and not land on the undo stack.
//
// Run after the native addon is rebuilt:
//   node bridge/test_add_pattern_block_refusal.js

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_add_pattern_block_refusal');

let passed = 0;
let failed = 0;
function check(condition, label, detail) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`); }
}
const blocks = () => addon.timeline_getPatternBlocks();

const PPQ = 960;

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'AddPatternBlockRefusalTest') === true, 'project created');

  const regionId = addon.timeline_addRegion({ name: 'Lead', startTime: 0, endTime: 2 });
  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1, order: 1 });
  const patP = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });
  const patQ = addon.timeline_addPattern({ name: 'Q', regionId, lengthTicks: 4 * PPQ });
  const mk = (trackId, patternId, positionTicks, over = {}) => ({
    trackId, patternId, positionTicks, durationTicks: 4 * PPQ, offsetTicks: 0, ...over,
  });

  // A successful add still returns the id of the block it made.
  const first = addon.timeline_addPatternBlock(mk(trackA, patP, 0));
  check(Number.isInteger(first) && first > 0, 'a first add returns a block id');
  const placed = blocks().find((b) => b.id === first);
  check(placed && placed.trackId === trackA && placed.patternId === patP && placed.positionTicks === 0,
    'and that id is the block that was just placed');

  // Add a second, unrelated block LAST, so "the newest block" is not the one a
  // refused duplicate of `first` would be confused with.
  const other = addon.timeline_addPatternBlock(mk(trackB, patP, 8 * PPQ));
  check(Number.isInteger(other) && other > first, 'a block elsewhere returns its own, newer id');

  const before = JSON.stringify(blocks());
  const undoTop = addon.undo_getUndoDescription();
  const redoTop = addon.undo_getRedoDescription();

  // 1. The duplicate: same track, same pattern, same position as `first`.
  //    Different length and offset make no difference to the refusal.
  const dup = addon.timeline_addPatternBlock(mk(trackA, patP, 0, { durationTicks: PPQ, offsetTicks: PPQ }));
  check(dup === -1, 'a duplicate add is refused with -1', `got ${dup}`);
  check(JSON.stringify(blocks()) === before, 'the refused add changed no block (existing block untouched)');
  check(addon.undo_getUndoDescription() === undoTop, 'the refused add is not on the undo stack',
    `top is now "${addon.undo_getUndoDescription()}"`);
  check(addon.undo_getRedoDescription() === redoTop, 'and kept the redo history');

  // 2. Unknown track / unknown pattern are refusals too, with the same sentinel.
  const noTrack = addon.timeline_addPatternBlock(mk(999999, patP, 16 * PPQ));
  check(noTrack === -1, 'an add on an unknown track returns -1', `got ${noTrack}`);
  const noPattern = addon.timeline_addPatternBlock(mk(trackA, 999999, 16 * PPQ));
  check(noPattern === -1, 'an add of an unknown pattern returns -1', `got ${noPattern}`);
  check(JSON.stringify(blocks()) === before, 'neither of those changed any block');

  // 3. Only an EXACT duplicate is refused: another pattern, track or position is fine.
  const otherPattern = addon.timeline_addPatternBlock(mk(trackA, patQ, 0));
  const otherTrack = addon.timeline_addPatternBlock(mk(trackB, patP, 0));
  const otherPos = addon.timeline_addPatternBlock(mk(trackA, patP, 4 * PPQ));
  check([otherPattern, otherTrack, otherPos].every((id) => Number.isInteger(id) && id > 0),
    'a different pattern, track or position is not a duplicate');
  check(new Set([first, other, otherPattern, otherTrack, otherPos]).size === 5,
    'and each got its own id');

  // 4. A later undo removes the block the last SUCCESSFUL add made, not `first`.
  addon.undo_undo();
  check(!blocks().some((b) => b.id === otherPos) && blocks().some((b) => b.id === first),
    'undo after a refused add undoes the previous real edit and spares the existing block');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
