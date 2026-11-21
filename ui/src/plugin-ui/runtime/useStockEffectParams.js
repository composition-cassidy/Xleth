import { useCallback, useEffect, useState } from 'react'

// Parameter state for one open stock effect, as the plugin-ui runtime has always
// done it: defaults from the manifest, hydrated once from getEffectParameters
// when the target changes, and every edit written straight through with
// setEffectParameter (live drag and commit alike). Shared by
// StockPluginRuntimeRenderer and the device bodies, so both write the engine the
// same way.
//
// Returns { params, setParam, syncParamsFromPreset }.

export function buildDefaultParams(manifest) {
  if (!manifest) return {}
  return Object.fromEntries(
    Object.entries(manifest.params).map(([id, meta]) => [id, meta.defaultValue])
  )
}

export default function useStockEffectParams(pluginId, manifest, target) {
  const [params, setParams] = useState(() => buildDefaultParams(manifest))

  // Hydrate params from engine when target changes
  useEffect(() => {
    if (!target) {
      setParams(buildDefaultParams(manifest))
      return
    }
    const { trackId, nodeId } = target
    const defaults = buildDefaultParams(manifest)
    setParams(defaults)

    ;(async () => {
      try {
        const raw  = await window.xleth?.audio?.getEffectParameters(trackId, nodeId)
        const list = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : [])
        setParams(prev => {
          const next = { ...prev }
          for (const p of list) {
            if (p.id in next) next[p.id] = p.value
          }
          return next
        })
      } catch (e) {
        console.warn(`[PluginUI] hydrate params failed for "${pluginId}":`, e?.message)
      }
    })()
  }, [target, pluginId, manifest])

  const setParam = useCallback((paramId, value) => {
    if (!target) return
    setParams(prev => ({ ...prev, [paramId]: value }))
    window.xleth?.audio?.setEffectParameter(target.trackId, target.nodeId, paramId, value)
  }, [target])

  // Sync local state from an applied preset (or its undo / an A/B switch) — the
  // adapter already wrote the engine, so this only mirrors the known blob.
  const syncParamsFromPreset = useCallback((state) => {
    if (!state || typeof state.params !== 'object') return
    setParams(prev => ({ ...prev, ...state.params }))
  }, [])

  return { params, setParam, syncParamsFromPreset }
}
