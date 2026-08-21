import { useCallback, useMemo } from 'react'
import useSamplerModulationStore from '../../../stores/samplerModulationStore.js'
import useSamplerModDragStore from '../../../stores/samplerModDragStore.js'
import {
  targetKey, routeKey, modRangeInKnobUnits, routeTooltip, sourceLabel,
  modSourceColorVar,
} from './modTargets.js'

// ── The registration hook ────────────────────────────────────────────────────
// Turns a declarative registration into the `mod` prop the shared Knob (and the
// slot mini-controls) consume. Call it unconditionally — `reg == null` returns
// null, which is exactly the "this control is not a modulation target" state.
//
// Multiple sources may drive the same control. The ring belongs to the FIRST
// route, which is the one a ring drag and a right-click act on; the rest are
// counted in the tooltip and edited in the tray's route list. One ring cannot
// honestly represent two independent depths, and stacking them would make the
// hit-test ambiguous.
export function useModTarget(reg, { value, min, max, color } = {}) {
  const key = reg ? targetKey(reg.target, reg.index ?? 0, reg.stage ?? 0) : null

  const routes = useSamplerModulationStore((s) => s.config?.routes)
  const previewRouteAmount = useSamplerModulationStore((s) => s.previewRouteAmount)
  const setRouteAmount = useSamplerModulationStore((s) => s.setRouteAmount)
  const toggleRouteBipolar = useSamplerModulationStore((s) => s.toggleRouteBipolar)
  const dragSource = useSamplerModDragStore((s) => s.source)
  const hoverKey = useSamplerModDragStore((s) => s.hoverKey)

  const matches = useMemo(() => {
    if (!key || !Array.isArray(routes)) return []
    const out = []
    for (let i = 0; i < routes.length; i++) if (routeKey(routes[i]) === key) out.push(i)
    return out
  }, [key, routes])

  const routeIdx = matches.length ? matches[0] : -1
  const route = routeIdx >= 0 ? routes[routeIdx] : null

  const onRingPreview = useCallback((amount) => {
    if (routeIdx >= 0) previewRouteAmount(routeIdx, amount)
  }, [routeIdx, previewRouteAmount])

  const onRingCommit = useCallback((amount) => {
    if (routeIdx >= 0) setRouteAmount(routeIdx, amount)
  }, [routeIdx, setRouteAmount])

  const onToggleBipolar = useCallback(() => {
    if (routeIdx >= 0) toggleRouteBipolar(routeIdx)
  }, [routeIdx, toggleRouteBipolar])

  return useMemo(() => {
    if (!reg || !key) return null
    const range = route
      ? modRangeInKnobUnits(reg, value, route.amount, route.bipolar, min, max)
      : { lo: 0, hi: 0 }
    let tooltip = route ? routeTooltip(route, reg, value) : ''
    if (route && matches.length > 1) {
      const others = matches.slice(1).map((i) => sourceLabel(routes[i].source)).join(', ')
      tooltip += ` · also ${others}`
    }
    return {
      dropProps: { 'data-mod-target': key },
      active: !!route,
      highlight: dragSource != null && hoverKey === key,
      amount: route?.amount ?? 0,
      bipolar: !!route?.bipolar,
      ringLo: range.lo,
      ringHi: range.hi,
      // Colour follows whichever source is speaking: the routed one at rest,
      // the dragged one while a card hovers.
      colorVar: route ? modSourceColorVar(route.source)
        : (dragSource != null ? modSourceColorVar(dragSource) : (color || '--theme-accent')),
      tooltip,
      onRingPreview,
      onRingCommit,
      onToggleBipolar,
    }
    // `routes` is only read through `matches`, which already depends on it.
  }, [reg, key, route, matches, routes, value, min, max, color, dragSource, hoverKey,
      onRingPreview, onRingCommit, onToggleBipolar])
}

export default useModTarget
