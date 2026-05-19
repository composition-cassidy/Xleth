import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import useEffectChainStore, { resolveFxMode, resolveFxPanelView } from '../../stores/effectChainStore.js'
import EffectModule from './EffectModule.jsx'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'

const EFFECT_CATEGORIES = [
  {
    label: 'Dynamics',
    submenu: [
      { label: 'Compressor',    id: 'compressor' },
      { label: 'Limiter',       id: 'limiter' },
      { label: 'Overdone',      id: 'overdone' },
      { label: 'Transient Proc',id: 'transientproc' },
    ],
  },
  {
    label: 'EQ & Filter',
    submenu: [
      { label: 'Xleth EQ',      id: 'xletheq' },
      { label: 'Xleth Filter',  id: 'xlethfilter' },
    ],
  },
  {
    label: 'Distortion',
    submenu: [
      { label: 'Distortion',    id: 'distortion' },
      { label: 'Waveshaper',    id: 'waveshaper' },
    ],
  },
  {
    label: 'Modulation',
    submenu: [
      { label: 'UniFlange',     id: 'uniflange' },
      { label: 'Chorus',        id: 'chorus' },
      { label: 'Flanger',       id: 'flanger' },
      { label: 'Phaser',        id: 'phaser' },
      { label: 'Phanjer',       id: 'phanjer' },
    ],
  },
  {
    label: 'Time',
    submenu: [
      { label: 'Delay',         id: 'delay' },
      { label: 'Reverb',        id: 'reverb' },
    ],
  },
  {
    label: 'Utility',
    submenu: [
      { label: 'Smart Balance', id: 'smartbalance' },
    ],
  },
]

const EMPTY_CHAIN = []
export const FX_GRAPH_SHELL_TITLE = 'FX Graph Shell'
export const FX_GRAPH_PREVIEW_LABEL = 'Preview Only'
export const FX_GRAPH_SHELL_MESSAGE = 'This read-only preview mirrors the current Mixer Chain order without mutating routing.'
export const FX_GRAPH_SHELL_NOTE = 'Editable FX Graph conversion is not implemented yet. The track still uses the normal Mixer Chain.'
export const FX_GRAPH_SHELL_BUTTON_TITLE =
  'Open FX Graph shell preview. Graph editing and chain-to-graph conversion are not implemented yet.'
export const FX_GRAPH_ACTIVE_TITLE = 'FX Graph Active'
export const FX_GRAPH_ACTIVE_MESSAGE = 'Routing is owned by FX Graph.'
export const FX_GRAPH_ACTIVE_NOTE = 'Editable graph view is not implemented in this phase.'
export const FX_GRAPH_ACTIVE_FUTURE_LABELS = [
  'Open Preview later',
  'Bypass Graph later',
  'Published Macros later',
]

const STOCK_EFFECT_NAMES = EFFECT_CATEGORIES
  .flatMap((category) => category.submenu)
  .reduce((names, effect) => ({ ...names, [effect.id]: effect.label }), {
    testgain: 'Test Gain',
  })

export function showEffectChainRack({ setFxPanelView, storeKey }) {
  setFxPanelView(storeKey, 'chain')
}

export function showEffectChainGraphShell({ setFxPanelView, storeKey }) {
  setFxPanelView(storeKey, 'graphShell')
}

export function getEffectChainPanelViewState(fxPanelView) {
  const showingGraphShell = fxPanelView === 'graphShell'

  return {
    showingGraphShell,
    chainButtonClassName: `effect-chain-mode-btn${showingGraphShell ? '' : ' active'}`,
    chainButtonDisabled: !showingGraphShell,
    nodeButtonClassName: `effect-chain-mode-btn${showingGraphShell ? ' active' : ''}`,
    nodeButtonDisabled: showingGraphShell,
    nodeButtonTitle: FX_GRAPH_SHELL_BUTTON_TITLE,
  }
}

export function getEffectChainPanelRenderState(fxMode, fxPanelView) {
  const graphOwned = fxMode === 'graph'
  const showingGraphShell = !graphOwned && fxPanelView === 'graphShell'

  return {
    graphOwned,
    showingGraphShell,
    showingEditableChain: !graphOwned && !showingGraphShell,
  }
}

export function resolveEffectChainPreviewName(effect) {
  if (effect?.name) return effect.name
  if (effect?.displayName) return effect.displayName
  if (effect?.pluginName) return effect.pluginName
  if (STOCK_EFFECT_NAMES[effect?.pluginId]) return STOCK_EFFECT_NAMES[effect.pluginId]
  return effect?.pluginId ?? 'Unknown Effect'
}

export function buildEffectChainPreviewNodes(chain = []) {
  return [
    { id: 'track-input', label: 'Track Input', type: 'terminal' },
    ...chain.map((effect, index) => ({
      id: effect.nodeId === -1 ? `pending-${effect.pluginId}-${index}` : `effect-${effect.nodeId}`,
      label: resolveEffectChainPreviewName(effect),
      type: 'effect',
    })),
    { id: 'track-output', label: 'Track Output', type: 'terminal' },
  ]
}

export function EffectChainGraphShell({ chain = [], chainLabel }) {
  const previewNodes = buildEffectChainPreviewNodes(chain)

  return (
    <div className="effect-chain-shell" role="note" aria-label={`${chainLabel} graph shell`}>
      <div className="effect-chain-shell-header">
        <div className="effect-chain-shell-title">{FX_GRAPH_SHELL_TITLE}</div>
        <div className="effect-chain-shell-badge">{FX_GRAPH_PREVIEW_LABEL}</div>
      </div>
      <div className="effect-chain-graph-preview" aria-label={`${chainLabel} read-only serial preview`}>
        {previewNodes.map((node, index) => (
          <React.Fragment key={node.id}>
            <div className={`effect-chain-graph-node effect-chain-graph-node--${node.type}`}>
              {node.label}
            </div>
            {index < previewNodes.length - 1 && (
              <div className="effect-chain-graph-connector" aria-hidden="true" />
            )}
          </React.Fragment>
        ))}
      </div>
      <p className="effect-chain-shell-copy">{FX_GRAPH_SHELL_MESSAGE}</p>
      <p className="effect-chain-shell-copy">{FX_GRAPH_SHELL_NOTE}</p>
    </div>
  )
}

export function EffectChainGraphActivePlaceholder({ chainLabel }) {
  return (
    <div className="effect-chain-shell effect-chain-graph-active" role="note" aria-label={`${chainLabel} graph active`}>
      <div className="effect-chain-shell-header">
        <div className="effect-chain-shell-title">{FX_GRAPH_ACTIVE_TITLE}</div>
      </div>
      <p className="effect-chain-shell-copy">{FX_GRAPH_ACTIVE_MESSAGE}</p>
      <p className="effect-chain-shell-copy">{FX_GRAPH_ACTIVE_NOTE}</p>
      <div className="effect-chain-graph-future-list" aria-label="Future graph controls">
        {FX_GRAPH_ACTIVE_FUTURE_LABELS.map((label) => (
          <span key={label} className="effect-chain-graph-future-chip">{label}</span>
        ))}
      </div>
    </div>
  )
}

export default function EffectChainPanel({ trackId, master }) {
  const key = master ? 'master' : String(trackId)

  const chain = useEffectChainStore(s => s.chains[key] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => master ? 'chain' : resolveFxMode(s.fxModes, key))
  const fxPanelView = useEffectChainStore(s => resolveFxPanelView(s.fxPanelViews, key))
  const fetchChain = useEffectChainStore(s => s.fetchChain)
  const addEffect = useEffectChainStore(s => s.addEffect)
  const moveEffect = useEffectChainStore(s => s.moveEffect)
  const setFxPanelView = useEffectChainStore(s => s.setFxPanelView)

  const [dragOrder, setDragOrder] = useState(null)
  const [addMenuPos, setAddMenuPos] = useState(null)
  const dragRef = useRef(null)
  const addBtnRef = useRef(null)

  const displayChain = dragOrder ?? chain
  const { graphOwned, showingGraphShell } = getEffectChainPanelRenderState(fxMode, fxPanelView)
  const panelViewState = getEffectChainPanelViewState(graphOwned ? 'graphShell' : fxPanelView)
  const chainLabel = master ? 'Master effect chain' : 'Track effect chain'

  useEffect(() => {
    fetchChain(key)
  }, [key, fetchChain])

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

  const handleDragStart = useCallback((nodeId, index, e) => {
    e.preventDefault()
    dragRef.current = { nodeId, fromIndex: index, currentIndex: index }
    setDragOrder([...chain])
    document.body.style.cursor = 'grabbing'
  }, [chain])

  const handleDragOver = useCallback((toIndex) => {
    if (!dragRef.current) return
    if (toIndex === dragRef.current.currentIndex) return
    dragRef.current.currentIndex = toIndex
    setDragOrder(prev => {
      if (!prev) return prev
      const arr = [...prev]
      const srcIdx = arr.findIndex(fx => fx.nodeId === dragRef.current.nodeId)
      if (srcIdx === -1) return prev
      const [item] = arr.splice(srcIdx, 1)
      arr.splice(toIndex, 0, item)
      return arr
    })
  }, [])

  const clearFloatingState = useCallback(() => {
    dragRef.current = null
    if (typeof document !== 'undefined') {
      document.body.style.cursor = ''
    }
    setDragOrder(null)
    setAddMenuPos(null)
  }, [])

  const handleAddClick = useCallback(() => {
    if (!addBtnRef.current) return
    const rect = addBtnRef.current.getBoundingClientRect()
    setAddMenuPos({ x: rect.left, y: rect.top })
  }, [])

  const handleChainMode = useCallback(() => {
    clearFloatingState()
    showEffectChainRack({ setFxPanelView, storeKey: key })
  }, [clearFloatingState, key, setFxPanelView])

  const handleNodeMode = useCallback(() => {
    clearFloatingState()
    showEffectChainGraphShell({ setFxPanelView, storeKey: key })
  }, [clearFloatingState, key, setFxPanelView])

  const menuItems = useMemo(() => {
    return EFFECT_CATEGORIES.map(cat => ({
      label: cat.label,
      submenu: cat.submenu.map(fx => ({
        label: fx.label,
        onClick: () => addEffect(key, fx.id),
      })),
    }))
  }, [key, addEffect])

  if (!master && trackId == null) return null

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

      {graphOwned ? (
        <EffectChainGraphActivePlaceholder chainLabel={chainLabel} />
      ) : showingGraphShell ? (
        <EffectChainGraphShell chain={chain} chainLabel={chainLabel} />
      ) : (
        <>
          <div className="effect-chain-list" role="listbox" aria-label={chainLabel}>
            {displayChain.length === 0 ? (
              <div className="effect-chain-empty">No effects</div>
            ) : (
              displayChain.map((fx, idx) => (
                <EffectModule
                  key={fx.nodeId === -1 ? `pending-${fx.pluginId}-${idx}` : fx.nodeId}
                  effect={fx}
                  index={idx}
                  storeKey={key}
                  onDragStart={handleDragStart}
                  onDragOver={handleDragOver}
                />
              ))
            )}
          </div>

          <div className="effect-chain-footer">
            <button
              ref={addBtnRef}
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
        />
      )}
    </div>
  )
}
