import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCanvasTextFitCache, fitCanvasText, measureCanvasTextWidth } from './canvasTextFit.js'

// 7px per character, 9px for the ellipsis.
function fakeCtx() {
  const measureText = vi.fn((text) => ({
    width: [...String(text)].reduce((w, ch) => w + (ch === '…' ? 9 : 7), 0),
  }))
  return { measureText }
}

const FONT = '600 10px Test'

beforeEach(() => clearCanvasTextFitCache())

describe('fitCanvasText', () => {
  it('returns the whole text when it fits', () => {
    expect(fitCanvasText(fakeCtx(), FONT, 'Kick', 28)).toBe('Kick')
    expect(fitCanvasText(fakeCtx(), FONT, 'Kick', 500)).toBe('Kick')
  })

  it('truncates to the longest prefix that fits with an ellipsis', () => {
    // 'Vocal chop' is 70px. 40px leaves room for 4 chars (28) + ellipsis (9).
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 40)).toBe('Voca…')
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 37)).toBe('Voca…')
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 36)).toBe('Voc…')
  })

  it('returns nothing, or a bare ellipsis when allowed, if not even one character fits', () => {
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 12)).toBe('')
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 12, true)).toBe('…')
    expect(fitCanvasText(fakeCtx(), FONT, 'Vocal chop', 8, true)).toBe('')
  })

  it('returns nothing for empty text or no room', () => {
    expect(fitCanvasText(fakeCtx(), FONT, '', 100)).toBe('')
    expect(fitCanvasText(fakeCtx(), FONT, null, 100)).toBe('')
    expect(fitCanvasText(fakeCtx(), FONT, 'Kick', 0)).toBe('')
  })

  it('measures nothing the second time it is asked the same question', () => {
    const ctx = fakeCtx()
    const first = fitCanvasText(ctx, FONT, 'Vocal chop long name here', 60)
    const measured = ctx.measureText.mock.calls.length
    expect(measured).toBeGreaterThan(1)
    expect(fitCanvasText(ctx, FONT, 'Vocal chop long name here', 60)).toBe(first)
    expect(ctx.measureText.mock.calls.length).toBe(measured)
    // A text that simply fits costs one measurement, ever.
    fitCanvasText(ctx, FONT, 'Kick', 500)
    fitCanvasText(ctx, FONT, 'Kick', 300)
    expect(ctx.measureText.mock.calls.length).toBe(measured + 1)
  })

  it('keeps answers apart by font, width and the bare-ellipsis option', () => {
    const ctx = fakeCtx()
    expect(fitCanvasText(ctx, FONT, 'Vocal chop', 40)).toBe('Voca…')
    expect(fitCanvasText(ctx, FONT, 'Vocal chop', 26)).toBe('Vo…')
    expect(fitCanvasText(ctx, FONT, 'Vocal chop', 12)).toBe('')
    expect(fitCanvasText(ctx, FONT, 'Vocal chop', 12, true)).toBe('…')
    const before = ctx.measureText.mock.calls.length
    fitCanvasText(ctx, '500 9px Test', 'Vocal chop', 40)
    expect(ctx.measureText.mock.calls.length).toBeGreaterThan(before)
  })

  it('forgets everything when cleared (a web font finishing loading)', () => {
    const ctx = fakeCtx()
    fitCanvasText(ctx, FONT, 'Vocal chop', 40)
    const measured = ctx.measureText.mock.calls.length
    clearCanvasTextFitCache()
    fitCanvasText(ctx, FONT, 'Vocal chop', 40)
    expect(ctx.measureText.mock.calls.length).toBeGreaterThan(measured)
  })
})

describe('measureCanvasTextWidth', () => {
  it('measures once per font and text', () => {
    const ctx = fakeCtx()
    expect(measureCanvasTextWidth(ctx, FONT, '+3st')).toBe(28)
    expect(measureCanvasTextWidth(ctx, FONT, '+3st')).toBe(28)
    expect(ctx.measureText).toHaveBeenCalledTimes(1)
  })
})
