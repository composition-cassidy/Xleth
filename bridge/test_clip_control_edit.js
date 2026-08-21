'use strict';

// Contract coverage for the transient gain/fade edit session. Run after the
// native addon is rebuilt: node bridge/test_clip_control_edit.js

const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_clip_control_edit');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}
function near(actual, expected, tolerance = 1e-5) {
  return Math.abs(actual - expected) <= tolerance;
}
function currentClip(clipId) {
  return addon.timeline_getClips().find((clip) => clip.id === clipId);
}
function rejects(call) {
  try { call(); return false; } catch { return true; }
}

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'ClipControlEditTest') === true, 'project created');

  const trackId = addon.timeline_addTrack({ name: 'Audio', volume: 1, order: 0 });
  const regionId = addon.timeline_addRegion({ name: 'Region', startTime: 0, endTime: 1 });
  const clipId = addon.timeline_addClip({
    trackId,
    regionId,
    positionTicks: 0,
    durationTicks: 960,
    velocity: 1,
  });
  check(clipId > 0, 'fixture clip created');

  const undoBeforePreview = addon.undo_getUndoDescription();
  const first = addon.timeline_beginClipControlEdit(clipId);
  check(first.sessionId > 0 && near(first.initial.velocity, 1), 'begin captures baseline');
  check(rejects(() => addon.timeline_previewClipControlEdit(first.sessionId, { ignored: 42 })), 'unknown patch fields are rejected');
  const preview = addon.timeline_previewClipControlEdit(first.sessionId, {
    velocity: 3,
    fadeInPercent: 70,
    fadeOutPercent: 70,
  });
  check(near(preview.velocity, 2), 'preview clamps velocity to 2.0');
  check(near(preview.fadeInPercent + preview.fadeOutPercent, 100), 'preview normalizes overlapping fades');
  check(addon.undo_getUndoDescription() === undoBeforePreview, 'preview creates no undo entry');
  check(addon.project_save() === false, 'save is deferred while preview is transient');

  const cancelled = addon.timeline_cancelClipControlEdit(first.sessionId);
  check(near(cancelled.velocity, 1) && near(cancelled.fadeInPercent, 0), 'cancel restores captured baseline');
  check(rejects(() => addon.timeline_previewClipControlEdit(first.sessionId, { velocity: 0.5 })), 'stale preview is rejected');

  const committedSession = addon.timeline_beginClipControlEdit(clipId);
  addon.timeline_previewClipControlEdit(committedSession.sessionId, { velocity: 1.6 });
  const committed = addon.timeline_commitClipControlEdit(committedSession.sessionId, {
    velocity: 0.5,
    fadeInPercent: 30,
    fadeOutPercent: 15,
  });
  check(near(committed.velocity, 0.5) && near(committed.fadeInPercent, 30) && near(committed.fadeOutPercent, 15), 'commit applies exact final patch');
  check(rejects(() => addon.timeline_previewClipControlEdit(committedSession.sessionId, { velocity: 1 })), 'late preview after commit is rejected');

  check(addon.undo_undo() === true, 'commit produces one undoable command');
  const undone = currentClip(clipId);
  check(near(undone.velocity, 1) && near(undone.fadeInPercent, 0) && near(undone.fadeOutPercent, 0), 'one undo restores pre-gesture values');
  check(addon.undo_redo() === true && near(currentClip(clipId).velocity, 0.5), 'redo restores committed values');

  const descriptionBeforeNoop = addon.undo_getUndoDescription();
  const noop = addon.timeline_beginClipControlEdit(clipId);
  addon.timeline_commitClipControlEdit(noop.sessionId, {});
  check(addon.undo_getUndoDescription() === descriptionBeforeNoop, 'unchanged commit creates no undo entry');
  addon.undo_undo();
  check(near(currentClip(clipId).velocity, 1), 'undo after no-op reaches the prior real command');
  addon.undo_redo();

  // ── Concurrent sessions (multi-clip volume/fade drag) ─────────────────────
  // A multi-clip drag opens one session per selected clip and commits them one
  // by one. Opening the second session must NOT roll back or invalidate the
  // first, or every clip but the last would silently fail to commit.
  const clipB = addon.timeline_addClip({
    trackId, regionId, positionTicks: 1920, durationTicks: 960, velocity: 1,
  });
  const clipC = addon.timeline_addClip({
    trackId, regionId, positionTicks: 3840, durationTicks: 960, velocity: 1,
  });

  const sA = addon.timeline_beginClipControlEdit(clipId);
  const sB = addon.timeline_beginClipControlEdit(clipB);
  const sC = addon.timeline_beginClipControlEdit(clipC);
  check(new Set([sA.sessionId, sB.sessionId, sC.sessionId]).size === 3,
    'three concurrent sessions get distinct ids');

  // The earlier sessions are still live after the later ones opened.
  const previewA = addon.timeline_previewClipControlEdit(sA.sessionId, { velocity: 0.25 });
  check(near(previewA.velocity, 0.25), 'first session still previews after later sessions open');
  addon.timeline_previewClipControlEdit(sB.sessionId, { velocity: 0.25 });
  addon.timeline_previewClipControlEdit(sC.sessionId, { velocity: 0.25 });

  addon.timeline_commitClipControlEdit(sA.sessionId, { velocity: 0.25 });
  addon.timeline_commitClipControlEdit(sB.sessionId, { velocity: 0.25 });
  addon.timeline_commitClipControlEdit(sC.sessionId, { velocity: 0.25 });
  check(near(currentClip(clipId).velocity, 0.25)
     && near(currentClip(clipB).velocity, 0.25)
     && near(currentClip(clipC).velocity, 0.25),
    'every clip in a concurrent group commits');

  // Each clip is its own undo entry, so the group unwinds one clip at a time.
  addon.undo_undo();
  check(near(currentClip(clipC).velocity, 1) && near(currentClip(clipB).velocity, 0.25),
    'group commits are individually undoable');
  addon.undo_redo();

  // Re-grabbing the SAME clip supersedes only its own session.
  const sB2 = addon.timeline_beginClipControlEdit(clipB);
  check(rejects(() => addon.timeline_previewClipControlEdit(sB.sessionId, { velocity: 1 })),
    're-grabbing a clip invalidates that clip’s previous session');
  addon.timeline_cancelClipControlEdit(sB2.sessionId);

  addon.timeline_removeClip(clipB);
  addon.timeline_removeClip(clipC);

  const removed = addon.timeline_beginClipControlEdit(clipId);
  addon.timeline_previewClipControlEdit(removed.sessionId, { velocity: 1.75 });
  addon.timeline_removeClip(clipId);
  check(rejects(() => addon.timeline_cancelClipControlEdit(removed.sessionId)), 'clip deletion invalidates its session');
} catch (error) {
  failed++;
  console.error(error?.stack || error);
} finally {
  try { addon.shutdown(); } catch {}
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed}/${passed + failed}`);
process.exit(failed ? 1 : 0);
