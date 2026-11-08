// What the visual effects ARE, for the Video view of the Devices tab: names,
// parameter tables and the picker. Every range, default, step and snap below is
// the one the Inspector's legacy panels used (ChainableEffectParams.jsx,
// NonChainableEffectParams.jsx, effectParamViews.jsx), which in turn mirror the
// engine's VisualEffect param layout and its defaults in Timeline.cpp
// (engine/src/model/TimelineTypes.h "VisualEffect"). Nothing here talks to the
// engine; videoFxWrites.js does.

import { formatValue, parseValue } from '../../../ui-kit'
import { fractionPercent, plainFormat, suffixFormat } from '../deviceFormat.js'

// Chain entry types, the engine's VisualEffect::Type values.
export const FX = Object.freeze({
  DESATURATION: 0,
  TINT: 1,
  BRIGHTNESS_CONTRAST: 2,
  TV_SIMULATOR: 3,
  ZOOM_PAN_ROT: 4,
  CHROMA_KEY: 5,
  OUTLINE: 6,
  DROP_SHADOW: 7,
  VISUAL_ECHO: 8,
})

/** Sentence-case names, the one map (the audio side's DEVICE_NAMES equivalent). */
export const CHAIN_NAMES = Object.freeze({
  [FX.DESATURATION]: 'Desaturation',
  [FX.TINT]: 'Tint',
  [FX.BRIGHTNESS_CONTRAST]: 'Brightness and contrast',
  [FX.TV_SIMULATOR]: 'TV simulator',
  [FX.ZOOM_PAN_ROT]: 'Zoom/pan/rot (chain)',
  [FX.CHROMA_KEY]: 'Chroma key',
  [FX.OUTLINE]: 'Outline',
  [FX.DROP_SHADOW]: 'Drop shadow',
  [FX.VISUAL_ECHO]: 'Visual echo',
})

export const chainName = (type) => CHAIN_NAMES[type] ?? `Effect ${type}`

/**
 * Outline, Drop shadow and Visual echo are composite-time stages in the engine
 * (isTerminalStageEffect, GridCompositor.cpp): they run after the whole chain
 * wherever they sit in it.
 */
export const isTerminalStage = (type) => (
  type === FX.OUTLINE || type === FX.DROP_SHADOW || type === FX.VISUAL_ECHO
)

const snapZero = (v) => (Math.abs(v) < 0.025 ? 0 : v)
const snapOne = (v) => (Math.abs(v - 1) < 0.025 ? 1 : v)
const quantizeTo = (step) => (v) => Math.round(v / step) * step

const pct = { ...fractionPercent }
const px = suffixFormat('px', 1)
// Degrees print without a space ("45°"), as phaseDegrees in deviceFormat.js does.
const deg = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 0 })}°`,
  parse: (t) => parseValue(String(t).replace(/°/g, ''), 'dB'),
}
const times = suffixFormat('×', 2)
const plain = (decimals) => ({ format: plainFormat(decimals), parse: (t) => parseValue(t, 'dB') })

/**
 * One knob row. `pi` is the params[] index, `snap` the commit-time snap the
 * legacy slider applied, `step` its quantisation.
 */
const p = (pi, label, min, max, def, step, fmt, extra = {}) => ({ pi, label, min, max, def, step, fmt, ...extra })

export const CHAIN_PARAMS = Object.freeze({
  [FX.DESATURATION]: [
    p(0, 'Amount', 0, 1, 1, 0.01, pct, { snap: snapZero, hint: 'How much colour is removed. 100 % is greyscale.' }),
  ],
  [FX.TINT]: [
    p(3, 'Strength', 0, 1, 0.5, 0.01, pct, { snap: snapZero, hint: 'How strongly the tint colour is laid over the picture' }),
    p(4, 'Floor', 0, 1, 0.15, 0.01, pct, { hint: 'Lightness below which the tint is not applied, so blacks stay black' }),
    p(5, 'Ceiling', 0, 1, 1, 0.01, pct, { hint: 'Lightness above which the tint is not applied' }),
  ],
  [FX.BRIGHTNESS_CONTRAST]: [
    p(0, 'Brightness', -1, 1, 0, 0.01, pct, { snap: snapZero, bipolar: true }),
    p(1, 'Contrast', -1, 1, 0, 0.01, pct, { snap: snapZero, bipolar: true }),
  ],
  [FX.TV_SIMULATOR]: [
    p(0, 'Intensity', 0, 1, 0.5, 0.01, pct),
    p(1, 'Roll speed', 0, 5, 1, 0.01, plain(2)),
    p(2, 'Scanlines', 0, 1, 0.3, 0.01, pct),
    p(3, 'Chroma', 0, 0.01, 0.003, 0.0001, plain(4), { hint: 'Red / blue channel offset' }),
    p(4, 'Noise', 0, 1, 0, 0.01, pct),
    p(5, 'Jitter', 0, 10, 2, 0.1, plain(1)),
    p(6, 'Colour bleed', 0, 0.02, 0, 0.0001, plain(4)),
  ],
  [FX.ZOOM_PAN_ROT]: [
    p(1, 'Zoom', 0.25, 4, 1, 0.01, times, { snap: snapOne, hint: 'Static zoom, used while the track’s own Zoom/pan/rot is not animating' }),
    p(4, 'Pan X', -1, 1, 0, 0.01, plain(2), { snap: snapZero, bipolar: true }),
    p(5, 'Pan Y', -1, 1, 0, 0.01, plain(2), { snap: snapZero, bipolar: true }),
    p(7, 'Rotation', -360, 360, 0, 1, deg, { snap: snapZero, bipolar: true }),
  ],
  [FX.CHROMA_KEY]: [
    p(3, 'Tolerance', 0, 0.6, 0.10, 0.005, plain(3), { snap: snapZero, hint: 'Core threshold. Colours closer to the key than this are fully removed.' }),
    p(4, 'Softness', 0, 0.8, 0.22, 0.005, plain(3), { snap: snapZero, hint: 'Edge threshold; keep it above Tolerance. The gap between them is the soft edge.' }),
    p(5, 'Spill', 0, 1, 0.5, 0.01, pct, { snap: snapZero, hint: 'Pulls key-coloured bounce light out of the pixels that survive' }),
    p(6, 'Choke', 0, 8, 0, 0.1, px, { snap: snapZero, hint: 'Shrinks the matte inward, in output pixels' }),
    p(7, 'Edge blur', 0, 8, 0, 0.1, px, { snap: snapZero, hint: 'Feathers the matte edge, in output pixels' }),
  ],
  [FX.OUTLINE]: [
    p(3, 'Thickness', 0, 24, 3, 0.5, px, { snap: snapZero, hint: 'Stroke width in cell pixels, drawn outside the video into the gap between cells' }),
    p(4, 'Softness', 0, 1, 0, 0.01, pct, { snap: snapZero, hint: '0 % is a hard edge; 100 % fades back to the subject and reads as a glow' }),
    p(5, 'Opacity', 0, 1, 1, 0.01, pct, { snap: snapZero, hint: 'At 0 % the effect is skipped' }),
    p(6, 'Alpha cutoff', 0.5, 0.99, 0.95, 0.01, pct, { snap: snapZero, hint: 'Pixels at or below this alpha count as background: this is what the stroke traces' }),
  ],
  [FX.DROP_SHADOW]: [
    p(3, 'Distance', 0, 64, 8, 0.5, px, { snap: snapZero, hint: 'Offset from the subject, in cell pixels' }),
    p(4, 'Angle', 0, 360, 45, 1, deg, { snap: snapZero, hint: '0° casts to the right and angles advance clockwise, so 45° is down-right' }),
    p(5, 'Size', 0, 1, 0, 0.01, pct, { snap: snapZero, hint: 'Inflates the shadow outward from the subject’s shape' }),
    p(6, 'Softness', 0, 1, 0.35, 0.01, pct, { snap: snapZero }),
    p(7, 'Opacity', 0, 1, 0.6, 0.01, pct, { snap: snapZero, hint: 'Scaled by the cell’s own opacity. At 0 % the effect is skipped.' }),
    p(9, 'Alpha cutoff', 0.5, 0.99, 0.95, 0.01, pct, { snap: snapZero, hint: 'Pixels at or below this alpha cast no shadow' }),
  ],
  [FX.VISUAL_ECHO]: [
    p(0, 'Taps', 1, 8, 4, 1, plain(0), { hint: 'Repeats drawn behind the live frame' }),
    p(1, 'Decay', 0, 1, 0.65, 0.01, pct, { snap: snapZero, hint: 'How much dimmer each repeat is. Ignored while Follow feedback is on.' }),
    p(3, 'Scale trail', 0, 1, 0.2, 0.01, pct, { snap: snapZero, hint: 'Shrinks each repeat toward the centre of the cell' }),
    p(5, 'Drift', 0, 1, 0, 0.01, pct, { snap: snapZero, hint: 'Walks alternate repeats to opposite edges. Needs the bound Delay in Ping-pong mode.' }),
  ],
})

export const knobQuantize = (row) => quantizeTo(row.step)

/** Commit-time value of a knob row: the legacy slider's snap, then its step. */
export function commitValue(row, v) {
  const q = Math.min(row.max, Math.max(row.min, quantizeTo(row.step)(v)))
  return row.snap ? row.snap(q) : q
}

// Colour triplets (params 0..2) and their defaults, per type.
export const COLOUR_DEFAULTS = Object.freeze({
  [FX.TINT]: [1, 0.85, 0.6],
  [FX.CHROMA_KEY]: [0, 0.694, 0.251],
  [FX.OUTLINE]: [1, 1, 1],
  [FX.DROP_SHADOW]: [0, 0, 0],
})

export const SHADOW_BLEND_OPTIONS = [
  { value: 0, label: 'Normal', hint: 'Paints the shadow colour over the backdrop' },
  { value: 1, label: 'Multiply', hint: 'Only ever darkens the backdrop' },
  { value: 2, label: 'Darken', hint: 'Keeps the darker of shadow and backdrop' },
  { value: 3, label: 'Linear burn', hint: 'Darkens strongly, losing detail in shadows' },
]

export const ECHO_FLIP_OPTIONS = [
  { value: 0, label: 'None' },
  { value: 1, label: 'Alternate horizontal' },
  { value: 2, label: 'Alternate vertical' },
  { value: 3, label: 'Alternate half-turn' },
  { value: 4, label: 'Cycle' },
]

export const ECHO_BLEND_OPTIONS = [
  { value: 0, label: 'Normal', hint: 'Each repeat is layered over the last' },
  { value: 1, label: 'Additive', hint: 'Repeats sum and bloom where they overlap' },
]

// ─── Per-note devices (non-chainable track configs) ──────────────────────────

/** The pinned group, in this fixed order: source time, frame, cell position, then the pattern-only ones. */
export const NOTE_DEVICES = Object.freeze([
  { id: 'pingPong', name: 'Ping-pong loop', field: 'pingPong' },
  { id: 'zoomPanRot', name: 'Zoom/pan/rot', field: 'zoomPanRot' },
  { id: 'bounce', name: 'Bounce', field: 'bounce' },
  { id: 'noteFade', name: 'Note fade', field: 'noteFade', patternOnly: true },
  { id: 'slideNote', name: 'Slide note effect', field: 'slideNoteEffect', patternOnly: true },
])

export const noteDeviceName = (id) => NOTE_DEVICES.find((d) => d.id === id)?.name ?? id

/** Whether a per-note config is in use on the track (shown in the chain without being added this session). */
export function noteDeviceActive(track, id) {
  if (!track) return false
  switch (id) {
    case 'pingPong': return !!track.pingPong?.enabled
    case 'zoomPanRot': return !!track.zoomPanRot?.enabled
    case 'bounce': return !!track.bounce?.enabled
    case 'noteFade': return !!track.noteFade?.enabled
    case 'slideNote': return (track.slideNoteEffect?.type ?? 0) !== 0
    default: return false
  }
}

/** The count the Inspector's "Video effects (N)" button prints. */
export function videoFxCount(track) {
  if (!track) return 0
  const pattern = track.type === 'Pattern'
  const notes = NOTE_DEVICES.filter((d) => (!d.patternOnly || pattern) && noteDeviceActive(track, d.id)).length
  return notes + (track.visualEffectChain?.length ?? 0)
}

/** Picker groups, the same grammar as the audio add menu (TrackContextMenu items). */
export const CHAIN_PICKER = Object.freeze([
  FX.DESATURATION, FX.TINT, FX.BRIGHTNESS_CONTRAST, FX.TV_SIMULATOR, FX.ZOOM_PAN_ROT,
  FX.CHROMA_KEY, FX.OUTLINE, FX.DROP_SHADOW, FX.VISUAL_ECHO,
])
