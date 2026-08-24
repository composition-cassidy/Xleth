import { describe, it, expect } from 'vitest'
import { anchoredScrollX, scrollSpringWriteback } from '../viewportAnchor.js'

describe('anchoredScrollX', () => {
  it('passes the spring value straight through with no anchor', () => {
    expect(anchoredScrollX(12.5, null, 40)).toBe(12.5)
  })

  it('keeps the anchored beat under the cursor pixel at any ppb', () => {
    const anchor = { beat: 100, pixelX: 400 }
    for (const ppb of [8, 40, 229, 5000, 50000]) {
      const scroll = anchoredScrollX(0, anchor, ppb)
      // The beat drawn at pixelX must be the anchored beat.
      expect(scroll + anchor.pixelX / ppb).toBeCloseTo(anchor.beat, 9)
    }
  })

  it('falls back to the spring value on a degenerate ppb', () => {
    expect(anchoredScrollX(7, { beat: 100, pixelX: 400 }, 0)).toBe(7)
  })
})

describe('scrollSpringWriteback', () => {
  it('always slaves the spring to the committed value while anchored', () => {
    expect(scrollSpringWriteback(-5, 0, true)).toBe(0)
    expect(scrollSpringWriteback(12, 12, true)).toBe(12)
  })

  it('leaves an unclamped free scroll alone so easing survives', () => {
    // Writing back here would zero the spring's velocity every frame and
    // turn the eased scroll into a jump-cut.
    expect(scrollSpringWriteback(12.5, 12.5, false)).toBe(null)
  })

  it('snaps a free scroll that hit a bound', () => {
    expect(scrollSpringWriteback(-3, 0, false)).toBe(0)
    expect(scrollSpringWriteback(999, 512, false)).toBe(512)
  })
})

describe('the invariant: spring state never diverges from drawn state', () => {
  // Model the real onTick loop against a clamp, and assert that what the
  // NEXT wheel notch would read always equals what was actually drawn.
  function runTicks({ maxScroll, anchor, ppbSeries, springScrollX = 0 }) {
    const clamp = (v) => Math.max(0, Math.min(maxScroll, v))
    let spring = springScrollX
    const frames = []
    for (const ppb of ppbSeries) {
      const requested = anchoredScrollX(spring, anchor, ppb)
      const committed = clamp(requested)
      const writeback = scrollSpringWriteback(requested, committed, Boolean(anchor))
      if (writeback !== null) spring = writeback
      frames.push({ ppb, drawn: committed, spring })
    }
    return frames
  }

  it('holds while zooming out into a shrinking maxScroll bound', () => {
    // Zooming out at the far right of a song: maxScroll shrinks under the
    // view, so the anchor keeps requesting a scroll past the end.
    const frames = runTicks({
      maxScroll: 40,
      anchor: { beat: 300, pixelX: 600 },
      ppbSeries: [200, 150, 100, 60, 30, 12, 8],
      springScrollX: 40,
    })
    for (const f of frames) expect(f.spring).toBe(f.drawn)
    expect(frames.at(-1).drawn).toBe(40) // pinned at the bound, not beyond
  })

  it('holds while zooming out against beat 0', () => {
    const frames = runTicks({
      maxScroll: 2048,
      anchor: { beat: 2, pixelX: 500 },
      ppbSeries: [229, 180, 120, 80, 40, 20, 8],
    })
    for (const f of frames) expect(f.spring).toBe(f.drawn)
    expect(frames.at(-1).drawn).toBe(0) // clamped, never negative
  })

  it('regression: the pre-fix behaviour DID diverge', () => {
    // Same scenario with the old rule (always write the raw request back).
    const clamp = (v) => Math.max(0, Math.min(2048, v))
    const anchor = { beat: 2, pixelX: 500 }
    let spring = 0
    let diverged = false
    for (const ppb of [229, 180, 120, 80, 40, 20, 8]) {
      const requested = anchoredScrollX(spring, anchor, ppb)
      const drawn = clamp(requested)
      spring = requested // ← the old writeback
      if (spring !== drawn) diverged = true
    }
    expect(diverged).toBe(true)
    expect(spring).toBeLessThan(0)
  })
})
