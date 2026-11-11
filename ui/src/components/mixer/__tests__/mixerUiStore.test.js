/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

async function load() {
  vi.resetModules()
  return import('../mixerUiStore.js')
}

describe('mixerUiStore', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to compact strips (72px: three 24px toggles fit) when nothing is stored', async () => {
    const m = await load()
    expect(m.default.getState().stripWidthMode).toBe('compact')
    expect(m.STRIP_WIDTHS).toEqual({ normal: 84, compact: 72 })
    expect(m.STRIP_WIDTHS.compact).toBeGreaterThanOrEqual(3 * 24)
  })

  it('keeps a stored choice either way: "normal" still means 84', async () => {
    localStorage.setItem('xleth.mixer.stripWidth', 'normal')
    expect((await load()).default.getState().stripWidthMode).toBe('normal')
    localStorage.setItem('xleth.mixer.stripWidth', 'compact')
    expect((await load()).default.getState().stripWidthMode).toBe('compact')
  })

  it('persists the strip width and the loudness dock choice', async () => {
    const m = await load()
    m.default.getState().setStripWidthMode('normal')
    expect(localStorage.getItem('xleth.mixer.stripWidth')).toBe('normal')
    expect(m.default.getState().loudnessDockOpen).toBe(false)
    m.default.getState().setLoudnessDockOpen(true)
    expect(localStorage.getItem('xleth.mixer.loudnessDockOpen')).toBe('1')
    expect((await load()).default.getState().loudnessDockOpen).toBe(true)
  })
})
