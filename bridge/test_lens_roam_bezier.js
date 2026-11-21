'use strict';
//
// bridge/test_lens_roam_bezier.js — Bezier keys on every Lens / Roam / Sweep key
// RPC, through the addon export:
//   - interp "Bezier" + bez [x1, y1, x2, y2] is accepted and read back exactly
//   - a Bezier key without bez reads back with the default handles
//   - a handles-only edit is a real change (one undo step); undo / redo exact
//   - a malformed bez, or an unknown interp, is rejected (state untouched)
//   - bez on a non-Bezier key is accepted and dropped
//   - everything survives project_save -> shutdown -> initialize -> project_load
//
// Run: cd bridge && node test_lens_roam_bezier.js
//

const path = require('path');
const fs   = require('fs');

const dllDir = path.resolve(__dirname, 'build/Release');
const vcpkgBin = path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin');
process.env.PATH = dllDir + ';' + vcpkgBin + ';' + process.env.PATH;
const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}

const PROJECT_DIR = path.resolve(__dirname, '_test_lens_roam_bezier');
const PPQ = 960;
const DEFAULT_BEZ = [0.42, 0, 0.58, 1];

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
    return o;
  }
  return v;
}
const str = (v) => JSON.stringify(canon(v));
const sameArr = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

async function main() {
  console.log('=== Lens + Roam: Bezier keys through every key RPC ===');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'LensRoamBezier') === true, 'project_create()');

  const regionId = addon.timeline_addRegion({ name: 'Src', label: 'Custom', startTime: 0, endTime: 4.0 });
  const clipTrack = addon.timeline_addTrack({ name: 'Clips', volume: 1.0, order: 0 });
  const patTrack  = addon.timeline_addTrack({ name: 'Pat', volume: 1.0, order: 1 });
  addon.timeline_convertToPatternTrack(patTrack);
  const clipId = addon.timeline_addClip({ trackId: clipTrack, regionId, positionTicks: 0, durationTicks: 4 * PPQ });
  const patternId = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });
  const noteId = addon.timeline_addNote(patternId, { positionTicks: 0, durationTicks: 960, pitch: 60, velocity: 1 });
  addon.timeline_addPatternBlock({ trackId: patTrack, patternId, positionTicks: 0, durationTicks: 4 * PPQ, offsetTicks: 0 });

  const lensRoam = () => addon.timeline_getLensRoam({
    clipIds: [clipId], sources: [{ trackId: patTrack, regionId }], trackIds: [clipTrack, patTrack],
  });
  const noteKeys = () => addon.timeline_getAllPatterns().find((p) => p.id === patternId)
    ?.notes.find((n) => n.id === noteId)?.lensOverride?.keys ?? [];
  const state = () => {
    const lr = lensRoam();
    return str({ clips: lr.clips, sources: lr.sources, tracks: lr.tracks, note: noteKeys() });
  };
  const roamKeys = () => lensRoam().tracks.find((t) => t.trackId === clipTrack)?.keys ?? [];
  const sweepKeys = () => lensRoam().tracks.find((t) => t.trackId === patTrack)?.sweep ?? [];
  const clipKeys = () => lensRoam().clips.find((c) => c.clipId === clipId)?.keys ?? [];
  const hitKeys = () => lensRoam().sources[0]?.hitCurve ?? [];

  const B = [0.1, -0.25, 0.9, 1.3];
  const cases = [
    {
      name: 'setTrackRoamKeys',
      set: (bez) => addon.timeline_setTrackRoamKeys(clipTrack, [
        { channel: 'scale', anchor: 'Origin', pos: 0, value: 1.0, interp: 'Bezier', ...(bez ? { bez } : {}) },
        { channel: 'scale', anchor: 'Origin', pos: 3840, value: 2.0, interp: 'Linear' }]),
      read: roamKeys,
    },
    {
      name: 'setTrackSweepKeys',
      set: (bez) => addon.timeline_setTrackSweepKeys(patTrack, [
        { channel: 'zoom', anchor: 'Origin', pos: 0, value: 1.0, interp: 'Bezier', ...(bez ? { bez } : {}) },
        { channel: 'zoom', anchor: 'Origin', pos: 3840, value: 1.5, interp: 'Linear' }]),
      read: sweepKeys,
    },
    {
      name: 'setClipLensKeys',
      set: (bez) => addon.timeline_setClipLensKeys(clipId, [
        { channel: 'zoom', anchor: 'Origin', pos: 0, value: 1.0, interp: 'Bezier', ...(bez ? { bez } : {}) },
        { channel: 'zoom', anchor: 'Origin', pos: 1920, value: 2.0, interp: 'Linear' }]),
      read: clipKeys,
    },
    {
      name: 'setHitCurve',
      set: (bez) => addon.timeline_setHitCurve(patTrack, regionId, {
        keys: [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 1.4, interp: 'Bezier', ...(bez ? { bez } : {}) },
               { channel: 'zoom', anchor: 'Tail', pos: 0, value: 1.0, interp: 'Linear' }] }),
      read: hitKeys,
    },
    {
      name: 'setNoteLensKeys',
      set: (bez) => addon.timeline_setNoteLensKeys({ patternId, noteId }, [
        { channel: 'centerX', anchor: 'Head', pos: 0, value: 0.1, interp: 'Bezier', ...(bez ? { bez } : {}) },
        { channel: 'centerX', anchor: 'Tail', pos: 0, value: 0.0, interp: 'Linear' }]),
      read: noteKeys,
    },
  ];

  const run = async (fn) => { const r = fn(); return (r && typeof r.then === 'function') ? r : r; };

  for (const c of cases) {
    // No handles given: the default.
    await run(() => c.set(null));
    const k0 = c.read()[0];
    assert(k0?.interp === 'Bezier' && sameArr(k0?.bez, DEFAULT_BEZ), `${c.name}: Bezier without bez reads back the default handles`);
    assert(!('bez' in (c.read()[1] ?? {})), `${c.name}: a Linear key carries no bez`);

    // Handles only: a real, undoable change.
    const before = state();
    await run(() => c.set(B));
    const after = state();
    const k1 = c.read()[0];
    assert(after !== before && sameArr(k1?.bez, B), `${c.name}: handles-only edit is a change, read back exactly`);
    addon.undo_undo();
    assert(state() === before, `${c.name}: undo restores the default handles`);
    addon.undo_redo();
    assert(state() === after, `${c.name}: redo restores the edited handles`);

    // Malformed bez / unknown interp: rejected, nothing changes.
    for (const bad of [[0.1, 'x', 0.9, 1], [0.1, 0.2, 0.3], 'smooth']) {
      let threw = false;
      try { await run(() => c.set(bad)); } catch { threw = true; }
      assert(threw && state() === after, `${c.name}: bez ${JSON.stringify(bad)} rejected`);
    }
    console.log(`  ok    ${c.name}`);
  }

  // Unknown interp rejected; bez on a Linear key accepted and dropped.
  {
    const s0 = state();
    let threw = false;
    try { addon.timeline_setTrackRoamKeys(clipTrack, [{ channel: 'scale', anchor: 'Origin', pos: 0, value: 1, interp: 'Spline' }]); } catch { threw = true; }
    assert(threw && state() === s0, 'unknown interp rejected');
    addon.timeline_setTrackRoamKeys(clipTrack, [
      { channel: 'offsetX', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear', bez: [0, 0, 1, 1] }]);
    const k = roamKeys()[0];
    assert(k?.interp === 'Linear' && !('bez' in k), 'bez on a Linear key is accepted and dropped');
    addon.undo_undo();
    assert(state() === s0, 'undo after the Linear-with-bez edit');
  }

  // Save / load.
  const final = state();
  assert(addon.project_save() === true, 'project_save()');
  addon.shutdown();
  assert(addon.initialize() === true, 're-initialize()');
  assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');
  assert(state() === final, 'every Bezier key and its handles survive save -> load');
  const saved = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
  const txt = JSON.stringify(saved);
  assert(txt.includes('"interp":"Bezier"') && txt.includes('"bez":[0.1,-0.25,0.9,1.3]'), 'project.json stores interp Bezier and bez');
  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
