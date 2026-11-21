import { describe, expect, it } from 'vitest'
import {
  MIN_VIEW_DUR, centreView, followView, moveView, panView, resolveView, rulerLabel, rulerStep,
  timeToX, viewForRange, xToTime, zoomView,
} from './pickerView.js'
import { makeTile, pickTile, rememberTile, tileRequest, tileSlice } from './pickerPeaks.js'
import { formatFps, formatSpan, formatTimecode, frameAt, parseTimecode } from './pickerFormat.js'
import { legibleOn } from './PickerWaveform.jsx'

const D = 100

describe('pickerView: the one px <-> time conversion', () => {
  it('null is fit, and stays fit whatever the duration turns out to be', () => {
    expect(resolveView(null, D)).toMatchObject({ start: 0, end: D, zoomed: false })
    expect(resolveView(null, 0)).toMatchObject({ start: 0, end: 0, zoomed: false })
  })

  it('clamps a stored view when it is read, never past the source', () => {
    expect(resolveView({ start: 90, end: 130 }, D)).toMatchObject({ start: 60, end: 100, zoomed: true })
    expect(resolveView({ start: -5, end: 5 }, D)).toMatchObject({ start: 0, end: 10 })
  })

  it('zooms about the anchor so the time under the cursor does not move', () => {
    const v = zoomView(null, D, 1 / 1.25, 25)
    const r = resolveView(v, D)
    expect(r.dur).toBeCloseTo(80, 6)
    // 25 s was at 25 % of the view and still is.
    expect((25 - r.start) / r.dur).toBeCloseTo(0.25, 6)
  })

  it('zooming out to the whole source returns to fit, and never zooms past the floor', () => {
    expect(zoomView({ start: 10, end: 95 }, D, 1.25, 50)).toBeNull()
    let v = null
    for (let i = 0; i < 80; i += 1) v = zoomView(v, D, 1 / 1.25, 50)
    expect(resolveView(v, D).dur).toBeCloseTo(MIN_VIEW_DUR, 6)
  })

  it('pans, centres and moves inside the source only', () => {
    expect(panView(null, D, 10)).toBeNull()
    expect(resolveView(panView({ start: 80, end: 100 }, D, 50), D)).toMatchObject({ start: 80, end: 100 })
    expect(resolveView(centreView({ start: 0, end: 20 }, D, 50), D)).toMatchObject({ start: 40, end: 60 })
    expect(resolveView(moveView({ start: 0, end: 20 }, D, 95), D)).toMatchObject({ start: 80, end: 100 })
  })

  it('frames a selection with padding, and a selection that is the whole source is fit', () => {
    const r = resolveView(viewForRange(40, 50, D), D)
    expect(r.start).toBeLessThan(40)
    expect(r.end).toBeGreaterThan(50)
    expect((r.start + r.end) / 2).toBeCloseTo(45, 6)
    expect(viewForRange(0, D, D)).toBeNull()
    expect(viewForRange(5, 5, D)).toBeNull()
  })

  it('follows the playhead by paging, and hands back the same object when it need not move', () => {
    const view = { start: 10, end: 20 }
    expect(followView(view, D, 15)).toBe(view)
    const next = resolveView(followView(view, D, 21), D)
    expect(next.start).toBeCloseTo(20, 6)
    expect(followView(null, D, 99)).toBeNull()
  })

  it('maps time to x and back', () => {
    const r = resolveView({ start: 20, end: 40 }, D)
    expect(timeToX(30, r, 1000)).toBeCloseTo(500, 6)
    expect(xToTime(500, r, 1000, D)).toBeCloseTo(30, 6)
    expect(xToTime(99999, r, 1000, D)).toBe(D)
    expect(xToTime(-99999, r, 1000, D)).toBe(0)
  })

  it('picks ruler steps on a 1-2-5 ladder, far enough apart to label', () => {
    for (const pxPerSec of [0.5, 3, 10, 80, 600, 5000, 40000]) {
      const { major, minor } = rulerStep(pxPerSec, 72)
      expect(major * pxPerSec).toBeGreaterThanOrEqual(72)
      expect(minor).toBeLessThanOrEqual(major)
      if (minor < major) expect(minor * pxPerSec).toBeGreaterThanOrEqual(6)
    }
    expect(rulerLabel(65, 5)).toBe('1:05')
    expect(rulerLabel(1.5, 0.5)).toBe('0:01.5')
    expect(rulerLabel(1.204, 0.001)).toBe('0:01.204')
  })
})

describe('pickerPeaks: which peaks to draw, and when to ask for more', () => {
  const peaks = (cols) => new Float32Array(cols * 3)
  const base = makeTile(peaks(4000), 0, D)

  it('draws from the whole-file peaks until a denser tile covers the view', () => {
    expect(pickTile([], base, 10, 12)).toBe(base)
    const tile = makeTile(peaks(3000), 9, 13)
    expect(pickTile([tile], base, 10, 12)).toBe(tile)
    // A tile that does not cover the view is not used for it.
    expect(pickTile([tile], base, 12, 14)).toBe(base)
  })

  it('asks for a padded tile only when nothing held is dense enough', () => {
    // Fit: 4000 columns across 1000 px is plenty.
    expect(tileRequest(base, 0, D, D, 1000)).toBeNull()
    const req = tileRequest(base, 10, 12, D, 1000)
    expect(req.start).toBeCloseTo(9, 6)
    expect(req.end).toBeCloseTo(13, 6)
    expect(req.cols).toBe(2000)
    const tile = makeTile(peaks(req.cols), req.start, req.end, req.cols)
    // Panning inside the padding needs no fetch.
    expect(tileRequest(pickTile([tile], base, 10.5, 12.5), 10.5, 12.5, D, 1000)).toBeNull()
  })

  it('stops asking once the mipmap has nothing finer', () => {
    const short = makeTile(peaks(100), 9, 13, 2000)
    expect(short.maxed).toBe(true)
    expect(tileRequest(short, 10, 12, D, 1000)).toBeNull()
  })

  it('keeps a bounded, newest-first cache and replaces a tile for the same window', () => {
    let tiles = []
    for (let i = 0; i < 12; i += 1) tiles = rememberTile(tiles, makeTile(peaks(10), i, i + 1))
    expect(tiles).toHaveLength(8)
    expect(tiles[0].start).toBe(11)
    const again = makeTile(peaks(20), 11, 12)
    tiles = rememberTile(tiles, again)
    expect(tiles).toHaveLength(8)
    expect(tiles[0]).toBe(again)
  })

  it('slices a tile to whole columns and reports where their edges sit', () => {
    const tile = makeTile(peaks(100), 0, 10)   // 0.1 s per column
    const { c0, c1, t0, t1 } = tileSlice(tile, 1.05, 2.02)
    expect([c0, c1]).toEqual([10, 21])
    expect(t0).toBeCloseTo(1.0, 6)
    expect(t1).toBeCloseTo(2.1, 6)
  })
})

describe('pickerFormat', () => {
  it('formats positions as m:ss.mmm and an unset point as a dash', () => {
    expect(formatTimecode(0)).toBe('0:00.000')
    expect(formatTimecode(61.2045)).toBe('1:01.205')
    expect(formatTimecode(59.9996)).toBe('1:00.000')
    expect(formatTimecode(12.25, 2)).toBe('0:12.25')
    expect(formatTimecode(null)).toBe('—')
  })

  it('parses what it prints, and plain seconds', () => {
    expect(parseTimecode('1:01.205')).toBeCloseTo(61.205, 6)
    expect(parseTimecode('62.5')).toBeCloseTo(62.5, 6)
    expect(parseTimecode('62,5 s')).toBeCloseTo(62.5, 6)
    expect(parseTimecode('1:02:03')).toBe(3723)
    expect(parseTimecode('abc')).toBeNull()
    expect(parseTimecode('')).toBeNull()
    expect(parseTimecode('1::2')).toBeNull()
  })

  it('formats lengths with a thin space before the unit', () => {
    expect(formatSpan(0.1844)).toBe('0.184 s')
    expect(formatSpan(12.4)).toBe('12.40 s')
    expect(formatSpan(75)).toBe('1:15.000')
    expect(formatSpan(null)).toBe('—')
  })

  it('reports frames and frame rates', () => {
    expect(frameAt(1, 30)).toBe(30)
    expect(frameAt(1, 0)).toBeNull()
    expect(formatFps(30)).toBe('30 fps')
    expect(formatFps(29.97)).toBe('29.97 fps')
  })
})

describe('label colours on the waveform', () => {
  const LABELS = ['#FF6B6B', '#FFA94D', '#FFD93D', '#FF6B9D', '#69DB7C', '#748FFC', '#B197FC']
  const lum = (rgb) => {
    const lin = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
  }
  const parse = (c) => (c.startsWith('#')
    ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
    : c.match(/\d+/g).map(Number))
  const ratio = (a, b) => {
    const la = lum(parse(a)); const lb = lum(parse(b))
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }

  it('are left as they are on the dark ground, where they already read', () => {
    for (const c of LABELS) expect(legibleOn(c, '#141414', '#E6E6E6')).toBe('rgb(' + parse(c).join(',') + ')')
  })

  it('reach 3:1 on the light ground, where the raw hues do not', () => {
    for (const c of LABELS) {
      expect(ratio(c, '#DCDCDC')).toBeLessThan(3)
      expect(ratio(legibleOn(c, '#DCDCDC', '#1A1A1A'), '#DCDCDC')).toBeGreaterThanOrEqual(3)
    }
  })
})
