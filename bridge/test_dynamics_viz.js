'use strict';
//
// bridge/test_dynamics_viz.js — Compressor visualization smoke test
//
// Verifies the new bridge surface for dynamics visualization end-to-end at
// the native-addon level (no Electron):
//   • Exports exist and accept the right argument shapes.
//   • Empty drains return well-formed payloads (count 0, empty ArrayBuffer).
//   • Enable / disable cycles do not throw or leak.
//   • Rapid open/close churn (50× toggles) does not corrupt state.
//   • Two independent compressor instances drain independently.
//   • Drain after the effect is removed returns "unknown" gracefully.
//
// Run after rebuilding the native addon:
//   node bridge/test_dynamics_viz.js
//

const path = require('path');

const dllDir = path.resolve(__dirname, 'build/Release');
process.env.PATH = dllDir + ';' + process.env.PATH;

const addon = require('./build/Release/xleth_native.node');

let passed = 0, failed = 0, total = 0;
function ok(cond, label) {
  total++;
  if (cond) { console.log(`  PASS  ${label}`); passed++; }
  else      { console.error(`  FAIL  ${label}`); failed++; }
}

function addMaster(pluginId) {
  const r = addon.audio_addMasterEffect(pluginId, 0);
  if (typeof r === 'string') {
    try { return JSON.parse(r).nodeId; } catch (e) { return -1; }
  }
  if (r && typeof r === 'object') return r.nodeId;
  if (typeof r === 'number')      return r;
  return -1;
}

(async () => {
  // 1. Init engine
  try {
    addon.initialize();
  } catch (e) {
    console.error(`Engine init failed (likely no audio device): ${e.message}`);
    console.error('SKIPPING — this test needs an audio device.');
    process.exit(0);
  }

  // 2. Exports present
  ok(typeof addon.audio_setEffectVisualizationEnabled === 'function',
     'audio_setEffectVisualizationEnabled is exported');
  ok(typeof addon.audio_drainEffectVizFrames === 'function',
     'audio_drainEffectVizFrames is exported');

  // 3. Add a master Compressor.
  const nodeId = addMaster('compressor');
  ok(nodeId >= 0, `audio_addMasterEffect("compressor") → nodeId=${nodeId}`);
  if (nodeId < 0) { process.exit(1); }

  // 4. Drain BEFORE enabling — well-formed empty payload.
  {
    const r = addon.audio_drainEffectVizFrames(-1, nodeId, 64);
    ok(r && typeof r === 'object', 'drain returns an object');
    ok(typeof r.type === 'string',  `drain.type is a string (got "${r.type}")`);
    ok(typeof r.schema === 'number', 'drain.schema is a number');
    ok(typeof r.bucketSize === 'number', 'drain.bucketSize is a number');
    ok(r.count === 0, 'drain.count == 0 before enable');
    ok(r.frames instanceof ArrayBuffer, 'drain.frames is an ArrayBuffer');
    ok(r.frames.byteLength === 0, 'drain.frames is empty (byteLength 0)');
  }

  // 5. Enable, then drain.
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeId, true) === true,
     'enable(true) → true');
  {
    const r = addon.audio_drainEffectVizFrames(-1, nodeId, 64);
    ok(r.type === 'compressor', `drain.type === "compressor" (got "${r.type}")`);
    ok(r.schema === 1,           `drain.schema === 1 (got ${r.schema})`);
    ok(r.bucketSize === 40,      `drain.bucketSize === 40 (got ${r.bucketSize})`);
    ok(typeof r.count === 'number', `drain.count is a number (got ${r.count})`);
    ok(r.frames instanceof ArrayBuffer, 'drain.frames is an ArrayBuffer');
    if (r.count > 0) {
      ok(r.frames.byteLength === r.count * 40,
         `drain.frames.byteLength == count * 40 (got ${r.frames.byteLength} for count ${r.count})`);
    }
  }

  // 6. Idempotent enable — calling enable(true) twice in a row is safe.
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeId, true) === true,
     'idempotent enable(true) returned true');

  // 7. Disable → drain returns 0.
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeId, false) === true,
     'disable returned true');
  {
    const r = addon.audio_drainEffectVizFrames(-1, nodeId, 64);
    ok(r.count === 0, 'drain.count == 0 after disable');
    ok(r.frames.byteLength === 0, 'drain.frames empty after disable');
  }

  // 8. Bogus nodeId — graceful empty payload, no throw.
  {
    const r = addon.audio_drainEffectVizFrames(-1, 99999, 64);
    ok(r && typeof r === 'object', 'drain on bogus nodeId returns object');
    ok(r.type === 'unknown', `bogus drain.type === "unknown" (got "${r.type}")`);
    ok(r.count === 0, 'bogus drain.count == 0');
    ok(r.frames instanceof ArrayBuffer && r.frames.byteLength === 0,
       'bogus drain.frames is empty ArrayBuffer');
  }

  // 9. Open/close churn — 50 rapid enable/disable cycles must not throw or leak.
  let churnOk = true;
  for (let i = 0; i < 50; i++) {
    try {
      const e1 = addon.audio_setEffectVisualizationEnabled(-1, nodeId, true);
      addon.audio_drainEffectVizFrames(-1, nodeId, 32);
      const e2 = addon.audio_setEffectVisualizationEnabled(-1, nodeId, false);
      addon.audio_drainEffectVizFrames(-1, nodeId, 32);
      if (e1 !== true || e2 !== true) { churnOk = false; break; }
    } catch (e) { churnOk = false; break; }
  }
  ok(churnOk, '50× enable/disable churn cycles complete without throw');

  // 10. Two independent compressor instances drain independently.
  const nodeIdB = addMaster('compressor');
  ok(nodeIdB >= 0 && nodeIdB !== nodeId,
     `second compressor → nodeId=${nodeIdB} (distinct from ${nodeId})`);
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeIdB, true) === true,
     'second compressor enable → true');
  {
    const a = addon.audio_drainEffectVizFrames(-1, nodeId, 32);
    const b = addon.audio_drainEffectVizFrames(-1, nodeIdB, 32);
    ok(a.type === 'compressor' || a.type === 'compressor',
       `inst A drain.type ok (got "${a.type}")`);
    ok(b.type === 'compressor' || b.type === 'compressor',
       `inst B drain.type ok (got "${b.type}")`);
    ok(a.frames instanceof ArrayBuffer && b.frames instanceof ArrayBuffer,
       'both drains return ArrayBuffers');
  }
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeIdB, false) === true,
     'second compressor disable → true');

  // 11. Drain after effect is removed → gracefully returns "unknown" payload.
  ok(typeof addon.audio_removeMasterEffect === 'function',
     'audio_removeMasterEffect is exported');
  const removed = addon.audio_removeMasterEffect(nodeIdB);
  ok(removed === true, `audio_removeMasterEffect(${nodeIdB}) returned true`);
  {
    // First, calling enable on a removed node returns false (not throw).
    const r1 = addon.audio_setEffectVisualizationEnabled(-1, nodeIdB, false);
    ok(r1 === false, 'enable(false) on removed effect returns false (no throw)');
    const r2 = addon.audio_setEffectVisualizationEnabled(-1, nodeIdB, true);
    ok(r2 === false, 'enable(true) on removed effect returns false (no throw)');

    const r = addon.audio_drainEffectVizFrames(-1, nodeIdB, 64);
    ok(r && typeof r === 'object', 'drain on removed effect returns object');
    ok(r.type === 'unknown',
       `drain on removed effect → type "unknown" (got "${r.type}")`);
    ok(r.count === 0, 'drain on removed effect → count 0');
    ok(r.frames instanceof ArrayBuffer && r.frames.byteLength === 0,
       'drain on removed effect → empty ArrayBuffer');
  }

  // 12. Cleanup the surviving compressor and confirm clean teardown.
  ok(addon.audio_setEffectVisualizationEnabled(-1, nodeId, false) === true,
     'final disable returned true');
  ok(addon.audio_removeMasterEffect(nodeId) === true,
     'final removeMasterEffect returned true');

  // ── Limiter visualization smoke checks ─────────────────────────────────────
  // Mirrors the Compressor cases above: drain shape, type/schema/bucketSize,
  // enable/disable churn, distinct from Compressor's bucket size.
  const limiterNodeId = addMaster('limiter');
  ok(limiterNodeId >= 0, `audio_addMasterEffect("limiter") → nodeId=${limiterNodeId}`);
  if (limiterNodeId >= 0) {
    // Drain BEFORE enable — well-formed empty payload, type still "unknown"
    // because no collector has been allocated yet.
    {
      const r = addon.audio_drainEffectVizFrames(-1, limiterNodeId, 64);
      ok(r && typeof r === 'object', 'limiter drain (pre-enable) returns an object');
      ok(typeof r.type === 'string',  `limiter drain.type pre-enable is a string (got "${r.type}")`);
      ok(r.count === 0,             'limiter drain.count == 0 before enable');
      ok(r.frames instanceof ArrayBuffer && r.frames.byteLength === 0,
         'limiter drain.frames is empty ArrayBuffer pre-enable');
    }

    // Enable, then drain — type/schema/bucketSize must match limiter schema.
    ok(addon.audio_setEffectVisualizationEnabled(-1, limiterNodeId, true) === true,
       'limiter enable(true) → true');
    {
      const r = addon.audio_drainEffectVizFrames(-1, limiterNodeId, 64);
      ok(r.type === 'limiter',  `limiter drain.type === "limiter" (got "${r.type}")`);
      ok(r.schema === 1,        `limiter drain.schema === 1 (got ${r.schema})`);
      ok(r.bucketSize === 56,   `limiter drain.bucketSize === 56 (got ${r.bucketSize})`);
      ok(r.frames instanceof ArrayBuffer, 'limiter drain.frames is an ArrayBuffer');
      if (r.count > 0) {
        ok(r.frames.byteLength === r.count * 56,
           `limiter drain.frames.byteLength == count * 56 (got ${r.frames.byteLength} for count ${r.count})`);
      }
    }

    // Idempotent enable.
    ok(addon.audio_setEffectVisualizationEnabled(-1, limiterNodeId, true) === true,
       'limiter idempotent enable(true) → true');

    // Disable → empty drain.
    ok(addon.audio_setEffectVisualizationEnabled(-1, limiterNodeId, false) === true,
       'limiter disable returned true');
    {
      const r = addon.audio_drainEffectVizFrames(-1, limiterNodeId, 64);
      ok(r.count === 0, 'limiter drain.count == 0 after disable');
      ok(r.frames instanceof ArrayBuffer && r.frames.byteLength === 0,
         'limiter drain.frames empty after disable');
    }

    // 30-cycle enable/disable churn.
    let limiterChurnOk = true;
    for (let i = 0; i < 30; i++) {
      try {
        const e1 = addon.audio_setEffectVisualizationEnabled(-1, limiterNodeId, true);
        addon.audio_drainEffectVizFrames(-1, limiterNodeId, 32);
        const e2 = addon.audio_setEffectVisualizationEnabled(-1, limiterNodeId, false);
        addon.audio_drainEffectVizFrames(-1, limiterNodeId, 32);
        if (e1 !== true || e2 !== true) { limiterChurnOk = false; break; }
      } catch (e) { limiterChurnOk = false; break; }
    }
    ok(limiterChurnOk, '30× limiter enable/disable churn cycles complete without throw');

    ok(addon.audio_removeMasterEffect(limiterNodeId) === true,
       'remove limiter master effect returned true');
  }

  console.log(`\n${failed === 0 ? 'PASSED' : 'FAILED'}: ${passed}/${total} tests`);
  process.exit(failed === 0 ? 0 : 1);
})();
