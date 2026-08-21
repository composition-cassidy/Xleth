import { useCallback, useEffect, useRef } from 'react'

// Shared spring-based view animator — Timeline and Piano Roll both mount one
// instance each (own state, same code: see useTimelineZoom/useTimelineScroll
// for the analogous "shared hook, per-consumer instance" pattern already used
// on this branch). ONE rAF loop per instance drives every registered
// property ("spring") together — never one loop per property.
//
// Physics: a critically damped spring (mass = 1, k = omega², c = 2*omega,
// damping ratio = 1). Integrated with semi-implicit ("symplectic") Euler,
// which is what makes retargeting mid-flight (a wheel notch arriving before
// the previous one has settled) just bend the existing trajectory instead of
// restarting a tween from scratch — there is no fixed duration anywhere in
// this file, only a rate (omega) and a current (position, velocity) state:
//
//   k = omega*omega, c = 2*omega
//   vel += (k*(target-current) - c*vel) * dt
//   current += vel * dt
//
// A critically damped step response from rest never overshoots; retargeting
// further in the same direction the spring is already moving does not
// overshoot the (new) target either — see useViewAnimator.test.js.
//
// Zoom (ppb) is registered with `space: 'log'`: current/target are stored as
// Math.log(value) and integrated in log space, converted back with Math.exp
// on every read (getCurrent/onTick). Linear interpolation of px/beat drifts
// the anchored beat under the cursor across the 8-50000 ppb range this app
// supports, because equal steps in linear ppb are wildly unequal in
// perceived zoom speed at the low vs. high end; equal steps in log-ppb are
// not. `space: 'linear'` (the default) is a plain scalar spring — used for
// scrollX/scrollY.
//
// This module knows nothing about beats, pixels, canvases, or cursors. A
// consumer that needs cross-property behavior (Timeline's cursor-anchored
// zoom recomputes scrollX from an anchor beat + the CURRENT interpolated ppb
// on every single tick, not just the final frame) does that itself inside
// its own `onTick` callback, using `setCurrent` to keep a slaved spring's
// bookkeeping honest — see TimelineView.jsx's zoomAnchorRef.

export const DEFAULT_OMEGA = 25 // rad/s — critically damped spring rate (ζ = 1)

// A stalled tab, a debugger pause, or the first frame after a long sleep can
// hand the loop a `now - lastTime` of hundreds of milliseconds. Feeding that
// straight into the integrator would produce a huge `vel` delta and fling
// the spring past its target in one step. Clamping dt bounds the worst-case
// per-step change regardless of how long the wall-clock gap actually was.
export const MAX_DT = 1 / 30

// getDrawStats().p95 above this (ms) means redraws are themselves eating the
// frame budget — easing on top just adds animation-of-a-slideshow. Snap
// instead: self-limiting on weak hardware, never blocks correctness.
export const SLOW_DRAW_MS = 8

const DEFAULT_LINEAR_EPSILON = 1e-3
const DEFAULT_LINEAR_EPSILON_VELOCITY = 1e-3
// log-space epsilon of 1e-4 is roughly a 0.01% change in the real (exp'd)
// value — tight enough that "settled" is visually indistinguishable from
// "exact" at any ppb from MIN_PPB to MAX_PPB.
const DEFAULT_LOG_EPSILON = 1e-4
const DEFAULT_LOG_EPSILON_VELOCITY = 1e-4

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing — no rAF, no React, no DOM).
// ---------------------------------------------------------------------------

// Creates one spring's state. `value` is in the CALLER's units (real ppb,
// pixels, beats — never pre-logged); log-space storage is an internal detail.
export function createSpring({ value, space = 'linear', epsilon, epsilonVelocity } = {}) {
  const toInternal = space === 'log' ? Math.log : (v) => v
  return {
    space,
    target: value,
    current: value,
    currentInternal: toInternal(value),
    vel: 0,
    epsilon: epsilon ?? (space === 'log' ? DEFAULT_LOG_EPSILON : DEFAULT_LINEAR_EPSILON),
    epsilonVelocity: epsilonVelocity ?? (space === 'log' ? DEFAULT_LOG_EPSILON_VELOCITY : DEFAULT_LINEAR_EPSILON_VELOCITY),
  }
}

// Snaps a spring directly to a value with zero velocity — used for both the
// `immediate` flag on setTarget and the plain setCurrent primitive. Not
// itself a "tick": callers decide whether that warrants a redraw.
function snapSpring(spring, value) {
  spring.target = value
  spring.currentInternal = spring.space === 'log' ? Math.log(value) : value
  spring.current = value
  spring.vel = 0
}

// Clamps a raw (now - lastTime) delta to a safe integration step. Exported
// so the "a stalled frame can't explode the integrator" requirement is
// directly testable without mocking rAF/performance.now().
export function clampDt(rawDt) {
  if (!Number.isFinite(rawDt) || rawDt < 0) return 0
  return Math.min(rawDt, MAX_DT)
}

// Advances one spring by `dt` seconds toward its (possibly just-changed)
// target. `snap` bypasses integration entirely (the adaptive frame-budget
// path). Returns whether the spring is still in motion after this step.
export function stepSpring(spring, dt, omega, snap = false) {
  const targetInternal = spring.space === 'log' ? Math.log(spring.target) : spring.target

  if (snap) {
    spring.currentInternal = targetInternal
    spring.vel = 0
  } else if (dt > 0) {
    const k = omega * omega
    const c = 2 * omega
    const accel = k * (targetInternal - spring.currentInternal) - c * spring.vel
    spring.vel += accel * dt
    spring.currentInternal += spring.vel * dt
  }

  const atRest = Math.abs(targetInternal - spring.currentInternal) < spring.epsilon
    && Math.abs(spring.vel) < spring.epsilonVelocity
  if (atRest) {
    spring.currentInternal = targetInternal
    spring.vel = 0
  }

  spring.current = spring.space === 'log' ? Math.exp(spring.currentInternal) : spring.currentInternal
  return !atRest
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * @param {Object} options
 * @param {Object<string, {value:number, space?:'linear'|'log', epsilon?:number, epsilonVelocity?:number}>} options.springs
 *   Initial spring definitions, keyed by name. Read ONCE on mount (lazy
 *   init) — later changes to this object are ignored, matching the
 *   `useState(() => ...)` convention used elsewhere in this codebase for
 *   "initial value only" props.
 * @param {number} [options.omega] Spring rate; defaults to DEFAULT_OMEGA.
 *   Internal tuning knob only — do not surface this as a user setting.
 * @param {() => ({p95:number}|undefined)} [options.getDrawStats] Optional;
 *   when its p95 exceeds SLOW_DRAW_MS, that frame snaps every spring to
 *   target instead of easing (re-evaluated every frame, so a transient
 *   hiccup degrades only the frames it actually affects, not the whole
 *   gesture).
 * @param {(values:Object<string,number>, meta:{dt:number, snapped:boolean, immediate?:boolean}) => void} [options.onTick]
 *   Called once per frame (after every spring has been advanced) with the
 *   current value of every spring. This is the ONLY place per-frame work
 *   should happen — never call React state setters from here.
 */
export default function useViewAnimator({ springs: springConfig, omega = DEFAULT_OMEGA, getDrawStats, onTick } = {}) {
  const springsRef = useRef(null)
  if (springsRef.current === null) {
    const map = new Map()
    for (const [key, cfg] of Object.entries(springConfig || {})) {
      map.set(key, createSpring(cfg))
    }
    springsRef.current = map
  }

  // "Latest ref" pattern: these can change every render (getDrawStats and
  // onTick are typically fresh closures), but the rAF loop itself must stay
  // a single stable function — see tick's `[]` deps below.
  const omegaRef = useRef(omega)
  omegaRef.current = omega
  const getDrawStatsRef = useRef(getDrawStats)
  getDrawStatsRef.current = getDrawStats
  const onTickRef = useRef(onTick)
  onTickRef.current = onTick

  const rafRef = useRef(null)
  const lastTimeRef = useRef(0)

  const snapshotValues = useCallback(() => {
    const values = {}
    for (const [key, spring] of springsRef.current) values[key] = spring.current
    return values
  }, [])

  const tick = useCallback((now) => {
    rafRef.current = null
    const dt = clampDt((now - lastTimeRef.current) / 1000)
    lastTimeRef.current = now

    const stats = getDrawStatsRef.current?.()
    const snap = Boolean(stats && stats.p95 > SLOW_DRAW_MS)

    let anyActive = false
    for (const spring of springsRef.current.values()) {
      const stillMoving = stepSpring(spring, dt, omegaRef.current, snap)
      if (stillMoving) anyActive = true
    }

    onTickRef.current?.(snapshotValues(), { dt, snapped: snap })

    // Sleep at rest: zero cost until the next setTarget() calls wake().
    if (anyActive) rafRef.current = requestAnimationFrame(tick)
  }, [snapshotValues])

  const wake = useCallback(() => {
    if (rafRef.current != null) return
    lastTimeRef.current = performance.now()
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const setTarget = useCallback((key, value, { immediate = false } = {}) => {
    const spring = springsRef.current.get(key)
    if (!spring) return
    spring.target = value
    if (immediate) {
      // Don't make a caller that just wants an instant snap (e.g. a
      // scrollbar thumb drag, or clamping scrollX after content shrinks)
      // wait a frame for a value that isn't going to animate anyway — and
      // don't wake the loop either, there is nothing left to ease.
      snapSpring(spring, value)
      onTickRef.current?.(snapshotValues(), { dt: 0, snapped: false, immediate: true })
      return
    }
    wake()
  }, [wake, snapshotValues])

  // Force-sets a spring's current position (and target, so it doesn't think
  // it owes further motion) without waking the loop or emitting a tick.
  // For a consumer's own onTick to slave one spring to another already-
  // ticking spring's result within the SAME frame (see the module doc's
  // cursor-anchor example) — calling setTarget here would be redundant
  // (the loop is already running and about to emit) and could also
  // trigger an unwanted synchronous re-entrant tick via immediate.
  const setCurrent = useCallback((key, value) => {
    const spring = springsRef.current.get(key)
    if (!spring) return
    snapSpring(spring, value)
  }, [])

  const getCurrent = useCallback((key) => springsRef.current.get(key)?.current, [])
  const getTarget = useCallback((key) => springsRef.current.get(key)?.target, [])

  const isAtRest = useCallback((key) => {
    const spring = springsRef.current.get(key)
    if (!spring) return true
    const targetInternal = spring.space === 'log' ? Math.log(spring.target) : spring.target
    return Math.abs(targetInternal - spring.currentInternal) < spring.epsilon
      && Math.abs(spring.vel) < spring.epsilonVelocity
  }, [])

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  return { setTarget, setCurrent, getCurrent, getTarget, isAtRest, wake }
}
