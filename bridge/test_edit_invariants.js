'use strict';

// Invariants of timeline editing, checked against the real addon.
//
// Each section builds its own small project and asserts a property that must
// hold for EVERY edit, rather than the behaviour of one call:
//
//   1. undo is exact      one undo after any valid edit restores the complete
//                         engine state, and one redo reproduces the edit
//   2. sequences are exact the same, walking back and forward through random
//                         sequences of edits
//   3. refusals are clean a rejected call, or one that changes nothing, leaves
//                         state, undo history and redo history untouched
//   4. groups are one edit a gesture of many calls is one undo entry, however
//                         many calls it takes
//   5. a split is silent  the two pieces play what the clip played, including
//                         stretched, reversed and faded clips
//   6. auto-trim is idempotent and trims the silence the clip actually plays
//
// "Complete engine state" is everything the UI reads: tracks, layout, regions,
// clips, patterns, pattern blocks, automation, loop region and tempo.
//
// Run after the native addon is rebuilt:
//   node bridge/test_edit_invariants.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const addonPath = process.env.XLETH_ADDON_PATH
  ? path.resolve(process.env.XLETH_ADDON_PATH)
  : path.resolve(__dirname, 'build/Release/xleth_native.node');
process.env.PATH = path.dirname(addonPath) + ';' + process.env.PATH;
const x = require(addonPath);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xleth-edit-invariants-'));
const PPQ = 960;

let passed = 0;
let failed = 0;
function check(condition, label, detail) {
  if (condition) { passed++; return; }
  failed++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${[].concat(detail).join('\n        ')}` : ''}`);
}
function section(name) { console.log(`\n[ ${name} ]`); }

// ── state snapshot ───────────────────────────────────────────────────────────
const READS = {
  bpm: () => x.timeline_getBPM(),
  tracks: () => x.timeline_getTracks(),
  layout: () => x.timeline_getTrackLayout(),
  regions: () => x.timeline_getRegions(),
  clips: () => x.timeline_getClips(),
  patterns: () => x.timeline_getAllPatterns(),
  blocks: () => x.timeline_getPatternBlocks(),
  lanes: () => x.automation_getLanes(),
  aclips: () => x.automation_getClips(),
  envelopes: () => x.automation_getEnvelopes(),
  loop: () => x.timeline_getLoopRegion(),
};
function snap() {
  const out = {};
  for (const key of Object.keys(READS)) out[key] = READS[key]();
  return out;
}
// Id-keyed lists compare by id (the engine iterates maps; the UI never relies
// on list order). nextNoteId is a counter that is deliberately not rewound:
// note ids are never reused.
function canon(value) {
  if (Array.isArray(value)) {
    const items = value.map(canon);
    if (value.length && value.every((v) => v && typeof v === 'object' && !Array.isArray(v) && 'id' in v)) {
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    return items;
  }
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value).sort()) { if (k !== 'nextNoteId') o[k] = canon(value[k]); }
    return o;
  }
  return value;
}
function diff(a, b, at = '', out = []) {
  if (out.length >= 6 || a === b) return out;
  const ta = Array.isArray(a) ? 'array' : a === null ? 'null' : typeof a;
  const tb = Array.isArray(b) ? 'array' : b === null ? 'null' : typeof b;
  if (ta !== tb) { out.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`.slice(0, 160)); return out; }
  if (ta === 'array') {
    if (a.length !== b.length) out.push(`${at}.length: ${a.length} -> ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${at}[${a[i]?.id ?? i}]`, out);
    return out;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], at ? `${at}.${k}` : k, out);
    return out;
  }
  if (typeof a === 'number' && Math.abs(a - b) < 1e-9) return out;
  out.push(`${at}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
  return out;
}
const delta = (a, b) => diff(canon(a), canon(b));
const same = (a, b) => delta(a, b).length === 0;

// ── fixture ──────────────────────────────────────────────────────────────────
let seq = 0;
const F = {};
function fresh() {
  x.project_newBlank();
  x.project_create(path.join(root, `p${seq++}`), 'EditInvariants');
  F.tA = x.timeline_addTrack({ name: 'Clip A', volume: 1, order: 0 });
  F.tB = x.timeline_addTrack({ name: 'Clip B', volume: 1, order: 1 });
  F.tP = x.timeline_addTrack({ name: 'Pat', volume: 1, order: 2 });
  x.timeline_convertToPatternTrack(F.tP);
  F.region = x.timeline_addRegion({ name: 'R', startTime: 0, endTime: 4 });
  F.region2 = x.timeline_addRegion({ name: 'R2', startTime: 1, endTime: 3 });
  const mk = (trackId, beat, beats = 1, extra = {}) => x.timeline_addClip({
    trackId, regionId: F.region, positionTicks: beat * PPQ, durationTicks: beats * PPQ, ...extra,
  });
  F.c1 = mk(F.tA, 0);
  F.c2 = mk(F.tA, 2, 2, { regionOffsetTicks: 240, stretchRatio: 2, pitchOffset: 3, pitchOffsetCents: 20, fadeInPercent: 10, fadeOutPercent: 20, velocity: 0.7 });
  F.c3 = mk(F.tB, 4);
  F.c4 = mk(F.tB, 8, 1, { reversed: true });
  F.pat = x.timeline_addPattern({ name: 'P1', regionId: F.region, lengthTicks: 4 * PPQ });
  F.pat2 = x.timeline_addPattern({ name: 'P2', regionId: F.region2, lengthTicks: 2 * PPQ });
  F.n1 = x.timeline_addNote(F.pat, { positionTicks: 0, durationTicks: 240, pitch: 60, velocity: 0.8 });
  F.n2 = x.timeline_addNote(F.pat, { positionTicks: 480, durationTicks: 240, pitch: 64, velocity: 0.6 });
  F.b1 = x.timeline_addPatternBlock({ trackId: F.tP, patternId: F.pat, positionTicks: 0, durationTicks: 4 * PPQ, offsetTicks: 0 });
  F.b2 = x.timeline_addPatternBlock({ trackId: F.tP, patternId: F.pat, positionTicks: 8 * PPQ, durationTicks: 4 * PPQ, offsetTicks: 0 });
  F.lane = x.automation_addLane({ ownerTrackId: -1 });
  F.lane2 = x.automation_addLane({ ownerTrackId: -1 });
  F.env = x.automation_addEnvelope({
    ownerTrackId: -1, effectInstanceId: 'inst-1', parameterId: 'mix',
    points: [{ tick: 0, value: 0 }, { tick: PPQ, value: 1 }, { tick: 2 * PPQ, value: 0.5 }],
  });
  F.ac1 = x.automation_addClip({ laneId: F.lane, envelopeId: F.env, positionTicks: 0, durationTicks: 2 * PPQ });
  F.ac2 = x.automation_addClip({ laneId: F.lane, envelopeId: F.env, positionTicks: 4 * PPQ, durationTicks: 2 * PPQ });
}
const clipOf = (id) => x.timeline_getClips().find((c) => c.id === id);

// ═════════════════════════════════════════════════════════════════════════════
try {
  check(x.initialize() === true, 'engine initializes');

  // ── 1. one undo restores everything, one redo reproduces the edit ──────────
  section('1. every valid edit undoes and redoes exactly');
  const EDITS = {
    addClip: () => x.timeline_addClip({ trackId: F.tA, regionId: F.region, positionTicks: 12 * PPQ, durationTicks: PPQ }),
    removeClip: () => x.timeline_removeClip(F.c1),
    moveClip: () => x.timeline_moveClip(F.c1, F.tB, 6 * PPQ),
    resizeClip: () => x.timeline_resizeClip(F.c2, 3 * PPQ),
    'resizeClip with offset': () => x.timeline_resizeClip(F.c4, 480, 480),
    resizeClipLeft: () => x.timeline_resizeClipLeft(F.c2, 2.5 * PPQ, 1.5 * PPQ, 480),
    stretchClip: () => x.timeline_stretchClip(F.c2, 4 * PPQ),
    stretchClipLeft: () => x.timeline_stretchClipLeft(F.c2, PPQ, 3 * PPQ),
    pitchShiftClip: () => x.timeline_pitchShiftClip(F.c1, 1, 5),
    reverseClip: () => x.timeline_reverseClip(F.c1),
    setClipParams: () => x.timeline_setClipParams(F.c1, { velocity: 0.33, fadeInPercent: 30, fadeOutPercent: 40 }),
    setClipModulation: () => x.timeline_setClipModulation(F.c1, { enabled: true, vibrato: { enabled: true, depthCents: 25, rateHz: 6 } }),
    addClipsBatch: () => x.timeline_addClipsBatch([{ trackId: F.tA, regionId: F.region, positionTicks: 20 * PPQ, durationTicks: PPQ }, { trackId: F.tB, regionId: F.region, positionTicks: 21 * PPQ, durationTicks: PPQ }]),
    pasteClipsBatch: () => x.timeline_pasteClipsBatch({ removeClipIds: [F.c3], clips: [{ trackId: F.tB, regionId: F.region, positionTicks: 4 * PPQ, durationTicks: 2 * PPQ }] }),
    moveClipsBatch: () => x.timeline_moveClipsBatch([{ clipId: F.c1, trackId: F.tB, positionTicks: 30 * PPQ }, { clipId: F.c3, trackId: F.tA, positionTicks: 31 * PPQ }]),
    removeClipsBatch: () => x.timeline_removeClipsBatch([F.c1, F.c3]),
    spliceClipsAtPlayhead: () => x.timeline_spliceClipsAtPlayhead([{ clipId: F.c2, splitTick: 3 * PPQ }]),
    quantizeClipsBatch: () => x.timeline_quantizeClipsBatch([{ id: F.c2, isPatternBlock: false, newStartTicks: 2 * PPQ + 240, newEndTicks: 4 * PPQ + 240, newOffsetTicks: 240 }]),
    addTrack: () => x.timeline_addTrack({ name: 'New', volume: 1, order: 3 }),
    'removeTrack with clips': () => x.timeline_removeTrack(F.tA),
    'removeTrack with blocks': () => x.timeline_removeTrack(F.tP),
    setTrackName: () => x.timeline_setTrackName(F.tB, 'Renamed'),
    setTrackMuted: () => x.timeline_setTrackMuted(F.tB, true),
    setTrackSolo: () => x.timeline_setTrackSolo(F.tB, true),
    setBPM: () => x.timeline_setBPM(98),
    setLoopRegion: () => x.timeline_setLoopRegion({ loopEnabled: true, startTick: PPQ, endTick: 5 * PPQ }),
    addRegion: () => x.timeline_addRegion({ name: 'R3', startTime: 0, endTime: 1 }),
    'removeRegion in use': () => x.timeline_removeRegion(F.region),
    addPattern: () => x.timeline_addPattern({ name: 'P3', regionId: F.region, lengthTicks: 4 * PPQ }),
    'removePattern in use': () => x.timeline_removePattern(F.pat),
    setPatternName: () => x.timeline_setPatternName(F.pat, 'Renamed'),
    addNote: () => x.timeline_addNote(F.pat, { positionTicks: 960, durationTicks: 240, pitch: 67, velocity: 0.5 }),
    'addNote past the pattern end': () => x.timeline_addNote(F.pat, { positionTicks: 6 * PPQ, durationTicks: 480, pitch: 60, velocity: 0.5 }),
    removeNote: () => x.timeline_removeNote(F.pat, F.n1),
    moveNote: () => x.timeline_moveNote(F.pat, F.n1, 720, 62),
    resizeNote: () => x.timeline_resizeNote(F.pat, F.n1, 480),
    setNoteVelocity: () => x.timeline_setNoteVelocity(F.pat, F.n1, 0.25),
    addPatternBlock: () => x.timeline_addPatternBlock({ trackId: F.tP, patternId: F.pat, positionTicks: 16 * PPQ, durationTicks: 4 * PPQ, offsetTicks: 0 }),
    removePatternBlock: () => x.timeline_removePatternBlock(F.b1),
    movePatternBlock: () => x.timeline_movePatternBlock(F.b1, F.tP, 20 * PPQ),
    resizePatternBlock: () => x.timeline_resizePatternBlock(F.b1, 2 * PPQ),
    resizePatternBlockLeft: () => x.timeline_resizePatternBlockLeft(F.b1, PPQ, 3 * PPQ, PPQ),
    setPatternBlockLoop: () => x.timeline_setPatternBlockLoop(F.b1, true),
    'automation addLane': () => x.automation_addLane({ ownerTrackId: -1 }),
    'automation removeLane': () => x.automation_removeLane(F.lane),
    'automation addClip': () => x.automation_addClip({ laneId: F.lane2, envelopeId: F.env, positionTicks: 0, durationTicks: PPQ }),
    'automation removeClip': () => x.automation_removeClip(F.ac1),
    'automation moveClip': () => x.automation_moveClip(F.ac1, F.lane2, 0),
    'automation resizeClip': () => x.automation_resizeClip(F.ac1, PPQ),
    'automation addPoint': () => x.automation_addPoint(F.env, { tick: 480, value: 0.75 }),
    'automation removePoint': () => x.automation_removePoint(F.env, 1),
    'automation movePoint': () => x.automation_movePoint(F.env, 1, 1200, 0.2),
    'automation setEnvelopePoints': () => x.automation_setEnvelopePoints(F.env, [{ tick: 0, value: 1 }, { tick: 480, value: 0 }]),
  };
  let exact = 0;
  for (const [name, run] of Object.entries(EDITS)) {
    fresh();
    const before = snap();
    run();
    const after = snap();
    check(!same(before, after), `${name}: changes something`);
    x.undo_undo();
    const undone = snap();
    check(same(before, undone), `${name}: ONE undo restores the prior state`, delta(before, undone));
    x.undo_redo();
    const redone = snap();
    check(same(after, redone), `${name}: ONE redo reproduces the edit`, delta(after, redone));
    if (same(before, undone) && same(after, redone)) exact++;
  }
  console.log(`  ${exact}/${Object.keys(EDITS).length} edits undo and redo exactly`);

  // ── 2. random sequences ────────────────────────────────────────────────────
  section('2. random edit sequences walk back and forward exactly');
  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  let sequenceEdits = 0;
  for (const seed of [11, 23, 37, 59]) {
    fresh();
    const r = rng(seed);
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const grid = (lo, hi) => int(lo, hi) * 240;
    const clips = () => x.timeline_getClips();
    const blocks = () => x.timeline_getPatternBlocks();
    const clipTracks = () => x.timeline_getTracks().filter((t) => t.type !== 'Pattern').map((t) => t.id);
    const ops = [
      () => { const t = pick(clipTracks()); if (t != null) x.timeline_addClip({ trackId: t, regionId: F.region, positionTicks: grid(0, 200), durationTicks: grid(1, 16), stretchRatio: pick([1, 0.5, 2]) }); },
      () => { const c = pick(clips()); if (c) x.timeline_removeClip(c.id); },
      () => { const c = pick(clips()); const t = pick(clipTracks()); if (c && t != null) x.timeline_moveClip(c.id, t, grid(0, 200)); },
      () => { const c = pick(clips()); if (c) x.timeline_resizeClip(c.id, grid(1, 16)); },
      () => { const c = pick(clips()); if (c) x.timeline_stretchClip(c.id, grid(1, 16)); },
      () => { const c = pick(clips()); if (c) x.timeline_pitchShiftClip(c.id, int(1, 2), int(-30, 30)); },
      () => { const c = pick(clips()); if (c) x.timeline_reverseClip(c.id); },
      () => { const c = pick(clips()); if (c) x.timeline_setClipParams(c.id, { velocity: 0.1 + r(), fadeInPercent: int(0, 60), fadeOutPercent: int(0, 60) }); },
      () => { const cs = clips().filter(() => r() > 0.6); const t = pick(clipTracks()); if (cs.length && t != null) x.timeline_moveClipsBatch(cs.map((c) => ({ clipId: c.id, trackId: t, positionTicks: c.positionTicks + 480 }))); },
      () => { const cs = clips().filter(() => r() > 0.8); if (cs.length) x.timeline_removeClipsBatch(cs.map((c) => c.id)); },
      () => { const c = pick(clips().filter((q) => q.durationTicks >= 480)); if (c) x.timeline_spliceClipsAtPlayhead([{ clipId: c.id, splitTick: c.positionTicks + 240 }]); },
      () => { x.timeline_addTrack({ name: `T${int(0, 999)}`, volume: 1, order: 9 }); },
      () => { const ts = x.timeline_getTracks(); if (ts.length > 3) x.timeline_removeTrack(pick(ts).id); },
      () => { x.timeline_setBPM(pick([90, 120, 128, 140, 174])); },
      () => { x.timeline_addNote(F.pat, { positionTicks: grid(0, 30), durationTicks: 240, pitch: int(48, 72), velocity: 0.6 }); },
      () => { const b = pick(blocks()); if (b) x.timeline_resizePatternBlock(b.id, grid(2, 32)); },
      () => { const b = pick(blocks()); if (b) x.timeline_removePatternBlock(b.id); },
      () => { x.automation_addPoint(F.env, { tick: grid(0, 16), value: r() }); },
      () => { const c = pick(x.automation_getClips()); if (c) x.automation_moveClip(c.id, c.laneId, grid(0, 400)); },
    ];
    const base = snap();
    const states = [];
    let prev = base;
    for (let i = 0; i < 40; i++) {
      pick(ops)();
      const now = snap();
      if (same(prev, now)) continue;        // refused or no-op: nothing recorded (section 3)
      states.push(now);
      prev = now;
    }
    sequenceEdits += states.length;
    let ok = true;
    for (let i = states.length - 1; i >= 0 && ok; i--) {
      x.undo_undo();
      const want = i === 0 ? base : states[i - 1];
      ok = same(snap(), want);
      check(ok, `seed ${seed}: undo #${states.length - i} restores the state before it`, ok ? null : delta(want, snap()));
    }
    for (let i = 0; i < states.length && ok; i++) {
      x.undo_redo();
      ok = same(snap(), states[i]);
      check(ok, `seed ${seed}: redo #${i + 1} reproduces the edit`, ok ? null : delta(states[i], snap()));
    }
    check(!x.undo_canRedo() || !ok, `seed ${seed}: the walk used up the redo history`);
  }
  console.log(`  ${sequenceEdits} edits walked back and forward`);

  // ── 3. refusals and no-ops ─────────────────────────────────────────────────
  section('3. a refused or empty edit leaves state and history untouched');
  const REFUSALS = {
    'removeClip, unknown id': () => x.timeline_removeClip(999999),
    'moveClip, unknown id': () => x.timeline_moveClip(999999, F.tA, 0),
    'moveClip onto a Pattern track': () => x.timeline_moveClip(F.c1, F.tP, 0),
    'moveClip to an unknown track': () => x.timeline_moveClip(F.c1, 999999, 0),
    'moveClip to a negative position': () => x.timeline_moveClip(F.c1, F.tA, -PPQ),
    'moveClip to where it already is': () => x.timeline_moveClip(F.c1, F.tA, clipOf(F.c1).positionTicks),
    'resizeClip, unknown id': () => x.timeline_resizeClip(999999, PPQ),
    'resizeClip to zero': () => x.timeline_resizeClip(F.c1, 0),
    'resizeClip to a negative length': () => x.timeline_resizeClip(F.c1, -PPQ),
    'resizeClip to its own length': () => x.timeline_resizeClip(F.c1, clipOf(F.c1).durationTicks),
    'resizeClipLeft with a negative region offset': () => x.timeline_resizeClipLeft(F.c1, 0, PPQ, -480),
    'resizeClipLeft to zero length': () => x.timeline_resizeClipLeft(F.c1, 0, 0, 0),
    'stretchClip to zero': () => x.timeline_stretchClip(F.c1, 0),
    'stretchClip, unknown id': () => x.timeline_stretchClip(999999, PPQ),
    'pitchShiftClip by nothing': () => x.timeline_pitchShiftClip(F.c1, 0, 0),
    'pitchShiftClip, unknown id': () => x.timeline_pitchShiftClip(999999, 1, 0),
    'reverseClip, unknown id': () => x.timeline_reverseClip(999999),
    'setClipParams to the same value': () => x.timeline_setClipParams(F.c1, { velocity: clipOf(F.c1).velocity }),
    'addClip on an unknown track': () => x.timeline_addClip({ trackId: 999999, regionId: F.region, positionTicks: 0, durationTicks: PPQ }),
    'addClip with an unknown region': () => x.timeline_addClip({ trackId: F.tA, regionId: 999999, positionTicks: 0, durationTicks: PPQ }),
    'addClip with zero length': () => x.timeline_addClip({ trackId: F.tA, regionId: F.region, positionTicks: 0, durationTicks: 0 }),
    'addClip at a negative position': () => x.timeline_addClip({ trackId: F.tA, regionId: F.region, positionTicks: -PPQ, durationTicks: PPQ }),
    'addClipsBatch with nothing valid': () => x.timeline_addClipsBatch([{ trackId: 999999, regionId: F.region, positionTicks: 0, durationTicks: PPQ }]),
    'pasteClipsBatch with nothing valid': () => x.timeline_pasteClipsBatch({ removeClipIds: [999999], clips: [{ trackId: 999999, regionId: F.region, positionTicks: 0, durationTicks: PPQ }] }),
    'moveClipsBatch of unknown ids': () => x.timeline_moveClipsBatch([{ clipId: 999999, trackId: F.tA, positionTicks: 0 }]),
    'moveClipsBatch that moves nothing': () => x.timeline_moveClipsBatch([{ clipId: F.c1, trackId: F.tA, positionTicks: clipOf(F.c1).positionTicks }]),
    'removeClipsBatch of unknown ids': () => x.timeline_removeClipsBatch([999999, 999998]),
    'split outside the clip': () => x.timeline_spliceClipsAtPlayhead([{ clipId: F.c1, splitTick: 50 * PPQ }]),
    'split on the clip edge': () => x.timeline_spliceClipsAtPlayhead([{ clipId: F.c1, splitTick: clipOf(F.c1).positionTicks }]),
    'removeTrack, unknown id': () => x.timeline_removeTrack(999999),
    'setTrackName to the same name': () => x.timeline_setTrackName(F.tB, 'Clip B'),
    'setTrackName, unknown id': () => x.timeline_setTrackName(999999, 'x'),
    'setTrackMuted to the same value': () => x.timeline_setTrackMuted(F.tB, false),
    'removeRegion, unknown id': () => x.timeline_removeRegion(999999),
    'removePattern, unknown id': () => x.timeline_removePattern(999999),
    'removeNote, unknown id': () => x.timeline_removeNote(F.pat, 999999),
    'moveNote, unknown id': () => x.timeline_moveNote(F.pat, 999999, 0, 60),
    'addNote to an unknown pattern': () => x.timeline_addNote(999999, { positionTicks: 0, durationTicks: 240, pitch: 60, velocity: 0.5 }),
    'removePatternBlock, unknown id': () => x.timeline_removePatternBlock(999999),
    'movePatternBlock, unknown id': () => x.timeline_movePatternBlock(999999, F.tP, 0),
    'addPatternBlock that duplicates one': () => x.timeline_addPatternBlock({ trackId: F.tP, patternId: F.pat, positionTicks: 0, durationTicks: 4 * PPQ, offsetTicks: 0 }),
    'resizePatternBlock to zero': () => x.timeline_resizePatternBlock(F.b1, 0),
    'setBPM to the current tempo': () => x.timeline_setBPM(x.timeline_getBPM()),
    'setBPM 0': () => x.timeline_setBPM(0),
    'setBPM negative': () => x.timeline_setBPM(-120),
    'setBPM not a finite number': () => x.timeline_setBPM(Infinity),
    'automation addClip that overlaps one': () => x.automation_addClip({ laneId: F.lane, envelopeId: F.env, positionTicks: 100, durationTicks: PPQ }),
    'automation moveClip into an overlap': () => x.automation_moveClip(F.ac2, F.lane, 100),
    'automation removeClip, unknown id': () => x.automation_removeClip(999999),
  };
  let clean = 0;
  for (const [name, run] of Object.entries(REFUSALS)) {
    fresh();
    // A real edit, undone: the redo history a ghost entry would destroy.
    x.timeline_setTrackName(F.tA, 'sentinel-undo');
    x.timeline_setTrackName(F.tB, 'sentinel-redo');
    x.undo_undo();
    const before = snap();
    const topBefore = x.undo_getUndoDescription();
    const redoBefore = x.undo_getRedoDescription();
    try { run(); } catch { /* a thrown rejection is a rejection */ }
    const after = snap();
    const stateOk = same(before, after);
    const undoOk = x.undo_getUndoDescription() === topBefore;
    const redoOk = x.undo_getRedoDescription() === redoBefore;
    check(stateOk, `${name}: state unchanged`, delta(before, after));
    check(undoOk, `${name}: no undo entry`, `top of the undo stack became "${x.undo_getUndoDescription()}"`);
    check(redoOk, `${name}: redo history kept`);
    if (stateOk && undoOk && redoOk) clean++;
  }
  console.log(`  ${clean}/${Object.keys(REFUSALS).length} refusals leave no trace`);
  fresh();
  let refused = false;
  try { x.timeline_setBPM(0.5); } catch { refused = true; }
  check(refused && x.timeline_getBPM() !== 0.5, 'a tempo below the engine floor is refused, loudly');
  const sound = x.timeline_getClips().every((c) => Number.isFinite(c.stretchRatio) && c.stretchRatio > 0);
  check(sound, 'no clip is left with a non-finite or non-positive stretch ratio');

  // A tempo change keeps every trim on the same instant of its source.
  {
    fresh();
    const sourceStartSec = (c, bpm) => (c.regionOffsetTicks / PPQ) * (60 / bpm);
    const before = clipOf(F.c2);
    const at140 = sourceStartSec(before, x.timeline_getBPM());
    x.timeline_setBPM(70);
    const after = clipOf(F.c2);
    check(Math.abs(sourceStartSec(after, 70) - at140) < 1e-9 && after.regionOffsetTicks === before.regionOffsetTicks / 2,
      'halving the tempo keeps a trimmed clip starting at the same instant of its source',
      `offset ${before.regionOffsetTicks} -> ${after.regionOffsetTicks} ticks`);
    check(after.positionTicks === before.positionTicks && after.durationTicks === before.durationTicks,
      'its position and length stay musical');
    x.undo_undo();
    check(same(before, clipOf(F.c2)), 'and undo restores the exact original trim');
  }

  // ── 4. groups ──────────────────────────────────────────────────────────────
  section('4. a gesture of many calls is one undo entry');
  {
    fresh();
    const N = 150;   // more than the engine keeps in its history
    const ids = x.timeline_addClipsBatch(Array.from({ length: N }, (_, i) => (
      { trackId: F.tA, regionId: F.region, positionTicks: (40 + i) * PPQ, durationTicks: PPQ })));
    const before = snap();
    const token = x.undo_beginGroup('Pitch shift');
    check(Number.isInteger(token) && token > 0, 'beginGroup returns a token');
    for (const id of ids) x.timeline_pitchShiftClip(id, 1, 0);
    check(x.undo_endGroup(token) === true, 'endGroup closes the group');
    check(x.undo_endGroup(token) === false, 'a second endGroup with the same token is refused');
    check(x.undo_getUndoDescription() === `Pitch shift (${N} edits)`, 'the gesture is one labelled entry', x.undo_getUndoDescription());
    const after = snap();
    x.undo_undo();
    check(same(before, snap()), `one undo reverses all ${N} calls`, delta(before, snap()));
    x.undo_redo();
    check(same(after, snap()), `one redo replays all ${N} calls`, delta(after, snap()));

    // An abandoned group cannot keep swallowing edits.
    const stale = x.undo_beginGroup('Abandoned');
    x.timeline_setTrackName(F.tA, 'in the abandoned group');
    x.undo_undo();
    check(x.timeline_getTracks().find((t) => t.id === F.tA).name === 'Clip A', 'undo commits an open group and undoes it');
    check(x.undo_endGroup(stale) === false, 'its late endGroup is refused');
    x.timeline_setTrackName(F.tB, 'after');
    check(x.undo_getUndoDescription().startsWith('Rename Track'), 'the next edit is its own entry');

    // Nothing recorded inside a group: nothing on the stack.
    const top = x.undo_getUndoDescription();
    const empty = x.undo_beginGroup('Empty');
    x.timeline_removeClip(999999);
    x.undo_endGroup(empty);
    check(x.undo_getUndoDescription() === top, 'a group in which nothing was recorded leaves no entry');
  }

  // ── 5. split ───────────────────────────────────────────────────────────────
  section('5. the pieces of a split play what the clip played');
  {
    // The source a clip reads at a timeline tick: ClipRenderCache's rule,
    // written out independently of the code under test.
    const sourceAt = (c, tick) => {
      const local = tick - c.positionTicks;
      if (local < 0 || local >= c.durationTicks) return null;
      const window = c.durationTicks / c.stretchRatio;
      const consumed = local / c.stretchRatio;
      return c.reversed ? c.regionOffsetTicks + window - consumed : c.regionOffsetTicks + consumed;
    };
    const fadeIn = (c) => c.fadeInPercent / 100 * c.durationTicks;
    const fadeOut = (c) => c.fadeOutPercent / 100 * c.durationTicks;
    for (const variant of [
      { name: 'plain', extra: {} },
      { name: 'stretched 1.5x', extra: { stretchRatio: 1.5 } },
      { name: 'reversed', extra: { reversed: true } },
      { name: 'reversed and stretched', extra: { reversed: true, stretchRatio: 0.5 } },
    ]) {
      fresh();
      const id = x.timeline_addClip({
        trackId: F.tA, regionId: F.region, positionTicks: 30 * PPQ, durationTicks: 4 * PPQ,
        regionOffsetTicks: 100, fadeInPercent: 10, fadeOutPercent: 20, pitchOffset: 2, velocity: 0.6, ...variant.extra,
      });
      const orig = clipOf(id);
      const cut = orig.positionTicks + PPQ;
      const reply = x.timeline_spliceClipsAtPlayhead([{ clipId: id, splitTick: cut }]);
      check(Array.isArray(reply?.pairs) && reply.pairs.length === 1 && reply.clips?.length === 2 && reply.removedIds?.[0] === id,
        `${variant.name}: the reply carries the pair, both new clips and the removed id`);
      const [l, r] = reply.pairs[0].map(clipOf);
      check(l.positionTicks === orig.positionTicks && l.durationTicks === PPQ && r.positionTicks === cut && r.durationTicks === 3 * PPQ,
        `${variant.name}: pieces span [start, cut) and [cut, end)`);
      let worst = 0;
      for (let t = orig.positionTicks; t < orig.positionTicks + orig.durationTicks; t += 97) {
        const piece = t < cut ? l : r;
        worst = Math.max(worst, Math.abs(sourceAt(piece, t) - sourceAt(orig, t)));
      }
      check(worst <= 1, `${variant.name}: every tick plays the source it played before (worst error ${worst.toFixed(2)} source ticks)`);
      check(Math.abs(fadeIn(l) - fadeIn(orig)) < 0.5 && l.fadeOutPercent === 0, `${variant.name}: fade-in stays on the left piece at its old length`);
      check(Math.abs(fadeOut(r) - fadeOut(orig)) < 0.5 && r.fadeInPercent === 0, `${variant.name}: fade-out stays on the right piece at its old length`);
      check(l.pitchOffset === 2 && r.pitchOffset === 2 && Math.abs(r.velocity - 0.6) < 1e-6 && r.stretchRatio === orig.stretchRatio,
        `${variant.name}: pitch, gain and stretch are carried to both pieces`);
      x.undo_undo();
      const back = clipOf(id);
      check(back && same(orig, back) && x.timeline_getClips().length === 5, `${variant.name}: one undo puts the clip back`);
    }
  }

  // ── 6. auto-trim, on real audio ────────────────────────────────────────────
  section('6. auto-trim removes the silence a clip actually plays, once');
  {
    // 0.25 s silence | 1.0 s tone | 0.5 s silence, 16-bit stereo, 48 kHz.
    const SR = 48000, LEAD = 0.25, TONE = 1.0, TAIL = 0.5;
    const frames = Math.round((LEAD + TONE + TAIL) * SR);
    const data = Buffer.alloc(frames * 4);
    for (let i = 0; i < frames; i++) {
      const t = i / SR;
      const v = t >= LEAD && t < LEAD + TONE ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 16000) : 0;
      data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
    }
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
    h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
    const wav = path.join(root, 'shape.wav');
    fs.writeFileSync(wav, Buffer.concat([h, data]));

    fresh();
    x.timeline_setBPM(120);                       // 960 ticks = 0.5 s
    const ticks = (sec) => sec * 2 * PPQ;
    const sourceId = x.project_importSource(wav);
    const region = x.timeline_addRegion({ name: 'Shape', label: 'Custom', sourceId, startTime: 0, endTime: LEAD + TONE + TAIL });
    const sampleId = x.audio_loadSourceRegion(wav, 0, LEAD + TONE + TAIL);
    if (!(sampleId >= 0)) {
      console.log('  SKIP  could not load the test tone into the sample bank');
    } else {
      x.audio_mapRegionToSample(region, sampleId);
      const full = ticks(LEAD + TONE + TAIL);
      const near = (a, b, tol = 4) => Math.abs(a - b) <= tol;

      const a = x.timeline_addClip({ trackId: F.tA, regionId: region, positionTicks: 40 * PPQ, durationTicks: full });
      const first = x.timeline_autoTrimClip(a, -54);
      check(first?.success && near(clipOf(a).regionOffsetTicks, ticks(LEAD)), 'the first trim stops where the tone starts', `offset ${clipOf(a).regionOffsetTicks}, tone starts at ${ticks(LEAD)}`);
      check(first?.clip?.id === a, 'the reply carries the trimmed clip');
      const once = clipOf(a);
      const second = x.timeline_autoTrimClip(a, -54);
      check(second?.success && second.trimmed === 0 && same(once, clipOf(a)), 'trimming it again changes nothing', `offset ${once.regionOffsetTicks} -> ${clipOf(a).regionOffsetTicks}`);

      const inside = ticks(LEAD + 0.4);
      const b = x.timeline_addClip({ trackId: F.tA, regionId: region, positionTicks: 50 * PPQ, durationTicks: ticks(0.5), regionOffsetTicks: inside });
      x.timeline_autoTrimClip(b, -54);
      check(clipOf(b).regionOffsetTicks === inside && clipOf(b).durationTicks === ticks(0.5), 'a clip that starts inside the tone is left alone');

      const c = x.timeline_addClip({ trackId: F.tA, regionId: region, positionTicks: 60 * PPQ, durationTicks: full * 2, stretchRatio: 2 });
      x.timeline_autoTrimClip(c, -54);
      check(near(clipOf(c).regionOffsetTicks, ticks(LEAD)) && near(clipOf(c).durationTicks, (full - ticks(LEAD)) * 2, 8),
        'a stretched clip advances by source ticks and shrinks by timeline ticks');

      const d = x.timeline_addClip({ trackId: F.tA, regionId: region, positionTicks: 80 * PPQ, durationTicks: full, reversed: true });
      x.timeline_autoTrimClip(d, -54);
      const rev = clipOf(d);
      check(rev.regionOffsetTicks === 0 && near(rev.regionOffsetTicks + rev.durationTicks, ticks(LEAD + TONE), 8),
        'a reversed clip loses the silence at the END of its window, which is what it plays first',
        `window now [${rev.regionOffsetTicks}, ${rev.regionOffsetTicks + rev.durationTicks}); the tone ends at ${ticks(LEAD + TONE)}`);
      x.undo_undo();
      check(clipOf(d).durationTicks === full, 'and one undo gives the length back');
    }
  }
} catch (err) {
  failed++;
  console.error('  FAIL  unexpected exception:', err && err.stack ? err.stack : err);
} finally {
  try { x.project_newBlank(); x.shutdown(); } catch { /* already down */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
