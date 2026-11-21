import { describe, expect, it } from 'vitest'
import { clipHasVideo, planClipVideoFxApply, seedVideoFxDefaults } from './clipVideoFxApply.js'
import {
  DEFAULT_CLIP_VIDEO_FX_DEFAULTS,
  isStockVideoCompanion,
  sanitizeClipVideoFxDefaults,
  STOCK_CLIP_VIDEO_FX,
} from '../../stores/clipVideoFxDefaultsStore.js'

const regionsById = {
  1: { id: 1, sourceId: 10 },  // video
  2: { id: 2, sourceId: 20 },  // audio-only
  3: { id: 3, sourceId: 30 },  // legacy source with no hasVideo flag
}
const sourcesById = {
  10: { id: 10, hasVideo: true },
  20: { id: 20, hasVideo: false },
  30: { id: 30 },
}

const clip = (id, regionId, video) => ({
  id,
  regionId,
  modulation: { video: { ...STOCK_CLIP_VIDEO_FX, ...(video || {}) } },
})

const defaults = (patch) => sanitizeClipVideoFxDefaults({
  ...DEFAULT_CLIP_VIDEO_FX_DEFAULTS,
  ...patch,
})

describe('clipHasVideo', () => {
  it('accepts a video source and rejects an audio-only one', () => {
    expect(clipHasVideo(clip(1, 1), regionsById, sourcesById)).toBe(true)
    expect(clipHasVideo(clip(2, 2), regionsById, sourcesById)).toBe(false)
  })

  it('treats a source with no hasVideo flag as video (pre-flag projects)', () => {
    expect(clipHasVideo(clip(3, 3), regionsById, sourcesById)).toBe(true)
  })

  it('rejects a clip whose region or source is missing', () => {
    expect(clipHasVideo(clip(4, 99), regionsById, sourcesById)).toBe(false)
    expect(clipHasVideo({ id: 5 }, regionsById, sourcesById)).toBe(false)
  })
})

describe('planClipVideoFxApply', () => {
  it('is a no-op when neither companion FX is enabled in the defaults', () => {
    expect(planClipVideoFxApply({
      clips: [clip(1, 1)],
      regionsById,
      sourcesById,
      defaults: defaults({}),
    })).toEqual([])
  })

  it('turns Swirl on for video clips that do not have it, carrying the default amount', () => {
    const edits = planClipVideoFxApply({
      clips: [clip(1, 1), clip(2, 2)],
      regionsById,
      sourcesById,
      defaults: defaults({ swirlEnabled: true, swirlAmount: 0.7 }),
    })
    expect(edits).toEqual([
      { clipId: 1, modulation: { video: { vibratoSwirlEnabled: true, swirlAmount: 0.7 } } },
    ])
  })

  it('skips a clip that already has the companion FX on', () => {
    const edits = planClipVideoFxApply({
      clips: [clip(1, 1, { vibratoSwirlEnabled: true, swirlAmount: 0.1 })],
      regionsById,
      sourcesById,
      defaults: defaults({ swirlEnabled: true, swirlAmount: 0.7 }),
    })
    expect(edits).toEqual([])
  })

  it('fills only the missing half when a clip already has the other one on', () => {
    const edits = planClipVideoFxApply({
      clips: [clip(1, 1, { vibratoSwirlEnabled: true, swirlAmount: 0.1 })],
      regionsById,
      sourcesById,
      defaults: defaults({
        swirlEnabled: true, swirlAmount: 0.7,
        waveEnabled: true, waveAmount: 0.3, waveFrequency: 12, smearAmount: 0.2,
        reverseWaveWithScratch: false,
      }),
    })
    expect(edits).toEqual([{
      clipId: 1,
      modulation: {
        video: {
          scratchWaveEnabled: true,
          waveAmount: 0.3,
          waveFrequency: 12,
          smearAmount: 0.2,
          reverseWaveWithScratch: false,
        },
      },
    }])
    // The Swirl the clip already had is untouched — the patch never mentions it.
    expect(edits[0].modulation.video).not.toHaveProperty('swirlAmount')
  })

  it('never emits the swirl centre/radius fields it does not own', () => {
    const [edit] = planClipVideoFxApply({
      clips: [clip(1, 1)],
      regionsById,
      sourcesById,
      defaults: defaults({ swirlEnabled: true }),
    })
    expect(Object.keys(edit.modulation.video).sort())
      .toEqual(['swirlAmount', 'vibratoSwirlEnabled'])
  })
})

describe('isStockVideoCompanion', () => {
  it('is true for an untouched clip and false once a value is dialled in', () => {
    expect(isStockVideoCompanion(STOCK_CLIP_VIDEO_FX, 'swirl')).toBe(true)
    expect(isStockVideoCompanion({ ...STOCK_CLIP_VIDEO_FX, swirlAmount: 0.7 }, 'swirl')).toBe(false)

    expect(isStockVideoCompanion(STOCK_CLIP_VIDEO_FX, 'wave')).toBe(true)
    expect(isStockVideoCompanion({ ...STOCK_CLIP_VIDEO_FX, smearAmount: 0.4 }, 'wave')).toBe(false)
    expect(isStockVideoCompanion({ ...STOCK_CLIP_VIDEO_FX, reverseWaveWithScratch: false }, 'wave'))
      .toBe(false)
  })

  it('treats a clip with no video block at all as stock', () => {
    expect(isStockVideoCompanion(undefined, 'swirl')).toBe(true)
    expect(isStockVideoCompanion({}, 'wave')).toBe(true)
  })
})

describe('sanitizeClipVideoFxDefaults', () => {
  it('clamps out-of-range values to the clip menu slider ranges', () => {
    const s = sanitizeClipVideoFxDefaults({
      swirlAmount: 9, waveAmount: -9, waveFrequency: 999, smearAmount: 'nope',
    })
    expect(s.swirlAmount).toBe(1)
    expect(s.waveAmount).toBe(-1)
    expect(s.waveFrequency).toBe(64)
    expect(s.smearAmount).toBe(DEFAULT_CLIP_VIDEO_FX_DEFAULTS.smearAmount)
  })

  it('falls back to the engine stock values for a missing/garbage payload', () => {
    expect(sanitizeClipVideoFxDefaults(null)).toEqual({ ...DEFAULT_CLIP_VIDEO_FX_DEFAULTS })
  })
})

describe('seedVideoFxDefaults', () => {
  const d = defaults({ swirlAmount: 0.7, waveAmount: 0.3, waveFrequency: 12, smearAmount: 0.2, reverseWaveWithScratch: false })

  it('returns the patch untouched when nothing is being switched on', () => {
    const patch = { swirlAmount: 0.11 }
    expect(seedVideoFxDefaults(STOCK_CLIP_VIDEO_FX, patch, d)).toBe(patch)
    expect(seedVideoFxDefaults(STOCK_CLIP_VIDEO_FX, { vibratoSwirlEnabled: false }, d))
      .toEqual({ vibratoSwirlEnabled: false })
  })

  it('seeds the default amount when Swirl goes off -> on for an untouched clip', () => {
    expect(seedVideoFxDefaults(STOCK_CLIP_VIDEO_FX, { vibratoSwirlEnabled: true }, d))
      .toEqual({ vibratoSwirlEnabled: true, swirlAmount: 0.7 })
  })

  it('leaves a hand-dialled amount alone when the clip is re-enabled', () => {
    expect(seedVideoFxDefaults({ ...STOCK_CLIP_VIDEO_FX, swirlAmount: 0.11 }, { vibratoSwirlEnabled: true }, d))
      .toEqual({ vibratoSwirlEnabled: true })
  })

  it('seeds only the group being switched on', () => {
    expect(seedVideoFxDefaults(STOCK_CLIP_VIDEO_FX, { scratchWaveEnabled: true }, d)).toEqual({
      scratchWaveEnabled: true,
      waveAmount: 0.3,
      waveFrequency: 12,
      smearAmount: 0.2,
      reverseWaveWithScratch: false,
    })
  })

  it('lets a value the caller passed explicitly win over the default', () => {
    expect(seedVideoFxDefaults(STOCK_CLIP_VIDEO_FX, { vibratoSwirlEnabled: true, swirlAmount: 0.05 }, d))
      .toEqual({ vibratoSwirlEnabled: true, swirlAmount: 0.05 })
  })

  it('does not re-seed a clip that already had the FX on', () => {
    const existing = { ...STOCK_CLIP_VIDEO_FX, vibratoSwirlEnabled: true }
    expect(seedVideoFxDefaults(existing, { vibratoSwirlEnabled: true }, d))
      .toEqual({ vibratoSwirlEnabled: true })
  })
})
