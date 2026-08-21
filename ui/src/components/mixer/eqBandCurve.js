// Per-band decorative response fills for the Parametric EQ display.
//
// The composite response curve drawn in EqCanvas comes from the engine
// (fetchResponseCurve) and is authoritative. These per-band translucent
// fills are a purely visual preview — RBJ Audio EQ Cookbook biquads,
// sampled client-side — so the display can shade each band's own
// contribution under the real composite line without a new RPC.
//
// Only shaping bands (Bell / Low Shelf / High Shelf) get a fill; cut/notch/
// tilt bands (Low Pass, High Pass, Notch, Tilt) are utility filters whose
// "area under the curve" isn't a meaningful preview, so they're skipped.

const FILLABLE_TYPES = new Set([0, 1, 2]) // Bell, Low Shelf, High Shelf

export function isFillableBandType(type) {
  return FILLABLE_TYPES.has(type)
}

function biquadCoeffs(type, freq, gainDb, q, fs) {
  const A = Math.pow(10, gainDb / 40)
  const w0 = (2 * Math.PI * Math.min(freq, fs * 0.45)) / fs
  const cosw = Math.cos(w0)
  const sinw = Math.sin(w0)
  const alpha = sinw / (2 * Math.max(q, 0.01))
  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0

  switch (type) {
    case 0: // Bell
      b0 = 1 + alpha * A; b1 = -2 * cosw; b2 = 1 - alpha * A
      a0 = 1 + alpha / A; a1 = -2 * cosw; a2 = 1 - alpha / A
      break
    case 1: { // Low Shelf
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) - (A - 1) * cosw + s)
      b1 = 2 * A * ((A - 1) - (A + 1) * cosw)
      b2 = A * ((A + 1) - (A - 1) * cosw - s)
      a0 = (A + 1) + (A - 1) * cosw + s
      a1 = -2 * ((A - 1) + (A + 1) * cosw)
      a2 = (A + 1) + (A - 1) * cosw - s
      break
    }
    case 2: { // High Shelf
      const s = 2 * Math.sqrt(A) * alpha
      b0 = A * ((A + 1) + (A - 1) * cosw + s)
      b1 = -2 * A * ((A - 1) + (A + 1) * cosw)
      b2 = A * ((A + 1) + (A - 1) * cosw - s)
      a0 = (A + 1) - (A - 1) * cosw + s
      a1 = 2 * ((A - 1) - (A + 1) * cosw)
      a2 = (A + 1) - (A - 1) * cosw - s
      break
    }
    default:
      break
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

function magDb(c, f, fs) {
  const w = (2 * Math.PI * f) / fs
  const c1 = Math.cos(w), c2 = Math.cos(2 * w)
  const num =
    c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2 +
    2 * (c.b0 * c.b1 + c.b1 * c.b2) * c1 +
    2 * c.b0 * c.b2 * c2
  const den =
    1 + c.a1 * c.a1 + c.a2 * c.a2 +
    2 * (c.a1 + c.a1 * c.a2) * c1 +
    2 * c.a2 * c2
  const v = num / Math.max(den, 1e-12)
  return 10 * Math.log10(Math.max(v, 1e-12))
}

// Samples a band's own response (dB) at the given frequencies.
export function sampleBandResponseDb(band, freqs, fs = 48000) {
  const c = biquadCoeffs(band.type, band.freq, band.gain, band.q, fs)
  return freqs.map(f => magDb(c, f, fs))
}
