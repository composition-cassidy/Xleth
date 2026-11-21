import { useCallback, useEffect, useRef, useState } from 'react'

// Parameter state for a device body whose editor never had a plugin-ui manifest
// (Delay, Flanger, Reverb, UniFlange). It is the write path those editors have
// always used, lifted out unchanged:
//
//   hydrate   one getEffectParameters read when the target changes
//   preview   local state now, engine write coalesced to one per animation frame
//             per parameter (a knob sweep must not be an IPC storm)
//   commit    local state + an immediate authoritative write (release, typed
//             value, wheel step, reset)
//
// `defaults` is a flat { id: value } object; only ids in it are hydrated.
// Returns { params, preview, commit, syncParamsFromPreset }.
export default function useDeviceParams(tag, defaults, target) {
  const [params, setParams] = useState(defaults)
  const targetRef = useRef(target)
  const pendingRef = useRef(null)
  const rafRef = useRef(0)
  targetRef.current = target

  useEffect(() => {
    setParams(defaults)
    if (!target) return undefined
    if (typeof window.xleth?.audio?.getEffectParameters !== 'function') {
      console.warn(`[Device] ${tag}: audio.getEffectParameters is unavailable, showing defaults`)
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const raw = await window.xleth.audio.getEffectParameters(target.trackId, target.nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        if (cancelled) return
        const next = { ...defaults }
        for (const p of list) if (p.id in next) next[p.id] = p.value
        setParams(next)
      } catch (e) {
        console.warn(`[Device] ${tag}: hydrate failed:`, e?.message)
      }
    })()
    return () => { cancelled = true }
  }, [target, defaults, tag])

  const send = useCallback((id, value) => {
    const t = targetRef.current
    if (!t) return
    const fn = window.xleth?.audio?.setEffectParameter
    if (typeof fn !== 'function') {
      console.warn(`[Device] ${tag}: audio.setEffectParameter is unavailable, dropped`, id, value)
      return
    }
    fn(t.trackId, t.nodeId, id, value)
  }, [tag])

  const flush = useCallback(() => {
    rafRef.current = 0
    const pending = pendingRef.current
    pendingRef.current = null
    if (!pending) return
    for (const id of Object.keys(pending)) send(id, pending[id])
  }, [send])

  const preview = useCallback((id, value) => {
    setParams((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }))
    pendingRef.current = { ...(pendingRef.current || {}), [id]: value }
    if (!rafRef.current) rafRef.current = requestAnimationFrame(flush)
  }, [flush])

  const commit = useCallback((id, value) => {
    setParams((prev) => (prev[id] === value ? prev : { ...prev, [id]: value }))
    if (pendingRef.current) delete pendingRef.current[id]
    send(id, value)
  }, [send])

  useEffect(() => () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    pendingRef.current = null
  }, [])

  // A preset load, its undo or an A/B switch: the adapter already wrote the
  // engine, so this only mirrors the blob it applied.
  const syncParamsFromPreset = useCallback((state) => {
    if (!state?.params || typeof state.params !== 'object') return
    setParams((prev) => ({ ...prev, ...state.params }))
  }, [])

  return { params, preview, commit, syncParamsFromPreset }
}
