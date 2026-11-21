'use strict';
//
// bridge/test_scale_crop_fx_contract.js — independent Roam Scale X/Y, Roam border
// crop, and video effect param keys (Motion view), through the addon export.
//
//   - setTrackRoam accepts scaleY / scaleLinked / crop edges (strict), undo/redo exact
//   - setTrackRoamKeys accepts the scaleY and crop channels
//   - a project with a linked, uncropped Roam saves none of the new fields
//   - a chain effect carries a uid; setTrackFxKeys is strict, undoable, survives save / load
//
// Run: cd bridge && node test_scale_crop_fx_contract.js
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
function throws(fn) { try { fn(); return false; } catch { return true; } }

const PROJECT_DIR = path.resolve(__dirname, '_test_scale_crop_fx_contract');
const PPQ = 960;

async function main() {
  console.log('=== Scale X/Y, crop and effect-key contract ===');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'ScaleCropFx') === true, 'project_create()');

  const regionId = addon.timeline_addRegion({ name: 'Src', label: 'Custom', startTime: 0, endTime: 4.0 });
  const trackId = addon.timeline_addTrack({ name: 'Clips', volume: 1.0, order: 0 });
  addon.timeline_addClip({ trackId, regionId, positionTicks: 0, durationTicks: 4 * PPQ });

  const roamOf = () => addon.timeline_getLensRoam({ trackIds: [trackId] }).tracks[0];

  // ── Roam scale Y + link + crop ────────────────────────────────────────────
  assert(roamOf().roam.scaleLinked === undefined && roamOf().roam.scaleY === undefined, 'a default Roam writes no new fields');
  const r1 = addon.timeline_setTrackRoam(trackId, { scale: 2, scaleLinked: false, scaleY: 0.5, cropLeft: 0.1, cropBottom: 0.25 });
  assert(r1.changed === true, 'setTrackRoam changed');
  const roam = roamOf().roam;
  assert(roam.scale === 2 && roam.scaleLinked === false && roam.scaleY === 0.5, 'unlinked scale read back');
  assert(Math.abs(roam.cropLeft - 0.1) < 1e-6 && Math.abs(roam.cropBottom - 0.25) < 1e-6, 'crop read back');
  assert(throws(() => addon.timeline_setTrackRoam(trackId, { scaleLinked: 'yes' })), 'scaleLinked must be a boolean');
  assert(throws(() => addon.timeline_setTrackRoam(trackId, { scaleY: 0 })), 'scaleY must be > 0');
  assert(throws(() => addon.timeline_setTrackRoam(trackId, { cropTop: 'x' })), 'crop must be a number');

  assert(addon.undo_undo() !== false, 'undo');
  assert(roamOf().roam.scaleLinked === undefined && roamOf().roam.cropLeft === undefined, 'undo restores the default Roam');
  assert(addon.undo_redo() !== false, 'redo');
  assert(roamOf().roam.scaleY === 0.5, 'redo restores it');

  const k = addon.timeline_setTrackRoamKeys(trackId, [
    { channel: 'scaleY', anchor: 'Origin', pos: 0, value: 1 },
    { channel: 'scaleY', anchor: 'Origin', pos: 960, value: 2 },
    { channel: 'cropRight', anchor: 'Origin', pos: 0, value: 0 },
    { channel: 'cropRight', anchor: 'Origin', pos: 960, value: 0.5 },
  ]);
  assert(k.changed === true && roamOf().keys.length === 4, 'scaleY and crop keys accepted');
  assert(throws(() => addon.timeline_setTrackRoamKeys(trackId, [{ channel: 'cropLeft', anchor: 'Origin', pos: 0, value: 2 }])), 'a crop key above 0.99 is refused');
  assert(throws(() => addon.timeline_setTrackRoamKeys(trackId, [{ channel: 'scaleY', anchor: 'Origin', pos: 0, value: 0 }])), 'a scaleY key <= 0 is refused');
  addon.timeline_setTrackRoamKeys(trackId, []);

  // ── Effect keys ───────────────────────────────────────────────────────────
  const idx = addon.timeline_addVisualEffect(trackId, 5);    // Chroma Key
  const idx2 = addon.timeline_addVisualEffect(trackId, 6);   // Outline
  assert(idx === 0 && idx2 === 1, 'two effects added');
  const chain = () => addon.timeline_getVisualEffectChain(trackId);
  const [ck, ol] = chain();
  assert(Number.isInteger(ck.uid) && ck.uid > 0 && ol.uid > 0 && ck.uid !== ol.uid, 'chain entries carry distinct uids');

  const fx = () => roamOf().fxKeys;
  assert(Array.isArray(fx()) && fx().length === 0, 'no fx keys yet');
  const keys = [
    { uid: ck.uid, param: 3, pos: 0, value: 0.1 },
    { uid: ck.uid, param: 3, pos: 960, value: 0.4, interp: 'EaseOut' },
    { uid: ol.uid, param: 3, pos: 0, value: 8 },
  ];
  const w = addon.timeline_setTrackFxKeys(trackId, keys);
  assert(w.changed === true && w.fxKeys.length === 3, 'setTrackFxKeys changed');
  assert(addon.timeline_setTrackFxKeys(trackId, keys).changed === false, 'the same keys change nothing');
  assert(throws(() => addon.timeline_setTrackFxKeys(trackId, [{ uid: 9999, param: 3, pos: 0, value: 1 }])), 'an unknown uid is refused');
  assert(throws(() => addon.timeline_setTrackFxKeys(trackId, [{ uid: ck.uid, param: 0, pos: 0, value: 1 }])), 'a colour param cannot be keyed');
  assert(throws(() => addon.timeline_setTrackFxKeys(trackId, [{ uid: ck.uid, param: 3, pos: -1, value: 1 }])), 'a negative pos is refused');
  assert(throws(() => addon.timeline_setTrackFxKeys(trackId, [{ uid: ck.uid, param: 3, pos: 0, value: 1, extra: 1 }])), 'an unknown field is refused');

  addon.undo_undo();
  assert(fx().length === 0, 'undo removes the keys');
  addon.undo_redo();
  assert(fx().length === 3, 'redo brings them back');

  // Reorder: the keys stay with their effect.
  addon.timeline_setTrackVisualEffectChainOrder(trackId, [1, 0]);
  assert(chain()[1].uid === ck.uid && fx().length === 3, 'keys survive a reorder (uid travels)');

  // Save / load.
  assert(addon.project_save() === true, 'project_save()');
  addon.shutdown();
  assert(addon.initialize() === true, 'initialize() again');
  assert(addon.project_load(PROJECT_DIR) !== false, 'project_load()');
  const lr = addon.timeline_getLensRoam({ trackIds: [trackId] }).tracks[0];
  assert(lr.fxKeys.length === 3, 'fx keys survive save / load');
  assert(lr.roam.scaleLinked === false && lr.roam.scaleY === 0.5, 'unlinked scale survives save / load');
  const ck2 = addon.timeline_getVisualEffectChain(trackId).find((e) => e.type === 5);
  assert(lr.fxKeys.some((q) => q.uid === ck2.uid && q.param === 3), 'the keys still address the same Chroma Key');

  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
