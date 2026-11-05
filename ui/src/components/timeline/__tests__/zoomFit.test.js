import { describe, it, expect } from 'vitest'
import {
  contentEndBeats, fitBeatsFor, minPpbFor, maxScrollFor, wheelZoomSteps,
  FIT_MIN_BEATS, FIT_BLEND_RATIO, ABS_MIN_PPB,
} from '../zoomFit.js'
import { scrollExtent } from '../TimelineScrollbar.jsx'
import { barStrideFor, BAR_LABEL_MIN_PX } from '../timelineDrawing.js'
import { BEATS_PER_BAR, MAX_PPB, ZOOM_FACTOR, beatsToTicks } from '../../../constants/timeline.js'

describe('contentEndBeats', () => {
  it('takes the furthest end across every list', () => {
    const clips = [{ positionTicks: 0, durationTicks: 960 }, { positionTicks: 9600, durationTicks: 960 }]
    const blocks = [{ positionTicks: 19200, durationTicks: 1920 }]
    expect(contentEndBeats([clips, blocks, null])).toBe(22)
  })

  it('counts point-like extras (cues) and tolerates empty input', () => {
    expect(contentEndBeats([], [beatsToTicks(48)])).toBe(48)
    expect(contentEndBeats()).toBe(0)
  })
})

describe('fitBeatsFor / minPpbFor', () => {
  it('fits the song plus a tail, never less than the floor', () => {
    expect(fitBeatsFor(0)).toBe(FIT_MIN_BEATS)
    const fit = fitBeatsFor(1000)
    expect(fit).toBeGreaterThan(1000)
    expect(fit).toBeLessThan(1000 * 1.05)
  })

  it('makes the fit span exactly fill the canvas at the minimum zoom', () => {
    const fit = fitBeatsFor(264)
    const min = minPpbFor(710, fit)
    expect(710 / min).toBeCloseTo(fit, 9)
  })

  it('goes below the old fixed 8 px/beat floor for a long song', () => {
    // BFDIA 9-sized song in a ~700px panel: old floor showed ~22 bars.
    expect(minPpbFor(710, fitBeatsFor(264))).toBeLessThan(8)
  })

  it('stays inside the absolute zoom range', () => {
    expect(minPpbFor(0, 100)).toBe(ABS_MIN_PPB)
    expect(minPpbFor(100, 1e9)).toBe(ABS_MIN_PPB)
    expect(minPpbFor(1e9, 1)).toBe(MAX_PPB)
  })
})

describe('maxScrollFor', () => {
  const canvasWidth = 710
  const workspaceBeats = 2048
  const fitBeats = fitBeatsFor(264)
  const minPpb = minPpbFor(canvasWidth, fitBeats)
  const bound = (ppb) => maxScrollFor({ ppb, canvasWidth, workspaceBeats, fitBeats, minPpb })

  it('is 0 at the minimum zoom, so the whole song is pinned on screen', () => {
    expect(bound(minPpb)).toBe(0)
  })

  it('matches the old full-workspace bound once zoomed well in', () => {
    const ppb = minPpb * FIT_BLEND_RATIO * 2
    expect(bound(ppb)).toBeCloseTo(workspaceBeats - canvasWidth / ppb, 9)
    expect(bound(40)).toBeCloseTo(workspaceBeats - canvasWidth / 40, 9)
  })

  it('is continuous and non-decreasing across the whole zoom range', () => {
    // A bound that jumps as ppb eases is exactly what makes the clamp yank
    // the view mid-zoom; a bound that dips makes a zoom-IN shove it back.
    let prev = bound(minPpb)
    for (let ppb = minPpb; ppb < 400; ppb *= 1.01) {
      const b = bound(ppb)
      expect(b).toBeGreaterThanOrEqual(prev - 1e-9)
      expect(b - prev).toBeLessThan(40) // no step bigger than a 1% zoom move
      prev = b
    }
  })

  it('never lets the scrollbar extent go below the visible window', () => {
    for (const ppb of [minPpb, minPpb * 1.5, 10, 40, 500]) {
      const visible = canvasWidth / ppb
      expect(scrollExtent(bound(ppb), visible, workspaceBeats)).toBeGreaterThanOrEqual(visible - 1e-9)
    }
  })

  it('handles a song longer than the workspace floor', () => {
    const fit = fitBeatsFor(5000)
    const min = minPpbFor(canvasWidth, fit)
    expect(maxScrollFor({ ppb: min, canvasWidth, workspaceBeats: 5256, fitBeats: fit, minPpb: min })).toBe(0)
  })
})

describe('wheelZoomSteps', () => {
  it('turns one mouse notch into exactly one zoom step', () => {
    expect(wheelZoomSteps(100)).toBe(-1)   // wheel down = zoom out
    expect(wheelZoomSteps(-100)).toBe(1)
    expect(wheelZoomSteps(250)).toBe(-1)   // accelerated notch: still one step
  })

  it('scales small touchpad/precision deltas to a fraction of a step', () => {
    expect(wheelZoomSteps(10)).toBeCloseTo(-0.1, 9)
    // Twenty 5px events = one notch's worth of zoom, not twenty notches.
    const total = Array.from({ length: 20 }, () => wheelZoomSteps(5)).reduce((a, b) => a + b, 0)
    expect(ZOOM_FACTOR ** total).toBeCloseTo(1 / ZOOM_FACTOR, 9)
  })

  it('treats line/page-mode events as whole notches', () => {
    expect(wheelZoomSteps(3, 1)).toBe(-1)
    expect(wheelZoomSteps(-1, 2)).toBe(1)
  })

  it('ignores zero/garbage deltas', () => {
    expect(wheelZoomSteps(0)).toBe(0)
    expect(wheelZoomSteps(NaN)).toBe(0)
  })
})

describe('barStrideFor', () => {
  it('labels every bar at normal zoom', () => {
    expect(barStrideFor(40, BAR_LABEL_MIN_PX)).toBe(1)
    expect(barStrideFor(9, BAR_LABEL_MIN_PX)).toBe(1)
  })

  it('thins labels by powers of two so they never crowd', () => {
    for (const ppb of [8, 4, 1, 0.3, 0.05]) {
      const stride = barStrideFor(ppb, BAR_LABEL_MIN_PX)
      expect(Math.log2(stride) % 1).toBe(0)
      expect(stride * BEATS_PER_BAR * ppb).toBeGreaterThanOrEqual(BAR_LABEL_MIN_PX)
      // ...and it's the SPARSEST such stride, not an arbitrarily coarse one.
      if (stride > 1) expect((stride / 2) * BEATS_PER_BAR * ppb).toBeLessThan(BAR_LABEL_MIN_PX)
    }
  })
})
