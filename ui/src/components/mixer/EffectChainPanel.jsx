import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useMixerStore from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
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
const VISIBLE_LIMIT = 4

export default function EffectChainPanel({ trackId, master }) {
  const key = master ? 'master' : String(trackId)

  const chain = useEffectChainStore(s => s.chains[key] ?? EMPTY_CHAIN)
  const fetchChain = useEffectChainStore(s => s.fetchChain)
  const addEffect = useEffectChainStore(s => s.addEffect)
  const moveEffect = useEffectChainStore(s => s.moveEffect)
  const trackOrder = useMixerStore(s => s.trackOrder)

  const vstPlugins  = useVstStore(s => s.plugins)
  const fetchVst    = useVstStore(s => s.fetchPlugins)

  // Local drag state
  const [dragOrder, setDragOrder] = useState(null)
  const [addMenuPos, setAddMenuPos] = useState(null)
  const [fullChainPos, setFullChainPos] = useState(null)
  const dragRef = useRef(null) // { nodeId, currentIndex }
  const addBtnRef = useRef(null)
  const overflowBtnRef = useRef(null)
  const fullChainPopoverRef = useRef(null)

  const displayChain = dragOrder ?? chain

  // Fetch chain on mount / when key changes
  useEffect(() => {
    fetchChain(key)
    fetchVst()
  }, [key, fetchChain, fetchVst])

  // Global mouseup to commit drag
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

  const handleAddClick = useCallback(() => {
    if (!addBtnRef.current) return
    const rect = addBtnRef.current.getBoundingClientRect()
    setFullChainPos(null)
    setAddMenuPos({ x: rect.left, y: rect.top })
  }, [])

  const handleOverflowClick = useCallback(() => {
    if (!overflowBtnRef.current) return
    const rect = overflowBtnRef.current.getBoundingClientRect()
    setAddMenuPos(null)
    setFullChainPos({ x: rect.right + 4, y: rect.top })
  }, [])

  // Close full-chain popover on outside click
  useEffect(() => {
    if (!fullChainPos) return
    const handler = (e) => {
      if (
        fullChainPopoverRef.current &&
        !fullChainPopoverRef.current.contains(e.target) &&
        e.target !== overflowBtnRef.current
      ) {
        setFullChainPos(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [fullChainPos])

  // Build add menu items — stock categories + dynamic VST3 category
  const menuItems = useMemo(() => {
    const vstSubmenu = vstPlugins.length === 0
      ? [{ label: 'No plugins scanned — open VST Browser to scan', disabled: true }]
      : vstPlugins.map(p => ({
          label: p.name + (p.vendor ? ' \u2014 ' + p.vendor : ''),
          onClick: () => addEffect(key, p.id),
        }))

    return [
      ...EFFECT_CATEGORIES.map(cat => ({
        label: cat.label,
        submenu: cat.submenu.map(fx => ({
          label: fx.label,
          onClick: () => addEffect(key, fx.id),
        })),
      })),
      { label: 'VST3 Plugins', submenu: vstSubmenu },
    ]
  }, [key, addEffect, vstPlugins])

  // Open node editor in separate window
  const handleNodeMode = useCallback(() => {
    const pos = master ? null : trackOrder.indexOf(trackId) + 1
    window.xleth?.window?.openNodeEditor(key, pos || null)
  }, [key, master, trackId, trackOrder])

  if (!master && trackId == null) return null

  return (
    <div className="effect-chain-panel">
      {/* Mode toggle */}
      <div className="effect-chain-mode-row">
        <button
          className="effect-chain-mode-btn active"
          disabled
        >
          CHAIN
        </button>
        <button
          className="effect-chain-mode-btn"
          onClick={handleNodeMode}
          title="Open Node Editor window"
        >
          NODE
        </button>
      </div>

      {/* Effect list — capped at VISIBLE_LIMIT rows */}
      <div className="effect-chain-list">
        {displayChain.length === 0 ? (
          <div className="effect-chain-empty">No effects</div>
        ) : (
          displayChain.slice(0, VISIBLE_LIMIT).map((fx, idx) => (
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

      {/* Overflow badge — visible when chain exceeds VISIBLE_LIMIT */}
      {displayChain.length > VISIBLE_LIMIT && (
        <button
          ref={overflowBtnRef}
          className="effect-chain-overflow"
          onClick={handleOverflowClick}
          title="Show full effect chain"
        >
          +{displayChain.length - VISIBLE_LIMIT} more
        </button>
      )}

      {/* Add button */}
      <div className="effect-chain-footer">
        <button
          ref={addBtnRef}
          className="effect-chain-add-btn"
          disabled={chain.length >= 100}
          onClick={handleAddClick}
          title="Add effect"
        >
          +
        </button>
      </div>

      {addMenuPos && (
        <TrackContextMenu
          x={addMenuPos.x}
          y={addMenuPos.y}
          items={menuItems}
          onClose={() => setAddMenuPos(null)}
        />
      )}

      {/* Full-chain popover — position:fixed, escapes strip layout */}
      {fullChainPos && (
        <div
          ref={fullChainPopoverRef}
          className="effect-chain-full-popover"
          style={{ left: fullChainPos.x, top: fullChainPos.y }}
        >
          <div className="effect-chain-full-popover-header">
            Full chain ({displayChain.length})
          </div>
          {displayChain.map((fx, idx) => (
            <EffectModule
              key={fx.nodeId === -1 ? `pending-${fx.pluginId}-${idx}` : fx.nodeId}
              effect={fx}
              index={idx}
              storeKey={key}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
            />
          ))}
        </div>
      )}
    </div>
  )
}
