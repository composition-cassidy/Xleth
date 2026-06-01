import { describe, expect, it, vi } from 'vitest'
import { positionMsToTick, startMacroAutomationPlayback } from './macroAutomationPlayback.js'

describe('positionMsToTick', () => {
  it('converts ms + bpm to integer ticks at PPQ 960', () => {
    // 120 bpm → 2 beats/sec. 500ms → 1 beat → 960 ticks.
    expect(positionMsToTick(500, 120)).toBe(960)
    // 140 bpm, 0 ms → 0.
    expect(positionMsToTick(0, 140)).toBe(0)
  })

  it('guards invalid input', () => {
    expect(positionMsToTick(NaN, 120)).toBe(0)
    expect(positionMsToTick(500, 0)).toBe(0)
    expect(positionMsToTick(-100, 120)).toBe(0)
  })
})

describe('startMacroAutomationPlayback', () => {
  it('drives applyMacroAutomationAtTick on each transport update and resets on transitions', () => {
    let handler = null
    const subscribe = vi.fn((fn) => { handler = fn; return () => {} })
    const store = {
      applyMacroAutomationAtTick: vi.fn(async () => ({ ok: true, driven: [] })),
      resetMacroAutomationRuntime: vi.fn(),
    }
    const unsubscribe = startMacroAutomationPlayback({ subscribe, getStore: () => store })

    // First update (stopped) → transition from null → reset, then apply.
    handler({ positionMs: 0, bpm: 120, isPlaying: false })
    expect(store.resetMacroAutomationRuntime).toHaveBeenCalledTimes(1)
    expect(store.applyMacroAutomationAtTick).toHaveBeenLastCalledWith(0, {})

    // Start playing → another transition → reset again, apply at new tick.
    handler({ positionMs: 500, bpm: 120, isPlaying: true })
    expect(store.resetMacroAutomationRuntime).toHaveBeenCalledTimes(2)
    expect(store.applyMacroAutomationAtTick).toHaveBeenLastCalledWith(960, {})

    // Continue playing (no transition) → no extra reset.
    handler({ positionMs: 1000, bpm: 120, isPlaying: true })
    expect(store.resetMacroAutomationRuntime).toHaveBeenCalledTimes(2)
    expect(store.applyMacroAutomationAtTick).toHaveBeenLastCalledWith(1920, {})

    expect(typeof unsubscribe).toBe('function')
  })

  it('ignores empty transport snapshots', () => {
    let handler = null
    const subscribe = vi.fn((fn) => { handler = fn; return () => {} })
    const store = {
      applyMacroAutomationAtTick: vi.fn(),
      resetMacroAutomationRuntime: vi.fn(),
    }
    startMacroAutomationPlayback({ subscribe, getStore: () => store })
    handler(null)
    expect(store.applyMacroAutomationAtTick).not.toHaveBeenCalled()
  })
})
