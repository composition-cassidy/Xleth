import { create } from 'zustand'

// ─── Clip video-companion FX defaults ─────────────────────────────────────────
// User-level (not per-project) defaults for the Video Companion FX block of
// ClipModulation — the Swirl that rides Vibrato and the Wave that rides Scratch.
//
// Two consumers, and they read DIFFERENT halves of this object:
//
//   • The clip context menu seeds the AMOUNTS when a companion toggle goes
//     off → on, so a freshly enabled Swirl starts at the user's number instead
//     of the engine's stock 0.25. It ignores swirlEnabled / waveEnabled: the
//     user clicking the checkbox IS the enable decision.
//   • Settings → Clip FX → "Apply to Project" reads swirlEnabled / waveEnabled
//     to decide WHICH companion FX to switch on across the project, and the
//     amounts to decide what to set them to.
//
// Persisted through window.xleth.settings (userData/xleth-settings.json) under
// one key, same shape as backdropFxSettings.js.

export const CLIP_VIDEO_FX_DEFAULTS_KEY = 'clipVideoFxDefaults'

// The engine's own ClipModulation::VideoCompanion field initialisers
// (engine/src/model/TimelineTypes.h). A clip that has never been touched still
// reports exactly these, which is what makes isStockVideoCompanion() below a
// usable "untouched" test.
export const STOCK_CLIP_VIDEO_FX = Object.freeze({
  swirlAmount: 0.25,
  waveAmount: 0.08,
  waveFrequency: 8,
  smearAmount: 0,
  reverseWaveWithScratch: true,
})

export const DEFAULT_CLIP_VIDEO_FX_DEFAULTS = Object.freeze({
  // Which companion FX "Apply to Project" turns on. Off out of the box so the
  // button is a no-op until the user opts in to at least one.
  swirlEnabled: false,
  waveEnabled: false,
  ...STOCK_CLIP_VIDEO_FX,
})

function boolOrDefault(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

export function sanitizeClipVideoFxDefaults(value) {
  const s = value && typeof value === 'object' ? value : {}
  const d = DEFAULT_CLIP_VIDEO_FX_DEFAULTS
  return {
    swirlEnabled: boolOrDefault(s.swirlEnabled, d.swirlEnabled),
    waveEnabled: boolOrDefault(s.waveEnabled, d.waveEnabled),
    // Ranges mirror the clip context-menu sliders in TimelineView.jsx.
    swirlAmount: clampNumber(s.swirlAmount, -1, 1, d.swirlAmount),
    waveAmount: clampNumber(s.waveAmount, -1, 1, d.waveAmount),
    waveFrequency: clampNumber(s.waveFrequency, 0.25, 64, d.waveFrequency),
    smearAmount: clampNumber(s.smearAmount, -1, 1, d.smearAmount),
    reverseWaveWithScratch: boolOrDefault(s.reverseWaveWithScratch, d.reverseWaveWithScratch),
  }
}

// ─── Patch builders ───────────────────────────────────────────────────────────
// Both return a PARTIAL video patch for mergeClipModulationPatch — never a full
// video block, so a field this feature doesn't own (swirlRadius, swirlCenterX/Y)
// keeps whatever the clip already had.

export function swirlDefaultsPatch(defaults) {
  const d = sanitizeClipVideoFxDefaults(defaults)
  return { swirlAmount: d.swirlAmount }
}

export function waveDefaultsPatch(defaults) {
  const d = sanitizeClipVideoFxDefaults(defaults)
  return {
    waveAmount: d.waveAmount,
    waveFrequency: d.waveFrequency,
    smearAmount: d.smearAmount,
    reverseWaveWithScratch: d.reverseWaveWithScratch,
  }
}

// True when the clip's video block still holds the engine's stock values for
// the named group. Seeding is gated on this so re-ticking a checkbox on a clip
// whose Swirl the user dialled to 0.7 does not silently reset it to the default;
// only a clip that was never dialled in gets seeded.
export function isStockVideoCompanion(video, group) {
  const v = video ?? {}
  const near = (a, b) => Math.abs(Number(a ?? b) - b) < 1e-6
  if (group === 'swirl') return near(v.swirlAmount, STOCK_CLIP_VIDEO_FX.swirlAmount)
  return near(v.waveAmount, STOCK_CLIP_VIDEO_FX.waveAmount)
    && near(v.waveFrequency, STOCK_CLIP_VIDEO_FX.waveFrequency)
    && near(v.smearAmount, STOCK_CLIP_VIDEO_FX.smearAmount)
    && (v.reverseWaveWithScratch ?? STOCK_CLIP_VIDEO_FX.reverseWaveWithScratch)
       === STOCK_CLIP_VIDEO_FX.reverseWaveWithScratch
}

function getXlethSettings() {
  return typeof window !== 'undefined' ? window.xleth?.settings : null
}

export const useClipVideoFxDefaultsStore = create((set, get) => ({
  defaults: { ...DEFAULT_CLIP_VIDEO_FX_DEFAULTS },
  hydrated: false,
  hydrate: async () => {
    const bridge = getXlethSettings()
    if (!bridge?.get) {
      set({ hydrated: true })
      return get().defaults
    }
    try {
      const saved = await bridge.get(CLIP_VIDEO_FX_DEFAULTS_KEY)
      const next = sanitizeClipVideoFxDefaults(saved)
      set({ defaults: next, hydrated: true })
      return next
    } catch (err) {
      console.warn('[ClipVideoFxDefaults] hydrate failed:', err?.message || err)
      set({ hydrated: true })
      return get().defaults
    }
  },
  setDefaults: async (patch) => {
    const next = sanitizeClipVideoFxDefaults({ ...get().defaults, ...(patch || {}) })
    set({ defaults: next, hydrated: true })
    try {
      await getXlethSettings()?.set?.(CLIP_VIDEO_FX_DEFAULTS_KEY, next)
    } catch (err) {
      console.warn('[ClipVideoFxDefaults] persist failed:', err?.message || err)
    }
    return next
  },
  resetForTests: () => set({
    defaults: { ...DEFAULT_CLIP_VIDEO_FX_DEFAULTS },
    hydrated: false,
  }),
}))

export default useClipVideoFxDefaultsStore
