// Round 3 (ui/DESIGN.md 22): the arrangement's empty space carries musical structure.
// Bar-group shading on the grid layer, and a ruler whose every fourth bar number leads.
import { describe, expect, it } from 'vitest'
import {
  BAR_GROUP_MAX_PX, BAR_GROUP_MIN_PX, barGroupBars, drawGrid, drawRuler, keepRulerLabels, rulerBarLabels,
} from './timelineDrawing.js'

const SHADE = '#131313'
const PALETTE = {
  bg: '#0f0f0f',
  laneSeparator: '#3a3a3a',
  patternLaneTint: 'rgba(255, 255, 255, 0.03)',
  barGroupShade: SHADE,
  gridMinor: '#2b2b2b',
  gridBeat: '#3a3a3a',
  gridBar: '#616161',
  rulerBg: '#171717',
  rulerText: '#9a9a9a',
  rulerBorder: '#444444',
  rulerGridMinor: '#2b2b2b',
  ink: '#e6e6e6',
  inkDark: '#1a1a1a',
}

/** Records fillRect and fillText with the style and font in force. */
function recordingCtx(charW = 6) {
  const rects = []
  const texts = []
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop]
      if (prop === 'fillRect') return (x, y, w, h) => rects.push({ x, y, w, h, style: String(target.fillStyle) })
      if (prop === 'fillText') return (text, x, y) => texts.push({ text, x, y, style: String(target.fillStyle), font: String(target.font) })
      if (prop === 'measureText') return (s) => ({ width: String(s).length * (String(target.font).includes('12px') ? charW + 1 : charW) })
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} })
      return () => {}
    },
    set(target, prop, value) { target[prop] = value; return true },
  })
  return { ctx, rects, texts }
}

describe('barGroupBars', () => {
  it('is four bars until four bars are wider than the limit, then one bar', () => {
    // 4 bars = 16 beats. At 33 px/beat that is 528px (four-bar groups); at 40 it is 640px (single bars).
    expect(barGroupBars(33)).toBe(4)
    expect(barGroupBars(BAR_GROUP_MAX_PX / 16)).toBe(4)
    expect(barGroupBars(40)).toBe(1)
    expect(barGroupBars(400)).toBe(1)
  })

  it('doubles when zoomed far out, so a band is never thinner than the minimum', () => {
    expect(barGroupBars(8)).toBe(4) // 128px per group
    for (const ppb of [2, 1, 0.5, 0.1, 0.02]) {
      const bars = barGroupBars(ppb)
      expect(bars * ppb * 4).toBeGreaterThanOrEqual(BAR_GROUP_MIN_PX)
      expect(Math.log2(bars) % 1).toBe(0)
    }
  })

  it('survives a zero or negative zoom', () => {
    expect(barGroupBars(0)).toBe(4)
    expect(barGroupBars(-3)).toBe(4)
  })
})

describe('drawGrid bar-group shading', () => {
  const shadeRects = (ppb, scroll = 0, w = 1280, h = 400) => {
    const { ctx, rects } = recordingCtx()
    drawGrid(ctx, w, h, scroll, ppb, 4, null, PALETTE, null, '1/16')
    return rects.filter((r) => r.style === SHADE)
  }

  it('shades every other group, full height, starting with the second', () => {
    // 33 px/beat: groups of 4 bars = 528px. The first (bars 1-4) is ground, the second is shaded.
    const rects = shadeRects(33)
    expect(rects.map((r) => [r.x, r.w])).toEqual([[528, 528]])
    expect(rects.every((r) => r.y === 0 && r.h === 400)).toBe(true)
  })

  it('one bar per group once four bars pass the width limit', () => {
    const rects = shadeRects(40) // bar = 160px: bars 2, 4, 6, 8 are shaded across 1280px
    expect(rects.map((r) => r.x)).toEqual([160, 480, 800, 1120])
    expect(rects.every((r) => r.w === 160)).toBe(true)
  })

  it('follows the scroll offset and clips to the canvas: the group a bar belongs to never changes', () => {
    // Scrolled 20 beats in at 33 px/beat: beat 16..32 is the second (shaded) group; it starts off-canvas.
    const rects = shadeRects(33, 20)
    expect(rects[0].x).toBe(0)
    expect(rects[0].w).toBe(Math.round((32 - 20) * 33))
    // The same bars are shaded whatever the offset: bar 5 (beat 16) is always in a shaded group.
    for (const scroll of [0, 3.5, 15.99, 16, 31.5]) {
      const xOfBeat16 = Math.round((16 - scroll) * 33)
      const hit = shadeRects(33, scroll).some((r) => r.x <= Math.max(0, xOfBeat16) && r.x + r.w > Math.max(0, xOfBeat16))
      expect(hit, `scroll ${scroll}`).toBe(true)
    }
  })

  it('paints the shade before anything else on the layer, and nothing when the token is empty', () => {
    const { ctx, rects } = recordingCtx()
    drawGrid(ctx, 1280, 400, 0, 33, 4, [{ type: 'Pattern' }], PALETTE, null, '1/16')
    expect(rects[0].style).toBe(SHADE)

    const none = recordingCtx()
    drawGrid(none.ctx, 1280, 400, 0, 33, 4, null, { ...PALETTE, barGroupShade: '' }, null, '1/16')
    expect(none.rects.filter((r) => r.style === SHADE)).toEqual([])
  })
})

describe('ruler bar numbers', () => {
  it('labels bars from the first on screen; every fourth label is major', () => {
    const labels = rulerBarLabels(0, 36, 4)
    expect(labels.map((l) => l.text)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(labels.filter((l) => l.major).map((l) => l.text)).toEqual(['1', '5', '9'])
    // Thinned to every second bar (zoomed out): majors are every fourth label, bars 1, 9, 17.
    const thin = rulerBarLabels(0, 80, 8)
    expect(thin.map((l) => l.text).slice(0, 6)).toEqual(['1', '3', '5', '7', '9', '11'])
    expect(thin.filter((l) => l.major).map((l) => l.text)).toEqual(['1', '9', '17'])
  })

  it('keeps every major and drops a minor that would touch a major or the minor before it', () => {
    const box = (text, x, w, major = false) => ({ text, x, right: x + w, major })
    const kept = keepRulerLabels([box('1', 4, 8, true), box('2', 10, 6), box('3', 30, 6), box('4', 34, 6), box('5', 60, 8, true)])
    // "2" overlaps "1"; "4" is too close to "3"; "3" stays.
    expect(kept.map((b) => b.text)).toEqual(['1', '3', '5'])
  })

  it('draws majors at 12px in ink and minors at 10px in the ruler text colour, never under 10px', () => {
    const { ctx, texts } = recordingCtx()
    // 1400px at 40 px/beat: bars 1 to 9 start on screen.
    drawRuler(ctx, 1400, 26, 0, 40, PALETTE)
    const majors = texts.filter((t) => t.font.includes('12px'))
    const minors = texts.filter((t) => t.font.includes('10px'))
    expect(majors.map((t) => t.text)).toEqual(['1', '5', '9'])
    expect(majors.every((t) => t.style === PALETTE.ink)).toBe(true)
    expect(minors.map((t) => t.text)).toEqual(['2', '3', '4', '6', '7', '8'])
    expect(minors.every((t) => t.style === PALETTE.rulerText)).toBe(true)
    expect(texts.every((t) => /1[02]px/.test(t.font))).toBe(true)
  })

  it('zoomed out until labels collide, only the minors go', () => {
    // 3 px/beat: a bar is 12px. Labels are thinned to every 4th bar by the existing stride rule
    // (36px apart) and are wider than that gap leaves room for between majors.
    const { ctx, texts } = recordingCtx(9)
    drawRuler(ctx, 1280, 26, 0, 3, PALETTE)
    const majors = texts.filter((t) => t.font.includes('12px')).map((t) => t.text)
    expect(majors.slice(0, 3)).toEqual(['1', '17', '33'])
    // No two drawn labels overlap.
    const drawn = texts.map((t) => ({ x: t.x, right: t.x + t.text.length * (t.font.includes('12px') ? 10 : 9) })).sort((a, b) => a.x - b.x)
    for (let i = 1; i < drawn.length; i += 1) expect(drawn[i].x).toBeGreaterThanOrEqual(drawn[i - 1].right)
  })
})
