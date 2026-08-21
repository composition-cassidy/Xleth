'use strict';
//
// bridge/test_automation_clips_bridge.js — automation clips bridge contract test
//
// Phase A ships 24 new RPCs. The four-layer bridge swallows an undefined call
// through optional chaining, so "the C++ compiles" proves nothing about whether
// a call reaches the engine. This exercises EVERY one of them through the SAME
// native entry point the renderer uses, and asserts on the engine's answer:
//
//   - every automation_* export exists and is callable (no silent undefined)
//   - lanes / envelopes / clips round-trip through the query RPCs
//   - same-lane overlap is rejected at the mutation layer (add / move / resize)
//   - evaluation semantics observed FROM JS: inside a clip, hold in the gap,
//     instant take-over, base value before anything has played
//   - a real stock effect on the master chain is bound by effectInstanceId and
//     its parameter is actually driven (plan resolves, diagnostics agree)
//   - the deletion contract query + one-step removal
//   - base-value get/set, make-unique, point edits, undo/redo
//   - everything survives project save/load
//
// Run after rebuilding the native addon:
//   node bridge/test_automation_clips_bridge.js
//

const fs = require('fs');
const os = require('os');
const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = `${dllDir};${process.env.PATH}`;

const addon = require('./build/Release/xleth_native.node');

let passed = 0;
let failed = 0;
let total = 0;

function ok(cond, label) {
  total += 1;
  if (cond) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.error(`  FAIL  ${label}`);
    failed += 1;
  }
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol,
     `${label} (expected ~${expected}, got ${actual}, tol +/-${tol})`);
}

// Every RPC this phase adds. Presence is checked before anything is called so a
// missing export is reported as itself rather than as a downstream crash.
const AUTOMATION_RPCS = [
  'automation_getLanes', 'automation_getClips', 'automation_getEnvelopes',
  'automation_addLane', 'automation_removeLane', 'automation_addEnvelope',
  'automation_addClip', 'automation_removeClip', 'automation_moveClip',
  'automation_resizeClip', 'automation_resizeClipLeft', 'automation_makeClipUnique',
  'automation_addPoint', 'automation_removePoint', 'automation_movePoint',
  'automation_setPointCurve', 'automation_setEnvelopePoints',
  'automation_getClipsForEffectInstance', 'automation_removeForEffectInstance',
  'automation_getBaseValue', 'automation_setBaseValue', 'automation_evaluateAtTick',
  'automation_getPlanDiagnostics', 'automation_refreshPlan',
];

const PROJ_DIR = path.join(os.tmpdir(), '_xleth_automation_bridge_test');
const PPQ = 960;

function getNodeId(raw) {
  if (typeof raw === 'string') { try { return JSON.parse(raw).nodeId; } catch (_) { return -1; } }
  if (raw && typeof raw === 'object') return raw.nodeId;
  if (typeof raw === 'number') return raw;
  return -1;
}

function parseMaybeJson(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (_) { return null; } }
  return v;
}

// The master chain's effectInstanceId for a given nodeId.
function masterInstanceIdFor(nodeId) {
  const chain = parseMaybeJson(addon.audio_getMasterEffectChain());
  const nodes = chain && (chain.nodes || chain);
  if (!Array.isArray(nodes)) return null;
  const hit = nodes.find((n) => n && n.nodeId === nodeId);
  return hit ? hit.effectInstanceId : null;
}

function evalAt(binding, tick) {
  return addon.automation_evaluateAtTick(binding, tick);
}

(async () => {
  console.log('=== Automation clips bridge contract test ===\n');

  console.log('[ RPC surface ]');
  let allPresent = true;
  for (const name of AUTOMATION_RPCS) {
    const present = typeof addon[name] === 'function';
    if (!present) allPresent = false;
    ok(present, `addon exports ${name}()`);
  }
  if (!allPresent) {
    console.error('\nMissing exports — the rest of the test cannot run.');
    process.exit(1);
  }

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
  ok(addon.project_create(PROJ_DIR, 'AutomationBridgeTest') === true, 'project_create() -> true');

  // ── A real stock effect on the master chain, addressed by instance id ──────
  console.log('\n[ binding a real stock effect ]');
  const nodeId = getNodeId(addon.audio_addMasterEffect('delay', 0));
  ok(nodeId >= 0, `audio_addMasterEffect("delay") -> nodeId=${nodeId}`);
  const instanceId = masterInstanceIdFor(nodeId);
  ok(typeof instanceId === 'string' && instanceId.length > 0,
     `master chain reports a stable effectInstanceId (${instanceId})`);
  if (!instanceId) process.exit(1);

  // ownerTrackId -1 addresses the Master chain everywhere in this API.
  const binding = { ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'mix' };

  // ── Lanes ─────────────────────────────────────────────────────────────────
  console.log('\n[ lanes ]');
  const laneId = addon.automation_addLane({ ownerTrackId: -1 });
  ok(laneId > 0, `automation_addLane({ownerTrackId:-1}) -> ${laneId}`);
  const lanes = addon.automation_getLanes(-1);
  ok(Array.isArray(lanes) && lanes.length === 1, 'automation_getLanes(-1) returns the Master lane');
  ok(lanes[0] && lanes[0].id === laneId && lanes[0].ownerTrackId === -1 && lanes[0].index === 0,
     'lane fields round-trip (id/ownerTrackId/index)');
  ok(Array.isArray(addon.automation_getLanes()) && addon.automation_getLanes().length === 1,
     'automation_getLanes() with no argument returns every lane');

  const laneId2 = addon.automation_addLane({ ownerTrackId: -1 });
  ok(laneId2 > 0 && laneId2 !== laneId, 'a second lane gets a distinct id');
  ok(addon.automation_getLanes(-1)[1].index === 1, 'omitting index appends after the last lane');

  // ── Envelopes ─────────────────────────────────────────────────────────────
  console.log('\n[ envelopes ]');
  const envA = addon.automation_addEnvelope({
    ownerTrackId: -1,
    effectInstanceId: instanceId,
    parameterId: 'mix',
    points: [{ tick: 0, value: 0.0 }, { tick: PPQ, value: 1.0 }],
  });
  ok(envA > 0, `automation_addEnvelope(...) -> ${envA}`);

  const gotA = addon.automation_getEnvelopes(envA);
  ok(Array.isArray(gotA) && gotA.length === 1, 'automation_getEnvelopes(id) returns that envelope');
  ok(gotA[0].binding.ownerTrackId === -1
     && gotA[0].binding.effectInstanceId === instanceId
     && gotA[0].binding.parameterId === 'mix',
     'envelope binding round-trips');
  ok(Array.isArray(gotA[0].points) && gotA[0].points.length === 2, 'envelope points round-trip');
  ok(gotA[0].points[0].curveType === 0 && gotA[0].points[0].tension === 0,
     'curveType/tension are present in the payload even at their defaults');

  // Points are sorted on the way in, whatever order they arrived in.
  const envUnsorted = addon.automation_addEnvelope({
    ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'feedback',
    points: [{ tick: 2 * PPQ, value: 0.9 }, { tick: 0, value: 0.1 }, { tick: PPQ, value: 0.5 }],
  });
  const sorted = addon.automation_getEnvelopes(envUnsorted)[0].points;
  ok(sorted[0].tick === 0 && sorted[1].tick === PPQ && sorted[2].tick === 2 * PPQ,
     'points arrive sorted ascending by tick regardless of input order');

  // ── Clips + overlap rejection ─────────────────────────────────────────────
  console.log('\n[ clips and same-lane overlap ]');
  const clipA = addon.automation_addClip({
    laneId, envelopeId: envA, positionTicks: PPQ, durationTicks: PPQ,
  });
  ok(clipA > 0, `automation_addClip(...) -> ${clipA}`);

  const rejected = addon.automation_addClip({
    laneId, envelopeId: envA, positionTicks: PPQ + 100, durationTicks: PPQ,
  });
  ok(rejected === -1, 'an overlapping clip on the same lane is rejected (-1)');
  ok(addon.automation_getClips(laneId).length === 1, 'and nothing was added');

  const abutting = addon.automation_addClip({
    laneId, envelopeId: envA, positionTicks: 2 * PPQ, durationTicks: PPQ,
  });
  ok(abutting > 0, 'an abutting clip is accepted (intervals are half-open)');
  ok(addon.automation_moveClip(abutting, laneId, PPQ + 100) === false,
     'automation_moveClip into an overlap returns false');
  ok(addon.automation_getClips(laneId).find((c) => c.id === abutting).positionTicks === 2 * PPQ,
     'a rejected move left the clip where it was');
  ok(addon.automation_resizeClip(clipA, 4 * PPQ) === false,
     'automation_resizeClip over a neighbour returns false');
  ok(addon.automation_removeClip(abutting) === true, 'automation_removeClip -> true');

  const clips = addon.automation_getClips(laneId);
  ok(clips.length === 1 && clips[0].id === clipA, 'automation_getClips(laneId) filters by lane');
  ok(clips[0].positionTicks === PPQ && clips[0].durationTicks === PPQ && clips[0].offsetTicks === 0,
     'clip placement fields round-trip');

  ok(addon.automation_moveClip(clipA, laneId, 2 * PPQ) === true, 'automation_moveClip -> true');
  ok(addon.automation_getClips(laneId)[0].positionTicks === 2 * PPQ, 'the move took effect');
  ok(addon.automation_moveClip(clipA, laneId, PPQ) === true, 'moved back');

  ok(addon.automation_resizeClip(clipA, 2 * PPQ) === true, 'automation_resizeClip -> true');
  ok(addon.automation_getClips(laneId)[0].durationTicks === 2 * PPQ, 'the resize took effect');
  ok(addon.automation_resizeClipLeft(clipA, PPQ + 480, PPQ, 480) === true,
     'automation_resizeClipLeft -> true');
  {
    const c = addon.automation_getClips(laneId)[0];
    ok(c.positionTicks === PPQ + 480 && c.durationTicks === PPQ && c.offsetTicks === 480,
       'left trim moved position, duration and offset together');
  }
  // Put it back to a clean [960, 1920) for the evaluation checks below.
  addon.automation_resizeClipLeft(clipA, PPQ, PPQ, 0);

  // ── Evaluation semantics, observed from JS ────────────────────────────────
  console.log('\n[ evaluation semantics ]');
  addon.automation_setBaseValue(binding, 0.25);
  addon.automation_refreshPlan();

  {
    const r = evalAt(binding, 0);
    ok(r.found === true, 'automation_evaluateAtTick finds the bound target');
    near(r.value, 0.25, 1e-9, 'before any clip -> the base value');
  }
  near(evalAt(binding, PPQ).value, 0.0, 1e-9, 'clip start -> its first point');
  near(evalAt(binding, PPQ + 480).value, 0.5, 1e-9, 'midway through the ramp');
  // The clip covers [960, 1920) and its last point sits at intra-clip tick 960,
  // i.e. exactly at the EXCLUSIVE end — so the last tick inside the clip is one
  // short of the final value, and the final value is what the hold picks up.
  near(evalAt(binding, 2 * PPQ - 1).value, 959 / 960, 1e-6,
       'the last tick inside the clip is one tick short of the final point');
  near(evalAt(binding, 4 * PPQ).value, 1.0, 1e-9, 'past the clip -> hold the last point');

  // A second clip further along takes over instantly at its own first point.
  const envB = addon.automation_addEnvelope({
    ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'mix',
    points: [{ tick: 0, value: 0.2 }],
  });
  const clipB = addon.automation_addClip({
    laneId, envelopeId: envB, positionTicks: 4 * PPQ, durationTicks: PPQ,
  });
  ok(clipB > 0, 'second clip placed after a gap');
  addon.automation_refreshPlan();
  near(evalAt(binding, 4 * PPQ - 1).value, 1.0, 1e-9, 'last tick of the gap still holds');
  near(evalAt(binding, 4 * PPQ).value, 0.2, 1e-9,
       'the new clip takes over INSTANTLY at its first point');

  // Cross-lane overlap: the topmost lane (lowest index) wins.
  const envTop = addon.automation_addEnvelope({
    ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'mix',
    points: [{ tick: 0, value: 0.05 }],
  });
  // laneId is index 0, laneId2 is index 1 — so a clip on laneId wins. Put the
  // overlapping pair on laneId2 (bottom) and laneId (top) at the same ticks.
  const envBottom = addon.automation_addEnvelope({
    ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'mix',
    points: [{ tick: 0, value: 0.95 }],
  });
  const bottomClip = addon.automation_addClip({
    laneId: laneId2, envelopeId: envBottom, positionTicks: 6 * PPQ, durationTicks: 2 * PPQ,
  });
  const topClip = addon.automation_addClip({
    laneId, envelopeId: envTop, positionTicks: 6 * PPQ, durationTicks: PPQ,
  });
  ok(bottomClip > 0 && topClip > 0, 'overlapping clips placed on two different lanes');
  addon.automation_refreshPlan();
  near(evalAt(binding, 6 * PPQ + 10).value, 0.05, 1e-9,
       'inside the cross-lane overlap the TOPMOST lane wins');
  near(evalAt(binding, 7 * PPQ + 10).value, 0.95, 1e-9,
       'past the top clip the bottom clip resumes at its own value');

  // Determinism: the same tick answers identically however we get there.
  {
    const a = evalAt(binding, 1234).value;
    evalAt(binding, 99999);
    evalAt(binding, 0);
    const b = evalAt(binding, 1234).value;
    ok(a === b, 'evaluation is stateless: the same tick always answers identically');
  }

  // ── Plan diagnostics / dead clips ─────────────────────────────────────────
  console.log('\n[ plan diagnostics ]');
  const diag = parseMaybeJson(addon.automation_getPlanDiagnostics());
  ok(diag && typeof diag === 'object', 'automation_getPlanDiagnostics returns an object');
  ok(diag.targetCount >= 1, `plan has targets (${diag.targetCount})`);
  ok(diag.resolvedTargets >= 1,
     `the binding resolved to a live stock parameter (${diag.resolvedTargets})`);
  ok(diag.overflowed === false, 'the plan did not overflow');

  {
    // A binding naming an effect that does not exist is a DEAD clip: kept in the
    // model, counted, and absent from the plan.
    const deadEnv = addon.automation_addEnvelope({
      ownerTrackId: -1, effectInstanceId: 'fx-does-not-exist', parameterId: 'mix',
      points: [{ tick: 0, value: 0.5 }],
    });
    const deadClip = addon.automation_addClip({
      laneId: laneId2, envelopeId: deadEnv, positionTicks: 20 * PPQ, durationTicks: PPQ,
    });
    ok(deadClip > 0, 'a clip with an unresolvable binding is still ACCEPTED');
    addon.automation_refreshPlan();
    const d2 = parseMaybeJson(addon.automation_getPlanDiagnostics());
    ok(d2.unresolvedClips >= 1, `the dead clip is counted (${d2.unresolvedClips})`);
    ok(addon.automation_getClips(laneId2).some((c) => c.id === deadClip),
       'and it is preserved in the model, not discarded');
    const dr = addon.automation_getBaseValue({
      ownerTrackId: -1, effectInstanceId: 'fx-does-not-exist', parameterId: 'mix',
    });
    ok(dr.resolved === false, 'automation_getBaseValue reports resolved:false for a dead binding');
    addon.automation_removeClip(deadClip);
  }

  // ── Base value ────────────────────────────────────────────────────────────
  console.log('\n[ base value ]');
  {
    const b1 = addon.automation_getBaseValue(binding);
    ok(b1.stored === true, 'automation_getBaseValue reports the stored flag');
    ok(b1.resolved === true, 'and that the binding resolves');
    near(b1.value, 0.25, 1e-9, 'the stored base value reads back');

    ok(addon.automation_setBaseValue(binding, 0.7) === true, 'automation_setBaseValue -> true');
    near(addon.automation_getBaseValue(binding).value, 0.7, 1e-9, 'the new base value reads back');

    // A binding with no stored base falls back to the parameter's live value.
    const fresh = { ownerTrackId: -1, effectInstanceId: instanceId, parameterId: 'feedback' };
    const b2 = addon.automation_getBaseValue(fresh);
    ok(b2.stored === false, 'an unrecorded binding reports stored:false');
    ok(b2.resolved === true, 'but still resolves to a live parameter');
    ok(b2.value >= 0 && b2.value <= 1, `and reports its live normalized value (${b2.value})`);

    addon.automation_setBaseValue(binding, 0.25);   // restore for later checks
  }

  // ── Points ────────────────────────────────────────────────────────────────
  console.log('\n[ point edits ]');
  ok(addon.automation_addPoint(envA, { tick: 480, value: 0.75 }) === true,
     'automation_addPoint -> true');
  ok(addon.automation_getEnvelopes(envA)[0].points.length === 3, 'the point was added');
  ok(addon.automation_addPoint(envA, { tick: 480, value: 0.4 }) === true,
     'adding at an existing tick succeeds');
  ok(addon.automation_getEnvelopes(envA)[0].points.length === 3,
     'and REPLACES rather than stacking (duplicate-tick rule)');
  near(addon.automation_getEnvelopes(envA)[0].points[1].value, 0.4, 1e-9,
       'the replacement value took');

  ok(addon.automation_movePoint(envA, 1, 700, 0.8) === true, 'automation_movePoint -> true');
  ok(addon.automation_getEnvelopes(envA)[0].points[1].tick === 700, 'the point moved');

  ok(addon.automation_setPointCurve(envA, 0, 1, 0.6) === true, 'automation_setPointCurve -> true');
  {
    const p0 = addon.automation_getEnvelopes(envA)[0].points[0];
    ok(p0.curveType === 1, 'curveType persisted');
    near(p0.tension, 0.6, 1e-9, 'tension persisted');
  }
  near(evalAt(binding, PPQ + 350).value,
       addon.automation_getEnvelopes(envA)[0].points[0].value
         + (0.8 - addon.automation_getEnvelopes(envA)[0].points[0].value) * (350 / 700),
       1e-6, 'v1 still evaluates a Tension segment linearly');

  ok(addon.automation_removePoint(envA, 1) === true, 'automation_removePoint -> true');
  ok(addon.automation_getEnvelopes(envA)[0].points.length === 2, 'the point was removed');

  ok(addon.automation_setEnvelopePoints(envA, [
       { tick: 0, value: 0.0 }, { tick: 480, value: 0.5 }, { tick: PPQ, value: 1.0 },
     ]) === true, 'automation_setEnvelopePoints -> true (the drag-commit path)');
  ok(addon.automation_getEnvelopes(envA)[0].points.length === 3, 'the whole list was replaced');

  // ── Make-unique ───────────────────────────────────────────────────────────
  console.log('\n[ make-unique ]');
  {
    const copyClip = addon.automation_addClip({
      laneId: laneId2, envelopeId: envA, positionTicks: 10 * PPQ, durationTicks: PPQ,
    });
    ok(copyClip > 0, 'a copy sharing the source envelope was placed');
    const newEnvId = addon.automation_makeClipUnique(copyClip);
    ok(newEnvId > 0 && newEnvId !== envA, `automation_makeClipUnique -> new envelope ${newEnvId}`);
    ok(addon.automation_getClips(laneId2).find((c) => c.id === copyClip).envelopeId === newEnvId,
       'the clip now plays the duplicate');
    ok(addon.automation_getEnvelopes(newEnvId)[0].points.length === 3,
       'the duplicate carries the source points');

    addon.automation_addPoint(newEnvId, { tick: 700, value: 0.1 });
    ok(addon.automation_getEnvelopes(envA)[0].points.length === 3,
       'editing the duplicate no longer touches the original');
    addon.automation_removeClip(copyClip);
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────
  console.log('\n[ undo / redo ]');
  {
    const before = addon.automation_getClips(laneId).length;
    const tmp = addon.automation_addClip({
      laneId, envelopeId: envA, positionTicks: 30 * PPQ, durationTicks: PPQ,
    });
    ok(tmp > 0, 'a clip was added');
    ok(addon.automation_getClips(laneId).length === before + 1, 'clip count went up');
    ok(addon.undo_undo() === true, 'undo_undo() -> true');
    ok(addon.automation_getClips(laneId).length === before, 'undo removed the clip');
    ok(addon.undo_redo() === true, 'undo_redo() -> true');
    ok(addon.automation_getClips(laneId).length === before + 1, 'redo restored it');
    ok(addon.automation_getClips(laneId).some((c) => c.id === tmp),
       'redo restored the SAME clip id');
    addon.automation_removeClip(tmp);
  }

  // ── Deletion contract ─────────────────────────────────────────────────────
  console.log('\n[ deletion contract ]');
  {
    const bound = addon.automation_getClipsForEffectInstance(-1, instanceId);
    ok(Array.isArray(bound) && bound.length >= 3,
       `automation_getClipsForEffectInstance lists every bound clip (${bound.length})`);
    ok(bound.every((c) => typeof c.parameterId === 'string'),
       'each entry names the parameter the dialog has to show');
    ok(addon.automation_getClipsForEffectInstance(-1, 'fx-nope').length === 0,
       'an unknown instance has no bound clips');

    const removed = addon.automation_removeForEffectInstance(-1, instanceId);
    ok(removed === bound.length,
       `automation_removeForEffectInstance removed them all (${removed})`);
    ok(addon.automation_getClipsForEffectInstance(-1, instanceId).length === 0,
       'no bound clips remain');
    ok(addon.undo_undo() === true, 'the whole cascade undoes in ONE step');
    ok(addon.automation_getClipsForEffectInstance(-1, instanceId).length === removed,
       'and every clip came back');
  }

  // ── Persistence ───────────────────────────────────────────────────────────
  console.log('\n[ project save / load ]');
  {
    const lanesBefore = addon.automation_getLanes().length;
    const clipsBefore = addon.automation_getClips().length;
    const envsBefore  = addon.automation_getEnvelopes().length;
    near(addon.automation_getBaseValue(binding).value, 0.25, 1e-9, 'base value before save');

    ok(addon.project_save() === true, 'project_save() -> true');
    ok(addon.project_load(PROJ_DIR) === true, 'project_load() -> true');

    ok(addon.automation_getLanes().length === lanesBefore,
       `lanes survive save/load (${lanesBefore})`);
    ok(addon.automation_getClips().length === clipsBefore,
       `clips survive save/load (${clipsBefore})`);
    ok(addon.automation_getEnvelopes().length === envsBefore,
       `envelopes survive save/load (${envsBefore})`);
    near(addon.automation_getBaseValue(binding).value, 0.25, 1e-9,
         'the base value survives save/load');

    const saved = JSON.parse(fs.readFileSync(path.join(PROJ_DIR, 'project.json'), 'utf8'));
    ok(Array.isArray(saved.automationLanes), 'project.json carries automationLanes');
    ok(Array.isArray(saved.automationClips), 'project.json carries automationClips');
    ok(Array.isArray(saved.automationEnvelopes), 'project.json carries automationEnvelopes');
    ok(Array.isArray(saved.automationBaseValues), 'project.json carries automationBaseValues');
    {
      const e = saved.automationEnvelopes.find((x) => Array.isArray(x.points) && x.points.length);
      ok(!!e, 'at least one serialized envelope has points');
      const plain = e.points.find((p) => p.c === undefined);
      ok(!!plain, 'a default point omits its curve fields (compact paramtrack shape)');
    }
  }

  // ── Lane removal cascade ──────────────────────────────────────────────────
  console.log('\n[ lane removal ]');
  {
    const onLane = addon.automation_getClips(laneId).length;
    ok(onLane > 0, `the lane still holds clips (${onLane})`);
    ok(addon.automation_removeLane(laneId) === true, 'automation_removeLane -> true');
    ok(addon.automation_getClips(laneId).length === 0, 'its clips went with it');
    ok(addon.undo_undo() === true, 'undo restores the lane');
    ok(addon.automation_getClips(laneId).length === onLane, 'and every clip on it');
    ok(addon.automation_removeLane(999999) === false, 'removing an unknown lane -> false');
  }

  console.log('\n[ shutdown ]');
  addon.shutdown();
  ok(true, 'shutdown() completed');

  fs.rmSync(PROJ_DIR, { recursive: true, force: true });

  console.log('\n--------------------------------------------------');
  console.log(`PASSED: ${passed}/${total} tests`);
  if (failed > 0) {
    console.error(`FAILED: ${failed}/${total} tests`);
    process.exit(1);
  }
  process.exit(0);
})();
