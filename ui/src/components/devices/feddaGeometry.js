// Pure maths behind the Fedda display (FeddaFieldCanvas.jsx). No DOM.

// XlethFeddaEffect meter slots (engine/src/audio/XlethFeddaEffect.h).
export const FEDDA_METER = Object.freeze({
  correlation: 0,       // measured L/R correlation of the processed output
  midDb: 1,             // output mid RMS, dB
  sideDb: 2,            // output side RMS, dB
  msCorrelation: 3,     // normalised mid/side correlation (tilt of the field)
  guardDepth: 4,        // Transient Guard duck depth 0..1
  targetCorrelation: 5, // target correlation for the current width
  dryMatchDb: 6,        // dry compare level-match gain, dB
  monitors: 7,          // 1 = mono check engaged, 2 = dry compare engaged (sum)
})

// The engine's width curve is g = width / 100 (stereoize::kWidthCurve); with a decorrelated side at
// equal power the output L/R correlation is (1 - g^2) / (1 + g^2). The engine publishes the same
// number (slot 5); this is only for before the first meter read.
export function targetCorrelationForWidth(widthPct) {
  const g = Math.max(0, Math.min(2, Number(widthPct) / 100 || 0))
  return (1 - g * g) / (1 + g * g)
}

// The upright ellipse a decorrelated side of the target correlation fills, normalised so its
// larger radius is R. Side/mid amplitude ratio = sqrt((1 - rho) / (1 + rho)).
export function targetEllipse(rho, R) {
  const r = Math.max(-0.999, Math.min(1, Number.isFinite(rho) ? rho : 1))
  const ratio = Math.sqrt((1 - r) / (1 + r))
  return ratio <= 1 ? { rx: R * ratio, ry: R } : { rx: R, ry: R / ratio }
}

// The covariance ellipse of the output in goniometer axes (x = R - L side, so L sits up-left; y = mid
// up), from the measured mid / side RMS (dB) and their correlation. Normalised so the larger radius
// is R: the display shows the shape, the S/M readout the level. `rotation` is for canvas ellipse()
// (clockwise, y down).
export function fieldEllipse(midDb, sideDb, msCorrelation, R) {
  const sm = 10 ** (midDb / 20)
  const ss = 10 ** (sideDb / 20)
  const r = Math.max(-1, Math.min(1, Number.isFinite(msCorrelation) ? msCorrelation : 0))
  const a = ss * ss            // var(x), x = -S
  const dd = sm * sm           // var(y)
  const c = -r * ss * sm       // cov(x, y)
  const mean = (a + dd) / 2
  const half = Math.sqrt(((a - dd) / 2) ** 2 + c * c)
  const l1 = Math.max(0, mean + half)
  const l2 = Math.max(0, mean - half)
  const theta = 0.5 * Math.atan2(2 * c, a - dd)   // major axis, counter-clockwise from +x
  const r1 = Math.sqrt(l1)
  const r2 = Math.sqrt(l2)
  const k = r1 > 0 ? R / r1 : 0
  return { rx: r1 * k, ry: r2 * k, rotation: -theta }
}
