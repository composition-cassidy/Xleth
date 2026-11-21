import { create } from 'zustand'
import { isMotionTier, setRootMotionTier } from '../ui-kit/motion'

// ─── Motion tier (ui/DESIGN.md section 27) ────────────────────────────────────
// How much the interface moves: Settings > Appearance > Motion.
//
//   flat    Tier 1  no animation at all, instant cuts
//   smooth  Tier 2  hover colour, dialogs, mouse-opened popovers, toasts (the default)
//   lively  Tier 3  everything transitional, with character
//
// The tier the user PICKED is `tier`; the tier IN FORCE is `effectiveMotionTier(state)`: when
// "Follow the system setting" is on and Windows has animation effects turned off
// (prefers-reduced-motion: reduce), the tier in force is flat whatever was picked. The tier in
// force is written to <html data-motion-tier>, where ui-kit/motion.css keys every duration
// off it. Nothing else in the app decides whether something animates.
//
// Persisted through window.xleth.settings under `uiMotion` = { tier, followSystem }.
// Debug logs use the [Motion] prefix.

const SETTINGS_KEY = 'uiMotion'
const CHANNEL_NAME = 'xleth-ui-motion'

export const MOTION_TIER_DEFAULT = 'smooth'

export const MOTION_TIER_OPTIONS = [
  {
    value: 'flat',
    label: 'Flat',
    description: 'No animation. Every change is an instant cut.',
  },
  {
    value: 'smooth',
    label: 'Smooth',
    description: 'Dialogs, menus you open with the mouse and status messages ease in and out, and controls fade as you point at them. Editing and keyboard shortcuts stay instant.',
  },
  {
    value: 'lively',
    label: 'Lively',
    description: 'Everything above, plus motion while you work: menus cascade, panels and tabs slide into place, buttons press, toggles and focus settle. Dragging, the playhead and the meters are never animated.',
  },
]

/** The tier actually applied, given what was picked and what the system asks for. */
export function effectiveMotionTier({ tier, followSystem, systemReduced }) {
  if (followSystem && systemReduced) return 'flat'
  return isMotionTier(tier) ? tier : MOTION_TIER_DEFAULT
}

/** Clean a stored value (or garbage) into { tier, followSystem }. */
export function normalizeMotionSettings(saved) {
  const tier = isMotionTier(saved?.tier) ? saved.tier : MOTION_TIER_DEFAULT
  const followSystem = typeof saved?.followSystem === 'boolean' ? saved.followSystem : true
  return { tier, followSystem }
}

function readSystemReduced() {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

let mediaQuery = null
let mediaListener = null
let channel = null

function persist(state) {
  const value = { tier: state.tier, followSystem: state.followSystem }
  Promise.resolve(window.xleth?.settings?.set?.(SETTINGS_KEY, value))
    .catch((e) => console.warn('[Motion] Failed to persist uiMotion:', e))
  // Other windows of this app (the FX Graph window) follow at once.
  try { channel?.postMessage(value) } catch { /* a closed channel is not an error */ }
}

export const useMotionStore = create((set, get) => ({
  tier: MOTION_TIER_DEFAULT,
  followSystem: true,
  systemReduced: false,
  hydrated: false,

  /** Read the saved choice and start following the system setting. Safe to call more than once. */
  async hydrate() {
    if (typeof window === 'undefined') return

    if (mediaQuery && mediaListener) mediaQuery.removeEventListener?.('change', mediaListener)
    mediaQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    mediaListener = (e) => { set({ systemReduced: !!e.matches }); get().apply() }
    mediaQuery?.addEventListener?.('change', mediaListener)

    if (!channel && typeof BroadcastChannel === 'function') {
      try {
        channel = new BroadcastChannel(CHANNEL_NAME)
        channel.onmessage = (e) => { set(normalizeMotionSettings(e.data)); get().apply() }
      } catch { channel = null }
    }

    let saved = null
    try {
      saved = await window.xleth?.settings?.get?.(SETTINGS_KEY)
    } catch (e) {
      console.warn('[Motion] Could not load uiMotion, using the default:', e)
    }
    set({ ...normalizeMotionSettings(saved), systemReduced: readSystemReduced(), hydrated: true })
    get().apply()
  },

  /** Write the tier in force to <html>. */
  apply() {
    const tier = effectiveMotionTier(get())
    setRootMotionTier(tier)
    return tier
  },

  setTier(tier) {
    if (!isMotionTier(tier) || tier === get().tier) return
    set({ tier })
    const applied = get().apply()
    console.log(`[Motion] tier=${tier} (in force: ${applied})`)
    persist(get())
  },

  setFollowSystem(followSystem) {
    const next = !!followSystem
    if (next === get().followSystem) return
    set({ followSystem: next })
    get().apply()
    persist(get())
  },
}))
