'use strict';

// Contract coverage for timeline_setClipModulationBatch — the RPC behind
// Settings > Clip FX > "Apply to Project". Run after the native addon is
// rebuilt:
//   node bridge/test_clip_modulation_batch.js
//
// The properties that matter to the caller, and that a serial loop of
// timeline_setClipModulation does NOT give it:
//   • N clips, ONE undo entry (a project can hold more clips than the undo
//     stack's 100-entry cap, so a per-clip loop silently flushed the history)
//   • undo restores the MIXED prior state, not one uniform value
//   • each entry is a partial patch merged onto that clip's own descriptor, so
//     an untouched field (vibrato, swirlRadius) survives

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_clip_modulation_batch');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}
function near(actual, expected, tolerance = 1e-5) {
  return Math.abs(actual - expected) <= tolerance;
}
function videoOf(id) {
  const c = addon.timeline_getClips().find((x) => x.id === id);
  return c && c.modulation ? c.modulation.video : undefined;
}

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'ClipModulationBatchTest') === true, 'project created');

  const trackId = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const regionId = addon.timeline_addRegion({ name: 'Region', startTime: 0, endTime: 1 });
  const ids = addon.timeline_addClipsBatch([
    { trackId, regionId, positionTicks: 0,    durationTicks: 480 },
    { trackId, regionId, positionTicks: 960,  durationTicks: 480 },
    { trackId, regionId, positionTicks: 1920, durationTicks: 480 },
  ]);
  check(ids.length === 3, 'three clips created');

  // Clip 1 starts with Swirl already on and a hand-dialled amount, plus a
  // vibrato block the batch must not disturb. Clips 2 and 3 are untouched.
  addon.timeline_setClipModulation(ids[0], {
    vibrato: { enabled: true, depthCents: 900 },
    video: { vibratoSwirlEnabled: true, swirlAmount: 0.9, swirlRadius: 0.2 },
  });


  // ── The apply: turn Swirl on where it isn't, with one default amount ───────
  const updated = addon.timeline_setClipModulationBatch([
    { clipId: ids[1], modulation: { video: { vibratoSwirlEnabled: true, swirlAmount: 0.45 } } },
    { clipId: ids[2], modulation: { video: { vibratoSwirlEnabled: true, swirlAmount: 0.45 } } },
  ]);

  check(Array.isArray(updated) && updated.length === 2,
        'setClipModulationBatch returns the post-state of every edited clip');
  check(near(videoOf(ids[1]).swirlAmount, 0.45) && videoOf(ids[1]).vibratoSwirlEnabled === true,
        'clip 2 got the default Swirl');
  check(near(videoOf(ids[2]).swirlAmount, 0.45) && videoOf(ids[2]).vibratoSwirlEnabled === true,
        'clip 3 got the default Swirl');
  check(near(videoOf(ids[0]).swirlAmount, 0.9),
        'the clip that already had Swirl was not in the batch and kept its own amount');

  // The engine exposes no undo-depth query, so 'one entry' is asserted the way
  // the user experiences it: the top entry names both clips, and the single
  // undo further down puts both of them back.
  check(addon.undo_getUndoDescription().includes('2 clip(s)'),
        'the batch pushed ONE undo entry, and it names both clips');

  // ── Partial-merge semantics: untouched fields survive ──────────────────────
  const c2 = addon.timeline_getClips().find((x) => x.id === ids[1]);
  check(near(c2.modulation.video.waveAmount, 0.08) && near(c2.modulation.video.waveFrequency, 8),
        'fields absent from the patch keep the engine defaults');

  addon.timeline_setClipModulationBatch([
    { clipId: ids[0], modulation: { video: { scratchWaveEnabled: true, waveAmount: 0.3 } } },
  ]);
  const c1 = addon.timeline_getClips().find((x) => x.id === ids[0]);
  check(c1.modulation.vibrato.enabled === true && near(c1.modulation.vibrato.depthCents, 900),
        'a video-only patch leaves the vibrato block alone');
  check(near(c1.modulation.video.swirlRadius, 0.2) && near(c1.modulation.video.swirlAmount, 0.9),
        'a video-only patch leaves the video fields it did not name alone');
  addon.undo_undo();

  // ── Undo restores the MIXED prior state ───────────────────────────────────
  addon.undo_undo();
  check(videoOf(ids[1]).vibratoSwirlEnabled === false && videoOf(ids[2]).vibratoSwirlEnabled === false,
        'undo switches Swirl back off on both batched clips');
  check(near(videoOf(ids[1]).swirlAmount, 0.25),
        'undo restores the engine stock amount on a clip that had never been dialled in');
  check(near(videoOf(ids[0]).swirlAmount, 0.9) && videoOf(ids[0]).vibratoSwirlEnabled === true,
        'undo does not touch the clip that was never in the batch');

  addon.undo_redo();
  check(near(videoOf(ids[1]).swirlAmount, 0.45) && near(videoOf(ids[2]).swirlAmount, 0.45),
        'redo re-applies the whole batch');
  addon.undo_undo();

  // ── Degenerate input ──────────────────────────────────────────────────────
  const topBefore = addon.undo_getUndoDescription();
  check(addon.timeline_setClipModulationBatch([]).length === 0,
        'an empty batch is a no-op, not an error');
  check(addon.timeline_setClipModulationBatch([
          { clipId: 999999, modulation: { video: { vibratoSwirlEnabled: true } } },
        ]).length === 0,
        'an unknown clip id is skipped rather than throwing');
  check(addon.undo_getUndoDescription() === topBefore,
        'a batch that edits nothing pushes no undo entry');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon.shutdown(); } catch { /* engine may already be down */ }
  fs.rmSync(projectDir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
