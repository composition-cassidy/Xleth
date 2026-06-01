import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import useEffectChainStore, { resolveFxMode, resolveFxPanelView } from '../../stores/effectChainStore.js'
import useVstStore from '../../stores/vstStore.js'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry'
import EffectModule from './EffectModule.jsx'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'
import {
  EFFECT_CATEGORIES,
  NO_SCANNED_PLUGINS_LABEL,
  formatVstPluginLabel,
  sortRackVstPlugins,
} from './effectCatalog.js'

// Re-exported so existing importers keep their path. The catalog itself now
// lives in effectCatalog.js, shared with the FX Graph add-effect picker.
export { EFFECT_CATEGORIES, sortRackVstPlugins }

const EMPTY_CHAIN = []
export const VISIBLE_LIMIT = 4
export const FX_GRAPH_ENTRY_TITLE = 'FX Graph'
export const FX_GRAPH_ENTRY_LABEL = 'Ready'
export const FX_GRAPH_ENTRY_MESSAGE = 'Open the FX Graph workspace to view graph status. Mixer Chain remains active.'
export const FX_GRAPH_ACTIVE_TITLE = 'FX Graph'
export const FX_GRAPH_ACTIVE_LABEL = 'Active'
export const FX_GRAPH_ACTIVE_MESSAGE =
  'FX Graph owns this track. Open the graph workspace to edit routing and effects.'
export const FX_GRAPH_SHELL_BUTTON_TITLE =
  'Open FX Graph workspace. The legacy graph editor is disabled.'

export function isSelectableEffectChainNode(effect) {
  return Number.isInteger(effect?.nodeId) && effect.nodeId !== -1
}

export function selectEffectChainNode(effect, currentSelectedNodeId = null) {
  return isSelectableEffectChainNode(effect) ? effect.nodeId : currentSelectedNodeId
}

export function syncSelectedEffectChainNode(selectedNodeId, chain) {
  if (selectedNodeId == null) return null
  return chain.some((effect) => effect.nodeId === selectedNodeId && isSelectableEffectChainNode(effect))
    ? selectedNodeId
    : null
}

export function shouldShowEffectChainOverflow(chainLength, visibleLimit = VISIBLE_LIMIT) {
  return chainLength > visibleLimit
}

export function buildEffectChainMenuItems({ addEffect, storeKey, vstPlugins }) {
  const sortedVstPlugins = sortRackVstPlugins(vstPlugins)
  const vstSubmenu = sortedVstPlugins.length === 0
    ? [{ label: NO_SCANNED_PLUGINS_LABEL, disabled: true }]
    : sortedVstPlugins.map((plugin) => ({
        label: formatVstPluginLabel(plugin),
        onClick: () => addEffect(storeKey, plugin.id),
      }))

  return [
    ...EFFECT_CATEGORIES.map((category) => ({
      label: `${category.label} (${category.submenu.length})`,
      submenu: category.submenu.map((effect) => ({
        label: effect.label,
        onClick: () => addEffect(storeKey, effect.id),
      })),
    })),
    { label: `VST3 Plugins (${sortedVstPlugins.length})`, submenu: vstSubmenu },
  ]
}

export function showEffectChainRack({ setFxPanelView, storeKey }) {
  setFxPanelView(storeKey, 'chain')
}

export function openFxGraphWorkspace(panelRegistry = usePanelRegistry.getState()) {
  panelRegistry.openPanel('fxGraph')
}

export function showEffectChainGraphShell({ panelRegistry = usePanelRegistry.getState() } = {}) {
  openFxGraphWorkspace(panelRegistry)
}

export function getEffectChainPanelViewState(fxPanelView, fxMode = 'chain') {
  const graphModeActive = fxMode === 'graph'
  const showingGraphShell = false

  return {
    showingGraphShell,
    graphModeActive,
    chainButtonClassName: `effect-chain-mode-btn${graphModeActive ? '' : ' active'}`,
    chainButtonDisabled: graphModeActive,
    nodeButtonClassName: `effect-chain-mode-btn${graphModeActive ? ' active' : ''}`,
    nodeButtonDisabled: false,
    nodeButtonTitle: FX_GRAPH_SHELL_BUTTON_TITLE,
  }
}

export function EffectChainGraphShell({
  active = false,
  chainLabel,
  onOpenWorkspace = () => openFxGraphWorkspace(),
}) {
  const title = active ? FX_GRAPH_ACTIVE_TITLE : FX_GRAPH_ENTRY_TITLE
  const status = active ? FX_GRAPH_ACTIVE_LABEL : FX_GRAPH_ENTRY_LABEL
  const helpText = active ? FX_GRAPH_ACTIVE_MESSAGE : FX_GRAPH_ENTRY_MESSAGE

  return (
    <div
      className={`effect-chain-shell${active ? ' effect-chain-shell--active' : ''}`}
      role={active ? 'status' : 'note'}
      aria-label={`${chainLabel}: ${helpText}`}
      title={helpText}
    >
      <div className="effect-chain-shell-header">
        <div className="effect-chain-shell-title">
          {title}
        </div>
        <div className="effect-chain-shell-badge">
          <span className="effect-chain-shell-status-dot" aria-hidden="true" />
          {status}
        </div>
      </div>
      <button
        className="effect-chain-shell-action"
        type="button"
        onClick={onOpenWorkspace}
        title={helpText}
        aria-label={`Open FX Graph workspace for ${chainLabel}. ${helpText}`}
      >
        Open
      </button>
    </div>
  )
}

export function getInitialEffectChainPopoverPosition(anchorRect, viewport = {
  width: window.innerWidth,
  height: window.innerHeight,
}) {
  const margin = 8
  const preferredWidth = 236
  const preferredHeight = 260
  const openRight = viewport.width - anchorRect.right >= preferredWidth
  const left = openRight
    ? anchorRect.right + 6
    : Math.max(margin, anchorRect.left - preferredWidth - 6)
  const top = Math.max(margin, Math.min(anchorRect.top, viewport.height - preferredHeight - margin))

  return { left, top }
}

export function clampEffectChainPopoverPosition(position, size, viewport = {
  width: window.innerWidth,
  height: window.innerHeight,
}) {
  const margin = 8
  const maxLeft = Math.max(margin, viewport.width - size.width - margin)
  const maxTop = Math.max(margin, viewport.height - size.height - margin)

  return {
    left: Math.min(Math.max(position.left, margin), maxLeft),
    top: Math.min(Math.max(position.top, margin), maxTop),
  }
}

export default function EffectChainPanel({ trackId, master }) {
  const key = master ? 'master' : String(trackId)

  const reactiveChain = useEffectChainStore((state) => state.chains[key] ?? EMPTY_CHAIN)
  const reactiveFxMode = useEffectChainStore((state) => resolveFxMode(state.fxModes, key))
  const reactiveFxPanelView = useEffectChainStore((state) => resolveFxPanelView(state.fxPanelViews, key))
  const fetchChain = useEffectChainStore((state) => state.fetchChain)
  const addEffect = useEffectChainStore((state) => state.addEffect)
  const moveEffect = useEffectChainStore((state) => state.moveEffect)
  const setFxPanelView = useEffectChainStore((state) => state.setFxPanelView)

  const reactiveVstPlugins = useVstStore((state) => state.plugins)
  const fetchVst = useVstStore((state) => state.fetchPlugins)

  const renderingWithoutDom = typeof document === 'undefined'
  const effectChainState = renderingWithoutDom ? useEffectChainStore.getState() : null
  const chain = effectChainState ? effectChainState.chains[key] ?? EMPTY_CHAIN : reactiveChain
  const fxMode = effectChainState ? resolveFxMode(effectChainState.fxModes, key) : reactiveFxMode
  const fxPanelView = effectChainState ? resolveFxPanelView(effectChainState.fxPanelViews, key) : reactiveFxPanelView
  const vstState = renderingWithoutDom ? useVstStore.getState() : null
  const vstPlugins = vstState ? vstState.plugins : reactiveVstPlugins

  const [dragOrder, setDragOrder] = useState(null)
  const [selectedNodeId, setSelectedNodeId] = useState(null)
  const [addMenuPos, setAddMenuPos] = useState(null)
  const [fullChainPos, setFullChainPos] = useState(null)
  const dragRef = useRef(null)
  const overflowBtnRef = useRef(null)
  const fullChainPopoverRef = useRef(null)

  const displayChain = dragOrder ?? chain
  const panelViewState = getEffectChainPanelViewState(fxPanelView, fxMode)
  const { graphModeActive } = panelViewState

  useEffect(() => {
    fetchChain(key)
    fetchVst()
  }, [key, fetchChain, fetchVst])

  useEffect(() => {
    setSelectedNodeId((currentSelectedNodeId) => syncSelectedEffectChainNode(currentSelectedNodeId, chain))
  }, [chain])

  useEffect(() => {
    const onMouseUp = () => {
      if (!dragRef.current) return

      const { nodeId, currentIndex, fromIndex } = dragRef.current
      dragRef.current = null
      document.body.style.cursor = ''
      setDragOrder(null)

      if (currentIndex !== fromIndex) {
        moveEffect(key, nodeId, currentIndex)
      }
    }

    document.addEventListener('mouseup', onMouseUp)
    return () => document.removeEventListener('mouseup', onMouseUp)
  }, [key, moveEffect])

  const handleDragStart = useCallback((nodeId, index, event) => {
    event.preventDefault()
    dragRef.current = { nodeId, fromIndex: index, currentIndex: index }
    setDragOrder([...chain])
    document.body.style.cursor = 'grabbing'
  }, [chain])

  const handleDragOver = useCallback((toIndex) => {
    if (!dragRef.current) return
    if (toIndex === dragRef.current.currentIndex) return

    dragRef.current.currentIndex = toIndex
    setDragOrder((previousOrder) => {
      if (!previousOrder) return previousOrder

      const nextOrder = [...previousOrder]
      const sourceIndex = nextOrder.findIndex((effect) => effect.nodeId === dragRef.current.nodeId)
      if (sourceIndex === -1) return previousOrder

      const [draggedEffect] = nextOrder.splice(sourceIndex, 1)
      nextOrder.splice(toIndex, 0, draggedEffect)
      return nextOrder
    })
  }, [])

  const handleSelectNode = useCallback((nodeId) => {
    setSelectedNodeId(nodeId)
  }, [])

  const handleAddClick = useCallback((event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setFullChainPos(null)
    setAddMenuPos((currentPos) => (currentPos ? null : { x: rect.left, y: rect.top }))
  }, [])

  const handleOverflowClick = useCallback(() => {
    if (!overflowBtnRef.current) return

    if (fullChainPos) {
      setFullChainPos(null)
      return
    }

    const rect = overflowBtnRef.current.getBoundingClientRect()
    setAddMenuPos(null)
    setFullChainPos(getInitialEffectChainPopoverPosition(rect))
  }, [fullChainPos])

  useEffect(() => {
    if (!fullChainPos) return

    const handleOutsideClick = (event) => {
      if (
        fullChainPopoverRef.current &&
        !fullChainPopoverRef.current.contains(event.target) &&
        event.target !== overflowBtnRef.current
      ) {
        setFullChainPos(null)
      }
    }

    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [fullChainPos])

  useEffect(() => {
    if (!fullChainPos) return

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setFullChainPos(null)
      }
    }

    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [fullChainPos])

  useEffect(() => {
    if (!fullChainPos) return
    if (!shouldShowEffectChainOverflow(displayChain.length)) {
      setFullChainPos(null)
    }
  }, [displayChain.length, fullChainPos])

  useEffect(() => {
    if (!fullChainPos || !fullChainPopoverRef.current) return

    const rect = fullChainPopoverRef.current.getBoundingClientRect()
    const nextPosition = clampEffectChainPopoverPosition(fullChainPos, {
      width: rect.width,
      height: rect.height,
    })

    if (nextPosition.left !== fullChainPos.left || nextPosition.top !== fullChainPos.top) {
      setFullChainPos(nextPosition)
    }
  }, [displayChain.length, fullChainPos])

  const menuItems = useMemo(() => (
    buildEffectChainMenuItems({
      addEffect,
      storeKey: key,
      vstPlugins,
    })
  ), [key, addEffect, vstPlugins])

  const clearFloatingState = useCallback(() => {
    dragRef.current = null
    if (typeof document !== 'undefined') {
      document.body.style.cursor = ''
    }
    setDragOrder(null)
    setAddMenuPos(null)
    setFullChainPos(null)
  }, [])

  const handleChainMode = useCallback(() => {
    clearFloatingState()
    showEffectChainRack({ setFxPanelView, storeKey: key })
  }, [clearFloatingState, key, setFxPanelView])

  const handleNodeMode = useCallback(() => {
    clearFloatingState()
    showEffectChainGraphShell()
  }, [clearFloatingState])

  if (!master && trackId == null) return null

  const renderEffectRows = (effects, { limit = effects.length } = {}) => (
    effects.slice(0, limit).map((effect, index) => (
      <EffectModule
        key={effect.nodeId === -1 ? `pending-${effect.pluginId}-${index}` : effect.nodeId}
        effect={effect}
        index={index}
        storeKey={key}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onSelect={handleSelectNode}
        selected={effect.nodeId === selectedNodeId}
      />
    ))
  )

  const overflowCount = Math.max(0, displayChain.length - VISIBLE_LIMIT)
  const overflowVisible = shouldShowEffectChainOverflow(displayChain.length)
  const chainLabel = master ? 'Master effect chain' : 'Track effect chain'

  return (
    <div className="effect-chain-panel">
      <div className="effect-chain-mode-row">
        <button
          className={panelViewState.chainButtonClassName}
          onClick={handleChainMode}
          disabled={panelViewState.chainButtonDisabled}
          title="Show Mixer Chain rack"
        >
          CHAIN
        </button>
        <button
          className={panelViewState.nodeButtonClassName}
          onClick={handleNodeMode}
          disabled={panelViewState.nodeButtonDisabled}
          title={panelViewState.nodeButtonTitle}
        >
          NODE
        </button>
      </div>

      {graphModeActive ? (
        <EffectChainGraphShell active={graphModeActive} chainLabel={chainLabel} />
      ) : (
        <>
          <div className="effect-chain-list" role="listbox" aria-label={chainLabel}>
            {displayChain.length === 0 ? (
              <button
                className="effect-chain-empty-btn"
                onClick={handleAddClick}
                title="Add effect"
                aria-label="Add effect"
              >
                + Add effect
              </button>
            ) : (
              renderEffectRows(displayChain, { limit: VISIBLE_LIMIT })
            )}
          </div>

          {overflowVisible && (
            <button
              ref={overflowBtnRef}
              className={`effect-chain-overflow${fullChainPos ? ' effect-chain-overflow--open' : ''}`}
              onClick={handleOverflowClick}
              title={fullChainPos ? 'Hide full effect chain' : 'Show full effect chain'}
              aria-label={fullChainPos ? 'Hide full effect chain' : 'Show full effect chain'}
            >
              +{overflowCount} more
            </button>
          )}

          <div className="effect-chain-footer">
            <button
              className="effect-chain-add-btn"
              disabled={chain.length >= 100}
              onClick={handleAddClick}
              title="Add effect"
              aria-label="Add effect"
            >
              +
            </button>
          </div>
        </>
      )}

      {addMenuPos && (
        <TrackContextMenu
          x={addMenuPos.x}
          y={addMenuPos.y}
          items={menuItems}
          onClose={() => setAddMenuPos(null)}
          menuClassName="effect-chain-add-menu"
          submenuClassName="effect-chain-add-submenu"
        />
      )}

      {fullChainPos && (
        <div
          ref={fullChainPopoverRef}
          className="effect-chain-full-popover"
          style={{ left: fullChainPos.left, top: fullChainPos.top }}
        >
          <div className="effect-chain-full-popover-header">
            <span>Effect Chain - {displayChain.length} Effect{displayChain.length === 1 ? '' : 's'}</span>
            <button
              className="effect-chain-full-popover-close"
              onClick={() => setFullChainPos(null)}
              title="Close full effect chain"
              aria-label="Close full effect chain"
            >
              x
            </button>
          </div>
          <div className="effect-chain-full-popover-list" role="listbox" aria-label={`${chainLabel} full list`}>
            {renderEffectRows(displayChain)}
          </div>
        </div>
      )}
    </div>
  )
}
