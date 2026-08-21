'use strict';

// Contract coverage for the bulk clip operations behind copy/paste and
// multi-clip drags: timeline_addClipsBatch (full-fidelity), moveClipsBatch and
// removeClipsBatch. Run after the native addon is rebuilt:
//   node bridge/test_clip_batch_ops.js

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_clip_batch_ops');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}
function near(actual, expected, tolerance = 1e-5) {
  return Math.abs(actual - expected) <= tolerance;
}
function clipById(id) {
  return addon.timeline_getClips().find((c) => c.id === id);
}

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'ClipBatchOpsTest') === true, 'project created');

  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1, order: 1 });
  const regionId = addon.timeline_addRegion({ name: 'Region', startTime: 0, endTime: 1 });

  // ── addClipsBatch carries the FULL clip field set ──────────────────────────
  // The old implementation read 7 of these and silently dropped the rest,
  // which is why paste could not use it.
  const rich = {
    trackId: trackA,
    regionId,
    positionTicks: 960,
    durationTicks: 480,
    regionOffsetTicks: 120,
    syllableIndex: 2,
    velocity: 0.65,
    pitchOffset: -3,
    pitchOffsetCents: 42,
    reversed: true,
    stretchRatio: 2.5,
    stretchMethod: 1,
    formantPreserve: true,
    fadeInPercent: 15,
    fadeOutPercent: 25,
    fadeInX1: 0.1, fadeInY1: 0.2, fadeInX2: 0.8, fadeInY2: 0.9,
    fadeOutX1: 0.3, fadeOutY1: 0.4, fadeOutX2: 0.7, fadeOutY2: 0.6,
  };
  const plain = {
    trackId: trackB, regionId, positionTicks: 1920, durationTicks: 480,
  };

  const ids = addon.timeline_addClipsBatch([rich, plain]);
  check(Array.isArray(ids) && ids.length === 2, 'addClipsBatch returns one id per clip');

  const a = clipById(ids[0]);
  check(!!a, 'batch-added clip is retrievable');
  check(a.regionOffsetTicks === 120, 'regionOffsetTicks survives the batch path');
  check(a.syllableIndex === 2, 'syllableIndex survives');
  check(near(a.velocity, 0.65), 'velocity survives');
  check(a.pitchOffset === -3, 'pitchOffset survives');
  check(a.pitchOffsetCents === 42, 'pitchOffsetCents survives');
  check(a.reversed === true, 'reversed survives');
  check(near(a.stretchRatio, 2.5), 'stretchRatio survives');
  check(a.stretchMethod === 1, 'stretchMethod survives');
  check(a.formantPreserve === true, 'formantPreserve survives');
  check(near(a.fadeInPercent, 15, 1e-3), 'fadeInPercent survives');
  check(near(a.fadeOutPercent, 25, 1e-3), 'fadeOutPercent survives');
  check(near(a.fadeInX1, 0.1, 1e-3) && near(a.fadeOutY2, 0.6, 1e-3),
        'fade bezier control points survive');

  const b = clipById(ids[1]);
  check(near(b.stretchRatio, 1.0) && b.reversed === false,
        'omitted fields fall back to engine defaults, not to the previous clip');

  // ── addClipsBatch is ONE undo entry ────────────────────────────────────────
  check(addon.undo_getUndoDescription().includes('clips batch'),
        'batch add describes itself as one operation');
  addon.undo_undo();
  check(addon.timeline_getClips().length === 0, 'one undo removes the whole batch');
  addon.undo_redo();
  check(addon.timeline_getClips().length === 2, 'redo restores the whole batch');
  check(clipById(ids[0]) !== undefined && clipById(ids[1]) !== undefined,
        'redo preserves the original clip ids');

  // ── moveClipsBatch ─────────────────────────────────────────────────────────
  const moved = addon.timeline_moveClipsBatch([
    { clipId: ids[0], trackId: trackB, positionTicks: 3840 },
    { clipId: ids[1], trackId: trackB, positionTicks: 4320 },
  ]);
  check(moved === 2, 'moveClipsBatch reports the number of clips moved');
  check(clipById(ids[0]).positionTicks === 3840 && clipById(ids[0]).trackId === trackB,
        'first clip moved to the requested track and position');
  check(clipById(ids[1]).positionTicks === 4320, 'second clip moved');

  addon.undo_undo();
  check(clipById(ids[0]).positionTicks === 960 && clipById(ids[0]).trackId === trackA,
        'one undo restores BOTH clips to their pre-move track and position');
  check(clipById(ids[1]).positionTicks === 1920, 'second clip restored too');

  // A move must not disturb the clip's playback params — it is the case that
  // used to trigger a full pitch/stretch re-render for every clip dragged.
  addon.timeline_moveClipsBatch([{ clipId: ids[0], trackId: trackA, positionTicks: 5760 }]);
  const afterMove = clipById(ids[0]);
  check(near(afterMove.stretchRatio, 2.5) && afterMove.pitchOffset === -3
        && afterMove.reversed === true,
        'a batched move leaves pitch/stretch/reverse untouched');
  addon.undo_undo();

  // Unknown clip ids are skipped, not fatal.
  const partial = addon.timeline_moveClipsBatch([
    { clipId: ids[0], trackId: trackA, positionTicks: 480 },
    { clipId: 999999, trackId: trackA, positionTicks: 480 },
  ]);
  check(partial === 1, 'moveClipsBatch skips ids that no longer exist');
  addon.undo_undo();

  // ── removeClipsBatch ───────────────────────────────────────────────────────
  const removed = addon.timeline_removeClipsBatch([ids[0], ids[1]]);
  check(removed === 2, 'removeClipsBatch reports the number of clips removed');
  check(addon.timeline_getClips().length === 0, 'both clips are gone');

  addon.undo_undo();
  check(addon.timeline_getClips().length === 2,
        'one undo restores the whole deleted selection');
  const restored = clipById(ids[0]);
  check(!!restored, 'restored clip keeps its original id');
  check(near(restored.stretchRatio, 2.5) && restored.pitchOffsetCents === 42
        && restored.regionOffsetTicks === 120,
        'restored clip keeps every field, not just position/duration');

  // ── pasteClipsBatch: overwrite + insert as ONE undo entry ──────────────────
  // Two clips sit at 960 and 1920. Paste a group over both: they must vanish,
  // the new pair must appear, and a SINGLE Ctrl+Z must restore the original
  // state exactly — not the half-applied state between remove and insert.
  const before = addon.timeline_getClips().map(c => `${c.trackId}@${c.positionTicks}`).sort();
  check(before.length === 2, 'two clips on the timeline before the paste');

  const pasteRes = addon.timeline_pasteClipsBatch({
    removeClipIds: [ids[0], ids[1]],
    clips: [
      { trackId: trackA, regionId, positionTicks: 960,  durationTicks: 480, stretchRatio: 3.0 },
      { trackId: trackB, regionId, positionTicks: 1920, durationTicks: 480, pitchOffsetCents: -11 },
    ],
  });
  check(Array.isArray(pasteRes.newIds) && pasteRes.newIds.length === 2,
        'pasteClipsBatch returns the inserted ids');
  check(pasteRes.removedCount === 2, 'pasteClipsBatch reports what it overwrote');
  check(addon.timeline_getClips().length === 2,
        'overwritten clips are gone, replacements are in — no stacking');
  check(near(clipById(pasteRes.newIds[0]).stretchRatio, 3.0),
        'pasted clip keeps its full field set');

  check(addon.undo_getUndoDescription().includes('Paste'),
        'the paste describes itself as one operation');
  addon.undo_undo();
  const restoredState = addon.timeline_getClips().map(c => `${c.trackId}@${c.positionTicks}`).sort();
  check(JSON.stringify(restoredState) === JSON.stringify(before),
        'ONE undo restores the pre-paste state (both the insert and the overwrite)');
  check(clipById(pasteRes.newIds[0]) === undefined,
        'undo removed the pasted clips too, not just restored the overwritten ones');

  addon.undo_redo();
  check(addon.timeline_getClips().length === 2, 'redo re-applies the paste');
  check(clipById(pasteRes.newIds[0]) !== undefined,
        'redo restores the pasted clips with their original ids');
  addon.undo_undo();

  // A paste onto empty space overwrites nothing.
  const cleanPaste = addon.timeline_pasteClipsBatch({
    removeClipIds: [],
    clips: [{ trackId: trackA, regionId, positionTicks: 99000, durationTicks: 480 }],
  });
  check(cleanPaste.removedCount === 0 && cleanPaste.newIds.length === 1,
        'a paste onto empty space overwrites nothing');
  addon.undo_undo();

  // ── Empty input is a no-op, not an error ───────────────────────────────────
  check(addon.timeline_addClipsBatch([]).length === 0, 'empty addClipsBatch is a no-op');
  check(addon.timeline_moveClipsBatch([]) === 0, 'empty moveClipsBatch is a no-op');
  check(addon.timeline_removeClipsBatch([]) === 0, 'empty removeClipsBatch is a no-op');
  check(addon.timeline_getClips().length === 2, 'no-op batches left the timeline alone');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
