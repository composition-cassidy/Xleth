// @vitest-environment jsdom
//
// Slice 4 — snapshot transition editor. Covers the two things the UI actually
// owns: (1) the pure math that turns a handle drag into whole-tick offsets
// (grid snap by default, Alt frees the snap but still quantizes to a whole
// tick), and (2) the exact six-field payload every write hands to
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
} from './VideoMirrorCanvas.jsx'
import { PPQ } from '../../constants/timeline.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TRANSITION_KEYS = [
  'enabled', 'startOffsetTicks', 'endOffsetTicks', 'type', 'freezeOutgoing', 'geomAngleDeg',
]

// ── Pure helpers ────────────────────────────────────────────────────────────

describe('buildCueTransition — the setCueTransition payload', () => {
  it('defaults to a hard cut with all six fields (zero-length window)', () => {
    const tr = buildCueTransition(undefined)
    expect(Object.keys(tr).sort()).toEqual([...TRANSITION_KEYS].sort())
    expect(tr).toEqual({
      enabled: false,
      startOffsetTicks: 0,
      endOffsetTicks: 0,
      type: 'crossfade',
      freezeOutgoing: true,
      geomAngleDeg: 0,
    })
  })

  it('always emits the full six-field shape with correct types', () => {
    const tr = buildCueTransition({ enabled: true, startOffsetTicks: 240, endOffsetTicks: 240 })
    expect(Object.keys(tr).sort()).toEqual([...TRANSITION_KEYS].sort())
    expect(typeof tr.enabled).toBe('boolean')
    expect(typeof tr.startOffsetTicks).toBe('number')
    expect(typeof tr.endOffsetTicks).toBe('number')
    expect(typeof tr.type).toBe('string')
    expect(typeof tr.freezeOutgoing).toBe('boolean')
    expect(typeof tr.geomAngleDeg).toBe('number')
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

  it('changing type or freeze never moves the handles', () => {
    const current = { enabled: true, startOffsetTicks: 480, endOffsetTicks: 600, type: 'crossfade' }
    const typed = buildCueTransition(current, { type: 'lineSweep' })
    expect(typed.type).toBe('lineSweep')
    expect(typed.startOffsetTicks).toBe(480)
    expect(typed.endOffsetTicks).toBe(600)

    const frozen = buildCueTransition(current, { freezeOutgoing: false })
    expect(frozen.freezeOutgoing).toBe(false)
    expect(frozen.startOffsetTicks).toBe(480)
    expect(frozen.endOffsetTicks).toBe(600)
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
    type: 'crossfade', freezeOutgoing: true, geomAngleDeg: 0,
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // jsdom lays everything out at 0×0; give the mirror a real width so the cue
    // lane + its handles occupy pixels and getBoundingClientRect starts at 0,0.
    clientWidthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    clientHeightSpy = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 200, width: 1000, height: 200, x: 0, y: 0, toJSON() {},
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

  async function renderCanvas(onSetCueTransition) {
    const props = {
      pixelsPerBeatRef: { current: 40 },
      scrollOffsetRef: { current: 0 },
      playheadBeatRef: { current: 0 },
      bpmRef: { current: 120 },
      tracks: [], clips: [], regions: {}, patternBlocks: [], patterns: {},
      cues: [{ tick: PIN_TICK, snapshotId: 's1', transition: { ...INITIAL } }],
      snapshots: [{ id: 's1', name: 'Base', active: true }],
      defaultSnapshotId: 's1',
      totalBeats: 64,
      snapGranularity: '1/16',
      onScrub: vi.fn(), onWheel: vi.fn(),
      onMoveCue: vi.fn().mockResolvedValue(true),
      onRemoveCue: vi.fn(), onRepointCue: vi.fn(),
      onSetCueTransition,
    }
    // First render mounts (the size effect sets the internal size ref); the
    // second render lets the cue lane read that width for its handle geometry.
    await act(async () => { root.render(<VideoMirrorCanvas {...props} />) })
    await act(async () => { root.render(<VideoMirrorCanvas {...props} />) })
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
  })

  it('a hard cut (handles collapsed on the pin) is the zero-length default', () => {
    // The default transition authored by the UI is disabled with no window.
    const hardCut = buildCueTransition(undefined)
    expect(hardCut.enabled).toBe(false)
    expect(hardCut.startOffsetTicks).toBe(0)
    expect(hardCut.endOffsetTicks).toBe(0)
  })
})
