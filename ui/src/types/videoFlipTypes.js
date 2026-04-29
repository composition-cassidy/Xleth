/**
 * @fileoverview Renderer-side type definitions for the VideoFlip v2 system.
 *
 * These JSDoc types mirror the C++ structs defined in
 * engine/src/model/TimelineTypes.h. The shapes are shared via JSON only —
 * C++ and JS layers each own their native definition. Do not import C++ types
 * from here; do not import this file from C++.
 *
 * JSON schema version: projectFileVersion = 2 (flip v2).
 * Spec reference: xleth-flip-v2-architecture-spec.md §3.1–3.3.
 */

/**
 * The six UV-transform orientations the shader supports.
 * Diagonal-mirror orientations (the other two D₄ elements) are deferred to v2.
 *
 * @typedef {'none' | 'horizontal' | 'vertical' | 'rotate-180' | 'rotate-90-cw' | 'rotate-90-ccw'} Orientation
 */

/**
 * One entry in a track's ordered flip-state cycle.
 *
 * @typedef {Object} VideoFlipState
 * @property {string}      id          - Stable client-side identifier (survives reorder).
 * @property {Orientation} orientation - UV transform this state applies.
 * @property {string}      [label]     - Optional user-facing name; omitted when empty.
 */

/**
 * Config object for the `every-note` modifier (no extra fields).
 * @typedef {{}} EveryNoteConfig
 */

/**
 * Config object for the `new-note` modifier (no extra fields).
 * @typedef {{}} NewNoteConfig
 */

/**
 * Config object for the `specific-pitches` modifier.
 * @typedef {Object} SpecificPitchesConfig
 * @property {number[]} pitches - MIDI note numbers (0–127) that trigger an advance.
 */

/**
 * Config object for the `every-n-beats` modifier.
 * @typedef {Object} EveryNBeatsConfig
 * @property {number}       n           - Beat/bar count between advances (1–32).
 * @property {'beat'|'bar'} subdivision - Whether `n` counts beats or bars.
 */

/**
 * Discriminated union: the rule that decides whether a trigger event advances
 * the state machine.
 *
 * @typedef {
 *   | { type: 'every-note';        config: EveryNoteConfig }
 *   | { type: 'new-note';          config: NewNoteConfig }
 *   | { type: 'specific-pitches';  config: SpecificPitchesConfig }
 *   | { type: 'every-n-beats';     config: EveryNBeatsConfig }
 * } VideoFlipModifier
 */

/**
 * Per-track video flip state-machine configuration. Persisted in the project
 * file under each track's `videoFlipConfig` key.
 *
 * @typedef {Object} VideoFlipConfig
 * @property {boolean}           enabled         - Master on/off; false = identity render, no resolver work.
 * @property {VideoFlipState[]}  states          - Ordered cycle of flip states (1–12 elements).
 * @property {VideoFlipModifier} modifier        - Advance rule for the state machine.
 * @property {number}            startStateIndex - Initial state index (0..states.length-1).
 */

/**
 * Returns the default VideoFlipConfig for a new track.
 *
 * @returns {VideoFlipConfig}
 */
export function defaultVideoFlipConfig() {
  return {
    enabled: false,
    states: [{ id: 's0', orientation: 'none' }],
    modifier: { type: 'every-note', config: {} },
    startStateIndex: 0,
  };
}

/**
 * All valid `Orientation` values, in shader-integer order (matches C++ enum).
 * Index is the integer the GPU constant buffer expects.
 *
 * @type {Orientation[]}
 */
export const ORIENTATIONS = [
  'none',          // 0 — identity
  'horizontal',    // 1 — mirror left-right
  'vertical',      // 2 — mirror up-down
  'rotate-180',    // 3 — half turn
  'rotate-90-cw',  // 4 — quarter turn CW
  'rotate-90-ccw', // 5 — quarter turn CCW
];

/**
 * Human-readable label for each orientation, suitable for UI dropdowns.
 *
 * @type {Record<Orientation, string>}
 */
export const ORIENTATION_LABELS = {
  'none':          'None (identity)',
  'horizontal':    'Horizontal flip',
  'vertical':      'Vertical flip',
  'rotate-180':    'Rotate 180°',
  'rotate-90-cw':  'Rotate 90° CW',
  'rotate-90-ccw': 'Rotate 90° CCW',
};

/**
 * All valid `VideoFlipModifier` type strings.
 * @type {Array<VideoFlipModifier['type']>}
 */
export const MODIFIER_TYPES = [
  'every-note',
  'new-note',
  'specific-pitches',
  'every-n-beats',
];

/**
 * Human-readable label for each modifier type.
 * @type {Record<VideoFlipModifier['type'], string>}
 */
export const MODIFIER_TYPE_LABELS = {
  'every-note':       'Every note',
  'new-note':         'New pitch',
  'specific-pitches': 'Specific pitches',
  'every-n-beats':    'Every N beats',
};

/**
 * Maximum number of states allowed per track (enforced by the C++ resolver).
 * @type {number}
 */
export const MAX_FLIP_STATES = 12;

/**
 * One mono trigger event, in the same shape the C++ resolver consumes.
 * @typedef {Object} TriggerEvent
 * @property {number} tick   - Absolute tick (960 PPQ).
 * @property {number} pitch  - MIDI note (or pitch identifier on clip tracks).
 */

/**
 * JS port of the C++ `resolveStateIndex` (engine/src/model/VideoFlipResolver.cpp).
 * Used by the renderer's Live Preview strip to compute the resolved state cycle
 * **without** an IPC round-trip per render. Behaviour MUST match the C++ resolver
 * byte-for-byte — keep in lockstep when the resolver evolves. The C++ side is
 * the source of truth for actual frame rendering; this is purely for UI preview.
 *
 * @param {VideoFlipConfig} config
 * @param {TriggerEvent[]}  monoEvents     - chord-filtered, ascending-tick mono events
 * @param {number}          ticksPerBeat
 * @param {number}          [beatsPerBar=4]
 * @returns {number[]}                       one stateIndex per input event
 */
export function resolveStateIndex(config, monoEvents, ticksPerBeat, beatsPerBar = 4) {
  const n = monoEvents.length;
  // Short-circuit: disabled or single-state config — every event resolves to 0.
  if (!config?.enabled || !config.states || config.states.length <= 1) {
    return new Array(n).fill(0);
  }

  const numStates = config.states.length;
  let startIdx = config.startStateIndex | 0;
  if (startIdx < 0)            startIdx = 0;
  if (startIdx >= numStates)   startIdx = numStates - 1;

  // every-n-beats — clock-driven, no event walk.
  if (config.modifier.type === 'every-n-beats') {
    const c = config.modifier.config || {};
    const nBeats = Math.max(1, c.n | 0);
    const unitTicks = (c.subdivision === 'bar')
      ? ticksPerBeat * Math.max(1, beatsPerBar | 0)
      : ticksPerBeat;
    const period = unitTicks * nBeats;
    return monoEvents.map(ev => {
      const k = Math.floor(ev.tick / period);
      const raw = k + startIdx;
      // JS modulo can be negative on negative dividends — normalise.
      return ((raw % numStates) + numStates) % numStates;
    });
  }

  // Walked modifiers: every-note, new-note, specific-pitches.
  const out = new Array(n);
  let stateIdx       = startIdx;
  let hasPrevious    = false;
  let previousPitch  = 0;

  const whitelist = new Set(
    (config.modifier.config && Array.isArray(config.modifier.config.pitches))
      ? config.modifier.config.pitches
      : []
  );

  for (let i = 0; i < n; ++i) {
    const ev = monoEvents[i];
    let advance = false;
    switch (config.modifier.type) {
      case 'every-note':
        advance = hasPrevious;
        break;
      case 'new-note':
        advance = hasPrevious && (ev.pitch !== previousPitch);
        break;
      case 'specific-pitches':
        // Whitelisted pitch ALWAYS advances, even on the first trigger
        // (whitelist semantics override the first-trigger rule — spec §3.3.3).
        advance = whitelist.has(ev.pitch);
        break;
      default:
        advance = false;
    }
    if (advance) stateIdx = (stateIdx + 1) % numStates;
    out[i] = stateIdx;
    hasPrevious = true;
    previousPitch = ev.pitch;
  }
  return out;
}

