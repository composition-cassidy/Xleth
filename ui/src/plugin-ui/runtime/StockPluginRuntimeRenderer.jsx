import { useState, useEffect, useCallback, useMemo } from 'react'
import { validate } from '../schema/validate.js'
import { getManifest } from '../manifests/index.js'
import { SHIPPED_LAYOUTS } from '../layouts/index.js'
import { buildPlaceholderLayout } from './placeholderLayout.js'
import { resolveComponent } from './registry.js'
import { PluginUIContext } from './PluginUIContext.js'
import { useMeterBus, useEffectMeterPolling } from './useEffectMeterPolling.js'

// ── Unknown / invalid node placeholders ──────────────────────────────────────

function UnknownNodePlaceholder({ node }) {
  if (process.env.NODE_ENV === 'production') return null
  return (
    <div className="pluginui-unknown-node" title={`Unknown type: ${node.type}`}>
      ?&nbsp;{node.type}
    </div>
  )
}

function InvalidNodePlaceholder({ node }) {
  if (process.env.NODE_ENV === 'production') return null
  return (
    <div className="pluginui-invalid-node" title={`Invalid node: ${node.id}`}>
      ✕&nbsp;{node.id}
    </div>
  )
}

// ── Layout resolution ─────────────────────────────────────────────────────────

function resolveShippedLayout(pluginId, manifest) {
  const shipped = SHIPPED_LAYOUTS[pluginId]
  if (!shipped) return buildPlaceholderLayout(pluginId, manifest)
  const result = validate(shipped, manifest)
  if (result.ok) return result.doc
  console.error(`[PluginUI] Shipped layout for "${pluginId}" failed validation:`, result.errors)
  return buildPlaceholderLayout(pluginId, manifest)
}

// ── Main renderer ─────────────────────────────────────────────────────────────
//
// `layoutOverride` (optional) — when present, the renderer skips its user-override
// IPC read and `onLayoutChanged` listener and uses the override directly. Any
// hard-fail in validation falls back through the existing shipped/placeholder
// cascade. This is the integration point for the Plugin UI Designer's preview.

export default function StockPluginRuntimeRenderer({
  pluginId,
  target,
  onClose,
  layoutOverride,
  layoutOverrideErrors,
}) {
  const manifest = useMemo(() => getManifest(pluginId), [pluginId])

  // Start with shipped layout (synchronous, no flash)
  const [activeLayout, setActiveLayout] = useState(() => resolveShippedLayout(pluginId, manifest))
  const [layoutErrors, setLayoutErrors] = useState([])

  // Param state: keyed by param id, hydrated from engine on target change
  const [params, setParams] = useState(() => buildDefaultParams(manifest))

  // Meter bus: mutable registry of nodeId → { slotIndex, updateFn }
  const meterBus = useMeterBus()

  // Run one rAF meter polling loop for all Meter nodes in this panel
  useEffectMeterPolling(target, meterBus)

  const overrideActive = layoutOverride != null

  // Honor layoutOverride when the Designer is driving the renderer.
  useEffect(() => {
    if (!overrideActive) return
    const result = validate(layoutOverride, manifest)
    if (result.ok) {
      setActiveLayout(result.doc)
      setLayoutErrors(layoutOverrideErrors ?? result.errors)
    } else {
      // Hard-fail: keep the existing shipped/placeholder fallback active so the
      // panel keeps rendering. Surface the errors for any consumer that cares.
      const fallback = resolveShippedLayout(pluginId, manifest)
      setActiveLayout(fallback)
      setLayoutErrors(layoutOverrideErrors ?? result.errors)
    }
  }, [overrideActive, layoutOverride, layoutOverrideErrors, pluginId, manifest])

  // Try to load user override when target opens (production path only).
  useEffect(() => {
    if (!target || overrideActive) return
    let cancelled = false

    async function tryUserOverride() {
      try {
        const raw = await window.xleth?.pluginUi?.loadUserOverride?.(pluginId)
        if (!raw || cancelled) return
        const result = validate(raw, manifest)
        if (result.ok) {
          if (!cancelled) {
            setActiveLayout(result.doc)
            setLayoutErrors(result.errors)
          }
        } else {
          console.warn(`[PluginUI] User override for "${pluginId}" is invalid — using shipped default.`, result.errors)
        }
      } catch (e) {
        // No user override or IPC failed; shipped default already active
      }
    }

    tryUserOverride()
    return () => { cancelled = true }
  }, [target, pluginId, manifest, overrideActive])

  // Listen for cross-window layout-changed notifications (designer saves).
  // Skipped while a layoutOverride is active — the Designer is canonical then.
  useEffect(() => {
    if (overrideActive) return
    const unsub = window.xleth?.pluginUi?.onLayoutChanged?.((changedPluginId) => {
      if (changedPluginId !== pluginId) return
      // Re-run the user-override load (triggers if target is set)
      if (target) {
        window.xleth?.pluginUi?.loadUserOverride?.(pluginId).then(raw => {
          if (!raw) {
            setActiveLayout(resolveShippedLayout(pluginId, manifest))
            setLayoutErrors([])
            return
          }
          const result = validate(raw, manifest)
          if (result.ok) {
            setActiveLayout(result.doc)
            setLayoutErrors(result.errors)
          }
        }).catch(() => {})
      }
    })
    return () => unsub?.()
  }, [pluginId, target, manifest, overrideActive])

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

  // ── Context value (stable reference per render cycle) ──────────────────

  const ctx = useMemo(() => ({
    target,
    manifest,
    params,
    setParam,
    meterBus,
    onClose,
    layoutErrors,
  }), [target, manifest, params, setParam, meterBus, onClose, layoutErrors])

  // ── Recursive node renderer ─────────────────────────────────────────────

  function renderNode(node) {
    if (!node) return null

    if (node._invalid) {
      return <InvalidNodePlaceholder key={node.id || `_invalid_${node._invalidIdx ?? Math.random()}`} node={node} />
    }

    const Component = resolveComponent(node.type)
    if (!Component) {
      return <UnknownNodePlaceholder key={node.id} node={node} />
    }

    // For TabGroup, pass renderChildren with support for a subset override
    const renderChildren = (childOverride) => {
      const children = childOverride ?? node.children ?? []
      return children.map(renderNode)
    }

    return (
      <Component key={node.id} node={node} renderChildren={renderChildren} />
    )
  }

  if (!target) return null

  return (
    <PluginUIContext.Provider value={ctx}>
      {renderNode(activeLayout.root)}
    </PluginUIContext.Provider>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildDefaultParams(manifest) {
  if (!manifest) return {}
  return Object.fromEntries(
    Object.entries(manifest.params).map(([id, meta]) => [id, meta.defaultValue])
  )
}
