'use strict';
//
// bridge/test_lens_roam_contract.js — Lens + Roam P12 verification
// (docs/XLETH_LENS_ROAM_VERIFY.md, item 4).
//
// Every Lens / Roam / Reel / Sweep edit RPC, called through the addon export
// (layer 4 of the four-layer bridge; the manifest -> preload -> IPC -> worker
// layers are covered by test_rpc_manifest.js). For each command:
//   - the call changes the engine state read back by getLensRoam / getAllPatterns
//   - undo_undo returns EXACTLY the state before it
//   - undo_redo returns EXACTLY the state after it
// then the final state survives project_save -> shutdown -> initialize ->
// project_load. Also: a call that changes nothing records no undo step.
//
// Run: cd bridge && node test_lens_roam_contract.js
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

const PROJECT_DIR = path.resolve(__dirname, '_test_lens_roam_contract');
const PPQ = 960;

// Canonical JSON (sorted keys) so engine key order never matters.
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

async function main() {
  console.log('=== Lens + Roam contract: undo / redo / save / load for every edit RPC ===');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'LensRoamContract') === true, 'project_create()');

  // Fixture: one region, a Clip track with one clip, a Pattern track with a
  // 4-note pattern in one block.
  const regionId = addon.timeline_addRegion({ name: 'Src', label: 'Custom', startTime: 0, endTime: 4.0 });
  const clipTrack = addon.timeline_addTrack({ name: 'Clips', volume: 1.0, order: 0 });
  const patTrack  = addon.timeline_addTrack({ name: 'Pat', volume: 1.0, order: 1 });
  addon.timeline_convertToPatternTrack(patTrack);
  const clipId = addon.timeline_addClip({ trackId: clipTrack, regionId, positionTicks: 0, durationTicks: 4 * PPQ });
  const patternId = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });
  const noteIds = [];
  for (let i = 0; i < 4; i++)
    noteIds.push(addon.timeline_addNote(patternId, { positionTicks: i * PPQ, durationTicks: 480, pitch: 60, velocity: 1 }));
  addon.timeline_addPatternBlock({ trackId: patTrack, patternId, positionTicks: 0, durationTicks: 4 * PPQ, offsetTicks: 0 });
  assert(clipId >= 1 && patternId >= 1 && noteIds.every((n) => n >= 1), 'fixture created');

  const note = (i) => ({ patternId, noteId: noteIds[i] });

  function state() {
    const lr = addon.timeline_getLensRoam({
      clipIds: [clipId], sources: [{ trackId: patTrack, regionId }], trackIds: [clipTrack, patTrack],
    });
    const pat = addon.timeline_getAllPatterns().find((p) => p.id === patternId);
    const overrides = (pat?.notes ?? []).map((n) => ({ id: n.id, o: n.lensOverride ?? null }));
    return str({ clips: lr.clips, sources: lr.sources, tracks: lr.tracks, overrides });
  }

  const cmds = [
    ['setClipLens',        () => addon.timeline_setClipLens(clipId, { fit: 'Contain', zoom: 1.5, centerX: 0.3, rotationDeg: 12, flip: 'Horizontal' })],
    ['setClipLensKeys',    () => addon.timeline_setClipLensKeys(clipId, [
                              { channel: 'zoom', anchor: 'Origin', pos: 0, value: 1.0, interp: 'Linear' },
                              { channel: 'zoom', anchor: 'Origin', pos: 1920, value: 2.0, interp: 'EaseOut' }])],
    ['resetClipLens',      () => addon.timeline_resetClipLens(clipId)],
    ['setTrackLens',       () => addon.timeline_setTrackLens(patTrack, regionId, { fit: 'Cover', zoom: 1.2, centerY: 0.4 })],
    ['setHitCurve',        () => addon.timeline_setHitCurve(patTrack, regionId, {
                              keys: [{ channel: 'zoom', anchor: 'Head', pos: 0, value: 1.4, interp: 'EaseOut' },
                                     { channel: 'zoom', anchor: 'Tail', pos: 0, value: 1.0, interp: 'Linear' }],
                              zones: { headTicks: 60, tailTicks: 120, shortNote: 'Cut' } })],
    ['applyHitPreset',     () => addon.timeline_applyHitPreset(patTrack, regionId, 'Punch + drift')],
    ['resetTrackLens',     () => addon.timeline_resetTrackLens(patTrack, regionId)],
    ['setNoteLensMode',    () => addon.timeline_setNoteLensMode([note(0), note(1)], 'Own')],
    ['setNoteLensKeys',    () => addon.timeline_setNoteLensKeys(note(2), [
                              { channel: 'centerX', anchor: 'Head', pos: 0, value: 0.1, interp: 'Linear' },
                              { channel: 'centerX', anchor: 'Body', pos: 1, value: -0.1, interp: 'Hold' }])],
    ['setNotesLensKeys',   () => addon.timeline_setNotesLensKeys([
                              { ...note(0), keys: [{ channel: 'zoom', anchor: 'Tail', pos: 120, value: 1.3, interp: 'Linear' }] },
                              { ...note(3), keys: [{ channel: 'rotationDeg', anchor: 'Head', pos: 30, value: 5, interp: 'Linear' }] }])],
    ['revertNotesToFollow',() => addon.timeline_revertNotesToFollow([note(0), note(2)])],
    ['setTrackRoam',       () => addon.timeline_setTrackRoam(patTrack, { offsetX: 0.5, offsetY: -0.25, scale: 1.3, rotationDeg: 20, bounds: 'Float', layer: 'Top' })],
    ['setTrackRoamKeys',   () => addon.timeline_setTrackRoamKeys(clipTrack, [
                              { channel: 'offsetX', anchor: 'Origin', pos: 0, value: -0.5, interp: 'Linear' },
                              { channel: 'scale', anchor: 'Origin', pos: 3840, value: 1.2, interp: 'Hold' }])],
    ['resetTrackRoam',     () => addon.timeline_resetTrackRoam(patTrack)],
    ['setTrackSweepKeys',  () => addon.timeline_setTrackSweepKeys(patTrack, [
                              { channel: 'zoom', anchor: 'Origin', pos: 0, value: 1.0, interp: 'Linear' },
                              { channel: 'zoom', anchor: 'Origin', pos: 3840, value: 1.5, interp: 'EaseOut' },
                              { channel: 'centerX', anchor: 'Origin', pos: 1920, value: 0.1, interp: 'Linear' }])],
    // Leave a non-trivial state for save/load.
    ['setClipLens (2)',    () => addon.timeline_setClipLens(clipId, { fit: 'Cover', zoom: 1.25, flip: 'Vertical' })],
    ['setTrackRoam (2)',   () => addon.timeline_setTrackRoam(clipTrack, { offsetY: 0.2, bounds: 'Float', layer: 'AboveNeighbours' })],
    ['setNoteLensMode (2)',() => addon.timeline_setNoteLensMode([note(1)], 'Nudge')],
  ];

  for (const [name, run] of cmds) {
    const before = state();
    let res;
    try { res = run(); } catch (e) { assert(false, `${name}: threw ${e.message}`); continue; }
    if (res && typeof res.then === 'function') res = await res;
    const after = state();
    assert(after !== before, `${name}: changes the engine state`);
    addon.undo_undo();
    const undone = state();
    assert(undone === before, `${name}: undo restores the exact prior state`);
    addon.undo_redo();
    const redone = state();
    assert(redone === after, `${name}: redo restores the exact edited state`);
    console.log(`  ${undone === before && redone === after && after !== before ? 'ok  ' : 'FAIL'}  ${name}`);
  }

  // No-op: the same values again records no undo step (undo then reverts the
  // PREVIOUS command, setNoteLensMode (2)).
  {
    const s0 = state();
    addon.timeline_setClipLens(clipId, { fit: 'Cover', zoom: 1.25, flip: 'Vertical' });
    assert(state() === s0, 'no-op setClipLens leaves state');
    addon.undo_undo();
    const pat = addon.timeline_getAllPatterns().find((p) => p.id === patternId);
    const n1 = pat.notes.find((n) => n.id === noteIds[1]);
    assert(n1?.lensOverride?.mode === 'Own', 'no-op recorded no undo step (undo reverted the previous command)');
    addon.undo_redo();
    assert(state() === s0, 'redo after the no-op check');
  }

  // Strict parsing: a typo must reject, never be swallowed.
  {
    const s0 = state();
    let threw = false, res;
    try { res = addon.timeline_setClipLens(clipId, { zooom: 2 }); } catch (e) { threw = true; }
    if (res && typeof res.then === 'function') { try { res = await res; } catch (e) { threw = true; } }
    assert(threw || res === false || res === null || res?.ok === false || res?.error, 'unknown field rejected');
    assert(state() === s0, 'rejected call changed nothing');
  }

  // Save -> fresh engine -> load.
  const final = state();
  assert(addon.project_save() === true, 'project_save()');
  addon.shutdown();
  assert(addon.initialize() === true, 're-initialize()');
  assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');
  const reloaded = state();
  assert(reloaded === final, 'every edited value survives save / load');
  if (reloaded !== final) {
    console.error('  before save:', final);
    console.error('  after load :', reloaded);
  }
  const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
  assert(pj.schema_version >= 8, `schema_version >= 8 (got ${pj.schema_version})`);

  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
