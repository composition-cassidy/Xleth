import React, { useState } from 'react'
import { GripVertical, Power } from 'lucide-react'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useVstStore from '../../stores/vstStore.js'
import ContextMenu from '../ContextMenu.jsx'
import { EFFECT_EDITORS, PLUGIN_NAMES, resolveTrackId } from './effectEditorOpeners.js'

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
    `${isPending ? ' effect-module--pending' : ''}`

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
