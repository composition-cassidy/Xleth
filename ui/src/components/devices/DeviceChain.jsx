import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState, MotionDiv } from '../../ui-kit'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useMixerStore from '../../stores/mixerStore.js'
import useVstStore from '../../stores/vstStore.js'
import { timelineEvents } from '../../timelineEvents.js'
import { buildEffectChainMenuItems, getEffectChainRowKey, openFxGraphWorkspace } from '../mixer/EffectChainPanel.jsx'
import TrackContextMenu from '../timeline/TrackContextMenu.jsx'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import EffectDevice from './EffectDevice.jsx'
import ChainHead from './ChainHead.jsx'
import useDeviceRevealStore from './deviceRevealStore.js'
import styles from './DeviceChain.module.css'

const EMPTY_CHAIN = []
const MAX_CHAIN = 100
const DRAG_THRESHOLD_PX = 4

/** Index the dragged device should take, from the pointer x and the other devices' centres. */
export function reorderIndexForPointer(clientX, rects, draggedIndex) {
  let index = 0
  rects.forEach((r, i) => {
    if (i === draggedIndex) return
    if (clientX > r.left + r.width / 2) index += 1
  })
  return index
}

export function moveInOrder(order, nodeId, toIndex) {
  const next = [...order]
  const from = next.findIndex((fx) => fx.nodeId === nodeId)
  if (from === -1) return order
  const [item] = next.splice(from, 1)
  next.splice(toIndex, 0, item)
  return next
}

// The selected mixer track's insert chain as devices, left to right in signal
// order (Devices tab). No track selected = the master chain.
export default function DeviceChain() {
  const selectedChainKey = useMixerStore((s) => s.selectedChainKey)
  const mixerTracks = useMixerStore((s) => s.tracks)
  const key = selectedChainKey ?? 'master'
  const master = key === 'master'

  const chain = useEffectChainStore((s) => s.chains[key] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore((s) => resolveFxMode(s.fxModes, key))
  const fetchChain = useEffectChainStore((s) => s.fetchChain)
  const addEffect = useEffectChainStore((s) => s.addEffect)
  const moveEffect = useEffectChainStore((s) => s.moveEffect)
  const vstPlugins = useVstStore((s) => s.plugins)
  const fetchVst = useVstStore((s) => s.fetchPlugins)

  const [dragOrder, setDragOrder] = useState(null)
  const [menuPos, setMenuPos] = useState(null)
  const dragRef = useRef(null)
  const rowRef = useRef(null)

  useEffect(() => {
    fetchChain(key)
    fetchVst()
  }, [key, fetchChain, fetchVst])

  // Track identity colours, resolved the way the arrangement resolves them.
  const [timelineTracks, setTimelineTracks] = useState([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const t = await window.xleth?.timeline?.getTracks?.()
        if (alive && Array.isArray(t)) setTimelineTracks(t)
      } catch (e) {
        console.warn('[Device] getTracks failed:', e?.message)
      }
    }
    load()
    timelineEvents.addEventListener('timeline-tracks-changed', load)
    return () => { alive = false; timelineEvents.removeEventListener('timeline-tracks-changed', load) }
  }, [])
  const identity = useTrackIdentityColors(timelineTracks)
  const identityColor = master ? undefined : identity[Number(key)]
  const chainName = master ? 'Master' : (mixerTracks[Number(key)]?.name || `Track ${key}`)

  const displayChain = dragOrder ?? chain

  // Motion: a device enters only when it is ADDED to the chain on screen (the chain grew by one
  // for the same track). A track switch or a project load draws its chain complete.
  const shownRef = useRef({ key, length: chain.length })
  const insertEnter = shownRef.current.key === key && chain.length === shownRef.current.length + 1
  useEffect(() => { shownRef.current = { key, length: chain.length } }, [key, chain.length])

  // A mixer strip's insert row asks for one device of a chain (deviceRevealStore): once that
  // chain is the one shown and the device exists, scroll it into view and outline it. The
  // outline goes on the next press inside the chain.
  const reveal = useDeviceRevealStore((s) => s.request)
  const clearReveal = useDeviceRevealStore((s) => s.clear)
  const revealedIndex = reveal && reveal.chainKey === key && reveal.index < chain.length ? reveal.index : -1
  const revealNonce = reveal?.nonce ?? 0
  useEffect(() => {
    if (revealedIndex < 0) return
    const el = rowRef.current?.querySelector(`[data-device-index="${revealedIndex}"]`)
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
  }, [revealedIndex, revealNonce])

  // ── Reorder: drag a device by its name. Local preview, one moveEffect on drop.
  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return
      d.active = true
      document.body.style.cursor = 'grabbing'
    }
    const els = Array.from(rowRef.current?.querySelectorAll('[data-device-index]') ?? [])
    const rects = els.map((el) => el.getBoundingClientRect())
    const draggedIndex = els.findIndex((el) => el.getAttribute('data-device-node') === String(d.nodeId))
    const to = reorderIndexForPointer(e.clientX, rects, draggedIndex)
    if (to === d.currentIndex) return
    d.currentIndex = to
    setDragOrder((prev) => moveInOrder(prev ?? d.base, d.nodeId, to))
  }, [])

  const endDrag = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    document.removeEventListener('pointercancel', endDrag)
    document.body.style.cursor = ''
    setDragOrder(null)
    if (d?.active && d.currentIndex !== d.fromIndex) {
      moveEffect(key, d.nodeId, d.currentIndex)
    }
  }, [key, moveEffect, onPointerMove])

  useEffect(() => () => {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    document.removeEventListener('pointercancel', endDrag)
  }, [onPointerMove, endDrag])

  const startDrag = (effect, index) => (e) => {
    if (e.button !== 0 || !Number.isInteger(effect.nodeId) || effect.nodeId < 0) return
    dragRef.current = { nodeId: effect.nodeId, fromIndex: index, currentIndex: index, startX: e.clientX, active: false, base: chain }
    setDragOrder(null)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', endDrag)
    document.addEventListener('pointercancel', endDrag)
  }

  const menuItems = useMemo(
    () => buildEffectChainMenuItems({ addEffect, storeKey: key, vstPlugins }),
    [addEffect, key, vstPlugins],
  )

  if (fxMode === 'graph') {
    return (
      <div className={styles.scroller} data-testid="xleth-device-chain">
        <div className={styles.row}>
          <ChainHead name={chainName} identityColor={identityColor} />
          <div className={styles.empty}>
            <EmptyState
              message={`${chainName} routes its effects in the FX Graph, so there is no chain to show here.`}
              actionLabel="Open FX Graph"
              onAction={() => openFxGraphWorkspace()}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.scroller} data-testid="xleth-device-chain" aria-label={`${chainName} devices`} role="list">
      <div className={styles.row} ref={rowRef} onPointerDownCapture={revealedIndex >= 0 ? clearReveal : undefined}>
        <ChainHead name={chainName} identityColor={identityColor} />
        {displayChain.map((effect, index) => {
          const live = Number.isInteger(effect.nodeId) && effect.nodeId >= 0
          const moveItems = live ? [
            { label: 'Move left', disabled: index === 0, onSelect: () => moveEffect(key, effect.nodeId, index - 1) },
            { label: 'Move right', disabled: index === displayChain.length - 1, onSelect: () => moveEffect(key, effect.nodeId, index + 1) },
          ] : []
          return (
            <MotionDiv
              recipe="insert"
              enter={insertEnter}
              key={getEffectChainRowKey(effect, index)}
              role="listitem"
              className={styles.slot}
              data-device-index={index}
              data-device-node={effect.nodeId}
              data-dragging={dragRef.current?.active && dragRef.current.nodeId === effect.nodeId ? true : undefined}
              data-revealed={index === revealedIndex ? true : undefined}
            >
              <EffectDevice
                effect={effect}
                storeKey={key}
                identityColor={identityColor}
                dragHandleProps={live ? { onPointerDown: startDrag(effect, index) } : undefined}
                moveItems={moveItems}
              />
            </MotionDiv>
          )
        })}
        <button
          type="button"
          className={styles.drop}
          disabled={chain.length >= MAX_CHAIN}
          data-hint={`Add an effect to ${chainName}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuPos((p) => (p ? null : { x: rect.left + 8, y: rect.top + 8 }))
          }}
        >
          Drop effects here
        </button>
      </div>
      {menuPos ? (
        <TrackContextMenu
          x={menuPos.x}
          y={menuPos.y}
          items={menuItems}
          onClose={() => setMenuPos(null)}
          menuClassName="effect-chain-add-menu"
          submenuClassName="effect-chain-add-submenu"
        />
      ) : null}
    </div>
  )
}
