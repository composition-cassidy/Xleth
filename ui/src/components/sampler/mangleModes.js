// ── MANGLE ────────────────────────────────────────────────────────────────
// Per-note, per-slot warp FX. Ids MUST match xleth::mangle::Mode in
// engine/src/audio/MangleDsp.h — they are persisted in the project file, so
// the enum is append-only and this list mirrors it 1:1.
//
// Mode 0 (Off) is the bypass and lives outside the groups so it is always the
// first option, whatever the group order.
export const MANGLE_OFF = 0
// Chain cap — MUST match xleth::mangle::kMaxInstances in engine/src/audio/MangleDsp.h.
export const MANGLE_MAX = 4
export const MANGLE_GROUPS = [
  {
    label: 'Alt',
    modes: [
      { v: 1,  l: 'Sync' },
      { v: 2,  l: 'Bend +' },
      { v: 3,  l: 'Bend −' },
      { v: 4,  l: 'Bend +/−' },
      { v: 5,  l: 'PWM' },
      { v: 6,  l: 'Asym +' },
      { v: 7,  l: 'Asym −' },
      { v: 8,  l: 'Asym +/−' },
      { v: 9,  l: 'Flip' },
      { v: 10, l: 'Mirror' },
      { v: 11, l: 'Quantize' },
      { v: 12, l: 'Even' },
      { v: 13, l: 'Odd' },
    ],
  },
  {
    label: 'Filter',
    modes: [
      { v: 14, l: 'LPF' },
      { v: 15, l: 'HPF' },
      { v: 16, l: 'BPF' },
      { v: 17, l: 'Notch' },
    ],
  },
  {
    label: 'Distortion',
    modes: [
      { v: 18, l: 'Tube' },
      { v: 19, l: 'Soft Clip' },
      { v: 20, l: 'Hard Clip' },
      { v: 21, l: 'Diode 1' },
      { v: 22, l: 'Diode 2' },
      { v: 23, l: 'Linear Fold' },
      { v: 24, l: 'Sine Fold' },
      { v: 25, l: 'Zero-Square' },
      { v: 26, l: 'Asym' },
      { v: 27, l: 'Rectify' },
      { v: 28, l: 'Sine Shaper' },
      { v: 29, l: 'Stomp Box' },
      { v: 30, l: 'Tape Sat.' },
      { v: 31, l: 'Soft Sat.' },
    ],
  },
  {
    label: 'Modulation',
    modes: [
      { v: 32, l: 'FM' },
      { v: 33, l: 'PD' },
      { v: 34, l: 'AM' },
      { v: 35, l: 'RM' },
    ],
  },
]

// One-line hints, keyed by mode id. The ALT and MODULATION groups in
// particular are not self-describing from their names alone.
export const MANGLE_HINTS = {
  1: 'Oscillator hard sync — the read head snaps back once per note cycle',
  2: 'Read phase bent toward the start of the sample',
  3: 'Read phase bent toward the end of the sample',
  4: 'Read phase bent outward from the midpoint',
  5: 'Read head advances then stalls each cycle — hollow, square-like',
  6: 'Each note period skewed fast-then-slow',
  7: 'Each note period skewed slow-then-fast',
  8: 'Skew direction alternates every cycle',
  9: 'Read direction reverses partway through each cycle',
  10: 'Read head ping-pongs inside a local window',
  11: 'Bit-depth reduction, 16 bits down to 1',
  12: 'Comb against a half-period-delayed copy — even harmonics',
  13: 'Comb against an inverted half-period copy — odd harmonics',
  14: 'Low pass, cutoff key-tracked and swept by Amount',
  15: 'High pass, cutoff key-tracked and swept by Amount',
  16: 'Band pass, centre key-tracked and swept by Amount',
  17: 'Notch, centre key-tracked and swept by Amount',
  27: 'Amount blends half-wave to full-wave rectification',
  32: 'Sine at the note frequency modulates read speed — vibrato to growl',
  33: 'Casio-style per-cycle phase kink',
  34: 'Unipolar tremolo at audio rate',
  35: 'Bipolar ring modulation at the note frequency',
}

// Modes that bend the READ HEAD rather than shape the sample — mirrors
// xleth::mangle::isPositionMode. The engine resolves every warp in a chain
// before any shaper (a bent head re-reads the source buffer, so it cannot take
// a shaped sample as its input), which the chain hint below has to reflect
// rather than promise a left-to-right flow the audio does not follow.
export const MANGLE_WARP_MODES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 32, 33])

export const mangleModeLabel = (v) => {
  if (!v) return 'Off'
  for (const g of MANGLE_GROUPS) {
    const hit = g.modes.find((m) => m.v === v)
    if (hit) return hit.l
  }
  return 'Off'
}

// The FILTER group sweeps cutoff AROUND a key-tracked base, so its Amount
// midpoint (not its minimum) is the neutral setting. Every other group treats
// Amount 0 as "off", which is worth telling the user rather than making them
// discover it by ear.
export const mangleAmountIsBipolar = (v) => v >= 14 && v <= 17

// An instance runs only when it has a real mode, is not bypassed, and mixes in:
// the same gate MangleDsp.h makeRuntime applies.
export const mangleInstanceActive = (mi) =>
  (mi?.mode ?? 0) !== MANGLE_OFF && !mi?.bypass && (mi?.mix ?? 1) > 0

export const OFF_INSTANCE = Object.freeze({ mode: MANGLE_OFF, amount: 0, mix: 1, bypass: false })

/** The chain as edited, always at least one row: an empty chain shows one virtual Off instance. */
export const displayChain = (chain) =>
  (Array.isArray(chain) && chain.length ? chain : [{ ...OFF_INSTANCE }])

/** One line saying what the chain does, in the order the AUDIO travels. */
export function mangleChainHint(chain) {
  const live = displayChain(chain).filter(mangleInstanceActive)
  if (live.length === 0) return 'Bypassed: the slot plays untouched'
  if (live.length === 1) {
    return MANGLE_HINTS[live[0].mode] || `${mangleModeLabel(live[0].mode)}: Amount drives, Mix blends`
  }
  // Warps resolve first (they re-read the source, so they cannot be fed a shaped
  // sample), then the shapers. Order stays audible inside each group.
  const warps = live.filter((mi) => MANGLE_WARP_MODES.has(mi.mode))
  const shapers = live.filter((mi) => !MANGLE_WARP_MODES.has(mi.mode))
  const flow = [...warps, ...shapers].map((mi) => mangleModeLabel(mi.mode)).join(' → ')
  return warps.length > 0 && shapers.length > 0
    ? `${flow}: per-note chain, warps resolve before shapers`
    : `${flow}: per-note chain, order is audible`
}
