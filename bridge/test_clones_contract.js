'use strict';
//
// bridge/test_clones_contract.js - Clones engine contract (docs/XLETH_CLONE_SPEC.md).
//
// Every Clone RPC through the addon export (layer 4; test_rpc_manifest.js covers
// the manifest -> preload -> IPC -> worker layers):
//   timeline_addClone          Voice / Trail, names, placement under the source,
//                              auto grid cell, defaults, strict rejects, one undo step
//   timeline_setCloneSettings  lensMode (Linked -> Own seeds a copy of the
//                              source's Track Lens), trail fields, opacity keys,
//                              strict / kind rejects, no-op = no undo entry
//   timeline_reorderClones     renumbers voices, pins follow their clone, undo
//   timeline_setNotesVoicePin  one undo step, Auto, no-op
//   timeline_getVoiceAssignment  the engine's assignment == the UI's JS port
//                              (ui/src/clones/cloneModel.js) on the same pattern
//   timeline_removeTrack       a source takes its Clones (one undo step); a Voice
//                              clone's removal rewrites pins
// plus: editPatternNotes keeps voicePin, getTracks / getLensRoam carry the clone
// fields, setTrackParent refuses Trails, addPatternBlock / convertToClipTrack
// refuse Clones, the track layout keeps Clones under their source, and the
// project round-trips (schema_version 10, keys only on Clones / pinned notes).
//
// Run: cd bridge && node test_clones_contract.js
//

const path = require('path');
const fs   = require('fs');
const { pathToFileURL } = require('url');

const dllDir = path.resolve(__dirname, 'build/Release');
const vcpkgBin = path.resolve(__dirname, '../build/vcpkg_installed/x64-windows/bin');
process.env.PATH = dllDir + ';' + (fs.existsSync(vcpkgBin) ? vcpkgBin + ';' : '') + process.env.PATH;
const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}
function section(name) { console.log(`\n[ ${name} ]`); }
function throws(fn) { try { fn(); return false; } catch (e) { return true; } }

const PROJECT_DIR = path.resolve(__dirname, '_test_clones_contract');
const PPQ = 960;
const DOT = '·';

async function main() {
  console.log('=== Clones contract ===');
  const { assignVoices } = await import(pathToFileURL(path.resolve(__dirname, '../ui/src/clones/cloneModel.js')).href);

  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'ClonesContract') === true, 'project_create()');

  // Fixture: Lead (Pattern), Other (Pattern), Bass (Clip); Lead plays one pattern.
  const lead  = addon.timeline_addTrack({ name: 'Lead', volume: 1.0, order: 0 });
  const other = addon.timeline_addTrack({ name: 'Other', volume: 1.0, order: 1 });
  const bass  = addon.timeline_addTrack({ name: 'Bass', volume: 1.0, order: 2 });
  addon.timeline_convertToPatternTrack(lead);
  addon.timeline_convertToPatternTrack(other);
  const regionId = addon.timeline_addRegion({ name: 'Src', label: 'Custom', startTime: 0, endTime: 4.0 });
  const pid = addon.timeline_addPattern({ name: 'P', regionId, lengthTicks: 4 * PPQ });
  const N = (p, d, pitch, extra = {}) => ({ positionTicks: p, durationTicks: d, pitch, velocity: 1, ...extra });
  // G 0..4, E 0..2, C 1..2, D 1.5..1.75, A 3..3.5 (beats)
  addon.timeline_editPatternNotes(pid, [
    N(0, 4 * PPQ, 67), N(0, 2 * PPQ, 64), N(PPQ, PPQ, 60), N(1.5 * PPQ, 0.25 * PPQ, 62), N(3 * PPQ, 0.5 * PPQ, 69),
  ]);
  addon.timeline_addPatternBlock({ trackId: lead, patternId: pid, positionTicks: 0, durationTicks: 4 * PPQ });
  addon.timeline_setGridLayout({
    columns: 3, rows: 1, previewFps: 30, gapScale: 0,
    slots: [{ trackId: lead, gridX: 0, gridY: 0, spanX: 8, spanY: 8, opacity: 1.0, zOrder: 0 }],
    fullscreenLayers: [],
  });
  const notes = () => addon.timeline_getPattern(pid).notes;
  const noteIds = notes().map((n) => n.id);
  const order = () => addon.timeline_getTracks().sort((a, b) => a.order - b.order || a.id - b.id).map((t) => t.id);
  const track = (id) => addon.timeline_getTracks().find((t) => t.id === id);

  section('addClone');
  assert(throws(() => addon.timeline_addClone(bass, 'Voice')), 'a Clip track cannot have Clones');
  assert(throws(() => addon.timeline_addClone(lead, 'Echo')), 'unknown kind throws');
  assert(throws(() => addon.timeline_addClone(lead, 'Voice', { delayTicks: 480 })), 'a Trail field on a Voice clone throws');
  assert(throws(() => addon.timeline_addClone(lead, 'Trail', { bogus: 1 })), 'unknown opts field throws');
  const before = order();
  const v1 = addon.timeline_addClone(lead, 'Voice');
  assert(v1 && v1.trackId > 0 && v1.placed === true, 'Voice clone added and auto-placed');
  const c1 = v1.trackId;
  assert(v1.track.name === `Lead ${DOT} Clone 1`, `named "Lead · Clone 1" (got ${v1.track && v1.track.name})`);
  assert(v1.track.cloneOf === lead && v1.track.clone.kind === 'Voice' && v1.track.clone.lensMode === 'Linked'
    && v1.track.clone.voice === 1, 'getTracks clone fields');
  assert(v1.track.visualOnly === true && v1.track.type === 'Pattern', 'a Clone is a video-only Pattern track');
  assert(addon.timeline_getGridLayout().slots.some((s) => s.trackId === c1 && s.gridX === 8), 'placed in the first free cell');
  assert(throws(() => addon.timeline_addClone(c1, 'Voice')), 'no Clones of Clones');
  const c2 = addon.timeline_addClone(lead, 'Voice').trackId;
  const t1r = addon.timeline_addClone(lead, 'Trail');
  const t1 = t1r.trackId;
  assert(t1r.placed === false, 'a Trail takes no grid cell');
  assert(t1r.track.clone.delayTicks === 480 && t1r.track.clone.tint === '#F07A2A'
    && Math.abs(t1r.track.clone.opacity - 0.9) < 1e-9, 'first Trail defaults: 1/8, #F07A2A, 90 %');
  const t2 = addon.timeline_addClone(lead, 'Trail', { delayTicks: 960, tint: '#112233', opacity: 0.5 }).track;
  assert(t2.name === `Lead ${DOT} Trail 2` && t2.clone.delayTicks === 960 && t2.clone.tint === '#112233',
    'Trail with explicit settings');
  assert(JSON.stringify(order()) === JSON.stringify([lead, c1, c2, t1, t2.id, other, bass]),
    `Clones sit directly under their source (got ${order()})`);
  addon.undo_undo();
  assert(!track(t2.id) && order().length === before.length + 3, 'undo removes the last clone (one step)');
  addon.undo_redo();
  assert(track(t2.id) && order()[4] === t2.id, 'redo restores it in place');

  section('layout keeps Clones under the source');
  addon.timeline_setTrackOrder([other, c2, bass, lead, t1, c1, t2.id]);
  assert(JSON.stringify(order()) === JSON.stringify([other, bass, lead, c1, c2, t1, t2.id]),
    `moving the source carries its Clones, in their order (got ${order()})`);

  section('voice assignment: engine == UI port');
  {
    const a = addon.timeline_getVoiceAssignment(lead);
    assert(a.voices === 2 && JSON.stringify(a.cloneIds) === JSON.stringify([c1, c2]), 'two voices, in order');
    const eng = a.patterns[0].notes.map((n) => (n.overflow ? 'o' : n.voice));
    const js = assignVoices(notes(), 2).map((r) => (r.overflow ? 'o' : r.voice));
    assert(JSON.stringify(eng) === JSON.stringify(js), `engine ${eng} == JS ${js}`);
    assert(JSON.stringify(eng) === JSON.stringify([0, 1, 2, 'o', 1]), `G E C D A -> 0 1 2 overflow 1 (got ${eng})`);
    const viaClone = addon.timeline_getVoiceAssignment(c2);
    assert(viaClone.trackId === lead, 'asking a Clone answers for its source');
  }

  section('setNotesVoicePin + editPatternNotes carry');
  {
    const r = addon.timeline_setNotesVoicePin([{ patternId: pid, noteId: noteIds[0] }], 2);
    assert(r.changed === true && r.count === 1, 'pin G to Clone 2');
    assert(notes()[0].voicePin === 2, 'getPattern shows the pin');
    const again = addon.timeline_setNotesVoicePin([{ patternId: pid, noteId: noteIds[0] }], 2);
    assert(again.changed === false, 're-pin is a no-op');
    const eng = addon.timeline_getVoiceAssignment(lead).patterns[0].notes.map((n) => (n.overflow ? 'o' : n.voice));
    const js = assignVoices(notes(), 2).map((x) => (x.overflow ? 'o' : x.voice));
    assert(JSON.stringify(eng) === JSON.stringify(js), `with a pin, engine ${eng} == JS ${js}`);
    // A piano-roll style full-list edit returns the note objects: the pin survives.
    const list = notes().map((n) => ({ ...n, velocity: 0.9 }));
    addon.timeline_editPatternNotes(pid, list);
    assert(notes()[0].voicePin === 2, 'editPatternNotes keeps voicePin');
    addon.undo_undo();
    addon.undo_undo();
    assert(notes()[0].voicePin === undefined, 'undo returns G to Auto (no key)');
    addon.undo_redo();
    assert(notes()[0].voicePin === 2, 'redo pins again');
    assert(throws(() => addon.timeline_setNotesVoicePin([{ patternId: pid }], 1)), 'a ref without noteId throws');
    assert(throws(() => addon.timeline_setNotesVoicePin([], -2)), 'pin < -1 throws');
  }

  section('reorderClones: pins follow their Clone');
  {
    addon.timeline_setNotesVoicePin([{ patternId: pid, noteId: noteIds[1] }], 1);   // E -> Clone 1
    assert(throws(() => addon.timeline_reorderClones(lead, [c2, c1])), 'a list missing a Clone throws');
    const r = addon.timeline_reorderClones(lead, [c2, c1, t1, t2.id]);
    assert(r.changed === true, 'reordered');
    assert(track(c2).clone.voice === 1 && track(c1).clone.voice === 2, 'voices renumbered');
    assert(notes()[0].voicePin === 1 && notes()[1].voicePin === 2, 'G stays with Clone 2 (now 1), E with Clone 1 (now 2)');
    addon.undo_undo();
    assert(track(c1).clone.voice === 1 && notes()[0].voicePin === 2 && notes()[1].voicePin === 1, 'undo restores both');
  }

  section('setCloneSettings');
  {
    assert(throws(() => addon.timeline_setCloneSettings(lead, { lensMode: 'Own' })), 'not a Clone throws');
    assert(throws(() => addon.timeline_setCloneSettings(c1, { delayTicks: 10 })), 'Trail field on a Voice clone throws');
    assert(throws(() => addon.timeline_setCloneSettings(t1, { lensMode: 'Own' })), 'lensMode on a Trail throws');
    assert(throws(() => addon.timeline_setCloneSettings(t1, { tint: 'red' })), 'bad tint throws');
    assert(throws(() => addon.timeline_setCloneSettings(t1, { opacityKeys: [{ pos: 0, value: 2 }] })), 'opacity key > 1 throws');
    assert(throws(() => addon.timeline_setCloneSettings(t1, { opacityKeys: [{ pos: 0, value: 1, extra: 1 }] })), 'unknown key field throws');
    // Linked -> Own seeds the clone's Track Lens with the source's.
    addon.timeline_setTrackLens(lead, regionId, { zoom: 1.7 });
    const own = addon.timeline_setCloneSettings(c1, { lensMode: 'Own' });
    assert(own.changed === true && own.clone.lensMode === 'Own', 'lensMode Own');
    const srcLens = addon.timeline_getLensRoam({ sources: [{ trackId: c1, regionId }] }).sources[0];
    assert(srcLens && Math.abs(srcLens.lens.zoom - 1.7) < 1e-6, 'Own starts from a copy of the source Lens');
    assert(addon.timeline_setCloneSettings(c1, { lensMode: 'Own' }).changed === false, 'same mode = no-op');
    const desc = addon.undo_getUndoDescription();
    const tr = addon.timeline_setCloneSettings(t1, {
      delayTicks: 720, tint: '#00FF80', opacity: 0.25,
      opacityKeys: [{ pos: 960, value: 1, interp: 'Hold' }, { pos: 0, value: 0 }],
    });
    assert(tr.changed && tr.clone.delayTicks === 720 && tr.clone.tint === '#00FF80' && tr.clone.opacity === 0.25,
      'trail settings applied');
    assert(tr.clone.opacityKeys.length === 2 && tr.clone.opacityKeys[0].pos === 0, 'opacity keys sorted by pos');
    const lrT = addon.timeline_getLensRoam({ trackIds: [t1] }).tracks[0];
    assert(lrT.cloneOf === lead && lrT.clone.kind === 'Trail' && lrT.clone.opacityKeys.length === 2,
      'getLensRoam carries the clone fields');
    addon.undo_undo();
    assert(track(t1).clone.delayTicks === 480 && addon.undo_getUndoDescription() === desc, 'one undo step');
  }

  section('refusals');
  {
    const p1 = addon.timeline_setTrackParent(t1, lead);
    assert(p1.changed === false && p1.rejected === 'trail_clone', 'a Trail cannot be a child');
    const p2 = addon.timeline_setTrackParent(other, t1);
    assert(p2.changed === false && p2.rejected === 'trail_clone', 'a Trail cannot be a parent');
    const p3 = addon.timeline_setTrackParent(c2, other);
    assert(p3.changed === true, 'a Voice clone can have a Parent');
    addon.undo_undo();
    assert(throws(() => addon.timeline_addPatternBlock({ trackId: c1, patternId: pid, positionTicks: 0, durationTicks: PPQ })),
      'no pattern blocks on a Clone');
    assert(throws(() => addon.timeline_convertToClipTrack(c1)), 'a Clone cannot become a Clip track');
  }

  section('removeTrack');
  {
    // Removing Clone 1 (voice 1): E (pinned 1) goes Auto, G (pinned 2) moves to 1.
    addon.timeline_removeTrack(c1);
    assert(!track(c1), 'Clone 1 removed');
    assert(notes()[1].voicePin === undefined && notes()[0].voicePin === 1, 'pins rewritten');
    assert(track(c2).clone.voice === 1, 'Clone 2 is voice 1 now');
    addon.undo_undo();
    assert(track(c1) && notes()[1].voicePin === 1 && notes()[0].voicePin === 2, 'undo restores clone and pins');
    const n = addon.timeline_getTracks().length;
    addon.timeline_removeTrack(lead);
    assert(addon.timeline_getTracks().length === n - 5 && !track(c2) && !track(t1), 'the source takes its 4 Clones');
    addon.undo_undo();
    assert(addon.timeline_getTracks().length === n
      && JSON.stringify(order()) === JSON.stringify([other, bass, lead, c1, c2, t1, t2.id]),
      `one undo restores all five in place (got ${order()})`);
  }

  section('save / load');
  {
    assert(addon.project_save() === true, 'project_save()');
    const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
    assert(pj.schema_version === 10, `schema_version 10 (got ${pj.schema_version})`);
    const tj = (id) => pj.tracks.find((t) => t.id === id);
    assert(!('cloneOf' in tj(lead)) && !('cloneOf' in tj(other)), 'ordinary tracks write no clone keys');
    assert(tj(c1).cloneOf === lead && tj(c1).cloneKind === 'Voice' && tj(c1).lensMode === 'Own', 'Voice clone keys');
    assert(tj(t1).cloneKind === 'Trail' && tj(t1).delayTicks === 480 && tj(t1).tint === '#F07A2A', 'Trail keys');
    const pjp = pj.patterns.find((p) => p.id === pid);
    assert(pjp.notes[0].voicePin === 2 && !('voicePin' in pjp.notes[2]), 'voicePin only on pinned notes');
    addon.shutdown();
    assert(addon.initialize() === true, 're-initialize');
    assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');
    assert(track(c1) && track(c1).clone.lensMode === 'Own' && track(t1).clone.tint === '#F07A2A', 'clones reload');
    assert(notes()[0].voicePin === 2, 'pins reload');
    const eng = addon.timeline_getVoiceAssignment(lead).patterns[0].notes.map((x) => (x.overflow ? 'o' : x.voice));
    assert(JSON.stringify(eng) === JSON.stringify(assignVoices(notes(), 2).map((x) => (x.overflow ? 'o' : x.voice))),
      'assignment after reload matches the JS port');
  }

  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
