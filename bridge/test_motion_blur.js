'use strict';
//
// bridge/test_motion_blur.js — motion blur RPC contract, through the addon.
//
//   * timeline_getMotionBlur / timeline_setMotionBlur: the project-wide
//     Lens / Roam / Sweep setting. Default off at 180 degrees; set merges the
//     fields given, sanitizes the shutter, returns what it stored; bad input
//     throws and changes nothing; not an undo step.
//   * Zoom/pan/rot's own per-track setting rides on
//     timeline_setTrackZoomPanRotSettings ("motionBlur"), is undoable with the
//     rest of the ZPR settings, and is KEPT when a caller omits it.
//   * The two are independent: neither write touches the other.
//   * Both survive project_save -> shutdown -> initialize -> project_load.
//
// Run: cd bridge && node test_motion_blur.js
//

const path = require('path');
const fs   = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;
const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const PROJECT_DIR = path.resolve(__dirname, '_test_motion_blur');

function zprOf(trackId) {
  return addon.timeline_getTracks().find((t) => t.id === trackId)?.zoomPanRot;
}

async function main() {
  console.log('=== Motion blur RPC contract ===');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'MotionBlur') === true, 'project_create()');
  const trackId = addon.timeline_addTrack({ name: 'T', volume: 1.0, order: 0 });

  // ── Project-wide ───────────────────────────────────────────────────────────
  const mb0 = addon.timeline_getMotionBlur();
  assert(eq(mb0, { enabled: false, shutterAngle: 180 }), `default off @180 (got ${JSON.stringify(mb0)})`);

  const r1 = addon.timeline_setMotionBlur({ enabled: true });
  assert(eq(r1, { enabled: true, shutterAngle: 180 }), 'set {enabled} keeps the shutter');
  const r2 = addon.timeline_setMotionBlur({ shutterAngle: 270 });
  assert(eq(r2, { enabled: true, shutterAngle: 270 }), 'set {shutterAngle} keeps enabled');
  assert(eq(addon.timeline_getMotionBlur(), r2), 'get reads back the set');
  const r3 = addon.timeline_setMotionBlur({ shutterAngle: 5000 });
  assert(r3.shutterAngle === 360, 'shutter > 360 is held at 360');
  const r4 = addon.timeline_setMotionBlur({ shutterAngle: -10 });
  assert(r4.shutterAngle === 0, 'negative shutter reads as closed');
  addon.timeline_setMotionBlur({ shutterAngle: 270 });

  let threw = false;
  try { addon.timeline_setMotionBlur(42); } catch { threw = true; }
  assert(threw, 'a non-object argument throws');
  assert(eq(addon.timeline_getMotionBlur(), { enabled: true, shutterAngle: 270 }), 'a rejected call changed nothing');
  assert(addon.undo_canUndo() === false || addon.undo_getUndoDescription() !== 'Set Motion Blur',
         'project motion blur is not an undo step');

  // ── Zoom/pan/rot, per track ────────────────────────────────────────────────
  const z0 = zprOf(trackId);
  assert(eq(z0.motionBlur, { enabled: false, shutterAngle: 180 }), 'track ZPR blur defaults off @180');

  addon.timeline_setTrackZoomPanRotSettings(trackId, { ...z0, enabled: true, motionBlur: { enabled: true, shutterAngle: 90 } });
  assert(eq(zprOf(trackId).motionBlur, { enabled: true, shutterAngle: 90 }), 'track ZPR blur set');
  assert(eq(addon.timeline_getMotionBlur(), { enabled: true, shutterAngle: 270 }),
         'track ZPR write leaves the project setting alone');

  // A caller that does not know the field (older scalar writers, presets) keeps it.
  const { motionBlur: _omit, ...withoutBlur } = zprOf(trackId);
  addon.timeline_setTrackZoomPanRotSettings(trackId, { ...withoutBlur, durationMs: 444 });
  const z1 = zprOf(trackId);
  assert(z1.durationMs === 444, 'other ZPR field written');
  assert(eq(z1.motionBlur, { enabled: true, shutterAngle: 90 }), 'omitted motionBlur is kept');

  // Undo / redo the ZPR blur write itself.
  addon.timeline_setTrackZoomPanRotSettings(trackId, { ...z1, motionBlur: { enabled: false, shutterAngle: 90 } });
  assert(zprOf(trackId).motionBlur.enabled === false, 'track ZPR blur off');
  addon.undo_undo();
  assert(zprOf(trackId).motionBlur.enabled === true, 'undo restores the track ZPR blur');
  addon.undo_redo();
  assert(zprOf(trackId).motionBlur.enabled === false, 'redo re-applies it');
  addon.undo_undo();

  addon.timeline_setMotionBlur({ enabled: false });
  assert(zprOf(trackId).motionBlur.enabled === true, 'project write leaves the track ZPR blur alone');
  addon.timeline_setMotionBlur({ enabled: true });

  // ── Save -> fresh engine -> load ───────────────────────────────────────────
  assert(addon.project_save() === true, 'project_save()');
  const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
  assert(eq(pj.motionBlur, { enabled: true, shutterAngle: 270 }), 'project.json carries motionBlur');
  addon.shutdown();
  assert(addon.initialize() === true, 're-initialize()');
  assert(eq(addon.timeline_getMotionBlur(), { enabled: false, shutterAngle: 180 }),
         'a fresh engine starts with motion blur off');
  assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');
  assert(eq(addon.timeline_getMotionBlur(), { enabled: true, shutterAngle: 270 }), 'project blur survives save / load');
  assert(eq(zprOf(trackId).motionBlur, { enabled: true, shutterAngle: 90 }), 'track ZPR blur survives save / load');

  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
