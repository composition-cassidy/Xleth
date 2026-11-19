'use strict';
//
// bridge/test_motion_view_contract.js - Motion view engine contract
// (docs/XLETH_MOTION_VIEW_DESIGN.md 3.1, R6-R8, R14-R16, R19).
//
// Every new RPC through the addon export (layer 4 of the bridge; the manifest
// -> preload -> IPC -> worker layers are covered by test_rpc_manifest.js):
//   timeline_setTrackParent   change, exact undo / redo, no-op, strict rejects,
//                             semantic `rejected` reasons (self / cycle /
//                             too_deep / unknown_track), keep-on-screen numbers
//                             (checked against an independent JS port of R7)
//   timeline_setTrackMasks    change, exact undo / redo, no-op, strict rejects,
//                             caps, defaults, shape keys sorted
//   timeline_removeTrack      opts { keepOnScreenTick }: the removed track's
//                             children detach in ONE undo step, keeping their
//                             on-screen pose; strict opts
//   project_get/setMotionViewState  opaque UI state: not undoable, not
//                             dirtying, strict, survives save / load, absent
//                             from project.json when empty, cleared by
//                             project_newBlank
// plus getLensRoam / getTracks carrying parentTrackId + masks, and the saved
// schema_version 9.
//
// Run: cd bridge && node test_motion_view_contract.js
//

const path = require('path');
const fs   = require('fs');

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

const PROJECT_DIR = path.resolve(__dirname, '_test_motion_view_contract');
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
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

function throws(fn) {
  try { fn(); return false; } catch (e) { return true; }
}

// ── Independent JS port of R7 (pixels, y down, +deg = clockwise) ───────────
function rot(deg, x, y) {
  if (deg === 0) return [x, y];
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
}
// Column `col` of a cols x 1 grid with no gap on a W x H canvas.
function home(col, cols, W, H) {
  const w = W / cols;
  return { cx: col * w + w / 2, cy: H / 2, unitW: w, unitH: H, w, h: H };
}
// S(p) = c' + s Rot(r) (p - c)
function parentSim(h, r) {
  const c2 = [h.cx + r.offsetX * h.unitW, h.cy + r.offsetY * h.unitH];
  const rc = rot(r.rotationDeg, h.cx, h.cy);
  return { s: r.scale, r: r.rotationDeg, tx: c2[0] - r.scale * rc[0], ty: c2[1] - r.scale * rc[1] };
}
function applySim(S, p) { const q = rot(S.r, p[0], p[1]); return [S.s * q[0] + S.tx, S.s * q[1] + S.ty]; }
function invSim(S) {
  const is = 1 / S.s;
  const t = rot(-S.r, -S.tx, -S.ty);
  return { s: is, r: -S.r, tx: is * t[0], ty: is * t[1] };
}
function roamedCentre(h, r) { return [h.cx + r.offsetX * h.unitW, h.cy + r.offsetY * h.unitH]; }

async function main() {
  console.log('=== Motion view contract: parent, masks, removeTrack detach, UI state ===');
  if (fs.existsSync(PROJECT_DIR)) fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  assert(addon.initialize() === true, 'initialize()');
  assert(addon.project_create(PROJECT_DIR, 'MotionViewContract') === true, 'project_create()');

  // Fixture: A, B, C placed in a 3 x 1 grid (no gap); U1..U6 unplaced.
  const A = addon.timeline_addTrack({ name: 'A', volume: 1.0, order: 0 });
  const B = addon.timeline_addTrack({ name: 'B', volume: 1.0, order: 1 });
  const C = addon.timeline_addTrack({ name: 'C', volume: 1.0, order: 2 });
  const U = [];
  for (let i = 0; i < 6; i++) U.push(addon.timeline_addTrack({ name: `U${i}`, volume: 1.0, order: 3 + i }));
  const FULL = 8;
  addon.timeline_setGridLayout({
    columns: 3, rows: 1, previewFps: 30, gapScale: 0,
    slots: [
      { trackId: A, gridX: 0,        gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 0 },
      { trackId: B, gridX: FULL,     gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 1 },
      { trackId: C, gridX: 2 * FULL, gridY: 0, spanX: FULL, spanY: FULL, opacity: 1.0, zOrder: 2 },
    ],
    fullscreenLayers: [],
  });
  const grid = addon.timeline_getGridLayout();
  const W = grid.canvasWidth, H = grid.canvasHeight;
  assert(W > 0 && H > 0 && grid.slots.length === 3, `fixture grid (${W} x ${H})`);
  const allIds = [A, B, C, ...U];

  function lr() { return addon.timeline_getLensRoam({ trackIds: allIds }); }
  function trackOf(id) { return lr().tracks.find((t) => t.trackId === id); }
  function state() {
    const tracks = addon.timeline_getTracks().map((t) => ({ id: t.id, parentTrackId: t.parentTrackId }));
    return str({ lr: lr().tracks, tracks });
  }
  const undoDesc = () => addon.undo_getUndoDescription();

  // ── getLensRoam / getTracks carry the new fields ───────────────────────────
  section('getLensRoam / getTracks');
  {
    const t = trackOf(A);
    assert(t && t.parentTrackId === -1 && Array.isArray(t.masks) && t.masks.length === 0,
      'getLensRoam track entry: parentTrackId -1, masks []');
    const gt = addon.timeline_getTracks().find((x) => x.id === A);
    assert(gt && gt.parentTrackId === -1, 'getTracks: parentTrackId -1');
  }

  // ── setTrackParent: change, undo, redo, no-op ──────────────────────────────
  section('timeline_setTrackParent: change / undo / redo / no-op');
  {
    const before = state();
    const res = addon.timeline_setTrackParent(B, A);
    assert(res && res.changed === true && res.trackId === B && res.parentTrackId === A
      && Array.isArray(res.compensated) && res.compensated.length === 0
      && Array.isArray(res.uncompensated) && res.uncompensated.length === 0 && res.rejected === undefined
      && res.roam && Array.isArray(res.keys), 'attach B -> A: post-state returned');
    const after = state();
    assert(after !== before && trackOf(B).parentTrackId === A
      && addon.timeline_getTracks().find((x) => x.id === B).parentTrackId === A, 'state changed (both readers)');
    addon.undo_undo();
    assert(state() === before, 'undo restores the exact prior state');
    addon.undo_redo();
    assert(state() === after, 'redo restores the exact edited state');
    const d0 = undoDesc();
    const again = addon.timeline_setTrackParent(B, A, { keepOnScreen: true, tick: 0 });
    assert(again.changed === false && state() === after && undoDesc() === d0,
      'the same parent again: changed false, no undo step (keepOnScreen too)');
  }

  // ── semantic rejections ────────────────────────────────────────────────────
  section('timeline_setTrackParent: rejected reasons');
  {
    const s0 = state(), d0 = undoDesc();
    const self = addon.timeline_setTrackParent(A, A);
    assert(self.changed === false && self.rejected === 'self', 'self -> rejected self');
    const cyc = addon.timeline_setTrackParent(A, B);
    assert(cyc.changed === false && cyc.rejected === 'cycle' && cyc.parentTrackId === -1, 'loop -> rejected cycle');
    const unkChild = addon.timeline_setTrackParent(9999, A);
    assert(unkChild.changed === false && unkChild.rejected === 'unknown_track', 'unknown child -> unknown_track');
    const unkParent = addon.timeline_setTrackParent(A, 9999);
    assert(unkParent.changed === false && unkParent.rejected === 'unknown_track', 'unknown parent -> unknown_track');
    assert(state() === s0 && undoDesc() === d0, 'rejections change nothing and record nothing');

    // Depth: U0 <- U1 <- U2 <- U3 <- U4 (U4 has 4 ancestors), U5 under U4 is too deep.
    for (let i = 1; i <= 4; i++) {
      const r = addon.timeline_setTrackParent(U[i], U[i - 1]);
      assert(r.changed === true, `chain: U${i} -> U${i - 1}`);
    }
    const deep = addon.timeline_setTrackParent(U[5], U[4]);
    assert(deep.changed === false && deep.rejected === 'too_deep', '5th ancestor -> rejected too_deep');
    const deepSub = addon.timeline_setTrackParent(U[0], C);
    assert(deepSub.changed === false && deepSub.rejected === 'too_deep',
      "the child's subtree counts: U0 (4 levels below it) under C -> too_deep");
    for (let i = 0; i < 4; i++) addon.undo_undo();
    assert(trackOf(U[1]).parentTrackId === -1 && trackOf(U[4]).parentTrackId === -1, 'chain undone');
  }

  // ── strict parse ───────────────────────────────────────────────────────────
  section('timeline_setTrackParent: strict parse');
  {
    const s0 = state();
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keep: true })), 'unknown opts field throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keepOnScreen: 'yes' })), 'non-bool keepOnScreen throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: NaN })), 'NaN tick throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: -1 })), 'negative tick throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { tick: '0' })), 'string tick throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: 2 ** 53 + 2 })), 'tick > 2^53 throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: 1e300 })), 'tick 1e300 throws');
    assert(throws(() => addon.timeline_setTrackParent(C, A, [1])), 'array opts throws');
    assert(throws(() => addon.timeline_setTrackParent(C, -2)), 'parent -2 throws');
    assert(throws(() => addon.timeline_setTrackParent(C, 1.5)), 'fractional parent throws');
    assert(throws(() => addon.timeline_setTrackParent(C, Infinity)), 'non-finite parent throws');
    assert(throws(() => addon.timeline_setTrackParent('C', A)), 'string trackId throws');
    assert(throws(() => addon.timeline_setTrackParent(C)), 'missing parent throws');
    assert(state() === s0, 'nothing changed');
  }

  // ── keep on screen (R6 / R7) ───────────────────────────────────────────────
  section('timeline_setTrackParent: keep on screen');
  {
    const ra = { offsetX: 0.5, offsetY: 0.25, scale: 2, rotationDeg: 90 };
    const rc = { offsetX: 0.1, offsetY: -0.2, scale: 0.5, rotationDeg: 10 };
    addon.timeline_setTrackRoam(A, ra);
    addon.timeline_setTrackRoam(C, { ...rc, bounds: 'Float', layer: 'Top' });
    const hA = home(0, 3, W, H), hC = home(2, 3, W, H);
    const SA = parentSim(hA, ra);
    const oldCentre = roamedCentre(hC, rc);
    const local = applySim(invSim(SA), oldCentre);
    const want = {
      offsetX: (local[0] - hC.cx) / hC.unitW, offsetY: (local[1] - hC.cy) / hC.unitH,
      scale: rc.scale / ra.scale, rotationDeg: rc.rotationDeg - ra.rotationDeg,
    };

    const before = state();
    const res = addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: 0 });
    assert(res.changed === true && res.parentTrackId === A, 'attach C -> A with keepOnScreen');
    assert(near(res.roam.offsetX, want.offsetX) && near(res.roam.offsetY, want.offsetY)
      && near(res.roam.scale, want.scale, 1e-6) && near(res.roam.rotationDeg, want.rotationDeg, 1e-4),
      `base solved per R7: got (${res.roam.offsetX.toFixed(5)}, ${res.roam.offsetY.toFixed(5)}, x${res.roam.scale}, ${res.roam.rotationDeg} deg), ` +
      `want (${want.offsetX.toFixed(5)}, ${want.offsetY.toFixed(5)}, x${want.scale}, ${want.rotationDeg} deg)`);
    assert(res.roam.bounds === 'Float' && res.roam.layer === 'Top', 'bounds / layer untouched');
    assert(str(res.compensated.slice().sort()) === str(['offsetX', 'offsetY', 'rotationDeg', 'scale'])
      && res.uncompensated.length === 0, 'compensated: all four, uncompensated: none');
    // The final pose under the chain equals the old one.
    const newCentre = applySim(SA, roamedCentre(hC, res.roam));
    assert(near(newCentre[0], oldCentre[0], 1e-2) && near(newCentre[1], oldCentre[1], 1e-2),
      'the child stays where it was on screen (JS forward check)');
    const after = state();
    addon.undo_undo();
    assert(state() === before, 'ONE undo restores parent AND base');
    addon.undo_redo();
    assert(state() === after, 'redo restores both');

    // Detach with keep-on-screen returns the original base.
    const det = addon.timeline_setTrackParent(C, -1, { keepOnScreen: true, tick: 0 });
    assert(det.changed && det.parentTrackId === -1 && near(det.roam.offsetX, rc.offsetX) && near(det.roam.offsetY, rc.offsetY)
      && near(det.roam.scale, rc.scale, 1e-6) && near(det.roam.rotationDeg, rc.rotationDeg),
      'detach with keepOnScreen: the base returns to the original values');
    addon.undo_undo();

    // A keyed channel is not compensated.
    addon.undo_undo();   // back to C unparented with base rc
    addon.timeline_setTrackRoamKeys(C, [{ channel: 'rotationDeg', anchor: 'Origin', pos: 0, value: 30, interp: 'Linear' }]);
    const k = addon.timeline_setTrackParent(C, B, { keepOnScreen: true, tick: 0 });
    assert(k.changed && k.uncompensated.includes('rotationDeg') && !k.compensated.includes('rotationDeg')
      && near(k.roam.rotationDeg, rc.rotationDeg) && k.compensated.includes('offsetX') && k.compensated.includes('scale'),
      'a keyed rotation is listed uncompensated and its base kept; offset / scale compensated');
    addon.undo_undo();
    addon.undo_undo();   // the keys

    // A child with no placement at the tick: nothing to keep.
    const np = addon.timeline_setTrackParent(U[5], A, { keepOnScreen: true });
    assert(np.changed === true && np.keepOnScreenSkipped === 'not_placed' && np.compensated.length === 0
      && np.uncompensated.length === 0, 'unplaced child: keepOnScreenSkipped not_placed');
    addon.undo_undo();
    // Re-attach C -> A (keep-on-screen) for the removeTrack test.
    const re = addon.timeline_setTrackParent(C, A, { keepOnScreen: true, tick: 0 });
    assert(re.changed && near(re.roam.offsetX, want.offsetX) && near(re.roam.scale, want.scale, 1e-6),
      're-attach C -> A gives the same keep-on-screen base');
  }

  // ── setTrackMasks ──────────────────────────────────────────────────────────
  section('timeline_setTrackMasks');
  const rect = (h) => [[-h, -h, 0, 0, 0, 0], [h, -h, 0, 0, 0, 0], [h, h, 0, 0, 0, 0], [-h, h, 0, 0, 0, 0]];
  const K = 0.5522847498;
  const ellipse = (rx, ry) => [[0, -ry, -K * rx, 0, K * rx, 0], [rx, 0, 0, -K * ry, 0, K * ry],
                               [0, ry, K * rx, 0, -K * rx, 0], [-rx, 0, 0, K * ry, 0, -K * ry]];
  const masks = [
    { id: 1, name: 'Window', kind: 'Rectangle',
      base: { shape: { closed: true, vertices: rect(0.4) }, feather: 0.05, expansion: -0.1, opacity: 0.9, mode: 'Add', invert: false },
      keys: [{ channel: 'feather', anchor: 'Origin', pos: 0, value: 0, interp: 'Linear' },
             { channel: 'opacity', anchor: 'Origin', pos: 1920, value: 0.5, interp: 'Bezier', bez: [0.1, 0.2, 0.3, 0.9] }],
      shapeKeys: [{ pos: 3840, interp: 'Linear', vertices: rect(0.2) },
                  { pos: 0, interp: 'EaseOut', vertices: rect(0.4) }] },
    { id: 2, kind: 'Ellipse', base: { shape: { vertices: ellipse(0.4, 0.3) }, mode: 'Subtract', invert: true } },
  ];
  {
    const before = state();
    const res = addon.timeline_setTrackMasks(B, masks);
    assert(res && res.changed === true && res.trackId === B && res.masks.length === 2, 'set two masks');
    const m0 = res.masks[0], m1 = res.masks[1];
    assert(m0.shapeKeys.length === 2 && m0.shapeKeys[0].pos === 0 && m0.shapeKeys[1].pos === 3840
      && m0.shapeKeys[0].interp === 'EaseOut', 'shape keys come back sorted by pos');
    assert(m0.keys[1].interp === 'Bezier' && str(m0.keys[1].bez) === str([0.1, 0.2, 0.3, 0.9]) && m0.keys[0].bez === undefined,
      'keys keep interp; bez only on Bezier');
    assert(m1.name === 'Mask 2' && m1.base.feather === 0 && m1.base.expansion === 0 && m1.base.opacity === 1
      && m1.base.mode === 'Subtract' && m1.base.invert === true && m1.keys.length === 0 && m1.shapeKeys.length === 0
      && m1.base.shape.closed === true, 'defaults filled (name, identity scalars, no keys, closed)');
    const after = state();
    assert(after !== before && str(trackOf(B).masks) === str(res.masks), 'getLensRoam returns the masks');
    addon.undo_undo();
    assert(state() === before, 'undo restores the exact prior state');
    addon.undo_redo();
    assert(state() === after, 'redo restores the exact edited state');
    const d0 = undoDesc();
    const same = addon.timeline_setTrackMasks(B, res.masks);
    assert(same.changed === false && undoDesc() === d0 && state() === after, 'the same masks again: no-op, no undo step');

    // Strict rejects.
    const bad = (label, edit) => {
      const m = JSON.parse(JSON.stringify(masks));
      edit(m);
      const s0 = state();
      assert(throws(() => addon.timeline_setTrackMasks(B, m)) && state() === s0, `rejects ${label}`);
    };
    bad('an unknown mask field', (m) => { m[0].colour = 1; });
    bad('an unknown base field', (m) => { m[0].base.blur = 1; });
    bad('an unknown key field', (m) => { m[0].keys[0].ease = 1; });
    bad('a string id', (m) => { m[0].id = '1'; });
    bad('a duplicate id', (m) => { m[1].id = 1; });
    bad('an open path', (m) => { m[0].base.shape.closed = false; });
    bad('2 vertices', (m) => { m[1].base.shape.vertices.splice(0, 2); });
    bad('a NaN vertex', (m) => { m[0].base.shape.vertices[0][0] = NaN; });
    bad('feather 1.5', (m) => { m[0].base.feather = 1.5; });
    bad('opacity -0.1', (m) => { m[0].base.opacity = -0.1; });
    bad('an unknown mode', (m) => { m[0].base.mode = 'Multiply'; });
    bad('an unknown kind', (m) => { m[0].kind = 'Star'; });
    bad('a note anchor', (m) => { m[0].keys[0].anchor = 'Head'; });
    bad('an unknown channel', (m) => { m[0].keys[0].channel = 'blur'; });
    bad('a shape key with the wrong vertex count', (m) => { m[0].shapeKeys[0].vertices.pop(); });
    bad('two shape keys at one pos', (m) => { m[0].shapeKeys[0].pos = 0; });
    bad('a 65-character name', (m) => { m[0].name = 'n'.repeat(65); });
    bad('9 masks (cap 8)', (m) => { for (let i = 3; i <= 9; i++) m.push({ id: i, base: { shape: { vertices: rect(0.1) } } }); });
    bad('65 vertices on a track (cap 64)', (m) => {
      const poly = (n) => Array.from({ length: n }, (_, i) => [Math.cos(i), Math.sin(i), 0, 0, 0, 0]);
      m[0].base.shape.vertices = poly(32); m[0].shapeKeys = [];
      m[1].base.shape.vertices = poly(32);
      m.push({ id: 3, base: { shape: { vertices: poly(3) } } });
    });
    bad('33 vertices in one mask (cap 32)', (m) => {
      m[1].base.shape.vertices = Array.from({ length: 33 }, (_, i) => [Math.cos(i), Math.sin(i), 0, 0, 0, 0]);
    });
    assert(throws(() => addon.timeline_setTrackMasks(9999, [])), 'an unknown track throws');
    assert(throws(() => addon.timeline_setTrackMasks(B, { id: 1 })), 'a non-array throws');

    // Clearing.
    const cleared = addon.timeline_setTrackMasks(B, []);
    assert(cleared.changed === true && cleared.masks.length === 0 && trackOf(B).masks.length === 0, 'an empty list clears');
    addon.undo_undo();
    assert(state() === after, 'undo the clear');
  }

  // ── removeTrack detaches children in ONE undo step ─────────────────────────
  section('timeline_removeTrack: children detach (keep on screen), one undo step');
  {
    // Now: B -> A (plain), C -> A (keep-on-screen base), A has Roam ra.
    assert(trackOf(B).parentTrackId === A && trackOf(C).parentTrackId === A, 'fixture: B and C are children of A');
    const ra = trackOf(A).roam;
    const cRoam = trackOf(C).roam;
    const SA = parentSim(home(0, 3, W, H), ra);
    const hC = home(2, 3, W, H);
    const finalC = applySim(SA, roamedCentre(hC, cRoam));
    const wantC = {
      offsetX: (finalC[0] - hC.cx) / hC.unitW, offsetY: (finalC[1] - hC.cy) / hC.unitH,
      scale: cRoam.scale * ra.scale, rotationDeg: cRoam.rotationDeg + ra.rotationDeg,
    };

    assert(throws(() => addon.timeline_removeTrack(A, { tick: 0 })), 'removeTrack: unknown opts field throws');
    assert(throws(() => addon.timeline_removeTrack(A, { keepOnScreenTick: -5 })), 'removeTrack: negative tick throws');
    assert(throws(() => addon.timeline_removeTrack(A, { keepOnScreenTick: 'x' })), 'removeTrack: string tick throws');
    assert(throws(() => addon.timeline_removeTrack(A, { keepOnScreenTick: 2 ** 53 + 2 })), 'removeTrack: tick > 2^53 throws');
    assert(addon.timeline_getTracks().some((t) => t.id === A), 'removeTrack: a rejected tick removes nothing');
    assert(addon.timeline_getTracks().some((t) => t.id === A), 'rejected removeTrack removed nothing');

    const before = state();
    const beforeTracks = addon.timeline_getTracks().length;
    addon.timeline_removeTrack(A, { keepOnScreenTick: 0 });
    const tracksAfter = addon.timeline_getTracks();
    assert(tracksAfter.length === beforeTracks - 1 && !tracksAfter.some((t) => t.id === A), 'A removed');
    const tb = tracksAfter.find((t) => t.id === B), tc = tracksAfter.find((t) => t.id === C);
    assert(tb.parentTrackId === -1 && tc.parentTrackId === -1, 'both children detached');
    const c2 = addon.timeline_getLensRoam({ trackIds: [C] }).tracks[0].roam;
    assert(near(c2.offsetX, wantC.offsetX) && near(c2.offsetY, wantC.offsetY) && near(c2.scale, wantC.scale, 1e-5)
      && near(c2.rotationDeg, wantC.rotationDeg, 1e-4),
      `C keeps its on-screen pose: base (${c2.offsetX.toFixed(5)}, ${c2.offsetY.toFixed(5)}, x${c2.scale}, ${c2.rotationDeg}) ` +
      `want (${wantC.offsetX.toFixed(5)}, ${wantC.offsetY.toFixed(5)}, x${wantC.scale}, ${wantC.rotationDeg})`);
    addon.undo_undo();
    assert(state() === before, 'ONE undo restores the track, both parents and the child base');
    addon.undo_redo();
    assert(!addon.timeline_getTracks().some((t) => t.id === A)
      && addon.timeline_getTracks().find((t) => t.id === C).parentTrackId === -1, 'redo removes and detaches again');
    addon.undo_undo();
    assert(state() === before, 'undo again');
    // Without opts (old callers): still detaches (tick 0).
    addon.timeline_removeTrack(A);
    assert(addon.timeline_getTracks().find((t) => t.id === B).parentTrackId === -1, 'removeTrack(id) with no opts detaches too');
    addon.undo_undo();
    assert(state() === before, 'and undoes in one step');
  }

  // ── Motion view UI state ───────────────────────────────────────────────────
  section('project_get/setMotionViewState');
  const mv = { v: 1, view: 'motion', graph: true,
    edit: { trackHeight: 36, scrollY: 12 },
    motion: { trackRowHeight: 28, scrollY: 40, headerWidth: 360, expanded: [`t:${B}`, `t:${B}/roam`, `t:${B}/mask:1`] } };
  {
    assert(addon.project_getMotionViewState() === null, 'no state at first: null');
    assert(addon.project_save() === true, 'save (clears dirty)');
    const dirty0 = addon.project_isDirty();
    const d0 = undoDesc();
    assert(addon.project_setMotionViewState(mv) === true, 'set returns true');
    assert(str(addon.project_getMotionViewState()) === str(mv), 'get returns what was set');
    assert(addon.project_isDirty() === dirty0 && dirty0 === false, 'not dirtying');
    assert(undoDesc() === d0, 'not undoable (no undo step)');
    assert(throws(() => addon.project_setMotionViewState(5)), 'a number throws');
    assert(throws(() => addon.project_setMotionViewState('x')), 'a string throws');
    assert(throws(() => addon.project_setMotionViewState([1, 2])), 'an array throws');
    assert(throws(() => addon.project_setMotionViewState({ a: NaN })), 'a non-finite number throws');
    assert(throws(() => addon.project_setMotionViewState({ big: 'x'.repeat(300 * 1024) })), 'over 256 KB throws');
    assert(throws(() => addon.project_setMotionViewState()), 'no argument throws');
    assert(str(addon.project_getMotionViewState()) === str(mv), 'rejected sets leave the state');
  }

  // ── save -> fresh engine -> load ───────────────────────────────────────────
  section('save / load');
  {
    const final = state();
    assert(addon.project_save() === true, 'project_save()');
    const pj = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
    assert(pj.schema_version >= 9, `schema_version 9 or later (got ${pj.schema_version})`);
    assert(pj.motionView && str(pj.motionView) === str(mv), 'project.json carries motionView');
    const pjB = pj.tracks.find((t) => t.id === B), pjA = pj.tracks.find((t) => t.id === A);
    assert(pjB && pjB.parentTrackId === A && pjB.roam.masks && pjB.roam.masks.length === 2, 'B saves parentTrackId + masks');
    assert(pjA && !('parentTrackId' in pjA) && !('masks' in pjA.roam), 'A (no parent, no masks) saves neither key');
    addon.shutdown();
    assert(addon.initialize() === true, 're-initialize()');
    assert(addon.project_getMotionViewState() === null, 'a fresh engine has no state');
    assert(addon.project_load(PROJECT_DIR) === true, 'project_load()');
    const reloaded = state();
    assert(reloaded === final, 'parents and masks survive save / load');
    if (reloaded !== final) { console.error('  before:', final); console.error('  after :', reloaded); }
    assert(str(addon.project_getMotionViewState()) === str(mv), 'motionView survives save / load');

    // Empty -> no key; reload -> null.
    assert(addon.project_setMotionViewState(null) === true && addon.project_getMotionViewState() === null, 'set null clears');
    assert(addon.project_setMotionViewState({}) === true && addon.project_getMotionViewState() === null, 'an empty object is none');
    assert(addon.project_save() === true, 'save without state');
    const pj2 = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf8'));
    assert(!('motionView' in pj2), 'no motionView key when empty');
    addon.project_setMotionViewState(mv);
    assert(addon.project_load(PROJECT_DIR) === true && addon.project_getMotionViewState() === null,
      'loading a project without the key replaces the open state with null');
    // A failed load keeps the still-open project's state.
    addon.project_setMotionViewState(mv);
    assert(addon.project_load(path.join(PROJECT_DIR, 'does-not-exist')) === false
      && str(addon.project_getMotionViewState()) === str(mv), 'a failed load keeps the open project state');
    const nb = addon.project_newBlank();
    assert(nb && (nb.ok === true || nb === true) && addon.project_getMotionViewState() === null, 'project_newBlank clears it');

    // A dangling parent (no such track) loads as stored but reports -1 (design 2.1).
    const pjD = JSON.parse(JSON.stringify(pj));
    pjD.tracks.find((t) => t.id === B).parentTrackId = 987654;
    fs.writeFileSync(path.join(PROJECT_DIR, 'project.json'), JSON.stringify(pjD, null, 2));
    assert(addon.project_load(PROJECT_DIR) === true, 'load a project with a dangling parentTrackId');
    const dl = addon.timeline_getLensRoam({ trackIds: [B] }).tracks[0];
    const dt = addon.timeline_getTracks().find((t) => t.id === B);
    assert(dl && dl.parentTrackId === -1, `getLensRoam: a dangling parent reports -1 (got ${dl && dl.parentTrackId})`);
    assert(dt && dt.parentTrackId === -1, `getTracks: a dangling parent reports -1 (got ${dt && dt.parentTrackId})`);
  }

  addon.shutdown();
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
