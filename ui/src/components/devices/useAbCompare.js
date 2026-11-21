import { useCallback, useEffect, useRef, useState } from 'react'
import { getPresetAdapter } from '../../fx-presets/effectPresetAdapters.js'

// A/B compare for one device, entirely in the renderer. Each side is a state
// blob from the same preset adapter the preset system uses
// (fx-presets/effectPresetAdapters.js): capture = the existing parameter
// getters, apply = a burst of the existing setters. No new RPC.
//
// Side B starts as a copy of A, so the first switch is silent. Every later
// switch stores the current side and applies the other. Like parameter edits,
// a switch is not an undo entry (stock-effect parameters have no undo).

export default function useAbCompare({ effectType, target, onApplied }) {
  const [side, setSide] = useState('a')
  const [busy, setBusy] = useState(false)
  const slotsRef = useRef({ a: null, b: null })
  const nodeKey = target ? `${target.storeKey}:${target.nodeId}` : null

  // A different effect instance starts a fresh comparison.
  useEffect(() => {
    slotsRef.current = { a: null, b: null }
    setSide('a')
  }, [effectType, nodeKey])

  const switchTo = useCallback(async (next) => {
    if (!target || busy || next === side) return
    setBusy(true)
    try {
      const adapter = getPresetAdapter(effectType)
      const current = await adapter.captureState(target)
      slotsRef.current[side] = current
      const stored = slotsRef.current[next]
      if (stored) {
        await adapter.applyState(target, stored)
        onApplied?.(stored)
      } else {
        slotsRef.current[next] = current
      }
      setSide(next)
    } catch (err) {
      console.warn('[Device] A/B switch failed:', err?.message)
    } finally {
      setBusy(false)
    }
  }, [target, busy, side, effectType, onApplied])

  // Copy the side being edited onto the other one.
  const copyToOther = useCallback(async () => {
    if (!target || busy) return
    try {
      const current = await getPresetAdapter(effectType).captureState(target)
      slotsRef.current[side === 'a' ? 'b' : 'a'] = current
    } catch (err) {
      console.warn('[Device] A/B copy failed:', err?.message)
    }
  }, [target, busy, side, effectType])

  return { side, busy, switchTo, copyToOther }
}
