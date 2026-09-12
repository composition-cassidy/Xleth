'use strict';

// Contract coverage for the batched pattern-block operations behind Ctrl+V and
// Ctrl+D: timeline_addPatternBlocksBatch and timeline_pastePatternBlocksBatch.
//
// What these replace: a SERIAL for-loop of awaited timeline_addPatternBlock,
// plus a SECOND awaited timeline_setPatternBlockLoop for every looped block. A
// 64-block paste was 64+ stacked round trips and 64+ undo entries, which the
// renderer papered over by counting them into compoundUndoCountRef. The two
// properties that has to buy: loopEnabled arrives WITH the block, and the whole
// group is ONE undo entry.
//
// Run after the native addon is rebuilt:
//   node bridge/test_pattern_block_batch_ops.js

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_pattern_block_batch_ops');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}
function blocks() { return addon.timeline_getPatternBlocks(); }
function blockById(id) { return blocks().find((b) => b.id === id); }

const PPQ = 960;

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'PatternBlockBatchOpsTest') === true, 'project created');

  const regionId = addon.timeline_addRegion({ name: 'Lead', startTime: 0, endTime: 2 });
  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1, order: 1 });
  const patId = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });

  const mk = (trackId, positionTicks, over = {}) => ({
    trackId, patternId: patId, positionTicks,
    durationTicks: 4 * PPQ, offsetTicks: 0, ...over,
  });

  // ── addPatternBlocksBatch returns post-state, not just ids ─────────────────
  const added = addon.timeline_addPatternBlocksBatch([
    mk(trackA, 0),
    mk(trackA, 4 * PPQ, { loopEnabled: true }),
    mk(trackB, 0, { offsetTicks: 480 }),
  ]);
  check(Array.isArray(added) && added.length === 3,
        'addPatternBlocksBatch returns one block per placement');
  check(added[0].id > 0 && added[1].id > added[0].id,
        'the returned blocks carry their assigned ids');
  check(added[0].positionTicks === 0 && added[1].positionTicks === 4 * PPQ
        && added[2].trackId === trackB,
        'the returned blocks carry their engine-side placement');

  // The whole point of the loopEnabled field: no second setPatternBlockLoop RPC.
  check(added[1].loopEnabled === true && added[0].loopEnabled === false,
        'loopEnabled arrives WITH the block — no second round trip per looped block');
  check(blockById(added[1].id).loopEnabled === true,
        'and it is what the timeline actually stored');
  check(added[2].offsetTicks === 480, 'offsetTicks survives the batch path');

  // ── ONE undo entry for the whole group ────────────────────────────────────
  check(blocks().length === 3, 'three blocks on the timeline');
  addon.undo_undo();
  check(blocks().length === 0, 'ONE undo removes the whole batch, not one block of three');
  addon.undo_redo();
  check(blocks().length === 3, 'redo restores the whole batch');
  check(blockById(added[0].id) !== undefined && blockById(added[2].id) !== undefined,
        'redo preserves the original block ids');
  check(blockById(added[1].id).loopEnabled === true,
        'redo preserves loopEnabled — it is part of the block, not a follow-up command');

  // ── pastePatternBlocksBatch: overwrite + insert as ONE undo entry ──────────
  // Three blocks exist. Paste a group over two of them: they must vanish, the
  // new ones appear, and a SINGLE undo must restore the pre-paste state — not
  // the half-applied state between remove and insert.
  const before = blocks().map((b) => `${b.trackId}@${b.positionTicks}`).sort();
  const pasteRes = addon.timeline_pastePatternBlocksBatch({
    removeBlockIds: [added[0].id, added[1].id],
    blocks: [mk(trackA, 0, { loopEnabled: true }), mk(trackA, 4 * PPQ)],
  });
  check(Array.isArray(pasteRes.blocks) && pasteRes.blocks.length === 2,
        'pastePatternBlocksBatch returns the inserted blocks');
  check(Array.isArray(pasteRes.removedIds) && pasteRes.removedIds.length === 2
        && pasteRes.removedIds.includes(added[0].id),
        'and names exactly which blocks it buried');
  check(blocks().length === 3,
        'overwritten blocks are gone, replacements are in — no stacking');
  check(pasteRes.blocks[0].loopEnabled === true, 'a pasted block keeps its loop flag');

  check(addon.undo_getUndoDescription().includes('Paste'),
        'the paste describes itself as one operation');
  addon.undo_undo();
  const restored = blocks().map((b) => `${b.trackId}@${b.positionTicks}`).sort();
  check(JSON.stringify(restored) === JSON.stringify(before),
        'ONE undo restores the pre-paste state (both the insert and the overwrite)');
  check(blockById(pasteRes.blocks[0].id) === undefined,
        'undo removed the pasted blocks too, not just restored the overwritten ones');
  check(blockById(added[1].id).loopEnabled === true,
        'the restored block keeps every field, loopEnabled included');

  addon.undo_redo();
  check(blocks().length === 3, 'redo re-applies the paste');
  check(blockById(pasteRes.blocks[0].id) !== undefined,
        'redo restores the pasted blocks with their original ids');
  addon.undo_undo();

  // A paste onto empty space overwrites nothing.
  const cleanPaste = addon.timeline_pastePatternBlocksBatch({
    removeBlockIds: [],
    blocks: [mk(trackB, 99 * PPQ)],
  });
  check(cleanPaste.removedIds.length === 0 && cleanPaste.blocks.length === 1,
        'a paste onto empty space overwrites nothing');
  addon.undo_undo();

  // ── Malformed and empty input ─────────────────────────────────────────────
  check(addon.timeline_addPatternBlocksBatch([]).length === 0,
        'empty addPatternBlocksBatch is a no-op');
  check(addon.timeline_pastePatternBlocksBatch({ blocks: [] }).blocks.length === 0,
        'empty pastePatternBlocksBatch is a no-op');
  // A placement missing a required field is skipped, not fatal, and not a
  // half-built block on the timeline.
  const partial = addon.timeline_addPatternBlocksBatch([
    mk(trackA, 8 * PPQ),
    { trackId: trackA, positionTicks: 12 * PPQ },   // no patternId / durationTicks
  ]);
  check(partial.length === 1, 'a malformed placement is skipped, not fatal');
  addon.undo_undo();
  check(blocks().length === 3, 'no-op and partial batches left the timeline as it was');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
