import { describe, expect, it } from 'vitest'
import { hasMeaningfulSelection } from '../sandboxStore.js'

// Regression: the selection action bar (SandboxPanelContent / itself) used to
// gate on `selection.endSample > selection.startSample` alone — true for any
// non-empty selection, including a few-sample drag that a high zoom level
// can produce well under a millisecond. hasMeaningfulSelection adds a
// resolution-independent time floor so the bar only shows for a selection
// actually worth acting on.
describe('hasMeaningfulSelection', () => {
  it('is false with no selection or no sample rate', () => {
    expect(hasMeaningfulSelection(null, 48000)).toBe(false)
    expect(hasMeaningfulSelection({ startSample: 0, endSample: 100 }, 0)).toBe(false)
  })

  it('is false for a degenerate sub-millisecond selection', () => {
    // 20 samples @ 48kHz ≈ 0.417ms — well under the 1ms floor.
    expect(hasMeaningfulSelection({ startSample: 100, endSample: 120 }, 48000)).toBe(false)
  })

  it('is true once the span exceeds ~1ms', () => {
    // 100 samples @ 48kHz ≈ 2.08ms.
    expect(hasMeaningfulSelection({ startSample: 100, endSample: 200 }, 48000)).toBe(true)
  })

  it('is false for a zero-length or inverted span', () => {
    expect(hasMeaningfulSelection({ startSample: 100, endSample: 100 }, 48000)).toBe(false)
    expect(hasMeaningfulSelection({ startSample: 200, endSample: 100 }, 48000)).toBe(false)
  })
})
