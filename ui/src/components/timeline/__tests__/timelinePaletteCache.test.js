/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { resolveTimelinePalette, invalidateTimelinePalette } from '../timelineDrawing.js'

// resolveTimelinePalette() is called 3-4x per animated frame by the viewport
// commit path, and each call used to make 46 getComputedStyle reads on
// documentElement — interleaved with that same path's DOM writes, forcing a
// synchronous style recalculation every frame of a zoom or pan.
describe('timeline palette cache', () => {
  let reads

  beforeEach(() => {
    reads = 0
    const real = window.getComputedStyle.bind(window)
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) => {
      const style = real(el)
      return {
        getPropertyValue: (name) => { reads++; return style.getPropertyValue(name) },
      }
    })
    invalidateTimelinePalette()
  })

  it('reads the DOM once, then serves every later call from cache', () => {
    resolveTimelinePalette()
    const first = reads
    expect(first).toBeGreaterThan(40)  // ~46 tokens

    for (let i = 0; i < 10; i++) resolveTimelinePalette()
    expect(reads).toBe(first)
  })

  it('returns a stable identity so downstream memoisation can key on it', () => {
    expect(resolveTimelinePalette()).toBe(resolveTimelinePalette())
  })

  it('re-reads after an explicit invalidation', () => {
    const before = resolveTimelinePalette()
    const readsAfterFirst = reads
    invalidateTimelinePalette()
    const after = resolveTimelinePalette()
    expect(reads).toBeGreaterThan(readsAfterFirst)
    expect(after).not.toBe(before)
  })

  it('re-reads after an xleth-theme-changed dispatch', () => {
    const before = resolveTimelinePalette()
    window.dispatchEvent(new CustomEvent('xleth-theme-changed'))
    expect(resolveTimelinePalette()).not.toBe(before)
  })

  it('picks up a token value changed between theme events', () => {
    document.documentElement.style.setProperty('--theme-accent', 'rgb(1, 2, 3)')
    window.dispatchEvent(new CustomEvent('xleth-theme-changed'))
    expect(resolveTimelinePalette().accent).toBe('rgb(1, 2, 3)')

    document.documentElement.style.setProperty('--theme-accent', 'rgb(4, 5, 6)')
    // No event yet — the cache is intentionally authoritative until told.
    expect(resolveTimelinePalette().accent).toBe('rgb(1, 2, 3)')
    window.dispatchEvent(new CustomEvent('xleth-theme-changed'))
    expect(resolveTimelinePalette().accent).toBe('rgb(4, 5, 6)')
  })
})
