// Distortion transfer-curve math and canvas painter.
// Ported verbatim from engine/src/audio/XlethDistortionEffect.h::processEffect
// (the per-sample switch) and its getModeDriveTrim/getModeOutputTrim tables, so
// the picture matches the sound exactly. Pure math only — no engine feed; the
// curve is recomputed from the current knob values on every draw.
//
// Fuzz is the one mode that isn't truly memoryless (the post-clip one-pole
// lowpass carries state between samples). At DC — a held input — that filter
// settles to its input, so the steady-state curve is just the clipper it's
// smoothing. That's what's drawn here; the flat-top brick wall is otherwise
// identical to Hard Clip's shape but at a different range/trim.
//
// downsample has no effect on this curve: it's a sample-and-hold in time, not
// a memoryless amplitude nonlinearity, so a static y = f(x) plot can't show it.

const HALF_PI = Math.PI / 2

// getModeDriveTrim / getModeOutputTrim, indexed by mode 0-6.
export const MODE_DRIVE_TRIM  = Object.freeze([0.58, 0.72, 1.35, 1.00, 0.90, 1.25, 0.85])
export const MODE_OUTPUT_TRIM = Object.freeze([1.10, 1.08, 0.88, 1.04, 0.90, 0.82, 0.86])

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

export function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

// Reads the five distortion params off the plugin-ui params object, applying
// the same clamps the engine's NormalisableRange enforces.
export function normalizeDistortionParams(params, bindings = {}) {
  const modeParam      = bindings.modeParam || 'mode'
  const driveParam     = bindings.driveParam || 'drive'
  const symmetryParam  = bindings.symmetryParam || 'symmetry'
  const bitsParam      = bindings.bitsParam || 'bits'
  return {
    mode:        clamp(Math.round(finiteOr(params?.[modeParam], 0)), 0, 6),
    driveDb:     clamp(finiteOr(params?.[driveParam], 12), 0, 48),
    symmetryPct: clamp(finiteOr(params?.[symmetryParam], 100), 0, 100),
    bitsValue:   clamp(finiteOr(params?.[bitsParam], 16), 2, 16),
  }
}

// Block-rate coefficients — mirrors processEffect step 2b exactly.
export function computeDistortionCoeffs({ driveDb, symmetryPct, bitsValue }) {
  const symNorm      = clamp(symmetryPct * 0.01, 0, 1)
  const analogBias   = 0.78 * symNorm
  const analogCenter = Math.tanh(analogBias)

  const crushSteps    = Math.pow(2, clamp(bitsValue, 2, 16) - 1)
  const crushStepsInv = 1 / crushSteps

  const sineK = HALF_PI + (2.30 - HALF_PI) * clamp(driveDb / 48, 0, 1)

  return { analogBias, analogCenter, crushSteps, crushStepsInv, sineK }
}

// The per-sample shaper switch, given the already drive-trimmed input x.
export function shapeSample(mode, x, coeffs) {
  switch (mode) {
    case 0: // Tube
      return Math.tanh(0.82 * x)

    case 1: { // Soft Clip
      const out = Math.abs(x) < 1.0 ? (x - (x * x * x) / 3.0) : Math.sign(x) * (2.0 / 3.0)
      return out * 1.5
    }

    case 2: // Hard Clip
      return clamp(x, -0.72, 0.72) / 0.72

    case 3: { // Analog
      const y = Math.tanh(0.92 * x + coeffs.analogBias) - coeffs.analogCenter
      const norm = y >= 0 ? (1.0 - coeffs.analogCenter) : (1.0 + coeffs.analogCenter)
      return y / norm
    }

    case 4: { // Crush — steady-state hold value equals the clamped input.
      const held = clamp(x, -1, 1)
      return Math.round(held * coeffs.crushSteps) * coeffs.crushStepsInv
    }

    case 5: // Fuzz — steady-state: the lowpass settles to its input at DC.
      return clamp(x, -1, 1)

    case 6: // Sine
      return Math.sin(coeffs.sineK * clamp(x, -1, 1))

    default:
      return x
  }
}

// out = f(xin) for a single input sample, xin in [-1, 1]. Mirrors
// processEffect step 6 (drive trim in, output trim + clamp out).
export function distortionCurveY(xin, mode, driveLin, coeffs) {
  const driveTrim  = MODE_DRIVE_TRIM[mode] ?? 1.0
  const outputTrim = MODE_OUTPUT_TRIM[mode] ?? 1.0
  const x = xin * driveLin * driveTrim
  const out = shapeSample(mode, x, coeffs)
  return clamp(out * outputTrim, -1, 1)
}

// Samples the curve across the full domain. widthPx drives sample density —
// dense enough that Crush's staircase and Hard Clip's brick-wall corner read
// as sharp steps rather than smoothed-over curves (no spline fitting here).
export function buildDistortionCurvePoints(distortionParams, widthPx, stepPx = 2) {
  const { mode, driveDb } = distortionParams
  const coeffs = computeDistortionCoeffs(distortionParams)
  const driveLin = Math.pow(10, driveDb / 20)

  const steps = Math.max(2, Math.ceil(Math.max(1, widthPx) / stepPx))
  const points = new Array(steps + 1)
  for (let i = 0; i <= steps; i++) {
    const xin = -1 + (2 * i) / steps
    points[i] = { xin, y: distortionCurveY(xin, mode, driveLin, coeffs) }
  }
  return points
}

// ── Canvas geometry ──────────────────────────────────────────────────────────

export function ampToX(amp, plot) {
  const t = (clamp(amp, -1, 1) + 1) / 2
  return plot.x + t * plot.w
}

export function ampToY(amp, plot) {
  const t = (clamp(amp, -1, 1) + 1) / 2
  return plot.y + (1 - t) * plot.h
}

function rgba(color, alpha) {
  if (!color) return `rgba(255, 255, 255, ${alpha})`
  const rgbaMatch = color.match(/^rgba\(([^)]+)\)$/i)
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((part) => part.trim())
    return parts.length >= 3 ? `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})` : color
  }
  if (color.startsWith('rgb(')) return color.replace('rgb(', 'rgba(').replace(')', `, ${alpha})`)
  const shortHex = color.trim().match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (shortHex) {
    const r = parseInt(shortHex[1] + shortHex[1], 16)
    const g = parseInt(shortHex[2] + shortHex[2], 16)
    const b = parseInt(shortHex[3] + shortHex[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const longHex = color.trim().match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (longHex) {
    const r = parseInt(longHex[1], 16)
    const g = parseInt(longHex[2], 16)
    const b = parseInt(longHex[3], 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color
}

function drawGrid(ctx, plot, theme) {
  ctx.save()
  ctx.lineWidth = 1
  ctx.strokeStyle = theme.grid || '#333'

  // Zero-crossing crosshair.
  ctx.globalAlpha = 0.5
  ctx.beginPath()
  const zx = ampToX(0, plot)
  const zy = ampToY(0, plot)
  ctx.moveTo(zx, plot.y)
  ctx.lineTo(zx, plot.y + plot.h)
  ctx.moveTo(plot.x, zy)
  ctx.lineTo(plot.x + plot.w, zy)
  ctx.stroke()

  // Unity (y = x) reference — dashed, dim. Not an accent color: the curve and
  // the active mode button are the only earned color in this panel.
  ctx.globalAlpha = 0.25
  ctx.setLineDash([2, 5])
  ctx.beginPath()
  ctx.moveTo(ampToX(-1, plot), ampToY(-1, plot))
  ctx.lineTo(ampToX(1, plot), ampToY(1, plot))
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

function drawCurve(ctx, plot, points, theme) {
  const accent = theme.accent || '#4ecdc4'

  const tracePath = () => {
    ctx.beginPath()
    for (let i = 0; i < points.length; i++) {
      const px = ampToX(points[i].xin, plot)
      const py = ampToY(points[i].y, plot)
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
  }

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'

  // Dim wide under-stroke, then the bright core — softens the edge without a
  // blur filter, same treatment CompressorCurveNode uses.
  tracePath()
  ctx.strokeStyle = rgba(accent, 0.18)
  ctx.lineWidth = 4
  ctx.stroke()

  tracePath()
  ctx.strokeStyle = accent
  ctx.lineWidth = 2.2
  ctx.stroke()
  ctx.restore()
}

// Renders the full curve editor into a w x h canvas (CSS px). Returns nothing
// — this view has no draggable handles, unlike the compressor curve.
export function drawDistortionCurve(ctx, w, h, distortionParams, theme) {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = theme.bgInset || '#0f0f0f'
  ctx.fillRect(0, 0, w, h)

  const plot = { x: 0, y: 0, w: Math.max(1, w), h: Math.max(1, h) }

  drawGrid(ctx, plot, theme)
  const points = buildDistortionCurvePoints(distortionParams, plot.w)
  drawCurve(ctx, plot, points, theme)
}
