/**
 * @vitest-environment jsdom
 *
 * useViewAnimator — critically damped spring animator shared by Timeline and
 * Piano Roll zoom/scroll. The pure-function tests (createSpring/stepSpring/
 * clampDt) cover the physics directly, with no rAF/timers involved. The hook
 * tests mount it via a tiny harness component and drive a manually-controlled
 * fake requestAnimationFrame queue so frame advancement is deterministic
 * (no real wall-clock waiting, no flakiness).
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import useViewAnimator, {
  DEFAULT_OMEGA, MAX_DT, SLOW_DRAW_MS, clampDt, createSpring, stepSpring,
} from '../useViewAnimator.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Pure physics: createSpring / stepSpring / clampDt
// ---------------------------------------------------------------------------

describe('stepSpring — critically damped convergence', () => {
  it('a step response from rest never overshoots the target', () => {
    const spring = createSpring({ value: 0 })
    spring.target = 100
    const dt = 1 / 60
    let maxSeen = -Infinity
    for (let i = 0; i < 600; i++) {
      stepSpring(spring, dt, DEFAULT_OMEGA)
      maxSeen = Math.max(maxSeen, spring.current)
    }
    expect(maxSeen).toBeLessThanOrEqual(100 + 1e-6)
    expect(spring.current).toBeCloseTo(100, 3)
  })

  it('retargeting mid-flight (further, same direction) converges without overshoot', () => {
    const spring = createSpring({ value: 0 })
    spring.target = 100
    const dt = 1 / 60
    // Run partway — spring is now moving with nonzero velocity, well short of 100.
    for (let i = 0; i < 10; i++) stepSpring(spring, dt, DEFAULT_OMEGA)
    expect(spring.current).toBeGreaterThan(0)
    expect(spring.current).toBeLessThan(100)

    // A second wheel notch arrives before the first has settled: retarget
    // further out, in the same direction the spring is already heading —
    // this is exactly what a burst of same-direction wheel notches does.
    spring.target = 200
    let maxSeen = -Infinity
    for (let i = 0; i < 600; i++) {
      stepSpring(spring, dt, DEFAULT_OMEGA)
      maxSeen = Math.max(maxSeen, spring.current)
    }
    expect(maxSeen).toBeLessThanOrEqual(200 + 1e-6)
    expect(spring.current).toBeCloseTo(200, 3)
  })

  it('retargeting behind the current position decelerates and reverses without oscillating past start', () => {
    const spring = createSpring({ value: 0 })
    spring.target = 100
    const dt = 1 / 60
    for (let i = 0; i < 10; i++) stepSpring(spring, dt, DEFAULT_OMEGA)
    const posAtRetarget = spring.current

    // Retarget back to 0 while still carrying forward velocity — a
    // critically damped 2nd-order system can cross the new target once
    // (it must reverse direction somehow) but must never oscillate back
    // past its position at the moment of retargeting.
    spring.target = 0
    let crossings = 0
    let wasAboveTarget = spring.current > 0
    for (let i = 0; i < 600; i++) {
      stepSpring(spring, dt, DEFAULT_OMEGA)
      const isAboveTarget = spring.current > 1e-6
      if (isAboveTarget !== wasAboveTarget) crossings++
      wasAboveTarget = isAboveTarget
      expect(spring.current).toBeLessThanOrEqual(posAtRetarget + 1e-6)
    }
    expect(crossings).toBeLessThanOrEqual(1)
    expect(spring.current).toBeCloseTo(0, 3)
  })

  it('settles current exactly onto target and zeroes velocity once within epsilon', () => {
    const spring = createSpring({ value: 0, epsilon: 0.01, epsilonVelocity: 0.01 })
    spring.target = 10
    const dt = 1 / 60
    let stillMoving = true
    let guard = 0
    while (stillMoving && guard < 10000) {
      stillMoving = stepSpring(spring, dt, DEFAULT_OMEGA)
      guard++
    }
    expect(stillMoving).toBe(false)
    expect(spring.current).toBe(10)
    expect(spring.vel).toBe(0)
  })

  it('snap mode jumps straight to target with zero velocity, bypassing integration', () => {
    const spring = createSpring({ value: 0 })
    spring.target = 500
    const stillMoving = stepSpring(spring, 1 / 60, DEFAULT_OMEGA, /* snap */ true)
    expect(spring.current).toBe(500)
    expect(spring.vel).toBe(0)
    expect(stillMoving).toBe(false)
  })
})

describe('createSpring / stepSpring — log-space zoom', () => {
  it('round-trips: current always equals Math.exp(currentInternal) for a log spring', () => {
    const spring = createSpring({ value: 40, space: 'log' })
    expect(spring.current).toBe(40)
    expect(spring.currentInternal).toBeCloseTo(Math.log(40), 10)

    spring.target = 2648
    const dt = 1 / 60
    for (let i = 0; i < 300; i++) {
      stepSpring(spring, dt, DEFAULT_OMEGA)
      expect(spring.current).toBeCloseTo(Math.exp(spring.currentInternal), 8)
    }
    expect(spring.current).toBeCloseTo(2648, 0)
  })

  it('converges correctly across the full MIN_PPB..MAX_PPB range without overshoot', () => {
    const spring = createSpring({ value: 8, space: 'log' })
    spring.target = 50000
    const dt = 1 / 60
    let maxSeen = -Infinity
    for (let i = 0; i < 2000; i++) {
      stepSpring(spring, dt, DEFAULT_OMEGA)
      maxSeen = Math.max(maxSeen, spring.current)
    }
    expect(maxSeen).toBeLessThanOrEqual(50000 * 1.0001) // tiny float slack, not a real overshoot
    expect(spring.current).toBeCloseTo(50000, -1)
  })

  it('a linear spring over the same range would NOT behave like the log spring (sanity check the space matters)', () => {
    // At the low end of the range, equal *log*-space steps are tiny in
    // linear ppb; a plain linear spring given the same omega reaches
    // halfway-to-target in absolute px MUCH faster relative to a log
    // spring's perceptual halfway point. This just documents why `space:
    // 'log'` is not interchangeable with the default.
    const logSpring = createSpring({ value: 40, space: 'log' })
    const linearSpring = createSpring({ value: 40, space: 'linear' })
    logSpring.target = 4000
    linearSpring.target = 4000
    const dt = 1 / 60
    for (let i = 0; i < 5; i++) {
      stepSpring(logSpring, dt, DEFAULT_OMEGA)
      stepSpring(linearSpring, dt, DEFAULT_OMEGA)
    }
    // Both start identically (same value, same target, same omega, same
    // early dt-count) but diverge because one integrates in log space.
    expect(logSpring.current).not.toBeCloseTo(linearSpring.current, 0)
  })
})

describe('clampDt', () => {
  it('passes small, valid deltas through unchanged', () => {
    expect(clampDt(1 / 60)).toBeCloseTo(1 / 60, 10)
    expect(clampDt(0)).toBe(0)
  })

  it('clamps to MAX_DT so a stalled frame cannot explode the integrator', () => {
    expect(clampDt(5)).toBe(MAX_DT)
    expect(clampDt(1)).toBe(MAX_DT)
    expect(clampDt(MAX_DT + 0.0001)).toBe(MAX_DT)
  })

  it('treats negative or non-finite deltas as zero (clock going backwards, first frame)', () => {
    expect(clampDt(-1)).toBe(0)
    expect(clampDt(NaN)).toBe(0)
    // Infinity is non-finite, same bucket as NaN — treated as "skip this
    // frame's integration" (0), not "clamp to the max step" (MAX_DT is for
    // large-but-finite gaps, e.g. a stalled tab).
    expect(clampDt(Infinity)).toBe(0)
  })

  it('a clamped dt keeps a single huge-gap frame from blowing past target', () => {
    // Without clamping, omega=25 and a 5s gap would make accel*dt enormous.
    const spring = createSpring({ value: 0 })
    spring.target = 100
    stepSpring(spring, clampDt(5), DEFAULT_OMEGA)
    expect(Number.isFinite(spring.current)).toBe(true)
    expect(spring.current).toBeLessThanOrEqual(100 + 1e-6)
    expect(spring.current).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// Hook: rAF loop lifecycle, via a manually-driven fake rAF queue.
// ---------------------------------------------------------------------------

function installFakeRaf() {
  let nextId = 1
  let queue = new Map() // id -> callback
  let now = 0
  const realRaf = globalThis.requestAnimationFrame
  const realCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (cb) => {
    const id = nextId++
    queue.set(id, cb)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => { queue.delete(id) }
  return {
    scheduledCount: () => queue.size,
    // Advances fake time by `ms` and fires every currently-queued callback
    // (a real rAF only ever has one pending callback per loop here, since
    // the hook doesn't schedule the next frame until the current one runs).
    tick(ms = 16) {
      now += ms
      const due = Array.from(queue.entries())
      queue = new Map()
      for (const [, cb] of due) cb(now)
    },
    restore() {
      globalThis.requestAnimationFrame = realRaf
      globalThis.cancelAnimationFrame = realCancel
    },
  }
}

function Harness({ apiRef, ...options }) {
  const api = useViewAnimator(options)
  apiRef.current = api
  return null
}

describe('useViewAnimator (hook)', () => {
  let container
  let root
  let raf

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    raf = installFakeRaf()
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    raf.restore()
  })

  it('does not schedule a frame until setTarget is called (zero cost at idle)', () => {
    const apiRef = { current: null }
    act(() => {
      root.render(<Harness apiRef={apiRef} springs={{ x: { value: 0 } }} />)
    })
    expect(raf.scheduledCount()).toBe(0)
  })

  it('wakes on setTarget, ticks toward the target, then sleeps once at rest', () => {
    const apiRef = { current: null }
    const ticks = []
    act(() => {
      root.render(
        <Harness
          apiRef={apiRef}
          springs={{ x: { value: 0, epsilon: 0.01, epsilonVelocity: 0.01 } }}
          onTick={(values) => ticks.push(values.x)}
        />
      )
    })

    act(() => apiRef.current.setTarget('x', 100))
    expect(raf.scheduledCount()).toBe(1)

    let guard = 0
    while (raf.scheduledCount() > 0 && guard < 2000) {
      act(() => raf.tick(16))
      guard++
    }

    expect(guard).toBeLessThan(2000) // actually stopped, didn't hit the guard rail
    expect(raf.scheduledCount()).toBe(0) // asleep again
    expect(apiRef.current.getCurrent('x')).toBe(100)
    expect(apiRef.current.isAtRest('x')).toBe(true)
    expect(ticks.length).toBeGreaterThan(1) // actually eased, not a single jump
    expect(ticks[ticks.length - 1]).toBe(100)
    // Monotonic approach for a from-rest step — no overshoot through the loop either.
    expect(Math.max(...ticks)).toBeLessThanOrEqual(100 + 1e-6)
  })

  it('restarts the loop when a new target arrives after settling', () => {
    const apiRef = { current: null }
    act(() => {
      root.render(<Harness apiRef={apiRef} springs={{ x: { value: 0, epsilon: 0.01, epsilonVelocity: 0.01 } }} />)
    })
    act(() => apiRef.current.setTarget('x', 10))
    let guard = 0
    while (raf.scheduledCount() > 0 && guard < 2000) { act(() => raf.tick(16)); guard++ }
    expect(raf.scheduledCount()).toBe(0)

    act(() => apiRef.current.setTarget('x', 50))
    expect(raf.scheduledCount()).toBe(1)
    guard = 0
    while (raf.scheduledCount() > 0 && guard < 2000) { act(() => raf.tick(16)); guard++ }
    expect(apiRef.current.getCurrent('x')).toBe(50)
  })

  it('immediate setTarget snaps synchronously without waiting for a frame', () => {
    const apiRef = { current: null }
    const ticks = []
    act(() => {
      root.render(
        <Harness apiRef={apiRef} springs={{ x: { value: 0 } }} onTick={(v) => ticks.push(v.x)} />
      )
    })
    act(() => apiRef.current.setTarget('x', 42, { immediate: true }))
    expect(apiRef.current.getCurrent('x')).toBe(42)
    expect(ticks).toEqual([42]) // fired synchronously, before any rAF tick
    expect(raf.scheduledCount()).toBe(0) // and never woke the loop — nothing to ease
  })

  it('setCurrent updates bookkeeping without waking the loop or emitting a tick', () => {
    const apiRef = { current: null }
    const ticks = []
    act(() => {
      root.render(
        <Harness apiRef={apiRef} springs={{ x: { value: 0 } }} onTick={(v) => ticks.push(v.x)} />
      )
    })
    act(() => apiRef.current.setCurrent('x', 7))
    expect(apiRef.current.getCurrent('x')).toBe(7)
    expect(apiRef.current.getTarget('x')).toBe(7)
    expect(raf.scheduledCount()).toBe(0)
    expect(ticks).toEqual([])
  })

  it('adaptive frame budget: a slow getDrawStats() snaps instead of easing', () => {
    const apiRef = { current: null }
    let p95 = 0
    const ticks = []
    act(() => {
      root.render(
        <Harness
          apiRef={apiRef}
          springs={{ x: { value: 0 } }}
          getDrawStats={() => ({ p95 })}
          onTick={(v, meta) => ticks.push({ x: v.x, snapped: meta.snapped })}
        />
      )
    })
    p95 = SLOW_DRAW_MS + 1 // weak-hardware frame
    act(() => apiRef.current.setTarget('x', 1000))
    act(() => raf.tick(16))
    expect(ticks[0].snapped).toBe(true)
    expect(ticks[0].x).toBe(1000) // snapped straight to target, no easing frames
    expect(raf.scheduledCount()).toBe(0) // already at rest — loop stops immediately
  })

  it('cancels the pending frame on unmount', () => {
    const apiRef = { current: null }
    act(() => {
      root.render(<Harness apiRef={apiRef} springs={{ x: { value: 0 } }} />)
    })
    act(() => apiRef.current.setTarget('x', 10))
    expect(raf.scheduledCount()).toBe(1)
    act(() => root.unmount())
    expect(raf.scheduledCount()).toBe(0)
  })

  it('drives multiple springs off ONE loop (one onTick per frame, not one per property)', () => {
    const apiRef = { current: null }
    let tickCount = 0
    act(() => {
      root.render(
        <Harness
          apiRef={apiRef}
          springs={{
            ppb: { value: 40, space: 'log' },
            scrollX: { value: 0 },
            scrollY: { value: 0 },
          }}
          onTick={() => { tickCount++ }}
        />
      )
    })
    act(() => {
      apiRef.current.setTarget('ppb', 400)
      apiRef.current.setTarget('scrollX', 100)
      apiRef.current.setTarget('scrollY', 50)
    })
    // Three retargets, still exactly one frame scheduled.
    expect(raf.scheduledCount()).toBe(1)
    act(() => raf.tick(16))
    expect(tickCount).toBe(1) // one onTick call carrying all three values, not three
  })
})
