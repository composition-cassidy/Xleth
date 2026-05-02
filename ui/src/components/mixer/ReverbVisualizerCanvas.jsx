// ─── ReverbVisualizerCanvas.jsx ──────────────────────────────────────────────
// Self-contained canvas visualizer for the Reverb bespoke panel.
// Renders a top-down acoustic room: source dot, expanding pre-delay ring,
// early-reflection rays bouncing from room walls, and a diffuse late-reverb
// particle cloud — all driven entirely by param values.
//
// No engine data is polled. All animation runs in one rAF loop that starts on
// mount and stops on unmount (ReverbPanel returns null when its store target is
// null, which unmounts this component entirely and triggers useEffect cleanup).
//
// Thread/lifecycle note:
//   cancelled = true stops the in-flight frame guard immediately.
//   cancelAnimationFrame drops any pending queued call. Both together guarantee
//   zero drawing after unmount, identical to ChorusOrbitVisualizer pattern.

import { useEffect, useRef } from 'react'

// ── Seeded PRNG ───────────────────────────────────────────────────────────────
// mulberry32 — deterministic, no global state, good distribution.
// Used once per mount to produce stable room geometry and cloud particles.

function mulberry32(a) {
  let s = a | 0
  return function () {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Clamps v to [0, 1]. */
export function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

/**
 * Maps decay (0.1–30 s) to a cloud spread factor in [0, 1] on a log scale.
 * Low decay → tight concentrated cloud. High decay → wide persistent cloud.
 */
export function decayToSpread(decay) {
  const logMin = Math.log(0.1)
  const logMax = Math.log(30)
  return clamp01((Math.log(Math.max(0.1, decay)) - logMin) / (logMax - logMin))
}

/**
 * Maps size (0–100 %) to a room half-extent fraction of the canvas dimension.
 * Returns a value in [0.24, 0.60] so the room visibly grows and shrinks.
 */
export function sizeToRoomFrac(sizePct) {
  return 0.24 + clamp01(sizePct / 100) * 0.36
}

/**
 * Maps hicut normalised (0 = 1 kHz, 1 = 20 kHz) to an RGB particle color.
 * Low hicut (warm/dark room): deep amber. High hicut (bright room): cool purple-white.
 */
export function hicutToColor(hicutNorm) {
  const n = clamp01(hicutNorm)
  return {
    r: Math.round(200 + n * (175 - 200)),  // 200 → 175
    g: Math.round(105 + n * (135 - 105)),  // 105 → 135
    b: Math.round(20  + n * (255 - 20)),   //  20 → 255
  }
}

/**
 * Maps locut normalised (0 = 20 Hz, 1 = 500 Hz) to a body-layer alpha.
 * Higher locut thins the low-frequency body density layer.
 */
export function locutToBodyAlpha(locutNorm, baseAlpha) {
  return baseAlpha * (1 - clamp01(locutNorm) * 0.82)
}

/**
 * Generates N stable early-reflection ray descriptors using rng.
 * wallSide: 0=top, 1=right, 2=bottom, 3=left.
 * wallNorm: normalised position [0.1, 0.9] along that wall edge.
 */
export function seedRays(count, rng) {
  const rays = []
  for (let i = 0; i < count; i++) {
    rays.push({
      wallSide: Math.floor(rng() * 4),
      wallNorm: 0.1 + rng() * 0.8,
    })
  }
  return rays
}

/**
 * Generates N stable cloud particle descriptors using rng.
 * Positions are approximately Gaussian (sum-of-uniforms) so energy
 * concentrates near centre — matching the late reverb tail.
 */
export function seedParticles(count, rng) {
  const particles = []
  for (let i = 0; i < count; i++) {
    // Sum of 4 uniforms → approx. Gaussian, range [-1, 1], centred at 0.
    const nx = clamp01((rng() + rng() + rng() + rng() - 2) / 2 + 0.5) * 2 - 1
    const ny = clamp01((rng() + rng() + rng() + rng() - 2) / 2 + 0.5) * 2 - 1
    particles.push({
      nx:        Math.max(-0.96, Math.min(0.96, nx)),
      ny:        Math.max(-0.96, Math.min(0.96, ny)),
      phase:     rng() * 2 * Math.PI,
      phaseRate: 0.28 + rng() * 1.44,   // irrational so shimmer never syncs across particles
      baseAlpha: 0.50 + rng() * 0.50,
      baseSize:  0.35 + rng() * 0.65,
    })
  }
  return particles
}

// ── Internal theme reader ─────────────────────────────────────────────────────

function readReverbTheme(canvas) {
  const cs  = canvas ? getComputedStyle(canvas) : null
  const get = (k, fb) => { const v = cs?.getPropertyValue(k)?.trim(); return v || fb }
  return { bgInset: get('--theme-bg-inset', '#0d0d14') }
}

// ── Style label table ────────────────────────────────────────────────────────
// Stage 3: Generic and Plate share visuals because Plate still routes to the
// Generic backend internally — showing a plate-specific scene before the DSP
// exists would lie about what's actually playing. Room and Hall get small
// scene multipliers reflecting their tuning character (tighter / wider).
const STYLE_LABELS = ['GENERIC', 'ROOM', 'PLATE', 'HALL']

// Per-style visual multipliers. All values default to 1.0; Generic and Plate
// use the unmodified scene. Multipliers are deliberately subtle so the
// visualizer hints at the tuning without overstating differences.
//   roomScale — room-rectangle half-extent multiplier (smaller = tighter space)
//   rayAlpha  — early-reflection ray brightness multiplier (more = louder ER)
//   cloudSize — late-reverb cloud spread multiplier (smaller = denser tail)
const STYLE_VIZ = [
  { roomScale: 1.00, rayAlpha: 1.00, cloudSize: 1.00 }, // 0 Generic
  { roomScale: 0.86, rayAlpha: 1.22, cloudSize: 0.85 }, // 1 Room  — tighter, more visible ER
  { roomScale: 1.00, rayAlpha: 1.00, cloudSize: 1.00 }, // 2 Plate — same as Generic for now
  { roomScale: 1.14, rayAlpha: 0.82, cloudSize: 1.12 }, // 3 Hall  — wider scene, softer ER
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReverbVisualizerCanvas({ params, styleIndex = 0 }) {
  const canvasRef    = useRef(null)
  const paramsRef    = useRef(params)
  const styleIdxRef  = useRef(styleIndex)
  const rafRef       = useRef(0)
  const raysRef      = useRef(null)   // stable seeded ER ray descriptors
  const cloudRef     = useRef(null)   // stable seeded cloud particle descriptors

  // Keep latest params readable every frame without restarting the rAF loop.
  paramsRef.current   = params
  styleIdxRef.current = styleIndex

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    // Seed stable geometry once per mount. Same seed → same layout always.
    const rng     = mulberry32(0xA9B3C1D2)
    raysRef.current  = seedRays(12, rng)
    cloudRef.current = seedParticles(48, rng)

    let cancelled = false
    const t0 = performance.now()

    function draw(now) {
      if (cancelled) return

      const p = paramsRef.current
      const t = now - t0

      // ── DPR-aware backing-store resize ──────────────────────────────────────
      const dpr  = Math.max(1, window.devicePixelRatio || 1)
      const rect = canvas.getBoundingClientRect()
      const cssW = rect.width  > 0 ? rect.width  : 480
      const cssH = rect.height > 0 ? rect.height : 230
      const tw   = Math.round(cssW * dpr)
      const th   = Math.round(cssH * dpr)
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width  = tw
        canvas.height = th
      }

      const ctx = canvas.getContext('2d', { alpha: false })
      if (!ctx) { rafRef.current = requestAnimationFrame(draw); return }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      const { bgInset } = readReverbTheme(canvas)

      // ── Param extraction ────────────────────────────────────────────────────
      const decay    = Math.max(0.1,  p.decay     ?? 2)
      const size     = Math.max(0,    p.size      ?? 50)
      const damping  = Math.max(0,    p.damping   ?? 50)
      const predelay = Math.max(0,    p.predelay  ?? 10)
      const erLevel  = Math.max(0,    p.er_level  ?? 50)
      const erLate   = Math.max(0,    p.er_late   ?? 50)
      const modRate  = Math.max(0,    p.mod_rate  ?? 30)
      const modDepth = Math.max(0,    p.mod_depth ?? 20)
      const hicut    = Math.max(1000, p.hicut     ?? 12000)
      const locut    = Math.max(20,   p.locut     ?? 80)
      const mix      = Math.max(0,    p.mix       ?? 30)

      const decayNorm    = decayToSpread(decay)
      const sizeNorm     = clamp01(size    / 100)
      const dampingNorm  = clamp01(damping / 100)
      const erLevelNorm  = clamp01(erLevel / 100)
      const erLateNorm   = clamp01(erLate  / 100)
      const modRateNorm  = clamp01(modRate  / 100)
      const modDepthNorm = clamp01(modDepth / 100)
      const hicutNorm    = clamp01((hicut - 1000) / 19000)
      const locutNorm    = clamp01((locut - 20)   / 480)
      const mixNorm      = clamp01(mix   / 100)

      // ── Per-style visual scaling ────────────────────────────────────────────
      // Stage 3: tuning-driven character is reflected here as a subtle scene
      // multiplier. Generic/Plate use 1.0 (no change); Room shrinks the
      // scene; Hall widens it.
      const styleIdx = Math.max(0, Math.min(STYLE_VIZ.length - 1,
        styleIdxRef.current | 0))
      const styleViz = STYLE_VIZ[styleIdx]

      // ── Room geometry ───────────────────────────────────────────────────────
      const cx = cssW / 2
      const cy = cssH * 0.43

      const roomFrac = sizeToRoomFrac(size) * styleViz.roomScale
      const roomHW   = cssW * roomFrac * 0.52   // room half-width
      const roomHH   = cssH * roomFrac * 0.62   // room half-height

      // Source dot: near bottom-centre of the room (listener / point source)
      const srcX = cx
      const srcY = cy + roomHH * 0.58

      // ── Background ──────────────────────────────────────────────────────────

      ctx.fillStyle = bgInset
      ctx.fillRect(0, 0, cssW, cssH)

      // Warm amber radial glow centred on the room
      {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(roomHW, roomHH) * 2.3)
        g.addColorStop(0,    'rgba(148, 82,   0, 0.13)')
        g.addColorStop(0.45, 'rgba( 68, 32,  98, 0.07)')
        g.addColorStop(1,    'rgba(  0,  0,   0, 0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, cssW, cssH)
      }

      // Cool purple accent, offset for visual depth
      {
        const px = cx + cssW * 0.13
        const py = cy - cssH * 0.09
        const g  = ctx.createRadialGradient(px, py, 0, px, py, cssW * 0.50)
        g.addColorStop(0,   'rgba(52, 16, 108, 0.09)')
        g.addColorStop(1,   'rgba( 0,  0,   0, 0)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, cssW, cssH)
      }

      // Corner vignette
      {
        const g = ctx.createRadialGradient(
          cx, cy, Math.min(cssW, cssH) * 0.22,
          cx, cy, Math.max(cssW, cssH) * 0.82,
        )
        g.addColorStop(0, 'rgba(0, 0, 0, 0)')
        g.addColorStop(1, 'rgba(0, 0, 0, 0.38)')
        ctx.fillStyle = g
        ctx.fillRect(0, 0, cssW, cssH)
      }

      // ── Room rectangle ──────────────────────────────────────────────────────
      // Dashed amber outline. Opacity and scale track the size param.
      ctx.save()
      ctx.strokeStyle = `rgba(210, 148, 40, ${(0.09 + sizeNorm * 0.13).toFixed(3)})`
      ctx.lineWidth   = 1
      ctx.setLineDash([3, 9])
      ctx.strokeRect(cx - roomHW, cy - roomHH, roomHW * 2, roomHH * 2)
      ctx.setLineDash([])
      ctx.restore()

      // ── Pre-delay ring ──────────────────────────────────────────────────────
      // Expanding ring from the source representing the arrival-time gap.
      // Long pre-delay → slower expansion → reflections "bloom" later.
      {
        const ringPeriodMs = 500 + predelay * 22    // 500 ms (0 ms) … 2700 ms (100 ms)
        const ringPhase    = (t % ringPeriodMs) / ringPeriodMs  // 0 → 1
        const maxRingR     = Math.max(roomHW, roomHH) * 1.30
        const ringR        = ringPhase * maxRingR
        const ringAlpha    = (1 - ringPhase) * (0.07 + mixNorm * 0.22)

        if (ringAlpha > 0.005) {
          ctx.save()
          ctx.strokeStyle = `rgba(255, 198, 65, ${ringAlpha.toFixed(3)})`
          ctx.lineWidth   = 1.1
          ctx.beginPath()
          ctx.arc(srcX, srcY, Math.max(1, ringR), 0, 2 * Math.PI)
          ctx.stroke()
          ctx.restore()
        }
      }

      // ── Early reflection rays ───────────────────────────────────────────────
      // 12 stable seeded rays from source to wall, then a short bounce inward.
      // Brightness driven by er_level × mix. Geometry uses normalised wall
      // positions so the rays rescale naturally when size changes.
      {
        const rays      = raysRef.current
        const rayAlpha  = erLevelNorm * (0.10 + mixNorm * 0.58) * styleViz.rayAlpha

        // Pre-compute wall impact point + reflected bounce endpoint for each ray.
        const computed = rays.map(ray => {
          let wallX, wallY
          switch (ray.wallSide) {
            case 0:   // top wall
              wallX = cx + (ray.wallNorm * 2 - 1) * roomHW
              wallY = cy - roomHH
              break
            case 1:   // right wall
              wallX = cx + roomHW
              wallY = cy + (ray.wallNorm * 2 - 1) * roomHH
              break
            case 2:   // bottom wall
              wallX = cx + (ray.wallNorm * 2 - 1) * roomHW
              wallY = cy + roomHH
              break
            default:  // left wall
              wallX = cx - roomHW
              wallY = cy + (ray.wallNorm * 2 - 1) * roomHH
              break
          }

          // Unit direction source → wall
          const dx   = wallX - srcX
          const dy   = wallY - srcY
          const dist = Math.sqrt(dx * dx + dy * dy) || 1
          const ndx  = dx / dist
          const ndy  = dy / dist

          // Reflected direction: flip the wall-normal component
          const bounceLen = Math.min(roomHW, roomHH) * 0.27
          let bx, by
          if (ray.wallSide === 0 || ray.wallSide === 2) {
            // Horizontal walls: flip y component
            bx = wallX + ndx  * bounceLen
            by = wallY - ndy  * bounceLen
          } else {
            // Vertical walls: flip x component
            bx = wallX - ndx  * bounceLen
            by = wallY + ndy  * bounceLen
          }

          return { wallX, wallY, bx, by }
        })

        ctx.save()
        ctx.lineCap = 'round'

        // Draw primary rays (source → wall) in one batch pass
        ctx.lineWidth   = 0.8
        ctx.shadowBlur  = 3 + erLevelNorm * 6
        ctx.shadowColor = `rgba(255, 198, 58, ${(rayAlpha * 0.7).toFixed(3)})`
        for (const { wallX, wallY } of computed) {
          const g = ctx.createLinearGradient(srcX, srcY, wallX, wallY)
          g.addColorStop(0,   'rgba(255, 222, 80, 0)')
          g.addColorStop(0.45,`rgba(255, 198, 58, ${(rayAlpha * 0.55).toFixed(3)})`)
          g.addColorStop(1,   `rgba(255, 176, 38, ${rayAlpha.toFixed(3)})`)
          ctx.strokeStyle = g
          ctx.beginPath()
          ctx.moveTo(srcX, srcY)
          ctx.lineTo(wallX, wallY)
          ctx.stroke()
        }

        // Draw bounce rays (wall → reflected direction) — dimmer, shorter
        ctx.lineWidth  = 0.65
        ctx.shadowBlur = 2
        for (const { wallX, wallY, bx, by } of computed) {
          const g = ctx.createLinearGradient(wallX, wallY, bx, by)
          g.addColorStop(0, `rgba(255, 176, 38, ${(rayAlpha * 0.55).toFixed(3)})`)
          g.addColorStop(1, 'rgba(255, 176, 38, 0)')
          ctx.strokeStyle = g
          ctx.beginPath()
          ctx.moveTo(wallX, wallY)
          ctx.lineTo(bx, by)
          ctx.stroke()
        }

        ctx.restore()
      }

      // ── Late reverb cloud ───────────────────────────────────────────────────
      // 48 stable seeded particles inside the room.
      // Spread driven by decay. Shimmer by mod_rate + mod_depth.
      // Color temperature from hicut. Body density from locut.
      // er_late and mix control overall cloud intensity independently.
      {
        const particles = cloudRef.current
        const col       = hicutToColor(hicutNorm)
        const colStr    = `${col.r}, ${col.g}, ${col.b}`

        // Cloud half-extents: larger spread at high decay; per-style multiplier
        // for tighter (Room) or wider (Hall) impression.
        const cloudHW = roomHW * (0.26 + decayNorm * 0.60) * styleViz.cloudSize
        const cloudHH = roomHH * (0.26 + decayNorm * 0.54) * styleViz.cloudSize

        // Gentle breathing pulse whose period matches decay time
        // Long decay → very slow pulse (cloud feels persistent)
        const decayPeriodMs = 900 + decayNorm * 7800
        const breathePhase  = (t % decayPeriodMs) / decayPeriodMs
        const breathe       = 0.62 + 0.38 * Math.sin(breathePhase * 2 * Math.PI - Math.PI * 0.5)

        // Shimmer: per-particle drift driven by mod_rate (speed) and mod_depth (amplitude)
        const shimmerSpeed = modRateNorm * 0.00072
        const shimmerAmp   = modDepthNorm * roomHH * 0.068

        // Damping: higher damping → softer glow blur on the whole cloud
        const cloudBlur = 2 + dampingNorm * 9

        ctx.save()
        ctx.shadowBlur  = cloudBlur
        ctx.shadowColor = `rgba(${colStr}, 0.22)`

        for (const ptc of particles) {
          // Per-particle shimmer drift (read from stable phase + time-driven angle)
          const driftX = Math.sin(t * shimmerSpeed * ptc.phaseRate + ptc.phase)           * shimmerAmp
          const driftY = Math.cos(t * shimmerSpeed * ptc.phaseRate * 0.71 + ptc.phase + 1.07) * shimmerAmp * 0.62

          const px = cx + ptc.nx * cloudHW + driftX
          const py = cy + ptc.ny * cloudHH + driftY

          // Soft alpha fade as particles approach room walls — keeps cloud
          // visually inside the room without hard clipping
          const boundFadeX = clamp01(1 - Math.max(0, (Math.abs(px - cx) - roomHW * 0.80) / (roomHW * 0.22)))
          const boundFadeY = clamp01(1 - Math.max(0, (Math.abs(py - cy) - roomHH * 0.80) / (roomHH * 0.22)))

          const alpha = ptc.baseAlpha * erLateNorm * (0.10 + mixNorm * 0.74) * breathe * boundFadeX * boundFadeY
          if (alpha < 0.004) continue

          const ptcR = Math.max(1.4, ptc.baseSize * (2.4 + dampingNorm * 4.8))

          ctx.globalAlpha = alpha
          const g = ctx.createRadialGradient(px, py, 0, px, py, ptcR * 1.7)
          g.addColorStop(0,    `rgba(${colStr}, 1)`)
          g.addColorStop(0.50, `rgba(${colStr}, 0.52)`)
          g.addColorStop(1,    `rgba(${colStr}, 0)`)
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(px, py, ptcR * 1.7, 0, 2 * Math.PI)
          ctx.fill()
        }

        ctx.globalAlpha = 1
        ctx.restore()

        // Body layer — soft central ellipse representing low-frequency body
        // Higher locut thins this layer (fewer low-frequency reflections pass)
        {
          const bodyBase  = erLateNorm * (0.055 + mixNorm * 0.095) * breathe
          const bodyAlpha = locutToBodyAlpha(locutNorm, bodyBase)
          if (bodyAlpha > 0.004) {
            const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(cloudHW, cloudHH))
            g.addColorStop(0,   `rgba(${colStr}, ${bodyAlpha.toFixed(3)})`)
            g.addColorStop(0.55,`rgba(${colStr}, ${(bodyAlpha * 0.38).toFixed(3)})`)
            g.addColorStop(1,   `rgba(${colStr}, 0)`)
            ctx.fillStyle = g
            ctx.beginPath()
            ctx.ellipse(cx, cy, cloudHW * 0.92, cloudHH * 0.92, 0, 0, 2 * Math.PI)
            ctx.fill()
          }
        }
      }

      // ── Source dot ──────────────────────────────────────────────────────────
      // Warm amber orb — always visible, represents the dry input signal.
      // Glow intensity rises with mix so the source "competes" with the tail.
      {
        const srcR  = Math.max(3.5, cssH * 0.027)
        const glowB = 7 + mixNorm * 11
        ctx.save()
        ctx.shadowBlur  = glowB
        ctx.shadowColor = 'rgba(255, 198, 28, 0.88)'
        const g = ctx.createRadialGradient(srcX, srcY, 0, srcX, srcY, srcR)
        g.addColorStop(0,    'rgba(255, 248, 172, 1.0)')
        g.addColorStop(0.36, 'rgba(248, 186,  22, 0.92)')
        g.addColorStop(0.78, 'rgba(182,  90,   4, 0.44)')
        g.addColorStop(1,    'rgba(120,  50,   0, 0)')
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(srcX, srcY, srcR, 0, 2 * Math.PI)
        ctx.fill()
        ctx.restore()
      }

      // ── Style label ─────────────────────────────────────────────────────────
      // Subtle top-left tag showing the active style. No scene change in
      // Stage 2 — same DSP across all four labels by design.
      {
        const label = STYLE_LABELS[Math.max(0, Math.min(STYLE_LABELS.length - 1, styleIdx))]
        ctx.save()
        ctx.font         = '600 9px ui-sans-serif, system-ui, -apple-system, sans-serif'
        ctx.textBaseline = 'top'
        ctx.fillStyle    = 'rgba(210, 148, 40, 0.55)'
        ctx.shadowBlur   = 3
        ctx.shadowColor  = 'rgba(0, 0, 0, 0.65)'
        ctx.fillText(label, 10, 8)
        ctx.restore()
      }

      rafRef.current = requestAnimationFrame(draw)
    }

    rafRef.current = requestAnimationFrame(draw)

    // Cleanup: cancelled = true stops the guard on the very next frame;
    // cancelAnimationFrame drops the pending queued call. Both together
    // guarantee no drawing occurs after unmount.
    return () => {
      cancelled = true
      cancelAnimationFrame(rafRef.current)
    }
  }, [])   // Empty deps: all per-frame data flows through paramsRef.

  return (
    <canvas
      ref={canvasRef}
      className="reverb-viz-canvas"
      style={{ display: 'block', width: '100%', height: '100%' }}
    />
  )
}
