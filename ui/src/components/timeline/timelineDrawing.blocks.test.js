// What the content layer paints for clips and pattern blocks, checked against
// the shared block geometry: the painted rectangle is the hit-tested rectangle,
// borders land on whole pixels, off-screen content costs nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Canvas icons are drawn by drawIcon (ui-kit/icons/canvas.ts); record what is asked for.
const iconCalls = []
vi.mock('../../ui-kit/icons/canvas.ts', () => ({
  drawIcon: (ctx, name, x, y, size) => { iconCalls.push({ name, x, y, size }) },
}))

vi.mock('../../constants/labels.js', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, labelHexColor: vi.fn(() => '#abcdef') }
})

import { TRACK_HEIGHT, beatsToTicks } from '../../constants/timeline.js'
import { labelHexColor } from '../../constants/labels.js'
import { drawClips, drawPatternBlocks, drawWorldSpinners } from './timelineDrawing.js'
import { blockRect, hitTestBlockAt } from './blockGeometry.js'
import { clearCanvasTextFitCache } from './canvasTextFit.js'
import { resetRegime } from './waveformRegime.js'

const PALETTE = {
  bg: '#141414',
  selectionHighlight: '#33ced6',
  clipWaveformFg: '#ffffff',
  clipWaveformBg: '#000000',
  clipFadeOverlay: 'rgba(0,0,0,0.5)',
  clipPitchBoxBg: '#101010',
  clipPitchBoxFg: '#eeeeee',
  clipControlAtLimit: '#ff0000',
  ink: '#e6e6e6',
  inkDark: '#1b1b1b',
  select: '#33ced6',
  accent: '#33ced6',
  labelColors: Object.assign(Object.create(null), { kick: '#aa0000', custom: '#00aa00' }),
}

const TRACK_COLORS = { a: '#336699', b: '#996633' }

function recordingCtx() {
  const calls = []
  const state = {}
  const ctx = new Proxy({}, {
    get(_target, prop) {
      if (prop in state) return state[prop]
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 6 })
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} })
      return (...args) => {
        calls.push({
          op: prop, args,
          fillStyle: state.fillStyle, strokeStyle: state.strokeStyle,
          lineWidth: state.lineWidth, font: state.font,
        })
      }
    },
    set(_target, prop, value) { state[prop] = value; return true },
  })
  return { ctx, calls, of: (op) => calls.filter((c) => c.op === op) }
}

const W = 800
const H = TRACK_HEIGHT * 2

function makeView(ctx, over = {}) {
  return {
    ctx, w: W, h: H,
    scrollOffset: 0, ppb: 40,
    trackIdToIndex: { a: 0, b: 1 },
    trackLayout: null,
    palette: PALETTE,
    displaySettings: null,
    trackColorById: TRACK_COLORS,
    mutedTrackIds: new Set(),
    ...over,
  }
}

const clip = (over = {}) => ({
  id: 1, trackId: 'a', regionId: 'r1',
  positionTicks: beatsToTicks(4), durationTicks: beatsToTicks(4),
  ...over,
})
const REGIONS = { r1: { id: 'r1', name: 'Kick 808', label: 'Kick', startTime: 0, endTime: 8 } }

const clipData = (clips, over = {}) => ({
  clips, regions: REGIONS, selectedClipIds: new Set(), bpm: 120, ...over,
})

const alphaOf = (style) => Number(/rgba\([^)]*,([\d.]+)\)$/.exec(String(style))?.[1])

beforeEach(() => {
  clearCanvasTextFitCache()
  resetRegime()
  labelHexColor.mockClear()
})

describe('drawClips', () => {
  it('clears the layer first, and paints nothing else when there are no clips', () => {
    const { ctx, calls } = recordingCtx()
    drawClips(makeView(ctx), clipData([]))
    expect(calls.map((c) => c.op)).toEqual(['clearRect'])
    expect(calls[0].args).toEqual([0, 0, W, H])
  })

  it('paints the body on the same rectangle the pointer hit-tests', () => {
    const c = clip({ positionTicks: beatsToTicks(4.3) })
    for (const [ppb, scrollOffset] of [[40, 0], [23.7, 0.137], [137.3, 2.41]]) {
      const { ctx, of } = recordingCtx()
      const view = makeView(ctx, { ppb, scrollOffset })
      drawClips(view, clipData([c]))
      const r = blockRect(c, 0, scrollOffset, ppb)
      expect(of('fillRect')[0].args).toEqual([r.x, r.y, r.w, r.h])
      expect(hitTestBlockAt([c], r.x + 0.5, 0, view)).toBe(c)
      expect(hitTestBlockAt([c], r.x + r.w - 0.5, 0, view)).toBe(c)
      expect(hitTestBlockAt([c], r.x - 0.5, 0, view)).toBeNull()
    }
  })

  it('draws a 1px border inside the block, on whole pixels', () => {
    const c = clip({ positionTicks: beatsToTicks(4.3) })
    const { ctx, of } = recordingCtx()
    drawClips(makeView(ctx, { ppb: 23.7, scrollOffset: 0.137 }), clipData([c]))
    const r = blockRect(c, 0, 0.137, 23.7)
    const border = of('strokeRect')[0]
    expect(border.lineWidth).toBe(1)
    expect(border.args).toEqual([r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1])
    // Half-pixel centre + 1px width = exactly one pixel column, none outside.
    expect(Number.isInteger(border.args[0] - 0.5)).toBe(true)
  })

  it('marks a selected clip with a 2px border, a ring inside it and both handles', () => {
    const c = clip()
    const { ctx, of } = recordingCtx()
    drawClips(makeView(ctx), clipData([c], { selectedClipIds: new Set([c.id]) }))
    const r = blockRect(c, 0, 0, 40)
    const [border, ring] = of('strokeRect')
    expect(border.lineWidth).toBe(2)
    expect(border.args).toEqual([r.x + 1, r.y + 1, r.w - 2, r.h - 2])
    expect(ring.lineWidth).toBe(1)
    expect(ring.strokeStyle).toBe(PALETTE.selectionHighlight)
    expect(ring.args).toEqual([r.x + 2.5, r.y + 2.5, r.w - 5, r.h - 5])
    const handles = of('fillRect').filter((f) => f.args[2] === 4 && f.args[3] === r.h)
    expect(handles.map((f) => f.args[0])).toEqual([r.x, r.x + r.w - 4])
  })

  it('skips clips that are off-screen or on an unknown track', () => {
    const { ctx, of } = recordingCtx()
    drawClips(makeView(ctx), clipData([
      clip({ id: 1, positionTicks: beatsToTicks(400) }),          // right of the viewport
      clip({ id: 2, positionTicks: 0, trackId: 'nope' }), // no such track
    ]))
    expect(of('fillRect')).toEqual([])
    const left = recordingCtx()
    drawClips(makeView(left.ctx, { scrollOffset: 100 }), clipData([clip({ positionTicks: 0 })]))
    expect(left.of('fillRect')).toEqual([])
  })

  it('takes the track colour, and otherwise the palette label colour, without reading computed style', () => {
    const tracked = recordingCtx()
    drawClips(makeView(tracked.ctx), clipData([clip()]))
    expect(String(tracked.of('fillRect')[0].fillStyle)).toContain('rgba(51,102,153')

    const labelled = recordingCtx()
    drawClips(makeView(labelled.ctx, { trackColorById: {} }), clipData([clip()]))
    expect(String(labelled.of('fillRect')[0].fillStyle)).toContain('rgba(170,0,0') // labelColors.kick

    const unknown = recordingCtx()
    drawClips(
      makeView(unknown.ctx, { trackColorById: {} }),
      clipData([clip()], { regions: { r1: { ...REGIONS.r1, label: 'Something else' } } }),
    )
    expect(String(unknown.of('fillRect')[0].fillStyle)).toContain('rgba(0,170,0') // labelColors.custom

    // labelHexColor is a getComputedStyle read; the draw loop must not reach it.
    expect(labelHexColor).not.toHaveBeenCalled()
  })

  it('names the clip in its title strip and truncates a name that does not fit', () => {
    const wide = recordingCtx()
    drawClips(makeView(wide.ctx), clipData([clip()]))
    expect(wide.of('fillText').map((t) => t.args[0])).toContain('Kick 808')

    // 2 beats = 80px: 68px for text at 6px per character, so the name is cut.
    const narrow = recordingCtx()
    drawClips(makeView(narrow.ctx), clipData(
      [clip({ durationTicks: beatsToTicks(2) })],
      { regions: { r1: { ...REGIONS.r1, name: 'A very long region name' } } },
    ))
    const text = narrow.of('fillText').map((t) => t.args[0])
    expect(text).toHaveLength(1)
    expect(text[0].endsWith('…')).toBe(true)
    expect(text[0].length).toBeLessThan('A very long region name'.length)

    // 0.5 beat = 20px: body and border only.
    const tiny = recordingCtx()
    drawClips(makeView(tiny.ctx), clipData([clip({ durationTicks: beatsToTicks(0.5) })]))
    expect(tiny.of('fillText')).toEqual([])
  })

  it('labels a syllable clip with its number and text', () => {
    const regions = {
      r1: {
        ...REGIONS.r1,
        syllables: [
          { startTime: 0, text: 'ba' },
          { startTime: 1, number: 0 },   // placeholder: not counted
          { startTime: 2, text: 'da' },
          { startTime: 3, text: '' },
        ],
      },
    }
    const labelOf = (syllableIndex) => {
      const { ctx, of } = recordingCtx()
      drawClips(makeView(ctx), clipData([clip({ syllableIndex })], { regions }))
      return of('fillText').map((t) => t.args[0])[0]
    }
    expect(labelOf(0)).toBe('1 ba')
    expect(labelOf(2)).toBe('2 da')
    expect(labelOf(3)).toBe('3')
  })

  it('dims the waveform and the border of a clip on a muted track', () => {
    const waveformCache = { r1: { peaks: new Float32Array(300).fill(0.5), stride: 3 } }
    const paint = (muted) => {
      resetRegime()
      const { ctx, calls, of } = recordingCtx()
      drawClips(
        makeView(ctx, { mutedTrackIds: new Set(muted ? ['a'] : []) }),
        clipData([clip()], { waveformCache }),
      )
      const waveformFill = calls.find((c) => c.op === 'fill' && String(c.fillStyle).startsWith('rgba(0,0,0'))
      return { waveform: alphaOf(waveformFill.fillStyle), border: alphaOf(of('strokeRect')[0].strokeStyle) }
    }
    const normal = paint(false)
    const muted = paint(true)
    expect(normal.waveform).toBeGreaterThan(0.5)
    expect(muted.waveform / normal.waveform).toBeCloseTo(0.45, 5)
    expect(muted.border / normal.border).toBeCloseTo(0.45, 5)
  })

  it('does not build control geometry for clips too small to carry controls', () => {
    // Zoomed out: 300 narrow clips. Each paints a body and a border, and that
    // is all; no fade wedges, gain line or pill.
    const clips = Array.from({ length: 300 }, (_, i) => clip({ id: i, positionTicks: i * 240, durationTicks: 200 }))
    const { ctx, of } = recordingCtx()
    drawClips(makeView(ctx, { ppb: 8 }), clipData(clips))
    const visible = clips.filter((c) => blockRect(c, 0, 0, 8).x <= W).length
    expect(of('fillRect')).toHaveLength(visible)
    expect(of('strokeRect')).toHaveLength(visible)
    expect(of('stroke')).toEqual([])
  })
})

describe('drawPatternBlocks', () => {
  const pattern = (over = {}) => ({
    id: 1, name: 'Melody', regionId: 'r1', lengthTicks: beatsToTicks(4),
    notes: [0, 1, 2, 3].map((b) => ({ positionTicks: beatsToTicks(b), durationTicks: 240, pitch: 60 + b })),
    ...over,
  })
  const blk = (over = {}) => ({
    id: 5, trackId: 'b', patternId: 1,
    positionTicks: 0, durationTicks: beatsToTicks(4), offsetTicks: 0, loopEnabled: true,
    ...over,
  })
  const blockData = (blocks, over = {}) => ({
    blocks, patterns: { 1: pattern() }, regions: REGIONS, selectedBlockIds: new Set(), ...over,
  })
  const noteRects = (rec) => rec.of('fillRect').filter((f) => f.args[3] === 2)

  it('does not clear: it paints on top of the clips', () => {
    const { ctx, of } = recordingCtx()
    drawPatternBlocks(makeView(ctx), blockData([blk()]))
    expect(of('clearRect')).toEqual([])
  })

  it('paints the block on the hit-tested rectangle with its stroke inside', () => {
    const b = blk({ positionTicks: beatsToTicks(1.3) })
    const { ctx, of } = recordingCtx()
    const view = makeView(ctx, { ppb: 23.7, scrollOffset: 0.137 })
    drawPatternBlocks(view, blockData([b]))
    const r = blockRect(b, 1, 0.137, 23.7)
    expect(of('fillRect')[0].args).toEqual([r.x, r.y, r.w, r.h])
    const stroke = of('strokeRect')[0]
    expect(stroke.lineWidth).toBe(2)
    expect(stroke.args).toEqual([r.x + 1, r.y + 1, r.w - 2, r.h - 2])
    expect(hitTestBlockAt([b], r.x + r.w - 0.5, 1, view)).toBe(b)
  })

  it('draws one bar per note in the block', () => {
    const rec = recordingCtx()
    drawPatternBlocks(makeView(rec.ctx), blockData([blk()]))
    expect(noteRects(rec)).toHaveLength(4)
  })

  it('only visits the notes that can reach the viewport', () => {
    // 512 bars of a 4-note pattern is 2048 note instances; 800px at 40px/beat
    // shows 5 bars of them.
    const long = blk({ durationTicks: beatsToTicks(2048) })
    const rec = recordingCtx()
    drawPatternBlocks(makeView(rec.ctx, { scrollOffset: 400 }), blockData([long]))
    const drawn = noteRects(rec).length
    expect(drawn).toBeGreaterThanOrEqual(20)
    expect(drawn).toBeLessThanOrEqual(24)
    for (const note of noteRects(rec)) {
      expect(note.args[0] + note.args[2]).toBeGreaterThan(-2)
      expect(note.args[0]).toBeLessThan(W + 2)
    }
  })

  it('shows a handle on BOTH edges of a selected block', () => {
    const b = blk()
    const { ctx, of } = recordingCtx()
    drawPatternBlocks(makeView(ctx), blockData([b], { selectedBlockIds: new Set([b.id]) }))
    const r = blockRect(b, 1, 0, 40)
    const handles = of('fillRect').filter((f) => f.args[2] === 4 && f.args[3] === r.h)
    expect(handles.map((f) => f.args[0])).toEqual([r.x, r.x + r.w - 4])
  })

  it('shows the loop glyph on a block longer than its pattern, clear of the handle', () => {
    const looping = blk({ durationTicks: beatsToTicks(8) })
    const r = blockRect(looping, 1, 0, 40)
    const glyphX = (selected, block = looping) => {
      const { ctx } = recordingCtx()
      iconCalls.length = 0
      drawPatternBlocks(makeView(ctx), blockData([block], { selectedBlockIds: new Set(selected ? [block.id] : []) }))
      const glyph = iconCalls.find((c) => c.name === 'repeat' || c.name === 'arrow-line-right')
      return glyph ? [glyph.name, glyph.x] : null
    }
    expect(glyphX(false)).toEqual(['repeat', r.x + r.w - 14])
    expect(glyphX(true)).toEqual(['repeat', r.x + r.w - 18])
    expect(glyphX(false, blk({ durationTicks: beatsToTicks(8), loopEnabled: false }))[0]).toBe('arrow-line-right')
    // Same length as the pattern: nothing loops, no glyph.
    expect(glyphX(false, blk())).toBeNull()
  })

  it('keeps the loop glyph off a block too small to hold it', () => {
    // A quarter-beat pattern looped twice: 20px wide, narrower than the glyph
    // plus its margin. It used to print across the neighbouring block.
    const { ctx, of } = recordingCtx()
    iconCalls.length = 0
    drawPatternBlocks(makeView(ctx), {
      blocks: [blk({ durationTicks: beatsToTicks(0.5) })],
      patterns: { 1: pattern({ lengthTicks: beatsToTicks(0.25), notes: [] }) },
      regions: REGIONS,
      selectedBlockIds: new Set(),
    })
    expect(of('fillText')).toEqual([])
    expect(iconCalls.filter((c) => c.name === 'repeat' || c.name === 'arrow-line-right')).toEqual([])
  })

  it('dims the notes of a block on a muted track', () => {
    const noteAlpha = (muted) => {
      const rec = recordingCtx()
      drawPatternBlocks(makeView(rec.ctx, { mutedTrackIds: new Set(muted ? ['b'] : []) }), blockData([blk()]))
      return alphaOf(noteRects(rec)[0].fillStyle)
    }
    expect(noteAlpha(false)).toBeCloseTo(0.95, 5)
    expect(noteAlpha(true)).toBeCloseTo(0.95 * 0.45, 5)
  })
})

describe('drawWorldSpinners', () => {
  it('draws one arc per processing clip on screen, anchored to the painted rectangle', () => {
    const on = clip({ id: 1 })
    const off = clip({ id: 2, positionTicks: beatsToTicks(400) })
    const { ctx, of } = recordingCtx()
    drawWorldSpinners(ctx, [on, off], { a: 0 }, new Set([1, 2]), 0, 40, 0, '#fff', null, W)
    const r = blockRect(on, 0, 0, 40)
    expect(of('arc')).toHaveLength(1)
    expect(of('arc')[0].args.slice(0, 3)).toEqual([r.x + r.w - 11, r.y + r.h - 11, 7])
  })
})
