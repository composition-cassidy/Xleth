import { describe, it, expect } from 'vitest'
import { nudgeEventFor, applyRecordFor, NUDGE_WINDOW_MS } from '../autoLoopTelemetry.js'

describe('applyRecordFor', () => {
  it('rounds the AUTO result and stamps region + time', () => {
    const rec = applyRecordFor({ loopStart: 100.4, loopEnd: 900.6, crossfadeSamples: 50.5 }, 7, 1000)
    expect(rec).toEqual({ t: 1000, regionId: 7, loopStart: 100, loopEnd: 901, crossfadeSamples: 51 })
  })
})

describe('nudgeEventFor', () => {
  const apply = { t: 1000, regionId: 7, loopStart: 100, loopEnd: 900, crossfadeSamples: 50 }

  it('returns null with no prior apply', () => {
    expect(nudgeEventFor(null, { loopStart: 200 }, 7, 2000)).toBeNull()
  })

  it('returns null for a different region', () => {
    expect(nudgeEventFor(apply, { loopStart: 200 }, 8, 2000)).toBeNull()
  })

  it('returns null past the 30 s window', () => {
    expect(nudgeEventFor(apply, { loopStart: 200 }, 7, 1000 + NUDGE_WINDOW_MS + 1)).toBeNull()
  })

  it('returns null when the edited value equals the snapped value', () => {
    // The event fetch re-writes loopStart to exactly what AUTO chose (a no-op).
    expect(nudgeEventFor(apply, { loopStart: 100 }, 7, 5000)).toBeNull()
  })

  it('fires a nudge when loopStart is changed within the window', () => {
    expect(nudgeEventFor(apply, { loopStart: 250 }, 7, 6000)).toEqual({
      kind: 'nudge', field: 'loopStart', from: 100, to: 250, since_apply_ms: 5000,
    })
  })

  it('fires a nudge on a crossfade change', () => {
    expect(nudgeEventFor(apply, { crossfadeSamples: 80 }, 7, 3000)).toEqual({
      kind: 'nudge', field: 'crossfadeSamples', from: 50, to: 80, since_apply_ms: 2000,
    })
  })

  it('ignores non-loop fields', () => {
    expect(nudgeEventFor(apply, { rootNote: 62, attackMs: 5 }, 7, 3000)).toBeNull()
  })
})
