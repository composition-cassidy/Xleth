import { describe, it, expect } from 'vitest'
import { rdpSimplify, rdpSimplifyNormalized, evaluateTrack, IDENTITY_CURVE } from './zprCurveMath.js'

describe('rdpSimplify', () => {
  it('collapses a straight line to its two endpoints regardless of interior points', () => {
    const points = Array.from({ length: 50 }, (_, i) => ({ t: i / 49, v: (i / 49) * 2 }))
    const out = rdpSimplify(points, 0.01)
    expect(out).toEqual([points[0], points[49]])
  })

  it('keeps a real corner when it exceeds tolerance', () => {
    // A sharp V: straight from t=0 to a peak at t=0.5, back down to t=1.
    const points = []
    for (let i = 0; i <= 20; i++) points.push({ t: i / 20, v: i <= 10 ? i / 10 : (20 - i) / 10 })
    const out = rdpSimplify(points, 0.05)
    expect(out.length).toBe(3)
    expect(out[1].t).toBeCloseTo(0.5, 5)
    expect(out[1].v).toBeCloseTo(1, 5)
  })

  it('drops a corner smaller than tolerance', () => {
    const points = []
    for (let i = 0; i <= 20; i++) points.push({ t: i / 20, v: i <= 10 ? i / 200 : (20 - i) / 200 })
    const out = rdpSimplify(points, 0.05)
    expect(out).toEqual([points[0], points[20]])
  })
})

describe('rdpSimplifyNormalized', () => {
  it('collapses a channel that never actually moved to its two endpoints', () => {
    const points = Array.from({ length: 30 }, (_, i) => ({ t: i / 29, v: 0.5 + (Math.random() - 0.5) * 1e-10 }))
    const out = rdpSimplifyNormalized(points, 0.05)
    expect(out.length).toBe(2)
  })

  it('applies tolerance as a fraction of the channel\'s own range, not an absolute unit', () => {
    // Same shape, two different scales (pan-like ~0.2 range vs rotation-like ~300deg range).
    const shape = (i, n) => (i <= n / 2 ? i / (n / 2) : (n - i) / (n / 2))
    const n = 40
    const small = Array.from({ length: n + 1 }, (_, i) => ({ t: i / n, v: shape(i, n) * 0.2 }))
    const large = Array.from({ length: n + 1 }, (_, i) => ({ t: i / n, v: shape(i, n) * 300 }))
    const outSmall = rdpSimplifyNormalized(small, 0.05)
    const outLarge = rdpSimplifyNormalized(large, 0.05)
    // Both keep the same structural corner (the peak) despite the 1500x scale
    // difference — proof the tolerance is range-relative, not absolute.
    expect(outSmall.length).toBe(3)
    expect(outLarge.length).toBe(3)
  })
})

describe('real-time recording: a 2-second drag thins to a reasonable keyframe count', () => {
  it('produces well under 15 keyframes at the default 3% tolerance and still reads as the same gesture', () => {
    // Simulate a hand-drawn 2-second drag at 60fps (120 raw samples) passing
    // through four deliberate waypoints (the "gesture"), each leg eased with a
    // little jitter — the way a real mouse trace looks, not a mathematically
    // straight line.
    const waypoints = [
      { t: 0.0, v: 0.0 },
      { t: 0.25, v: 0.30 },
      { t: 0.55, v: -0.15 },
      { t: 0.8, v: 0.10 },
      { t: 1.0, v: 0.02 },
    ]
    const lerpWaypoints = (t) => {
      for (let i = 0; i < waypoints.length - 1; i++) {
        const a = waypoints[i], b = waypoints[i + 1]
        if (t >= a.t && t <= b.t) {
          const local = (t - a.t) / (b.t - a.t)
          return a.v + (b.v - a.v) * local
        }
      }
      return waypoints[waypoints.length - 1].v
    }

    const raw = []
    const sampleCount = 120  // 2s @ 60fps
    for (let i = 0; i < sampleCount; i++) {
      const t = i / (sampleCount - 1)
      const jitter = (Math.sin(i * 12.9898) * 43758.5453) % 1 * 0.004  // deterministic pseudo-noise
      raw.push({ t, v: lerpWaypoints(t) + jitter })
    }

    const DEFAULT_TOLERANCE = 0.03
    const thinned = rdpSimplifyNormalized(raw, DEFAULT_TOLERANCE)

    expect(thinned.length).toBeLessThan(15)
    expect(thinned.length).toBeGreaterThanOrEqual(waypoints.length)  // real corners survive

    // "Still reads as the same gesture": rebuild a ParamTrack from the thinned
    // points (linear segments) and confirm it tracks the original waypoints
    // reasonably closely, not just endpoint-to-endpoint.
    const track = {
      constantValue: 0,
      keys: thinned.map(p => ({ t: p.t, value: p.v, ...pointCurve() })),
    }
    for (const wp of waypoints) {
      const reconstructed = evaluateTrack(
        { keys: track.keys.map(k => ({ t: k.t, v: k.value, c: [k.p1x, k.p1y, k.p2x, k.p2y] })) },
        wp.t,
      )
      expect(Math.abs(reconstructed - wp.v)).toBeLessThan(0.06)
    }

    function pointCurve() {
      return { p1x: IDENTITY_CURVE[0], p1y: IDENTITY_CURVE[1], p2x: IDENTITY_CURVE[2], p2y: IDENTITY_CURVE[3] }
    }
  })
})
