import { describe, expect, it } from 'vitest'
import {
  MASTER, MAX_SENDS, destinationsOf, findTrackSidechain, formatSendGain, isRoutedTo,
  isSidechainedTo, routeOnly, toggleDestination,
} from '../routeSets.js'

describe('toggleDestination (FL multi-wiring)', () => {
  it('adds a track next to Master: Master stays the primary, the track becomes a send', () => {
    expect(toggleDestination(MASTER, [], 5)).toEqual({ targetTrackId: MASTER, sends: [{ targetTrackId: 5, gain: 1 }] })
  })

  it('removes a send and keeps the other levels', () => {
    const sends = [{ targetTrackId: 5, gain: 0.5 }, { targetTrackId: 6, gain: 0.25 }]
    expect(toggleDestination(MASTER, sends, 5)).toEqual({ targetTrackId: MASTER, sends: [{ targetTrackId: 6, gain: 0.25 }] })
  })

  it('unrouting Master promotes the first remaining track to the primary output', () => {
    const sends = [{ targetTrackId: 5, gain: 0.5 }, { targetTrackId: 6, gain: 0.25 }]
    expect(toggleDestination(MASTER, sends, MASTER)).toEqual({ targetTrackId: 5, sends: [{ targetTrackId: 6, gain: 0.25 }] })
  })

  it('re-routing Master makes it the primary again and keeps the old primary as a send', () => {
    expect(toggleDestination(5, [], MASTER)).toEqual({ targetTrackId: MASTER, sends: [{ targetTrackId: 5, gain: 1 }] })
  })

  it('a track always keeps one output: Master alone cannot be unrouted, a lone bus falls back to Master', () => {
    expect(toggleDestination(MASTER, [], MASTER)).toBeNull()
    expect(toggleDestination(5, [], 5)).toEqual({ targetTrackId: MASTER, sends: [] })
  })

  it('refuses a send past the engine limit', () => {
    const sends = Array.from({ length: MAX_SENDS }, (_, i) => ({ targetTrackId: 10 + i, gain: 1 }))
    expect(toggleDestination(MASTER, sends, 99)).toBeNull()
  })

  it('routeOnly drops every other destination', () => {
    expect(routeOnly(7)).toEqual({ targetTrackId: 7, sends: [] })
  })
})

describe('route queries', () => {
  it('lists destinations primary-first and answers isRoutedTo', () => {
    expect(destinationsOf(MASTER, [{ targetTrackId: 3, gain: 0.5 }]).map(d => d.targetTrackId)).toEqual([MASTER, 3])
    expect(isRoutedTo(MASTER, [{ targetTrackId: 3 }], 3)).toBe(true)
    expect(isRoutedTo(MASTER, [{ targetTrackId: 3 }], 4)).toBe(false)
  })

  it('finds only the track-level sidechain route, but any enabled route counts as sidechained', () => {
    const routes = [
      { routeId: 'fx', sourceTrackId: 1, targetTrackId: 2, targetEffectInstanceId: 'e1', enabled: true },
      { routeId: 'off', sourceTrackId: 1, targetTrackId: 3, targetEffectInstanceId: '', enabled: false },
    ]
    expect(findTrackSidechain(routes, 1, 2)).toBeNull()
    expect(isSidechainedTo(routes, 1, 2)).toBe(true)
    expect(isSidechainedTo(routes, 1, 3)).toBe(false)
    expect(findTrackSidechain(routes, 1, 3)?.routeId).toBe('off')
  })

  it('formats a send level in dB', () => {
    expect(formatSendGain(1)).toBe('+0.0 dB')
    expect(formatSendGain(0.5)).toBe('-6.0 dB')
    expect(formatSendGain(0)).toBe('-inf dB')
  })
})
