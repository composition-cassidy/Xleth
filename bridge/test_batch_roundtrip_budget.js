'use strict';

// Round-trip budget for the two bulk gestures the timeline is graded on.
//
// This is the engine-boundary half of the acceptance criteria:
//
//   drag-move a 200-clip selection → exactly one moveClipsBatch, and the reply
//                                    carries everything the renderer needs, so
//                                    no getClips has to follow it
//   paste 64 pattern blocks        → one round trip, one undo entry
//
// Every addon call the renderer would make is counted through a proxy, so a
// regression that reintroduces a per-item loop or a trailing full refetch fails
// here rather than only showing up as a slow drag on a large project.
//
// Run after the native addon is rebuilt:
//   node bridge/test_batch_roundtrip_budget.js

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const raw = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_batch_roundtrip_budget');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}

// Counts every engine call by method name, so a budget is an assertion about
// the whole gesture rather than about one call site.
const calls = [];
const addon = new Proxy(raw, {
  get(target, prop) {
    const v = target[prop];
    if (typeof v !== 'function') return v;
    return (...args) => { calls.push(String(prop)); return v.apply(target, args); };
  },
});
function budget(fn) {
  const start = calls.length;
  const result = fn();
  const made = calls.slice(start);
  const byMethod = {};
  for (const m of made) byMethod[m] = (byMethod[m] || 0) + 1;
  return { result, made, byMethod };
}

const PPQ = 960;

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'BatchRoundTripBudget') === true, 'project created');

  const regionId = addon.timeline_addRegion({ name: 'R', startTime: 0, endTime: 2 });
  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1, order: 1 });
  const patId = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });

  // ── Scenario A: drag-move a 200-clip selection ────────────────────────────
  const N_CLIPS = 200;
  const ids = addon.timeline_addClipsBatch(
    Array.from({ length: N_CLIPS }, (_, i) => ({
      trackId: trackA, regionId,
      positionTicks: i * 480, durationTicks: 480,
    })));
  check(ids.length === N_CLIPS, `${N_CLIPS} clips created`);

  // The drag lands on empty space on another track, so nothing is buried and
  // the gesture is a single moveClipsBatch — exactly what the renderer emits.
  const moves = ids.map((clipId, i) => ({
    clipId, trackId: trackB, positionTicks: 100000 + i * 480,
  }));
  const moveRun = budget(() => addon.timeline_moveClipsBatch(moves));

  check(moveRun.made.length === 1,
        `a ${N_CLIPS}-clip drag is ONE engine call (was ${moveRun.made.length})`);
  check(moveRun.byMethod.timeline_moveClipsBatch === 1,
        'and that call is moveClipsBatch');
  check(!moveRun.byMethod.timeline_getClips,
        'no getClips follows it — the reply already carries the post-state');
  check(moveRun.result.length === N_CLIPS,
        `the reply carries all ${N_CLIPS} moved clips`);
  check(moveRun.result.every((c, i) =>
          c.id === ids[i] && c.trackId === trackB && c.positionTicks === 100000 + i * 480),
        'every returned clip carries its post-move track and position');
  // Full clip objects, not position patches: the renderer merges these straight
  // into its list, so anything clipToJs emits has to be here.
  check(moveRun.result.every((c) =>
          c.durationTicks !== undefined && c.stretchRatio !== undefined
          && c.fadeInPercent !== undefined && c.modulation !== undefined),
        'and is a full clip object, not a position patch');

  // ONE undo entry for the whole selection.
  addon.undo_undo();
  const afterUndo = addon.timeline_getClips();
  check(afterUndo.every((c) => c.trackId === trackA),
        'ONE undo put the whole 200-clip selection back, not one clip of it');
  addon.undo_redo();
  addon.undo_undo();

  // ── Scenario B: paste 64 pattern blocks ──────────────────────────────────
  const N_BLOCKS = 64;
  const blocks = Array.from({ length: N_BLOCKS }, (_, i) => ({
    trackId: trackA, patternId: patId,
    positionTicks: i * 4 * PPQ, durationTicks: 4 * PPQ, offsetTicks: 0,
    // Every other block is looped — under the old shape each of these cost a
    // SECOND awaited round trip (setPatternBlockLoop) and a second undo entry.
    loopEnabled: i % 2 === 0,
  }));
  const pasteRun = budget(() => addon.timeline_pastePatternBlocksBatch({
    removeBlockIds: [], blocks,
  }));

  check(pasteRun.made.length === 1,
        `a ${N_BLOCKS}-block paste is ONE engine call (was ${pasteRun.made.length})`);
  check(pasteRun.byMethod.timeline_pastePatternBlocksBatch === 1,
        'and that call is pastePatternBlocksBatch');
  check(!pasteRun.byMethod.timeline_addPatternBlock
        && !pasteRun.byMethod.timeline_setPatternBlockLoop,
        'no per-block addPatternBlock and no per-block setPatternBlockLoop');
  check(!pasteRun.byMethod.timeline_getPatternBlocks,
        'no getPatternBlocks follows it — the reply already carries the blocks');
  check(pasteRun.result.blocks.length === N_BLOCKS,
        `the reply carries all ${N_BLOCKS} inserted blocks`);
  check(pasteRun.result.blocks.every((b, i) => b.loopEnabled === (i % 2 === 0)),
        'loopEnabled came back on the blocks — no follow-up RPC set it');
  check(addon.timeline_getPatternBlocks().length === N_BLOCKS,
        'and the timeline really holds them');

  // ONE undo entry for the whole paste.
  addon.undo_undo();
  check(addon.timeline_getPatternBlocks().length === 0,
        'ONE undo removes all 64 blocks, not one of them');
  addon.undo_redo();
  check(addon.timeline_getPatternBlocks().length === N_BLOCKS, 'redo restores all 64');

  // ── Scenario C: paste 64 automation clips onto one lane ──────────────────
  // The positions are all the same on purpose: same-lane overlap is rejected,
  // so each placement depends on the ones before it. Resolving that engine-side
  // is what lets the whole group be one call instead of 64 awaited ones.
  const laneId = addon.automation_addLane({ ownerTrackId: trackA, index: -1 });
  const envelopeId = addon.automation_addEnvelope({
    ownerTrackId: trackA, effectInstanceId: 'fx-1', parameterId: 'mix',
    points: [{ t: 0, v: 0.5 }],
  });
  check(laneId > 0 && envelopeId > 0, 'automation lane + envelope created');

  const N_AUTO = 64;
  const autoRun = budget(() => addon.automation_addClipsBatch(
    Array.from({ length: N_AUTO }, () => ({
      laneId, envelopeId, positionTicks: 0, durationTicks: 4 * PPQ, offsetTicks: 0,
    }))));
  check(autoRun.made.length === 1,
        `a ${N_AUTO}-clip automation paste is ONE engine call (was ${autoRun.made.length})`);
  check(!autoRun.byMethod.automation_addClip, 'no per-clip automation_addClip');
  check(autoRun.result.length === N_AUTO, `all ${N_AUTO} placements landed`);
  check(autoRun.result.every((c, i) => c.positionTicks === i * 4 * PPQ),
        'each was slotted past the ones before it in the SAME batch');
  addon.undo_undo();
  check(addon.automation_getClips().length === 0,
        'ONE undo removes the whole automation group');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { raw.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
