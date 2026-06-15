import React, { useEffect, useMemo, useState } from 'react'
import { GripVertical, Power } from 'lucide-react'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useMixerStore, {
  COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID,
  findSidechainRouteForEffect,
  mapSidechainRouteStatus,
} from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
import ContextMenu from '../ContextMenu.jsx'
import { EFFECT_EDITORS, PLUGIN_NAMES, resolveTrackId } from './effectEditorOpeners.js'
import './EffectModule.sidechain.css'

export function isSelectableEffectModule(effect) {
  return Number.isInteger(effect?.nodeId) && effect.nodeId !== -1
}

export function stopEffectModuleEvent(event, { preventDefault = false } = {}) {
  if (preventDefault) {
    event?.preventDefault?.()
  }
  event?.stopPropagation?.()
}

export function getEffectModuleInlineAction(effect, isVst) {
  if (effect?.missing) {
    return {
      action: 'remove',
      label: 'Remove',
      title: 'Remove missing plugin placeholder',
      className: 'effect-module-action effect-module-action--danger',
    }
  }

  if (effect?.crashed && isVst) {
    return {
      action: 'reset',
      label: 'Reset',
      title: 'Attempt plugin crash recovery',
      className: 'effect-module-action effect-module-action--warning',
    }
  }

  if (isVst) {
    return {
      action: 'edit',
      label: 'Edit',
      title: 'Open plugin editor',
      className: 'effect-module-action',
    }
  }

  return null
}

export function readCompressorExternalSidechainValue(parameters) {
  if (!Array.isArray(parameters)) return null
  const param = parameters.find((entry) =>
    entry?.id === COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID ||
    entry?.parameterId === COMPRESSOR_EXTERNAL_SIDECHAIN_PARAM_ID)
  if (!param) return null
  const rawValue = param.value ?? param.normalizedValue ?? param.defaultValue
  if (typeof rawValue === 'boolean') return rawValue
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) return rawValue >= 0.5
  return null
}

export function effectHasCompressorSidechainParam(effect) {
  return readCompressorExternalSidechainValue(effect?.parameters) != null ||
    readCompressorExternalSidechainValue(effect?.params) != null
}

export function canShowCompressorSidechainControls(effect, storeKey) {
  return canShowSidechainControls(effect, storeKey)
}

export function readEngineSidechainCapability(effect) {
  const capability = effect?.sidechain
  if (!capability || typeof capability !== 'object') return null
  if (typeof capability.supported !== 'boolean') return null
  return {
    supported: capability.supported,
    channels: Number.isInteger(capability.channels) ? capability.channels : 0,
    enabled: capability.enabled === true,
  }
}

export function canShowSidechainControls(effect, storeKey) {
  if (storeKey === 'master') return false
  if (!isSelectableEffectModule(effect) || effect?.missing || effect?.crashed) return false
  if (readEngineSidechainCapability(effect)?.supported !== true) return false
  return typeof effect?.effectInstanceId === 'string' && effect.effectInstanceId.length > 0
}

export function getSidechainStatusText({
  externalEnabled,
  route,
  routeError,
  sourceTrack,
}) {
  if (routeError) return routeError
  if (route?.status && route.status !== 'ok') return mapSidechainRouteStatus(route.status) ?? 'Route stale'
  if (!externalEnabled) return 'Sidechain: Off'
  if (!route) return 'Sidechain: Off'
  if (!sourceTrack) return 'Route stale'
  if (route.enabled === false) return 'Sidechain: Off'
  return `Sidechain: ${sourceTrack.name || `Track ${route.sourceTrackId}`}`
}

export const getCompressorSidechainStatusText = getSidechainStatusText

export async function runEffectModuleInlineAction(action, {
  audio,
  fetchChain,
  removeEffect,
  storeKey,
  nodeId,
}) {
  const trackId = resolveTrackId(storeKey)

  switch (action) {
    case 'remove':
      return removeEffect?.(storeKey, nodeId)

    case 'reset':
      await audio?.resetCrashedPlugin?.(trackId, nodeId)
      return fetchChain?.(storeKey)

    case 'edit':
      return audio?.openPluginEditor?.(trackId, nodeId)

    default:
      return undefined
  }
}

export function openStockEffectEditor(effect, storeKey) {
  if (!effect || effect.missing || !isSelectableEffectModule(effect)) return false
  const opener = EFFECT_EDITORS[effect.pluginId]
  if (!opener) return false

  const trackId = resolveTrackId(storeKey)
  opener(trackId, effect.nodeId, storeKey)
  return true
}

export function handleEffectModuleRowSelection(effect, onSelect) {
  if (!isSelectableEffectModule(effect)) return false
  onSelect?.(effect.nodeId)
  return true
}

export function handleEffectModuleTitleClick(event, { effect, storeKey, onSelect }) {
  stopEffectModuleEvent(event)
  const selected = handleEffectModuleRowSelection(effect, onSelect)
  const opened = openStockEffectEditor(effect, storeKey)
  return { selected, opened }
}

export function handleEffectModuleBypassClick(event, {
  effect,
  isPending,
  setBypass,
  storeKey,
}) {
  stopEffectModuleEvent(event)
  if (isPending) return false

  setBypass(storeKey, effect.nodeId, !effect.bypassed)
  return true
}

export async function handleEffectModuleInlineActionClick(event, {
  audio,
  effect,
  fetchChain,
  inlineAction,
  isPending,
  removeEffect,
  storeKey,
}) {
  stopEffectModuleEvent(event)
  if (!inlineAction || isPending) return false

  await runEffectModuleInlineAction(inlineAction.action, {
    audio,
    fetchChain,
    removeEffect,
    storeKey,
    nodeId: effect.nodeId,
  })
  return true
}

function parseEffectParameters(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return [] }
  }
  return Array.isArray(raw) ? raw : []
}

function SidechainControls({ effect, storeKey }) {
  const targetTrackId = resolveTrackId(storeKey)
  const routeKey = `${targetTrackId}::${effect.effectInstanceId}`
  const requiresExternalParam = effect.pluginId === 'compressor'
  const tracks = useMixerStore(s => s.tracks)
  const trackOrder = useMixerStore(s => s.trackOrder)
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const sidechainRoutes = useMixerStore(s => s.sidechainRoutes)
  const sidechainRoutingErrors = useMixerStore(s => s.sidechainRoutingErrors)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const setEffectExternalSidechain = useMixerStore(s => s.setEffectExternalSidechain)
  const initialExternal = readCompressorExternalSidechainValue(effect.parameters) ??
    readCompressorExternalSidechainValue(effect.params) ??
    Boolean(findSidechainRouteForEffect(sidechainRoutes, targetTrackId, effect.effectInstanceId)?.enabled)
  const [externalEnabled, setExternalEnabled] = useState(requiresExternalParam ? initialExternal : Boolean(initialExternal))
  const [paramLoaded, setParamLoaded] = useState(requiresExternalParam && effectHasCompressorSidechainParam(effect))

  const route = useMemo(
    () => findSidechainRouteForEffect(sidechainRoutes, targetTrackId, effect.effectInstanceId),
    [sidechainRoutes, targetTrackId, effect.effectInstanceId],
  )
  const routeError = sidechainRoutingErrors[routeKey] ?? null
  const eligibleSources = useMemo(
    () => useMixerStore.getState().getEligibleSidechainSources(targetTrackId),
    [targetTrackId, tracks, trackOrder, outputRoutes, sidechainRoutes],
  )
  const sourceTrack = route ? tracks[route.sourceTrackId] : null
  const selectedSourceValue = route?.sourceTrackId != null ? String(route.sourceTrackId) : ''
  const hasSelectableSource = eligibleSources.length > 0 || Boolean(route && sourceTrack)
  const statusText = getSidechainStatusText({
    externalEnabled,
    route,
    routeError,
    sourceTrack,
  })

  useEffect(() => {
    if (!requiresExternalParam) {
      setParamLoaded(false)
      setExternalEnabled(Boolean(route?.enabled))
      return
    }
    setParamLoaded(effectHasCompressorSidechainParam(effect))
    const nextValue = readCompressorExternalSidechainValue(effect.parameters) ??
      readCompressorExternalSidechainValue(effect.params) ??
      Boolean(route?.enabled)
    setExternalEnabled(nextValue)
  }, [effect.effectInstanceId, requiresExternalParam, route?.enabled])

  useEffect(() => {
    refreshRouting()
  }, [refreshRouting])

  useEffect(() => {
    let cancelled = false
    if (!requiresExternalParam) return undefined
    ;(async () => {
      try {
        const raw = await window.xleth?.audio?.getEffectParameters?.(targetTrackId, effect.nodeId)
        if (cancelled) return
        const value = readCompressorExternalSidechainValue(parseEffectParameters(raw))
        if (value != null) {
          setParamLoaded(true)
          setExternalEnabled(value)
        } else {
          setParamLoaded(false)
        }
      } catch {
        if (!cancelled) setParamLoaded(false)
      }
    })()
    return () => { cancelled = true }
  }, [targetTrackId, effect.nodeId, effect.effectInstanceId, requiresExternalParam])

  useEffect(() => {
    if (!paramLoaded && route?.enabled) {
      setExternalEnabled(true)
    }
  }, [paramLoaded, route?.enabled])

  const applySidechain = async ({ enabled, sourceTrackId = selectedSourceValue }) => {
    const previousEnabled = externalEnabled
    setExternalEnabled(enabled)
    const result = await setEffectExternalSidechain({
      targetTrackId,
      targetNodeId: effect.nodeId,
      effectInstanceId: effect.effectInstanceId,
      enabled,
      sourceTrackId: enabled ? sourceTrackId : null,
      requireExternalParam: requiresExternalParam,
    })
    if (result?.externalEnabled != null) {
      setExternalEnabled(result.externalEnabled)
    } else if (result?.ok === false) {
      setExternalEnabled(previousEnabled)
    }
    return result
  }

  const handleSectionMouseDown = (event) => {
    stopEffectModuleEvent(event)
  }

  const handleToggleChange = async (event) => {
    stopEffectModuleEvent(event)
    await applySidechain({ enabled: event.target.checked })
  }

  const handleSourceChange = async (event) => {
    stopEffectModuleEvent(event)
    await applySidechain({ enabled: true, sourceTrackId: event.target.value })
  }

  return (
    <div
      className="compressor-sidechain-controls"
      onMouseDown={handleSectionMouseDown}
      onClick={stopEffectModuleEvent}
      role="group"
      aria-label="Effect sidechain"
    >
      {requiresExternalParam ? (
        <label className={`compressor-sidechain-toggle${externalEnabled ? ' compressor-sidechain-toggle--on' : ''}`}>
          <input
            type="checkbox"
            checked={externalEnabled}
            onChange={handleToggleChange}
            aria-label="External Sidechain"
          />
          <span>EXT. SIDECHAIN</span>
        </label>
      ) : (
        <span className="compressor-sidechain-toggle compressor-sidechain-toggle--readonly">
          SIDECHAIN
        </span>
      )}

      <label className="compressor-sidechain-source">
        <select
          value={selectedSourceValue}
          onChange={handleSourceChange}
          disabled={(requiresExternalParam && !externalEnabled) || !hasSelectableSource}
          aria-label="Sidechain source"
        >
          <option value="">none</option>
          {route && sourceTrack && !eligibleSources.some(source => source.sourceTrackId === route.sourceTrackId) && (
            <option value={String(route.sourceTrackId)}>{sourceTrack.name || `Track ${route.sourceTrackId}`}</option>
          )}
          {eligibleSources.map((source) => (
            <option key={source.sourceTrackId} value={String(source.sourceTrackId)}>
              {source.name}
            </option>
          ))}
        </select>
      </label>

      {(routeError || (route && route.status !== 'ok')) && (
        <span className="compressor-sidechain-status compressor-sidechain-status--warning">
          {statusText}
        </span>
      )}
    </div>
  )
}

export function handleEffectModuleGripMouseDown(event, {
  effect,
  index,
  isPending,
  onDragStart,
}) {
  stopEffectModuleEvent(event, { preventDefault: true })
  if (isPending) return false

  onDragStart(effect.nodeId, index, event)
  return true
}

export default function EffectModule({
  effect,
  index,
  storeKey,
  onDragStart,
  onDragOver,
  onSelect,
  selected = false,
}) {
  const [deleteMenu, setDeleteMenu] = useState(null)
  const setBypass = useEffectChainStore(s => s.setBypass)
  const fetchChain = useEffectChainStore(s => s.fetchChain)
  const removeEffect = useEffectChainStore(s => s.removeEffect)
  const vstPlugins = useVstStore(s => s.plugins)

  const isPending = effect.nodeId === -1
  const isVst = !(effect.pluginId in PLUGIN_NAMES)
  const stockName = PLUGIN_NAMES[effect.pluginId]
  const vstMeta = isVst ? vstPlugins.find(p => p.id === effect.pluginId) : null
  const displayName = stockName ?? vstMeta?.name ?? effect.pluginId
  const vendor = vstMeta?.vendor ?? null
  const canOpenStockEditor = Boolean(EFFECT_EDITORS[effect.pluginId]) && !effect.missing
  const inlineAction = isPending ? null : getEffectModuleInlineAction(effect, isVst)
  const showSidechainControls = canShowSidechainControls(effect, storeKey)

  const handleBypassClick = (e) => {
    handleEffectModuleBypassClick(e, {
      effect,
      isPending,
      setBypass,
      storeKey,
    })
  }

  const handleContextMenu = (e) => {
    stopEffectModuleEvent(e, { preventDefault: true })
    if (isPending) return
    setDeleteMenu({ x: e.clientX, y: e.clientY })
  }

  const handleRowClick = () => {
    handleEffectModuleRowSelection(effect, onSelect)
  }

  const handleTitleContentClick = (e) => {
    handleEffectModuleTitleClick(e, {
      effect,
      storeKey,
      onSelect,
    })
  }

  const handleInlineAction = async (e) => {
    await handleEffectModuleInlineActionClick(e, {
      audio: window.xleth?.audio,
      effect,
      fetchChain,
      inlineAction,
      isPending,
      removeEffect,
      storeKey,
    })
  }

  const handleGripMouseDown = (e) => {
    handleEffectModuleGripMouseDown(e, {
      effect,
      index,
      isPending,
      onDragStart,
    })
  }

  const handleGripClick = (e) => {
    stopEffectModuleEvent(e, { preventDefault: true })
  }

  const handleMouseEnter = () => {
    onDragOver(index)
  }

  const nameTitle = displayName + (vendor ? ` - ${vendor}` : '')
  const rowClassName =
    `effect-module${selected ? ' effect-module--selected' : ''}` +
    `${effect.bypassed ? ' effect-module--bypassed' : ''}` +
    `${isPending ? ' effect-module--pending' : ''}` +
    `${showSidechainControls ? ' effect-module--with-sidechain' : ''}`

  return (
    <div
      className={rowClassName}
      onClick={handleRowClick}
      onMouseEnter={handleMouseEnter}
      onContextMenu={handleContextMenu}
      role="option"
      aria-selected={selected}
    >
      <div className="effect-module-grip-zone">
        <div
          className="effect-module-grip"
          onMouseDown={handleGripMouseDown}
          onClick={handleGripClick}
          title="Drag to reorder"
          aria-label="Drag to reorder effect"
        >
          <GripVertical size={10} />
        </div>
      </div>

      <div
        className={`effect-module-content${canOpenStockEditor ? ' effect-module-content--editable' : ''}`}
        title={nameTitle}
        onClick={handleTitleContentClick}
      >
        <span className="effect-module-name-text">{displayName}</span>
        {vendor && <span className="effect-module-vendor">{vendor}</span>}
      </div>

      <div className="effect-module-badges" aria-live="polite">
        {effect.missing && (
          <span className="effect-module-badge effect-module-badge--missing">MISSING</span>
        )}
        {effect.crashed && (
          <span className="effect-module-badge effect-module-badge--crashed">CRASHED</span>
        )}
      </div>

      <div className="effect-module-action-slot">
        {inlineAction ? (
          <button
            className={inlineAction.className}
            onClick={handleInlineAction}
            title={inlineAction.title}
            aria-label={inlineAction.title}
          >
            {inlineAction.label}
          </button>
        ) : (
          <span className="effect-module-action-placeholder" aria-hidden="true" />
        )}
      </div>

      <button
        className={`effect-module-bypass${effect.bypassed ? ' bypassed' : ''}`}
        onClick={handleBypassClick}
        title={effect.bypassed ? 'Enable effect' : 'Bypass effect'}
        aria-label={effect.bypassed ? 'Enable effect' : 'Bypass effect'}
      >
        <Power size={10} />
      </button>

      {showSidechainControls && (
        <SidechainControls effect={effect} storeKey={storeKey} />
      )}

      {deleteMenu && (
        <ContextMenu
          x={deleteMenu.x}
          y={deleteMenu.y}
          items={[{ label: 'Delete', danger: true, onClick: () => removeEffect(storeKey, effect.nodeId) }]}
          onClose={() => setDeleteMenu(null)}
        />
      )}
    </div>
  )
}
