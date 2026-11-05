import { describe, it, expect, beforeEach } from 'vitest'
import { nearestCrossingIndex, radiusForView } from '../zeroCrossing.js'
import {
  copySlotSettings, buildSlotPaste, hasSlotClipboard, __resetSlotClipboard,
} from '../slotClipboard.js'
import {
  buildPatchState, rescaleSlotIndices, mergePatchSlots, patchRegionSettings,
  SAMPLER_PATCH_VERSION,
} from '../samplerPatch.js'
import {
  noteForCode, lowNoteFor, noteName, clampOctaveShift,
  MIN_OCTAVE_SHIFT, MAX_OCTAVE_SHIFT, BASE_NOTE,
} from '../auditionKeymap.js'

// ── Zero-crossing snap ───────────────────────────────────────────────────────

describe('nearestCrossingIndex', () => {
  it('returns -1 when the block never crosses zero', () => {
    expect(nearestCrossingIndex(new Float32Array([0.5, 0.6, 0.7, 0.8]), 2)).toBe(-1)
  })

  it('finds a rising crossing and picks the sample closer to zero', () => {
    //                                     idx: 0     1     2    3
    const s = new Float32Array([-0.9, -0.8, -0.1, 0.7])
    // The crossing is between 2 and 3; |−0.1| < |0.7| so index 2 wins.
    expect(nearestCrossingIndex(s, 3)).toBe(2)
  })

  it('finds a falling crossing too', () => {
    const s = new Float32Array([0.9, 0.05, -0.6, -0.8])
    expect(nearestCrossingIndex(s, 0)).toBe(1)
  })

  it('returns an exact zero at the centre untouched', () => {
    const s = new Float32Array([0.4, 0, -0.4])
    expect(nearestCrossingIndex(s, 1)).toBe(1)
  })

  it('picks the crossing nearest the centre when there are several', () => {
    // Crossings around idx 1 and idx 5.
    const s = new Float32Array([-0.5, 0.02, 0.5, 0.6, 0.5, 0.03, -0.5])
    expect(nearestCrossingIndex(s, 5)).toBe(5)
    expect(nearestCrossingIndex(s, 0)).toBe(1)
  })

  it('is safe on degenerate input', () => {
    expect(nearestCrossingIndex(null, 0)).toBe(-1)
    expect(nearestCrossingIndex(new Float32Array([0.1]), 0)).toBe(-1)
  })
})

describe('radiusForView', () => {
  it('scales with the zoom so a snap is never a visible jump', () => {
    // 480000 samples across 600px = 800/px, so ~2px of slack.
    expect(radiusForView(480000, 600)).toBe(1600)
    // Zoomed to 1200 samples across 600px = 2/px.
    expect(radiusForView(1200, 600)).toBe(4)
  })

  it('clamps at both ends', () => {
    expect(radiusForView(1, 600)).toBe(4)          // floor
    expect(radiusForView(100000000, 600)).toBe(2048) // ceiling
  })
})

// ── Slot clipboard ───────────────────────────────────────────────────────────

describe('slot clipboard', () => {
  beforeEach(() => __resetSlotClipboard())

  const sourceSlot = {
    audioFilePath: 'C:/samples/source.wav',
    name: 'Source layer',
    rootNote: 62, semitone: 3, fine: -12.5, volume: 0.8, pan: -0.4,
    mute: true, solo: true,
    smpStart: 1000, smpLength: 4000,
    loopStart: 1500, loopEnd: 3500, crossfadeSamples: 400,
    loopEnabled: true, loopMode: 1,
    mangleChain: [{ mode: 18, amount: 0.5, mix: 0.9, bypass: false }],
  }

  it('starts empty', () => {
    expect(hasSlotClipboard()).toBe(false)
    expect(buildSlotPaste(1000)).toBeNull()
  })

  it('never carries audio identity or performance state', () => {
    copySlotSettings(sourceSlot, 10000)
    const paste = buildSlotPaste(10000)
    expect(paste.audioFilePath).toBeUndefined()
    expect(paste.name).toBeUndefined()
    expect(paste.mute).toBeUndefined()
    expect(paste.solo).toBeUndefined()
  })

  it('carries tuning, loop flags and the mangle chain', () => {
    copySlotSettings(sourceSlot, 10000)
    const paste = buildSlotPaste(10000)
    expect(paste.rootNote).toBe(62)
    expect(paste.semitone).toBe(3)
    expect(paste.fine).toBe(-12.5)
    expect(paste.loopEnabled).toBe(true)
    expect(paste.loopMode).toBe(1)
    expect(paste.mangleChain).toEqual([{ mode: 18, amount: 0.5, mix: 0.9, bypass: false }])
  })

  it('deep-copies the mangle chain so a later source edit cannot reach it', () => {
    const slot = { ...sourceSlot, mangleChain: [{ mode: 18, amount: 0.5, mix: 1, bypass: false }] }
    copySlotSettings(slot, 10000)
    slot.mangleChain[0].amount = 0.99
    expect(buildSlotPaste(10000).mangleChain[0].amount).toBe(0.5)
  })

  it('clamps sample positions onto a shorter target', () => {
    copySlotSettings(sourceSlot, 10000)
    const paste = buildSlotPaste(2000)
    expect(paste.smpStart).toBeLessThanOrEqual(1999)
    expect(paste.loopStart).toBeLessThanOrEqual(1999)
    // 3500 is past the 2000-sample target, so loopEnd falls back to the
    // "to the end" sentinel rather than pointing off the buffer.
    expect(paste.loopEnd).toBe(0)
    expect(paste.crossfadeSamples).toBeLessThanOrEqual(2000)
  })

  it('keeps the 0 = "to the end" sentinel rather than promoting it', () => {
    copySlotSettings({ ...sourceSlot, smpLength: 0, loopEnd: 0 }, 10000)
    const paste = buildSlotPaste(10000)
    expect(paste.smpLength).toBe(0)
    expect(paste.loopEnd).toBe(0)
  })

  it('passes positions through untouched when the target length is unknown', () => {
    copySlotSettings(sourceSlot, 10000)
    const paste = buildSlotPaste(0)
    expect(paste.smpStart).toBe(1000)
    expect(paste.loopEnd).toBe(3500)
  })

  it('never lets the crossfade exceed the loop it sits in', () => {
    copySlotSettings({ ...sourceSlot, loopStart: 100, loopEnd: 300, crossfadeSamples: 5000 }, 10000)
    expect(buildSlotPaste(10000).crossfadeSamples).toBeLessThanOrEqual(200)
  })
})

// ── Patches ──────────────────────────────────────────────────────────────────

describe('rescaleSlotIndices', () => {
  it('scales positions proportionally onto a different sample length', () => {
    const out = rescaleSlotIndices(
      { sourceNumSamples: 1000, smpStart: 250, smpLength: 500, loopStart: 400, loopEnd: 800, crossfadeSamples: 50 },
      2000,
    )
    expect(out.smpStart).toBe(500)
    expect(out.smpLength).toBe(1000)
    expect(out.loopStart).toBe(800)
    expect(out.loopEnd).toBe(1600)
    expect(out.crossfadeSamples).toBe(100)
  })

  it('preserves the "to the end" sentinels', () => {
    const out = rescaleSlotIndices(
      { sourceNumSamples: 1000, smpStart: 0, smpLength: 0, loopStart: 0, loopEnd: 0, crossfadeSamples: 0 },
      4321,
    )
    expect(out.smpLength).toBe(0)
    expect(out.loopEnd).toBe(0)
  })

  it('passes through unscaled when either length is unknown', () => {
    const out = rescaleSlotIndices({ sourceNumSamples: 0, smpStart: 123, loopStart: 45 }, 0)
    expect(out.smpStart).toBe(123)
    expect(out.loopStart).toBe(45)
  })

  it('keeps positions inside the target buffer', () => {
    const out = rescaleSlotIndices(
      { sourceNumSamples: 1000, smpStart: 990, loopStart: 995, loopEnd: 999, crossfadeSamples: 10 },
      100,
    )
    expect(out.smpStart).toBeLessThanOrEqual(99)
    expect(out.loopStart).toBeLessThanOrEqual(99)
    expect(out.loopEnd).toBeLessThanOrEqual(100)
  })
})

describe('buildPatchState / mergePatchSlots', () => {
  const slots = [
    { audioFilePath: 'a.wav', name: 'Kick', rootNote: 60, volume: 1, smpStart: 10, mangleChain: [] },
    { audioFilePath: 'b.wav', name: 'Snare', rootNote: 64, volume: 0.5, smpStart: 20, mangleChain: [] },
  ]

  it('stamps the version and records each slot\u2019s capture length', () => {
    const state = buildPatchState({
      settings: { crossfadeEnabled: true, voiceCount: 8, arpEnabled: false },
      slots,
      numSamplesBySlot: { 0: 1000, 1: 2000 },
      modulation: { routes: [] },
    })
    expect(state.version).toBe(SAMPLER_PATCH_VERSION)
    expect(state.slots[0].sourceNumSamples).toBe(1000)
    expect(state.slots[1].sourceNumSamples).toBe(2000)
    expect(state.region.voiceCount).toBe(8)
    expect(state.modulation).toEqual({ routes: [] })
  })

  it('excludes audio identity from the saved state', () => {
    const state = buildPatchState({ settings: {}, slots, numSamplesBySlot: {}, modulation: null })
    expect(state.slots[0].audioFilePath).toBeUndefined()
    expect(state.slots[0].name).toBeUndefined()
  })

  it('keeps the target\u2019s audio and name when merging a patch in', () => {
    const state = buildPatchState({
      settings: {}, slots, numSamplesBySlot: { 0: 1000, 1: 1000 }, modulation: null,
    })
    const current = [
      { audioFilePath: 'live-1.wav', name: 'My layer', mute: true, rootNote: 48, volume: 0.1 },
      { audioFilePath: 'live-2.wav', name: 'Other', rootNote: 48, volume: 0.1 },
    ]
    const merged = mergePatchSlots(state.slots, current, { 0: 1000, 1: 1000 })
    expect(merged[0].audioFilePath).toBe('live-1.wav')
    expect(merged[0].name).toBe('My layer')
    expect(merged[0].mute).toBe(true)          // performance state survives
    expect(merged[0].rootNote).toBe(60)        // settings applied
    expect(merged[0].volume).toBe(1)
  })

  it('leaves layers the patch does not describe alone', () => {
    const current = [
      { audioFilePath: 'x.wav', rootNote: 48 },
      { audioFilePath: 'y.wav', rootNote: 49 },
      { audioFilePath: 'z.wav', rootNote: 50 },
    ]
    const merged = mergePatchSlots([{ sourceNumSamples: 100, rootNote: 72 }], current, {})
    expect(merged[0].rootNote).toBe(72)
    expect(merged[1].rootNote).toBe(49)
    expect(merged[2].rootNote).toBe(50)
  })

  it('only lets known region fields through', () => {
    const out = patchRegionSettings({ region: { voiceCount: 4, somethingElse: 'nope' } })
    expect(out).toEqual({ voiceCount: 4 })
  })
})

// ── Audition keymap ──────────────────────────────────────────────────────────

describe('auditionKeymap', () => {
  it('maps the Z row to C4 upward at neutral shift', () => {
    expect(noteForCode('KeyZ', 0)).toBe(BASE_NOTE)
    expect(noteForCode('KeyS', 0)).toBe(BASE_NOTE + 1)
    expect(noteForCode('KeyM', 0)).toBe(BASE_NOTE + 11)
    expect(noteForCode('KeyQ', 0)).toBe(BASE_NOTE + 12)
  })

  it('preserves the original hard-coded bindings at shift 0', () => {
    // These are the exact values the old inline KEY_MAP used.
    expect(noteForCode('KeyC', 0)).toBe(64)
    expect(noteForCode('Digit7', 0)).toBe(82)
    expect(noteForCode('KeyP', 0)).toBe(88)
  })

  it('shifts by octaves', () => {
    expect(noteForCode('KeyZ', 1)).toBe(BASE_NOTE + 12)
    expect(noteForCode('KeyZ', -2)).toBe(BASE_NOTE - 24)
  })

  it('returns null for unbound keys', () => {
    expect(noteForCode('KeyL', 0)).toBeNull()
    expect(noteForCode('Space', 0)).toBeNull()
  })

  it('keeps every key in MIDI range across the whole shift span', () => {
    const codes = ['KeyZ', 'KeyM', 'KeyQ', 'KeyU', 'KeyP']
    for (let sh = MIN_OCTAVE_SHIFT; sh <= MAX_OCTAVE_SHIFT; sh++) {
      for (const c of codes) {
        const n = noteForCode(c, sh)
        expect(n).not.toBeNull()
        expect(n).toBeGreaterThanOrEqual(0)
        expect(n).toBeLessThanOrEqual(127)
      }
    }
  })

  it('clamps the shift', () => {
    expect(clampOctaveShift(99)).toBe(MAX_OCTAVE_SHIFT)
    expect(clampOctaveShift(-99)).toBe(MIN_OCTAVE_SHIFT)
    expect(clampOctaveShift('x')).toBe(0)
  })

  it('labels notes with the same C4=60 convention as the root-note picker', () => {
    expect(noteName(60)).toBe('C4')
    expect(noteName(61)).toBe('C#4')
    expect(noteName(59)).toBe('B3')
    expect(lowNoteFor(0)).toBe(60)
    expect(lowNoteFor(-1)).toBe(48)
  })
})
