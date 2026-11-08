import { THIN_SPACE, formatValue, skewScale } from '../../ui-kit'

// The four character compressors on CompressorCore (Glue, Opto, FET, Vari-Mu):
// one device body, one config per model. Ranges, defaults and index orders mirror
// each effect's createLayout() in engine/src/audio/Xleth*CompressorEffect.h
// exactly. The device only draws and writes them.
//
// Item kinds:
//   knob    continuous. `unit` is a kit format unit; `format` replaces it.
//   seg     stepped, index- or position-valued, a kit SegmentedControl.
//   toggle  0 / 1.
// `hero: true` marks the model's character switch (it gets the large segmented
// size and the widest section).

// ── Time helpers ─────────────────────────────────────────────────────────────

/**
 * A duration for a caption: µs below 0.1 ms, ms below 1 s, else s. format.ts has
 * no µs or s unit (DESIGN.md section 6 lists dB, Hz, ms, %, ratio), so these two
 * are formed here; the number rules are the same (thin space, true minus).
 */
export function formatDuration(ms) {
  if (!(ms > 0)) return formatValue(0, 'ms')
  if (ms < 0.1) return `${Math.round(ms * 1000)}${THIN_SPACE}µs`
  if (ms < 1000) return formatValue(ms, 'ms')
  return `${Number((ms / 1000).toFixed(2))}${THIN_SPACE}s`
}

// FET: knob 1 = slowest, 7 = fastest, geometric (Fet1176; the hardware's numbering).
const knobSeconds = (k, slowS, fastS) => slowS * Math.pow(fastS / slowS, (Math.min(7, Math.max(1, k)) - 1) / 6)
export const fetAttackSeconds = (k) => knobSeconds(k, 800e-6, 20e-6)
export const fetReleaseSeconds = (k) => knobSeconds(k, 1.1, 0.05)

// Vari-Mu: Fairchild670::kPositions, the ORIGINAL manual's figures (the engine
// divides them by 3 for its RC constants). Positions 5 and 6 are automatic.
export const VARIMU_POSITIONS = [
  { pos: 1, attackMs: 0.2, releaseMs: [300] },
  { pos: 2, attackMs: 0.2, releaseMs: [800] },
  { pos: 3, attackMs: 0.4, releaseMs: [2000] },
  { pos: 4, attackMs: 0.4, releaseMs: [5000] },
  { pos: 5, attackMs: 0.4, releaseMs: [2000, 10000], auto: true },
  { pos: 6, attackMs: 0.2, releaseMs: [300, 10000, 25000], auto: true },
]

export function varimuReadout(pos) {
  const p = VARIMU_POSITIONS.find((x) => x.pos === pos) ?? VARIMU_POSITIONS[1]
  const release = p.releaseMs.map(formatDuration).join(' · ')
  return {
    attack: formatDuration(p.attackMs),
    release: p.auto ? `Auto ${release}` : release,
  }
}

// ── Builders ─────────────────────────────────────────────────────────────────

const knob = (id, label, unit, min, max, def, extra = {}) => ({ type: 'knob', id, label, unit, min, max, def, ...extra })
const seg = (id, label, options, def, extra = {}) => ({ type: 'seg', id, label, options, def, ...extra })
const toggle = (id, label, def, extra = {}) => ({ type: 'toggle', id, label, def, ...extra })

const ratioLabel = (r) => formatValue(r, 'ratio', { decimals: 0, unitless: true })
const ratioOption = (value, r) => ({ value, label: ratioLabel(r), ariaLabel: formatValue(r, 'ratio', { decimals: 0 }), hint: `${formatValue(r, 'ratio', { decimals: 0 })} ratio` })
const msLabel = (ms) => formatValue(ms, 'ms', { unitless: true, decimals: ms < 1 ? 1 : 0 })

const SIGNED = { signed: true }

// ── Models ───────────────────────────────────────────────────────────────────

export const MODELS = {
  glue: {
    id: 'glue',
    grTitle: 'GR',
    sections: [
      {
        title: 'Input', width: 76,
        items: [knob('threshold', 'Threshold', 'dB', -40, 0, -10, { size: 44, width: 68, hint: 'Threshold. Everything above it is compressed.' })],
      },
      {
        title: 'Character', width: 188,
        items: [
          seg('ratio', 'Ratio', [ratioOption(0, 2), ratioOption(1, 4), ratioOption(2, 10)], 1, { hero: true, hint: 'Compression ratio, to 1' }),
          seg('topology', 'Topology', [
            { value: 0, label: 'Classic', hint: 'Classic feedback VCA' },
            { value: 1, label: 'FF', hint: 'Feed-forward detection' },
          ], 0),
          toggle('color', 'Color', 1, { hint: 'Subtle console-style output saturation' }),
        ],
      },
      {
        title: 'Time', width: 232,
        items: [
          seg('attack', 'Attack', [0.1, 0.3, 1, 3, 10, 30].map((ms, i) => ({ value: i, label: msLabel(ms), hint: `${formatValue(ms, 'ms')} attack` })), 4, { unit: 'ms' }),
          seg('release', 'Release', [
            { value: 0, label: '0.1', hint: '0.1 s release' },
            { value: 1, label: '0.3', hint: '0.3 s release' },
            { value: 2, label: '0.6', hint: '0.6 s release' },
            { value: 3, label: '1.2', hint: '1.2 s release' },
            { value: 4, label: 'Auto', hint: 'Program-dependent release' },
          ], 4, { unit: 's' }),
        ],
      },
      {
        title: 'Sidechain', width: 92,
        items: [
          toggle('sc_hpf_on', 'High-pass', 0, { hint: 'High-pass the detector so low frequencies do not drive the compression' }),
          knob('sc_hpf_freq', 'Freq', 'Hz', 20, 500, 100, {
            skew: 0.4, scale: skewScale(20, 500, 0.4), size: 36, width: 68, enabledBy: 'sc_hpf_on', hint: 'Detector high-pass frequency',
          }),
        ],
      },
      {
        title: 'Output', width: 76,
        items: [knob('makeup', 'Makeup', 'dB', -10, 20, 0, { size: 44, width: 68, formatOptions: SIGNED, hint: 'Makeup gain after compression' })],
      },
    ],
  },

  opto: {
    id: 'opto',
    grTitle: 'GR',
    sections: [
      {
        title: 'Input', width: 92,
        items: [knob('peak_reduction', 'Peak reduction', 'dB', 0, 40, 20, { size: 44, width: 84, hint: 'How hard the signal is pushed into the leveling cell' })],
      },
      {
        title: 'Character', width: 156,
        items: [
          seg('mode', 'Mode', [
            { value: 0, label: 'Compress', hint: 'Gentle compression' },
            { value: 1, label: 'Limit', hint: 'Limiting' },
          ], 0, { hero: true, hint: 'Compress or limit' }),
        ],
      },
      {
        title: 'Output', width: 76,
        items: [knob('gain', 'Gain', 'dB', 0, 40, 0, { size: 44, width: 68, hint: 'Make-up gain after the cell' })],
      },
    ],
  },

  fet: {
    id: 'fet',
    grTitle: 'GR',
    sections: [
      {
        title: 'Input', width: 76,
        items: [knob('input', 'Input', 'dB', -24, 36, 0, { size: 44, width: 68, formatOptions: SIGNED, hint: 'Input drive into the compression curve. There is no threshold.' })],
      },
      {
        title: 'Character', width: 204,
        items: [
          seg('ratio', 'Ratio', [
            ratioOption(0, 4), ratioOption(1, 8), ratioOption(2, 12), ratioOption(3, 20),
            { value: 4, label: 'All', ariaLabel: 'All buttons in', hint: 'All ratio buttons in: its own character, not a blend' },
          ], 0, { hero: true, hint: 'Ratio, to 1' }),
        ],
      },
      {
        title: 'Time', width: 148,
        items: [
          knob('attack', 'Attack', null, 1, 7, 3, {
            size: 36, width: 68, format: (v) => v.toFixed(1), caption: (v) => formatDuration(fetAttackSeconds(v) * 1000),
            hint: 'Attack, 1 slow to 7 fast, as on the unit',
          }),
          knob('release', 'Release', null, 1, 7, 5, {
            size: 36, width: 68, format: (v) => v.toFixed(1), caption: (v) => formatDuration(fetReleaseSeconds(v) * 1000),
            hint: 'Release, 1 slow to 7 fast, as on the unit',
          }),
        ],
      },
      {
        title: 'Output', width: 76,
        items: [knob('output', 'Output', 'dB', -24, 24, 0, { size: 44, width: 68, formatOptions: SIGNED, hint: 'Output level' })],
      },
    ],
  },

  varimu: {
    id: 'varimu',
    grTitle: 'GR',
    sections: [
      {
        title: 'Input', width: 76,
        items: [knob('input', 'Input', 'dB', -24, 36, 0, { size: 44, width: 68, formatOptions: SIGNED, hint: 'Input drive into the tube curve. There is no threshold.' })],
      },
      {
        title: 'Character', width: 156,
        items: [
          seg('mode', 'Mode', [
            { value: 0, label: 'Linked', hint: 'Stereo-linked: one control voltage for L and R' },
            { value: 1, label: 'Mid-side', hint: 'Independent limiters on mid and side' },
          ], 0),
        ],
      },
      {
        title: 'Time', width: 240,
        items: [
          seg('time_constant', 'Time constant', VARIMU_POSITIONS.map((p) => ({
            value: p.pos,
            label: String(p.pos),
            hint: `Position ${p.pos}: attack ${varimuReadout(p.pos).attack}, release ${varimuReadout(p.pos).release}`,
          })), 2, { hero: true, readout: 'varimu' }),
        ],
      },
      {
        title: 'Output', width: 76,
        items: [knob('output', 'Output', 'dB', -24, 24, 0, { size: 44, width: 68, formatOptions: SIGNED, hint: 'Output level' })],
      },
    ],
  },
}

for (const model of Object.values(MODELS)) {
  model.defaults = Object.freeze(Object.fromEntries(
    model.sections.flatMap((s) => s.items.map((i) => [i.id, i.def])),
  ))
}
