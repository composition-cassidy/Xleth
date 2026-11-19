'use strict';

// Large RPC replies take a different road out of the addon than small ones:
// a plain-JSON reply of 512+ nodes is handed to V8 as text (one JSON.parse)
// instead of being built one N-API call per node (bridge/src/XlethAddon.cpp,
// resultToNapi). The two roads must produce the same value.
//
// This reads every clip twice — once inside the big timeline_getClips reply
// (text road) and once on its own through timeline_getClipsInRange (a reply far
// below the threshold, node-by-node road) — and requires them to be deeply
// equal, field for field and type for type.
//
// Run after the native addon is rebuilt:
//   node bridge/test_large_reply_fidelity.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const addon = require(addonPath);
const projectDir = path.resolve(__dirname, '_test_large_reply_fidelity');

let passed = 0;
let failed = 0;
function check(condition, label) {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.error(`  FAIL  ${label}`); }
}

function countNodes(value) {
  if (value === null || typeof value !== 'object') return 1;
  let n = 1;
  for (const key of Object.keys(value)) n += countNodes(value[key]);
  return n;
}

const CLIP_COUNT = 300;
const PPQ = 960;

try {
  fs.rmSync(projectDir, { recursive: true, force: true });
  check(addon.initialize() === true, 'engine initializes');
  check(addon.project_create(projectDir, 'LargeReplyFidelity') === true, 'project created');

  const trackA = addon.timeline_addTrack({ name: 'A', volume: 1, order: 0 });
  const trackB = addon.timeline_addTrack({ name: 'B', volume: 1, order: 1 });
  const regionId = addon.timeline_addRegion({ name: 'Region', startTime: 0, endTime: 4 });

  // Varied on purpose: negatives, fractions that do not round-trip through a
  // short decimal, booleans both ways, and integers next to floats.
  const payloads = [];
  for (let i = 0; i < CLIP_COUNT; i++) {
    payloads.push({
      trackId: i % 2 ? trackB : trackA,
      regionId,
      positionTicks: i * 4 * PPQ,
      durationTicks: PPQ,
      regionOffsetTicks: (i * 37) % 480,
      syllableIndex: (i % 5) - 1,
      velocity: 0.1 + (i % 9) / 7,
      pitchOffset: (i % 25) - 12,
      pitchOffsetCents: (i % 199) - 99,
      reversed: i % 3 === 0,
      stretchRatio: i % 4 === 0 ? 1 : 0.5 + (i % 11) / 3,
      stretchMethod: i % 3,
      formantPreserve: i % 2 === 0,
      fadeInPercent: (i % 40) / 3,
      fadeOutPercent: (i % 30) / 7,
      fadeInX1: 0.1, fadeInY1: 1 / 3, fadeInX2: 2 / 3, fadeInY2: 0.9,
      fadeOutX1: 0.3, fadeOutY1: 0.4, fadeOutX2: 0.7, fadeOutY2: 1 / 7,
    });
  }
  const ids = addon.timeline_addClipsBatch(payloads);
  check(Array.isArray(ids) && ids.length === CLIP_COUNT, `${CLIP_COUNT} clips added`);

  // Give some clips nested arrays and strings, which the scalar fields above
  // never exercise.
  for (let i = 0; i < CLIP_COUNT; i += 17) {
    addon.timeline_setClipModulation(ids[i], {
      enabled: true,
      vibrato: {
        enabled: true,
        depthCents: 12.5 + i,
        rateHz: 5 + i / 13,
        shape: 'custom',
        customShape: [
          { time: 0, value: -1 },
          { time: 1 / 3, value: 0.123456789 },
          { time: 1, value: 1 },
        ],
      },
    });
  }

  const all = addon.timeline_getClips();
  check(Array.isArray(all) && all.length === CLIP_COUNT, 'getClips returns every clip');
  const nodes = countNodes(all);
  check(nodes >= 512, `the full reply is large enough for the text road (${nodes} nodes)`);

  const byId = new Map(all.map((c) => [c.id, c]));
  let compared = 0;
  let mismatches = 0;
  let firstMismatch = null;
  for (let i = 0; i < CLIP_COUNT; i++) {
    const beat = i * 4;
    // getClipsInRange selects by clip START in [startBeat, endBeat).
    const small = addon.timeline_getClipsInRange(beat - 0.5, beat + 0.5);
    const single = Array.isArray(small) ? small.find((c) => c.id === ids[i]) : null;
    if (!single) { mismatches++; firstMismatch = firstMismatch || `clip ${ids[i]} missing from its range query`; continue; }
    compared++;
    try {
      assert.deepStrictEqual(byId.get(ids[i]), single);
    } catch (err) {
      mismatches++;
      firstMismatch = firstMismatch || `clip ${ids[i]}: ${String(err.message).split('\n').slice(0, 6).join(' | ')}`;
    }
  }
  check(compared === CLIP_COUNT, 'every clip was also read through a small reply');
  check(mismatches === 0, `large and small replies agree on every clip${firstMismatch ? ` (first: ${firstMismatch})` : ''}`);

  // Types the text road must not blur.
  const sample = byId.get(ids[0]);
  check(typeof sample.id === 'number' && Number.isInteger(sample.id), 'ids are integers');
  check(typeof sample.reversed === 'boolean' && typeof sample.formantPreserve === 'boolean', 'booleans stay booleans');
  check(typeof sample.velocity === 'number' && !Number.isInteger(byId.get(ids[1]).velocity), 'fractions stay fractions');
  check(sample.modulation && typeof sample.modulation === 'object' && !Array.isArray(sample.modulation), 'nested objects stay objects');
  check(Array.isArray(sample.modulation.vibrato.customShape) && sample.modulation.vibrato.customShape.length === 3, 'nested arrays stay arrays');
  check(typeof sample.modulation.vibrato.shape === 'string', 'strings stay strings');
  check(byId.get(ids[1]).pitchOffset < 0, 'negative integers survive');

  // Replies with no JSON form must still take the node-by-node road.
  const noReply = addon.timeline_setPreviewFps(30);
  check(noReply === undefined, 'a void RPC still returns undefined');
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { addon.shutdown(); } catch { /* already down */ }
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
