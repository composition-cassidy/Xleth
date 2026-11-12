import { describe, expect, it } from 'vitest'
import { placeFlyout, FLYOUT_WIDTH } from '../grid/GridEditFlyout.jsx'

const viewport = { width: 1600, height: 900 }

describe('Edit Grid flyout placement', () => {
  it('opens to the right of a Preview docked at the left (Compose)', () => {
    const box = placeFlyout({ left: 0, right: 345, top: 40 }, viewport)
    expect(box.left).toBe(349)
    expect(box.top).toBe(40)
    expect(box.width).toBe(FLYOUT_WIDTH)
    expect(box.height).toBe(560)
  })

  it('opens to the left when the Preview sits at the right edge', () => {
    const box = placeFlyout({ left: 1250, right: 1600, top: 40 }, viewport)
    expect(box.left).toBe(1250 - 4 - FLYOUT_WIDTH)
  })

  it('stays inside a short window', () => {
    const box = placeFlyout({ left: 0, right: 345, top: 500 }, { width: 1600, height: 600 })
    expect(box.top + box.height).toBeLessThanOrEqual(600 - 8)
    expect(box.top).toBeGreaterThanOrEqual(8)
  })
})
