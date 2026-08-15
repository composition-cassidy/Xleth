// @vitest-environment jsdom
//
// Slice 4 — snapshot transition editor. Covers the two things the UI actually
// owns: (1) the pure math that turns a handle drag into whole-tick offsets
// (grid snap by default, Alt frees the snap but still quantizes to a whole
// tick), and (2) the complete payload (including easing) every write hands to
// window.xleth.timeline.setCueTransition. A focused integration test drives a
// real Start/End handle drag through VideoMirrorCanvas and asserts the emitted
// payload — the UI only authors the window; the engine renders the blend.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import VideoMirrorCanvas, {
  buildCueTransition,
  transitionHandleTick,
  clampStartOffsetTicks,
  clampEndOffsetTicks,
  DEFAULT_TRANSITION_WINDOW_TICKS,
  DEFAULT_TRANSITION_EDGE_SOFTNESS,
  DEFAULT_TRANSITION_ZOOM_AMOUNT,
  DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX,
  DEFAULT_TRANSITION_RADIAL_ORIGIN,
  DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX,
  DEFAULT_TRANSITION_GLITCH_INTENSITY,
  DEFAULT_TRANSITION_GLITCH_BLOCK_PX,
  DEFAULT_TRANSITION_BLUR_RADIUS_PX,
  DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT,
  DEFAULT_TRANSITION_DISPLACEMENT_SCALE,
  DEFAULT_TRANSITION_EFFECT_SEED,
  TRANSITION_TYPE_OPTIONS,
  normalizeTransitionEdgeSoftness,
  normalizeTransitionZoomAmount,
  normalizeTransitionDissolveGrain,
  normalizeTransitionRadialOrigin,
  normalizeTransitionPixelateBlock,
  normalizeTransitionGlitchIntensity,
  normalizeTransitionGlitchBlock,
  normalizeTransitionBlurRadius,
  normalizeTransitionDisplacementAmount,
  normalizeTransitionDisplacementScale,
  normalizeTransitionEffectSeed,
} from './VideoMirrorCanvas.jsx'
import {
  LINEAR_TRANSITION_CURVE,
  TRANSITION_EASING_PRESETS,
  normalizeTransitionEasing,
} from './SnapshotTransitionBezierEditor.jsx'
import {
  lineSweepAngleFromPoint,
  lineSweepDirectionLabel,
  normalizeLineSweepAngle,
  snapCardinalTransitionAngle,
  snapLineSweepAngle,
} from './LineSweepDirectionControl.jsx'
import { PPQ } from '../../constants/timeline.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRANSITION_KEYS = [
  'enabled', 'startOffsetTicks', 'endOffsetTicks', 'type', 'geomAngleDeg',
  'edgeSoftness', 'zoomAmount', 'dissolveGrainPx',
  'radialOriginX', 'radialOriginY', 'pixelateMaxBlockPx',
  'glitchIntensity', 'glitchBlockPx', 'blurRadiusPx',
  'displacementAmount', 'displacementScale', 'effectSeed', 'easing',
]

const LINEAR_EASING = {
  startToPin: { ...LINEAR_TRANSITION_CURVE },
  pinToEnd: { ...LINEAR_TRANSITION_CURVE },
}

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('buildCueTransition — the setCueTransition payload', () => {
  it('defaults to a hard cut with a complete linear-easing payload', () => {
    const tr = buildCueTransition(undefined)
    expect(Object.keys(tr).sort()).toEqual([...TRANSITION_KEYS].sort())
    expect(tr).toEqual({
      enabled: false,
      startOffsetTicks: 0,
      endOffsetTicks: 0,
      type: 'crossfade',
      geomAngleDeg: 0,
      edgeSoftness: DEFAULT_TRANSITION_EDGE_SOFTNESS,
      zoomAmount: DEFAULT_TRANSITION_ZOOM_AMOUNT,
      dissolveGrainPx: DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX,
      radialOriginX: DEFAULT_TRANSITION_RADIAL_ORIGIN,
      radialOriginY: DEFAULT_TRANSITION_RADIAL_ORIGIN,
      pixelateMaxBlockPx: DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX,
      glitchIntensity: DEFAULT_TRANSITION_GLITCH_INTENSITY,
      glitchBlockPx: DEFAULT_TRANSITION_GLITCH_BLOCK_PX,
      blurRadiusPx: DEFAULT_TRANSITION_BLUR_RADIUS_PX,
      displacementAmount: DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT,
      displacementScale: DEFAULT_TRANSITION_DISPLACEMENT_SCALE,
      effectSeed: DEFAULT_TRANSITION_EFFECT_SEED,
      easing: LINEAR_EASING,
    })
  })

  it('always emits the full transition shape with correct types', () => {
    const tr = buildCueTransition({ enabled: true, startOffsetTicks: 240, endOffsetTicks: 240 })
    expect(Object.keys(tr).sort()).toEqual([...TRANSITION_KEYS].sort())
    expect(typeof tr.enabled).toBe('boolean')
    expect(typeof tr.startOffsetTicks).toBe('number')
    expect(typeof tr.endOffsetTicks).toBe('number')
    expect(typeof tr.type).toBe('string')
    expect(typeof tr.geomAngleDeg).toBe('number')
    expect(typeof tr.edgeSoftness).toBe('number')
    expect(typeof tr.zoomAmount).toBe('number')
    expect(typeof tr.dissolveGrainPx).toBe('number')
    expect(typeof tr.radialOriginX).toBe('number')
    expect(typeof tr.pixelateMaxBlockPx).toBe('number')
    expect(typeof tr.glitchIntensity).toBe('number')
    expect(typeof tr.blurRadiusPx).toBe('number')
    expect(typeof tr.displacementAmount).toBe('number')
    expect(typeof tr.effectSeed).toBe('number')
    expect(tr.easing).toEqual(LINEAR_EASING)
  })

  it('seeds a visible window only when THIS edit enables a collapsed hard cut', () => {
    const seeded = buildCueTransition(
      { enabled: false, startOffsetTicks: 0, endOffsetTicks: 0 }, { enabled: true },
    )
    expect(seeded.enabled).toBe(true)
    expect(seeded.startOffsetTicks).toBe(DEFAULT_TRANSITION_WINDOW_TICKS)
    expect(seeded.endOffsetTicks).toBe(DEFAULT_TRANSITION_WINDOW_TICKS)
  })

  it('does not reseed when the window is already open', () => {
    const kept = buildCueTransition(
      { enabled: true, startOffsetTicks: 480, endOffsetTicks: 600 }, { enabled: true },
    )
    expect(kept.startOffsetTicks).toBe(480)
    expect(kept.endOffsetTicks).toBe(600)
  })

  it('changing type never moves the handles or easing', () => {
    const current = {
      enabled: true, startOffsetTicks: 480, endOffsetTicks: 600, type: 'crossfade',
      easing: {
        startToPin: { ...TRANSITION_EASING_PRESETS.easeIn.curve },
        pinToEnd: { ...TRANSITION_EASING_PRESETS.easeOut.curve },
      },
    }
    const typed = buildCueTransition(current, { type: 'lineSweep' })
    expect(typed.type).toBe('lineSweep')
    expect(typed.startOffsetTicks).toBe(480)
    expect(typed.endOffsetTicks).toBe(600)
    expect(typed.easing).toEqual(current.easing)
  })

  it('disabling preserves the stored window so re-enabling restores it', () => {
    const off = buildCueTransition(
      { enabled: true, startOffsetTicks: 480, endOffsetTicks: 600 }, { enabled: false },
    )
    expect(off.enabled).toBe(false)
    expect(off.startOffsetTicks).toBe(480)
    expect(off.endOffsetTicks).toBe(600)
  })

  it('clamps offsets non-negative and rounds them to whole ticks', () => {
    const tr = buildCueTransition({ enabled: true, startOffsetTicks: -50, endOffsetTicks: 12.7 })
    expect(tr.startOffsetTicks).toBe(0)
    expect(tr.endOffsetTicks).toBe(13)
  })

  it('normalizes the line sweep angle while preserving every other transition field', () => {
    const tr = buildCueTransition({
      enabled: true, startOffsetTicks: 480, endOffsetTicks: 600, type: 'lineSweep',
      geomAngleDeg: 45,
      easing: {
        startToPin: { ...TRANSITION_EASING_PRESETS.easeIn.curve },
        pinToEnd: { ...TRANSITION_EASING_PRESETS.easeOut.curve },
      },
    }, { geomAngleDeg: 361 })
    expect(tr.geomAngleDeg).toBe(1)
    expect(tr.startOffsetTicks).toBe(480)
    expect(tr.endOffsetTicks).toBe(600)
    expect(tr.easing.startToPin).toEqual(TRANSITION_EASING_PRESETS.easeIn.curve)
    expect(tr.easing.pinToEnd).toEqual(TRANSITION_EASING_PRESETS.easeOut.curve)
  })

  it('clamps every curated transition parameter and preserves them across type changes', () => {
    const clamped = buildCueTransition({
      enabled: true,
      edgeSoftness: 1,
      zoomAmount: -1,
      dissolveGrainPx: 99,
      radialOriginX: -2,
      radialOriginY: 4,
      pixelateMaxBlockPx: 999,
      glitchIntensity: -1,
      glitchBlockPx: 2,
      blurRadiusPx: 999,
      displacementAmount: 2,
      displacementScale: 0,
      effectSeed: 999999,
    })
    expect(clamped.edgeSoftness).toBe(0.10)
    expect(clamped.zoomAmount).toBe(0)
    expect(clamped.dissolveGrainPx).toBe(8)
    expect(clamped.radialOriginX).toBe(0)
    expect(clamped.radialOriginY).toBe(1)
    expect(clamped.pixelateMaxBlockPx).toBe(128)
    expect(clamped.glitchIntensity).toBe(0)
    expect(clamped.glitchBlockPx).toBe(4)
    expect(clamped.blurRadiusPx).toBe(48)
    expect(clamped.displacementAmount).toBe(0.20)
    expect(clamped.displacementScale).toBe(1)
    expect(clamped.effectSeed).toBe(65535)

    const changed = buildCueTransition({
      ...clamped, type: 'zoom', edgeSoftness: 0.035, zoomAmount: 0.21, dissolveGrainPx: 5,
      radialOriginX: 0.2, pixelateMaxBlockPx: 44, glitchIntensity: 0.7,
      blurRadiusPx: 20, displacementAmount: 0.1, effectSeed: 19,
    }, { type: 'displacement' })
    expect(changed.type).toBe('displacement')
    expect(changed.edgeSoftness).toBe(0.035)
    expect(changed.zoomAmount).toBe(0.21)
    expect(changed.dissolveGrainPx).toBe(5)
    expect(changed.radialOriginX).toBe(0.2)
    expect(changed.pixelateMaxBlockPx).toBe(44)
    expect(changed.glitchIntensity).toBe(0.7)
    expect(changed.blurRadiusPx).toBe(20)
    expect(changed.displacementAmount).toBe(0.1)
    expect(changed.effectSeed).toBe(19)
  })

  it('exposes all twelve engine-backed transition types in Basic and Advanced tiers', () => {
    expect(TRANSITION_TYPE_OPTIONS.map(({ value }) => value)).toEqual([
      'crossfade', 'lineSweep', 'push', 'slide', 'zoom', 'dissolve', 'outThenIn',
      'radialReveal', 'pixelate', 'glitch', 'blurThrough', 'displacement',
    ])
    expect([...new Set(TRANSITION_TYPE_OPTIONS.map(({ group }) => group))]).toEqual(['Basic', 'Advanced'])
  })

  it('repairs non-finite parameter values to their defaults', () => {
    expect(normalizeTransitionEdgeSoftness(Number.NaN)).toBe(DEFAULT_TRANSITION_EDGE_SOFTNESS)
    expect(normalizeTransitionZoomAmount(Infinity)).toBe(DEFAULT_TRANSITION_ZOOM_AMOUNT)
    expect(normalizeTransitionDissolveGrain(undefined)).toBe(DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX)
    expect(normalizeTransitionRadialOrigin(Number.NaN)).toBe(DEFAULT_TRANSITION_RADIAL_ORIGIN)
    expect(normalizeTransitionPixelateBlock(Infinity)).toBe(DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX)
    expect(normalizeTransitionGlitchIntensity(undefined)).toBe(DEFAULT_TRANSITION_GLITCH_INTENSITY)
    expect(normalizeTransitionGlitchBlock(Number.NaN)).toBe(DEFAULT_TRANSITION_GLITCH_BLOCK_PX)
    expect(normalizeTransitionBlurRadius(Infinity)).toBe(DEFAULT_TRANSITION_BLUR_RADIUS_PX)
    expect(normalizeTransitionDisplacementAmount(undefined)).toBe(DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT)
    expect(normalizeTransitionDisplacementScale(Number.NaN)).toBe(DEFAULT_TRANSITION_DISPLACEMENT_SCALE)
    expect(normalizeTransitionEffectSeed(Infinity)).toBe(DEFAULT_TRANSITION_EFFECT_SEED)
  })
})

describe('line sweep direction helpers', () => {
  const compass = { left: 0, top: 0, width: 100, height: 100 }

  it('normalizes angles to integer degrees in the 0–359 range', () => {
    expect(normalizeLineSweepAngle(360)).toBe(0)
    expect(normalizeLineSweepAngle(-1)).toBe(359)
    expect(normalizeLineSweepAngle(45.6)).toBe(46)
    expect(normalizeLineSweepAngle(Number.NaN)).toBe(0)
  })

  it('snaps within five degrees of every cardinal direction', () => {
    expect(snapLineSweepAngle(88)).toBe(90)
    expect(snapLineSweepAngle(92)).toBe(90)
    expect(snapLineSweepAngle(178)).toBe(180)
    expect(snapLineSweepAngle(272)).toBe(270)
    expect(snapLineSweepAngle(358)).toBe(0)
    expect(snapLineSweepAngle(84)).toBe(84)
  })

  it('bypasses cardinal snap when Ctrl precision is requested', () => {
    expect(snapLineSweepAngle(89, true)).toBe(89)
    expect(lineSweepAngleFromPoint(2, 50, compass, true)).toBe(180)
  })

  it('maps compass points and cardinal labels to the incoming sweep direction', () => {
    expect(lineSweepAngleFromPoint(100, 50, compass)).toBe(0)
    expect(lineSweepAngleFromPoint(50, 100, compass)).toBe(90)
    expect(lineSweepAngleFromPoint(0, 50, compass)).toBe(180)
    expect(lineSweepAngleFromPoint(50, 0, compass)).toBe(270)
    expect(lineSweepDirectionLabel(0)).toBe('From left')
    expect(lineSweepDirectionLabel(90)).toBe('From top')
    expect(lineSweepDirectionLabel(180)).toBe('From right')
    expect(lineSweepDirectionLabel(270)).toBe('From bottom')
  })

  it('forces motion transitions to the nearest cardinal direction', () => {
    expect(snapCardinalTransitionAngle(44)).toBe(0)
    expect(snapCardinalTransitionAngle(46)).toBe(90)
    expect(snapCardinalTransitionAngle(181)).toBe(180)
    expect(snapCardinalTransitionAngle(315)).toBe(0)
  })
})

describe('transitionHandleTick — grid snap vs Alt-free', () => {
  // ppb = 40 px/beat, scroll = 0  ⇒  beat = localX / 40, tick = beat * 960.
  it('snaps to the musical grid by default', () => {
    // localX 401 → 10.025 beats → 1/16 grid rounds to 10 beats = 9600 ticks.
    expect(transitionHandleTick(401, 0, 40, { alt: false }, '1/16')).toBe(9600)
  })

  it('Alt frees the snap but still quantizes to a whole tick', () => {
    // Same drag, Alt held → 10.025 beats kept, quantized to the nearest tick.
    expect(transitionHandleTick(401, 0, 40, { alt: true }, '1/16')).toBe(9624)
    expect(Number.isInteger(transitionHandleTick(401, 0, 40, { alt: true }, '1/16'))).toBe(true)
  })

  it('never returns a negative tick', () => {
    expect(transitionHandleTick(-200, 0, 40, { alt: false }, '1/16')).toBe(0)
  })
})

describe('clamp offsets never cross the pin', () => {
  it('Start handle collapses to 0 when dragged past the pin', () => {
    expect(clampStartOffsetTicks(1000, 1200)).toBe(0)
    expect(clampStartOffsetTicks(1000, 600)).toBe(400)
  })
  it('End handle collapses to 0 when dragged before the pin', () => {
    expect(clampEndOffsetTicks(1000, 600)).toBe(0)
    expect(clampEndOffsetTicks(1000, 1600)).toBe(600)
  })
})

// ── Integration: a real handle drag emits the setCueTransition payload ───────

describe('VideoMirrorCanvas — Start/End handle drag', () => {
  let container, root
  let clientWidthSpy, clientHeightSpy, rectSpy, ctxSpy

  // jsdom has no 2D canvas; forcing a real width makes the mirror actually draw,
  // so hand it an inert context. We are testing the cue lane's DOM handles, not
  // the pixels.
  function fakeCtx() {
    const noop = () => {}
    return new Proxy({
      measureText: () => ({ width: 0 }),
      createLinearGradient: () => ({ addColorStop: noop }),
      getImageData: () => ({ data: [] }),
      canvas: {},
    }, {
      get(target, prop) { return prop in target ? target[prop] : noop },
      set(target, prop, val) { target[prop] = val; return true },
    })
  }

  const PIN_TICK = 0
  const INITIAL = {
    enabled: true, startOffsetTicks: 480, endOffsetTicks: 480,
    type: 'crossfade', geomAngleDeg: 0,
    edgeSoftness: DEFAULT_TRANSITION_EDGE_SOFTNESS,
    zoomAmount: DEFAULT_TRANSITION_ZOOM_AMOUNT,
    dissolveGrainPx: DEFAULT_TRANSITION_DISSOLVE_GRAIN_PX,
    radialOriginX: DEFAULT_TRANSITION_RADIAL_ORIGIN,
    radialOriginY: DEFAULT_TRANSITION_RADIAL_ORIGIN,
    pixelateMaxBlockPx: DEFAULT_TRANSITION_PIXELATE_MAX_BLOCK_PX,
    glitchIntensity: DEFAULT_TRANSITION_GLITCH_INTENSITY,
    glitchBlockPx: DEFAULT_TRANSITION_GLITCH_BLOCK_PX,
    blurRadiusPx: DEFAULT_TRANSITION_BLUR_RADIUS_PX,
    displacementAmount: DEFAULT_TRANSITION_DISPLACEMENT_AMOUNT,
    displacementScale: DEFAULT_TRANSITION_DISPLACEMENT_SCALE,
    effectSeed: DEFAULT_TRANSITION_EFFECT_SEED,
    easing: LINEAR_EASING,
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // jsdom lays everything out at 0×0; give the mirror a real width so the cue
    // lane + its handles occupy pixels and getBoundingClientRect starts at 0,0.
    clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    clientHeightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function getRect() {
      const graph = this.classList?.contains('vmt-easing-graph')
      const compass = this.classList?.contains('vmt-line-sweep-compass')
      const width = graph ? 176 : (compass ? 50 : 1000)
      const height = graph ? 96 : (compass ? 50 : 200)
      return {
        left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON() {},
      }
    })
    ctxSpy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeCtx())
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    clientWidthSpy.mockRestore()
    clientHeightSpy.mockRestore()
    rectSpy.mockRestore()
    ctxSpy.mockRestore()
  })

  function pointer(type, target, clientX = 0, opts = {}) {
    const Ctor = window.PointerEvent || window.MouseEvent
    const ev = new Ctor(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 10, ...opts })
    target.dispatchEvent(ev)
  }

  function key(target, keyName, opts = {}) {
    target.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: keyName, ...opts,
    }))
  }

  // TransitionParameterControl now renders the shared Fader primitive (see
  // ui/src/components/controls/Fader.jsx) instead of a native
  // <input type="range">, so it has no aria-label/value to query or set
  // directly. Faders carry no per-field attribute of their own — the label
  // lives in the sibling <span> — so locate by that instead.
  function faderRowFor(container, label) {
    const rows = [...container.querySelectorAll('.vmt-transition-parameter')]
    return rows.find((row) => row.querySelector('span')?.textContent === label) ?? null
  }
  function faderFor(container, label) {
    return faderRowFor(container, label)?.querySelector('.xleth-fader') ?? null
  }

  // Fader batches pointermove into one dragLaw update per animation frame
  // (see Fader.jsx) — every simulated move needs a flushed frame before its
  // effect is observable.
  async function flushFrame() {
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
  }

  // Drives a real grab-relative drag on a horizontal Fader from `from` to
  // `to` within [min, max] and commits on release — the same gesture a user
  // performs, replacing the old "set .value + dispatch input" shortcut that
  // only worked on a native range input. dragRangePx=1000 matches this
  // file's global clientWidth mock (see beforeEach), which Fader reads via
  // resolveDragRange() for its horizontal fill-mode groove.
  async function dragFaderTo(el, { min, max, from, to, dragRangePx = 1000 }) {
    const startNorm = (from - min) / (max - min)
    const targetNorm = (to - min) / (max - min)
    const startX = 100
    const endX = startX + (targetNorm - startNorm) * dragRangePx
    await act(async () => { pointer('pointerdown', el, startX) })
    await act(async () => { pointer('pointermove', el, endX) })
    await flushFrame()
    await act(async () => { pointer('pointerup', el, endX) })
  }

  async function renderCanvas(onSetCueTransition, transition = INITIAL) {
    const onRemoveCue = vi.fn()
    const props = {
      pixelsPerBeatRef: { current: 40 },
      scrollOffsetRef: { current: 0 },
      playheadBeatRef: { current: 0 },
      bpmRef: { current: 120 },
      tracks: [], clips: [], regions: {}, patternBlocks: [], patterns: {},
      cues: [{ tick: PIN_TICK, snapshotId: 's1', transition: { ...transition } }],
      snapshots: [{ id: 's1', name: 'Base', active: true }],
      defaultSnapshotId: 's1',
      totalBeats: 64,
      snapGranularity: '1/16',
      onScrub: vi.fn(), onWheel: vi.fn(),
      onMoveCue: vi.fn().mockResolvedValue(true),
      onRemoveCue, onRepointCue: vi.fn(),
      onSetCueTransition,
    }
    // First render mounts (the size effect sets the internal size ref); the
    // second render lets the cue lane read that width for its handle geometry.
    await act(async () => { root.render(<VideoMirrorCanvas {...props} />) })
    await act(async () => { root.render(<VideoMirrorCanvas {...props} />) })
    return { onRemoveCue }
  }

  it('dragging the End handle emits a full transition with the snapped offset', async () => {
    const onSetCueTransition = vi.fn()
    await renderCanvas(onSetCueTransition)

    // Select the cue (click its marker: pointer down then up with no movement).
    const marker = container.querySelector('.vmt-cue-marker')
    expect(marker).toBeTruthy()
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })

    // Handles now render for the selected cue.
    const endHandle = container.querySelector('.vmt-transition-handle-end')
    expect(endHandle).toBeTruthy()

    // Drag End to localX 400 → 10 beats → 9600 ticks after the pin at tick 0.
    await act(async () => {
      pointer('pointerdown', endHandle, 10)
      pointer('pointermove', window, 400)
      pointer('pointerup', window, 400)
    })

    expect(onSetCueTransition).toHaveBeenCalledTimes(1)
    const [tick, payload] = onSetCueTransition.mock.calls[0]
    expect(tick).toBe(PIN_TICK)
    expect(Object.keys(payload).sort()).toEqual([...TRANSITION_KEYS].sort())
    expect(payload.enabled).toBe(true)
    expect(payload.endOffsetTicks).toBe(10 * PPQ)   // 9600
    expect(payload.startOffsetTicks).toBe(480)      // untouched outgoing handle
    expect(Number.isInteger(payload.endOffsetTicks)).toBe(true)
    expect(container.textContent).not.toContain('Freeze outgoing')
  })

  it('a hard cut (handles collapsed on the pin) is the zero-length default', () => {
    // The default transition authored by the UI is disabled with no window.
    const hardCut = buildCueTransition(undefined)
    expect(hardCut.enabled).toBe(false)
    expect(hardCut.startOffsetTicks).toBe(0)
    expect(hardCut.endOffsetTicks).toBe(0)
  })

  it('shows the compass only for Line Sweep and commits a complete snapped direction payload', async () => {
    const onSetCueTransition = vi.fn()
    await renderCanvas(onSetCueTransition, {
      ...INITIAL,
      type: 'lineSweep',
      geomAngleDeg: 45,
    })
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })

    const compass = container.querySelector('.vmt-line-sweep-compass')
    expect(compass).toBeTruthy()
    expect(faderFor(container, 'Feather')).toBeTruthy()
    expect(compass.getAttribute('aria-valuetext')).toBe('Custom direction, 45 degrees')

    // Compass center is (25, 25); this is 88° and must snap to 90°.
    await act(async () => { pointer('pointerdown', compass, 26, { clientY: 50 }) })
    expect(onSetCueTransition).not.toHaveBeenCalled()
    await act(async () => { pointer('pointerup', compass, 26, { clientY: 50 }) })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    const payload = onSetCueTransition.mock.calls[0][1]
    expect(payload.type).toBe('lineSweep')
    expect(payload.geomAngleDeg).toBe(90)
    expect(payload.startOffsetTicks).toBe(INITIAL.startOffsetTicks)
    expect(payload.endOffsetTicks).toBe(INITIAL.endOffsetTicks)
    expect(payload.easing).toEqual(INITIAL.easing)

    onSetCueTransition.mockClear()
    await act(async () => { key(compass, 'ArrowLeft', { ctrlKey: true }) })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    expect(onSetCueTransition.mock.calls[0][1].geomAngleDeg).toBe(89)
  })

  it('does not show the direction compass for Crossfade', async () => {
    await renderCanvas(vi.fn())
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    expect(container.querySelector('.vmt-line-sweep-compass')).toBeNull()
  })

  it('uses cardinal-only direction for Push and preserves the full parameter payload', async () => {
    const onSetCueTransition = vi.fn()
    await renderCanvas(onSetCueTransition, {
      ...INITIAL, type: 'push', geomAngleDeg: 40, edgeSoftness: 0.03,
      zoomAmount: 0.2, dissolveGrainPx: 4,
    })
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    const compass = container.querySelector('.vmt-line-sweep-compass')
    expect(compass.getAttribute('aria-label')).toBe('Push direction')
    expect(compass.getAttribute('aria-valuenow')).toBe('0')
    await act(async () => { key(compass, 'ArrowRight') })
    const payload = onSetCueTransition.mock.calls[0][1]
    expect(payload.geomAngleDeg).toBe(90)
    expect(payload.edgeSoftness).toBe(0.03)
    expect(payload.zoomAmount).toBe(0.2)
    expect(payload.dissolveGrainPx).toBe(4)
  })

  it('shows only the curated parameter control for Zoom and Dissolve', async () => {
    const onSetCueTransition = vi.fn()
    await renderCanvas(onSetCueTransition, { ...INITIAL, type: 'zoom', zoomAmount: 0.2 })
    let marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    const zoom = faderFor(container, 'Zoom intensity')
    expect(zoom).toBeTruthy()
    expect(faderFor(container, 'Dissolve grain')).toBeNull()
    expect(container.querySelector('.vmt-line-sweep-compass')).toBeNull()
    await dragFaderTo(zoom, { min: 0, max: 0.30, from: 0.2, to: 0.24 })
    expect(onSetCueTransition.mock.calls.at(-1)[1].zoomAmount).toBe(0.24)

    onSetCueTransition.mockClear()
    await renderCanvas(onSetCueTransition, { ...INITIAL, type: 'dissolve', dissolveGrainPx: 5 })
    marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    const grain = faderFor(container, 'Dissolve grain')
    expect(grain).toBeTruthy()
    expect(faderFor(container, 'Zoom intensity')).toBeNull()
    await dragFaderTo(grain, { min: 1, max: 8, from: 5, to: 7 })
    expect(onSetCueTransition.mock.calls.at(-1)[1].dissolveGrainPx).toBe(7)
  })

  it('shows categorized Advanced modes with only their relevant controls', async () => {
    const onSetCueTransition = vi.fn()
    const openEditor = async (transition) => {
      await renderCanvas(onSetCueTransition, { ...INITIAL, ...transition })
      const marker = container.querySelector('.vmt-cue-marker')
      await act(async () => {
        pointer('pointerdown', marker, 0)
        pointer('pointerup', window, 0)
      })
    }

    await openEditor({ type: 'radialReveal', radialOriginX: 0.3, radialOriginY: 0.7 })
    expect(faderFor(container, 'Origin X')).toBeTruthy()
    expect(faderFor(container, 'Origin Y')).toBeTruthy()
    expect(faderFor(container, 'Feather')).toBeTruthy()
    const typeSelect = container.querySelector('[aria-label^="Animation type for cue"]')
    await act(async () => { typeSelect.click() })
    expect([...document.querySelectorAll('.xleth-select-group-label')].map(node => node.textContent))
      .toEqual(['Basic', 'Advanced'])
    expect(document.querySelector('[role="option"][data-value="displacement"]')).toBeTruthy()

    await openEditor({ type: 'pixelate', pixelateMaxBlockPx: 48 })
    const maxBlock = faderFor(container, 'Max block')
    expect(maxBlock).toBeTruthy()
    expect(faderFor(container, 'Intensity')).toBeNull()
    await dragFaderTo(maxBlock, { min: 1, max: 128, from: 48, to: 64 })
    const pixelatePayload = onSetCueTransition.mock.calls.at(-1)[1]
    expect(pixelatePayload.pixelateMaxBlockPx).toBe(64)
    expect(Object.keys(pixelatePayload).sort()).toEqual([...TRANSITION_KEYS].sort())

    await openEditor({ type: 'glitch', effectSeed: 12 })
    expect(faderFor(container, 'Intensity')).toBeTruthy()
    expect(faderFor(container, 'Slice height')).toBeTruthy()
    expect(faderFor(container, 'Seed')).toBeTruthy()

    await openEditor({ type: 'blurThrough', geomAngleDeg: 33 })
    expect(faderFor(container, 'Blur radius')).toBeTruthy()
    expect(container.querySelector('.vmt-line-sweep-compass')?.getAttribute('aria-label'))
      .toBe('Blur Through direction')

    await openEditor({ type: 'displacement', displacementAmount: 0.1 })
    expect(faderFor(container, 'Strength')).toBeTruthy()
    expect(faderFor(container, 'Noise scale')).toBeTruthy()
    expect(faderFor(container, 'Seed')).toBeTruthy()
    expect(container.querySelector('.vmt-line-sweep-compass')).toBeNull()
  })

  it('uses X to close the editor and a separate trash button to delete the cue', async () => {
    const { onRemoveCue } = await renderCanvas(vi.fn())
    const marker = container.querySelector('.vmt-cue-marker')

    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })

    const close = container.querySelector('.vmt-close-cue-editor')
    expect(close).toBeTruthy()
    expect(container.querySelector('.vmt-delete-cue')).toBeTruthy()

    await act(async () => { close.click() })
    expect(container.querySelector('.vmt-cue-editor')).toBeNull()
    expect(onRemoveCue).not.toHaveBeenCalled()

    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    await act(async () => { container.querySelector('.vmt-delete-cue').click() })
    expect(onRemoveCue).toHaveBeenCalledOnce()
    expect(onRemoveCue).toHaveBeenCalledWith(PIN_TICK)
  })

  it('keeps easing collapsed by default and expands to one joined four-handle graph', async () => {
    await renderCanvas(vi.fn())
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })

    const summary = container.querySelector('.vmt-easing-summary')
    expect(summary).toBeTruthy()
    expect(summary.getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.vmt-easing-graph')).toBeNull()

    await act(async () => { summary.click() })
    expect(summary.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelectorAll('.vmt-easing-control')).toHaveLength(4)
    expect(container.querySelector('.vmt-easing-control.is-pin-outer')).toBeTruthy()
    expect(container.querySelector('.vmt-easing-control.is-pin-inner')).toBeTruthy()
    expect(container.querySelector('.vmt-easing-anchor.is-pin')).toBeTruthy()
  })

  it('previews a curve handle locally and commits one bounded payload on pointer release', async () => {
    const onSetCueTransition = vi.fn()
    await renderCanvas(onSetCueTransition)
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    await act(async () => { container.querySelector('.vmt-easing-summary').click() })

    const graph = container.querySelector('.vmt-easing-graph')
    const control = container.querySelector('.vmt-easing-control')
    await act(async () => {
      pointer('pointerdown', control, 10, { clientY: 86 })
      pointer('pointermove', graph, 40, { clientY: 60 })
    })
    expect(onSetCueTransition).not.toHaveBeenCalled()

    await act(async () => { pointer('pointerup', graph, 40, { clientY: 60 }) })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    const payload = onSetCueTransition.mock.calls[0][1]
    expect(payload.easing.startToPin.x1).toBeCloseTo((40 - 10) / 78)
    expect(payload.easing.startToPin.y1).toBeCloseTo((86 - 60) / 38)
    expect(payload.easing.pinToEnd).toEqual(LINEAR_EASING.pinToEnd)
  })

  it('supports keyboard adjustments, per-half presets, and resetting both halves', async () => {
    const onSetCueTransition = vi.fn()
    const customTransition = {
      ...INITIAL,
      easing: {
        startToPin: { x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.8 },
        pinToEnd: { x1: 0.1, y1: 0.2, x2: 0.9, y2: 0.7 },
      },
    }
    await renderCanvas(onSetCueTransition, customTransition)
    const marker = container.querySelector('.vmt-cue-marker')
    await act(async () => {
      pointer('pointerdown', marker, 0)
      pointer('pointerup', window, 0)
    })
    await act(async () => { container.querySelector('.vmt-easing-summary').click() })

    const firstControl = container.querySelector('.vmt-easing-control')
    await act(async () => { key(firstControl, 'ArrowRight') })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    expect(onSetCueTransition.mock.calls[0][1].easing.startToPin.x1).toBeCloseTo(0.21)
    expect(onSetCueTransition.mock.calls[0][1].easing.pinToEnd).toEqual(customTransition.easing.pinToEnd)

    onSetCueTransition.mockClear()
    const presetSelect = container.querySelector('.vmt-easing-preset-select')
    await act(async () => { presetSelect.click() })
    const easeOutOption = document.body.querySelector('.xleth-select-option[data-value="easeOut"]')
    expect(easeOutOption).toBeTruthy()
    await act(async () => { easeOutOption.click() })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    expect(onSetCueTransition.mock.calls[0][1].easing.startToPin)
      .toEqual(TRANSITION_EASING_PRESETS.easeOut.curve)

    onSetCueTransition.mockClear()
    await act(async () => { container.querySelector('.vmt-easing-reset').click() })
    expect(onSetCueTransition).toHaveBeenCalledOnce()
    expect(onSetCueTransition.mock.calls[0][1].easing).toEqual(LINEAR_EASING)
  })
})

describe('snapshot transition easing normalization', () => {
  it('defaults malformed halves to linear and clamps complete finite curves', () => {
    expect(normalizeTransitionEasing()).toEqual(LINEAR_EASING)
    expect(normalizeTransitionEasing({
      startToPin: { x1: -2, y1: 3, x2: Number.NaN, y2: 0.75 },
      pinToEnd: { x1: -2, y1: 3, x2: 0.25, y2: 0.75 },
    })).toEqual({
      startToPin: { ...LINEAR_TRANSITION_CURVE },
      pinToEnd: { x1: 0, y1: 1, x2: 0.25, y2: 0.75 },
    })
  })
})
