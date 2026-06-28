import { describe, expect, it } from 'vitest'
import {
  MAX_TRACK_HEIGHT,
  MIN_TRACK_HEIGHT,
  beatToGridLinePixel,
  beatToPlayheadPixel,
  beatsToTicks,
  snapBeatToGrid,
  zoomTrackHeight,
} from './timeline.js'

describe('timeline coordinate helpers', () => {
  it('uses the active granularity when snapping beats', () => {
    expect(snapBeatToGrid(24.37, {}, 'Bar')).toBe(24)
    expect(snapBeatToGrid(24.37, {}, 'Half')).toBe(24)
    expect(snapBeatToGrid(24.37, {}, '1/8')).toBe(24.5)
    expect(snapBeatToGrid(24.37, {}, '1/64')).toBe(24.375)
  })

  it('keeps modifier snap overrides intact', () => {
    expect(snapBeatToGrid(24.37, { alt: true }, 'Bar')).toBe(24.37)
    expect(snapBeatToGrid(24.37, { shift: true }, 'Bar')).toBe(24.375)
    expect(snapBeatToGrid(24.37, { ctrl: true }, 'Bar')).toBe(24.5)
  })

  it('places a 1px DOM playhead on the same pixel column as canvas grid lines', () => {
    expect(beatToGridLinePixel(24, 0, 40)).toBe(960.5)
    expect(beatToPlayheadPixel(24, 0, 40, 1)).toBe(960)
  })

  it('can convert edit cursor beats without forcing the 1/16 grid', () => {
    expect(beatsToTicks(24.37)).toBe(23395)
    expect(beatsToTicks(snapBeatToGrid(24.37))).toBe(23280)
  })

  it('zooms track height in wheel direction and clamps the range', () => {
    expect(zoomTrackHeight(50, -1)).toBe(57)
    expect(zoomTrackHeight(50, 1)).toBe(43)
    expect(zoomTrackHeight(MAX_TRACK_HEIGHT, -1)).toBe(MAX_TRACK_HEIGHT)
    expect(zoomTrackHeight(MIN_TRACK_HEIGHT, 1)).toBe(MIN_TRACK_HEIGHT)
  })
})
