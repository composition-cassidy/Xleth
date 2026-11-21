'use strict';
//
// bridge/test_visual_echo_contract.js — Visual Echo bridge contract test
//
// Drives the REAL xleth_native.node addon through the SAME entry points the
// renderer uses, because the thing most likely to break this feature is not the
// compositor — it is one of the four bridge layers silently dropping the call.
//
// Adding a chainable visual effect touches six hand-maintained tables with no
// registry between them, and every one of them fails QUIETLY:
//
//   • a stale `effectType must be 0-N` guard throws a RangeError that the UI's
//     optional-chaining bridge swallows, so the effect just never appears
//   • a missing Track.cpp case saves the effect as "Desaturation" with empty
//     params, so the chain silently degrades on the next project load
//   • a missing RPC export means window.xleth.timeline.foo is `undefined` and
//     `?.()` evaluates to undefined instead of throwing
//
// So this test asserts each of those separately rather than assuming that "the
// effect showed up" means the whole path is wired.
//
// Verified here:
//   1. add          — timeline_addVisualEffect(trackId, 8) is accepted
//   2. params       — every one of the 8 documented params round-trips
//   3. checked write— a write to an out-of-range index REPORTS failure
//   4. persistence  — params survive project save + load (the Track.cpp tables)
//   5. undo/redo    — add and set-param both round-trip through UndoManager
//   6. binding      — a Delay's nodeId can be stored as the binding and read back
//
// Run after rebuilding the native addon:
//   node bridge/test_visual_echo_contract.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = `${dllDir};${process.env.PATH}`;

const addon = require('./build/Release/xleth_native.node');

const PROJ_DIR = path.join(os.tmpdir(), 'xleth-visual-echo-contract');

// VisualEcho param indices — mirrors the canonical layout documented on
// VisualEffect in engine/src/model/TimelineTypes.h. Spelled out here on purpose:
// if that layout is ever reshuffled, this test should fail loudly rather than
// keep passing against whatever the params happen to mean now.
const FX_VISUAL_ECHO   = 8;
const P_TAPS           = 0;
const P_DECAY          = 1;
const P_DELAY_NODE_ID  = 2;
const P_SCALE_TRAIL    = 3;
const P_FLIP_MODE      = 4;
const P_DRIFT          = 5;
const P_BLEND_MODE     = 6;
const P_FOLLOW_FEEDBACK = 7;

let passed = 0;
let failed = 0;
let total = 0;

function ok(cond, label) {
  total += 1;
  if (cond) { console.log(`  PASS  ${label}`); passed += 1; }
  else      { console.error(`  FAIL  ${label}`); failed += 1; }
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol,
     `${label} (expected ~${expected}, got ${actual}, tol +/-${tol})`);
}

function getChain(trackId) {
  const raw = addon.timeline_getVisualEffectChain(trackId);
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function getNodeId(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw).nodeId; } catch (_) { return -1; }
  }
  if (raw && typeof raw === 'object' && 'nodeId' in raw) return raw.nodeId;
  return typeof raw === 'number' ? raw : -1;
}

(async () => {
  console.log('=== Visual Echo bridge contract test ===\n');

  let initOk = false;
  try {
    initOk = addon.initialize();
  } catch (err) {
    console.error(`Engine init failed: ${err.message}`);
    console.error('SKIPPING - this test needs an audio device.');
    process.exit(0);
  }
  ok(initOk === true, 'initialize() returns true');

  if (fs.existsSync(PROJ_DIR)) fs.rmSync(PROJ_DIR, { recursive: true, force: true });
  ok(addon.project_create(PROJ_DIR, 'VisualEchoContract') === true,
     'project_create() returns true');

  const trackId = addon.timeline_addTrack({ name: 'Echo', volume: 1.0, order: 0 });
  ok(typeof trackId === 'number' && trackId >= 0, `timeline_addTrack -> ${trackId}`);

  // ── 1. The effect type is reachable at all ────────────────────────────────
  //
  // This is the assertion that catches a stale range guard. Before the type was
  // registered, `timeline_addVisualEffect(trackId, 8)` threw
  // "effectType must be 0-7" — which, through the renderer's optional-chaining
  // bridge, is indistinguishable from the call quietly doing nothing.
  console.log('\n[ registration ]');
  let addIdx = -1;
  let addThrew = null;
  try {
    addIdx = addon.timeline_addVisualEffect(trackId, FX_VISUAL_ECHO);
  } catch (err) {
    addThrew = err;
  }
  ok(addThrew === null,
     `timeline_addVisualEffect(type=8) does not throw${addThrew ? ` (${addThrew.message})` : ''}`);
  ok(addIdx === 0, `timeline_addVisualEffect returns the new index (got ${addIdx})`);
  if (addIdx < 0) { console.error('cannot continue without the effect'); process.exit(1); }

  // Type 9 must STILL be rejected. Without this, a range guard that was widened
  // to some large number (or removed) would look identical to a correct one.
  let nineThrew = false;
  try { addon.timeline_addVisualEffect(trackId, 9); } catch (_) { nineThrew = true; }
  ok(nineThrew, 'timeline_addVisualEffect(type=9) is still rejected');

  let chain = getChain(trackId);
  ok(Array.isArray(chain) && chain.length === 1, 'chain has exactly one effect');
  ok(chain[0].type === FX_VISUAL_ECHO, `chain reports type ${FX_VISUAL_ECHO}`);

  // ── 2. Defaults ───────────────────────────────────────────────────────────
  //
  // The binding default matters more than it looks: -1 means UNBOUND, and an
  // all-zero fallback would read as "bound to node 0", which is a legal uid.
  console.log('\n[ defaults ]');
  near(chain[0].params[P_TAPS], 4, 1e-4, 'default taps is 4');
  near(chain[0].params[P_DELAY_NODE_ID], -1, 1e-4,
       'default binding is -1 (unbound), not 0');
  near(chain[0].params[P_FOLLOW_FEEDBACK], 1, 1e-4, 'follow-feedback defaults on');

  // ── 3. Every param round-trips ────────────────────────────────────────────
  console.log('\n[ parameter round-trip ]');
  const WRITES = [
    [P_TAPS,            6],
    [P_DECAY,           0.42],
    [P_SCALE_TRAIL,     0.75],
    [P_FLIP_MODE,       3],
    [P_DRIFT,           0.33],
    [P_BLEND_MODE,      1],
    [P_FOLLOW_FEEDBACK, 0],
  ];
  for (const [pi, v] of WRITES) {
    addon.timeline_setVisualEffectParam(trackId, addIdx, pi, v);
  }
  chain = getChain(trackId);
  for (const [pi, v] of WRITES) {
    near(chain[0].params[pi], v, 1e-4, `param[${pi}] round-trips as ${v}`);
  }

  // ── 4. A write that cannot land must REPORT that, not fail silently ───────
  //
  // The engine's checked-return pattern: Timeline::setVisualEffectParam returns
  // false for a bad index, SetVisualEffectParamCommand records that, and
  // shouldRecordInUndoHistory() then keeps the no-op out of the undo stack. The
  // observable consequence at this layer is that the failed write leaves the
  // undo depth alone — so a later undo rewinds a REAL edit rather than burning
  // itself on a step that changed nothing.
  console.log('\n[ checked writes ]');
  const beforeBad = JSON.stringify(getChain(trackId));
  addon.timeline_setVisualEffectParam(trackId, addIdx, 99, 1.0);   // param index out of range
  addon.timeline_setVisualEffectParam(trackId, 77, P_TAPS, 1.0);   // effect index out of range
  addon.timeline_setVisualEffectParam(9999, addIdx, P_TAPS, 1.0);  // track does not exist
  ok(JSON.stringify(getChain(trackId)) === beforeBad,
     'out-of-range writes leave the chain untouched');

  // The undo stack must not have grown. If the failed writes HAD been recorded,
  // this undo would consume one of them and the chain below would still show 6.
  addon.undo_undo();
  chain = getChain(trackId);
  near(chain[0].params[P_FOLLOW_FEEDBACK], 1, 1e-4,
       'undo rewinds the last REAL write, not a swallowed failed one');
  addon.undo_redo();
  chain = getChain(trackId);
  near(chain[0].params[P_FOLLOW_FEEDBACK], 0, 1e-4, 'redo reapplies it');

  // ── 5. Persistence — the table most often missed ──────────────────────────
  //
  // engine/src/model/Track.cpp holds four hand-maintained switch statements
  // (type<->string, params<->named JSON). Miss the VisualEcho case in any of
  // them and the effect saves as "Desaturation" with empty params: the chain
  // silently degrades on reload with no error printed anywhere.
  console.log('\n[ persistence ]');
  ok(addon.project_save() === true, 'project_save() returns true');
  ok(addon.project_load(PROJ_DIR) === true, 'project_load() returns true');

  const reloaded = getChain(trackId);
  ok(Array.isArray(reloaded) && reloaded.length === 1,
     'the reloaded project still has one visual effect');
  if (reloaded && reloaded.length === 1) {
    ok(reloaded[0].type === FX_VISUAL_ECHO,
       `reloaded effect is still type ${FX_VISUAL_ECHO} (not silently Desaturation)`);
    for (const [pi, v] of WRITES) {
      near(reloaded[0].params[pi], v, 1e-4, `param[${pi}] survives save/load as ${v}`);
    }
  }

  // ── 6. Binding to a real Delay node ───────────────────────────────────────
  //
  // The binding is stored as a float because params[] is a float array. Node
  // uids are small integers and exact in float32 far past 2^24, but that is an
  // assumption worth testing rather than asserting in a comment.
  console.log('\n[ delay binding ]');
  const delayNode = getNodeId(addon.audio_addEffect(trackId, 'delay', 0));
  ok(delayNode >= 0, `audio_addEffect(track, "delay") -> nodeId=${delayNode}`);
  if (delayNode >= 0) {
    addon.timeline_setVisualEffectParam(trackId, addIdx, P_DELAY_NODE_ID, delayNode);
    const bound = getChain(trackId);
    near(bound[0].params[P_DELAY_NODE_ID], delayNode, 1e-4,
         'the Delay nodeId round-trips exactly through the float param slot');

    // And it must survive a save/load too — a binding that silently reverted to
    // -1 on reload would look exactly like "the echo stopped working".
    ok(addon.project_save() === true, 'project_save() with a binding returns true');
    ok(addon.project_load(PROJ_DIR) === true, 'project_load() with a binding returns true');
    const afterLoad = getChain(trackId);
    near(afterLoad[0].params[P_DELAY_NODE_ID], delayNode, 1e-4,
         'the binding survives save/load');
  }

  // ── 7. Remove + undo ──────────────────────────────────────────────────────
  console.log('\n[ remove / undo ]');
  addon.timeline_removeVisualEffect(trackId, addIdx);
  ok(getChain(trackId).length === 0, 'removeVisualEffect empties the chain');
  addon.undo_undo();
  const restored = getChain(trackId);
  ok(restored.length === 1, 'undo restores the effect');
  if (restored.length === 1) {
    ok(restored[0].type === FX_VISUAL_ECHO, 'undo restores it as a Visual Echo');
    near(restored[0].params[P_TAPS], 6, 1e-4, 'undo restores its params too');
  }

  try { addon.shutdown(); } catch (_) { /* best effort */ }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests`);
  process.exit(failed > 0 ? 1 : 0);
})();
