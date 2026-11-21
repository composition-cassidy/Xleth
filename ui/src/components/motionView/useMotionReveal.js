// 'xleth-motion-reveal' (docs/XLETH_MOTION_VIEW_DESIGN.md 5.2, R17): the Edit view's
// motion marker and the Inspector's "Show in Motion view" buttons ask the
// timeline to switch to Motion view and open { trackId, path } there. The
// timeline listens with useMotionRevealListener and hands the request to
// MotionView (its `reveal` prop), which expands, selects and scrolls to the row
// once its rows exist (a reveal from the Edit view arrives before MotionView mounts).

import { useEffect, useRef } from 'react'
import { MOTION_REVEAL_EVENT } from '../timeline/motionReveal.js'
import { useMotionViewStore } from '../../motion/motionViewStore.js'

/**
 * Turn one event detail into a reveal request and switch to Motion view.
 * Returns { trackId, path } (a NEW object every time, so the same row can be
 * revealed twice) or null for a detail without a usable track id.
 */
export function acceptMotionReveal(detail, store = useMotionViewStore) {
  const trackId = Number(detail?.trackId)
  if (!Number.isFinite(trackId)) return null
  const path = Array.isArray(detail?.path) ? detail.path.filter((s) => typeof s === 'string' && s.length > 0) : []
  store.getState().setView('motion')
  return { trackId, path }
}

/** Listen on window for reveal requests; onReveal({ trackId, path }) after the view switch. */
export function useMotionRevealListener(onReveal) {
  const cb = useRef(onReveal)
  cb.current = onReveal
  useEffect(() => {
    const on = (e) => {
      const req = acceptMotionReveal(e?.detail)
      if (req) cb.current?.(req)
    }
    window.addEventListener(MOTION_REVEAL_EVENT, on)
    return () => window.removeEventListener(MOTION_REVEAL_EVENT, on)
  }, [])
}
