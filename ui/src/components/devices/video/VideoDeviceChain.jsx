import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '../../../ui-kit'
import useMixerStore from '../../../stores/mixerStore.js'
import TrackContextMenu from '../../timeline/TrackContextMenu.jsx'
import useTrackIdentityColors from '../../inspector/useTrackIdentityColors.js'
import ChainHead from '../ChainHead.jsx'
import chainStyles from '../DeviceChain.module.css'
import VideoChainDevice from './VideoChainDevice.jsx'
import NoteDevice from './NoteDevice.jsx'
import useVideoTracks from './useVideoTracks.js'
import useVideoDeviceStore from './videoDeviceStore.js'
import {
  CHAIN_PICKER, NOTE_DEVICES, chainName, noteDeviceActive,
} from './videoFxCatalog.js'
import { addChainEffect, moveChainEffect, setNoteDeviceEnabled } from './videoFxWrites.js'
import styles from './VideoDeviceChain.module.css'

const DRAG_THRESHOLD_PX = 4
const EMPTY = []

/** Index the dragged device should take, from the pointer x and the other devices' centres. */
export function chainIndexForPointer(clientX, rects, draggedIndex) {
  let index = 0
  rects.forEach((r, i) => {
    if (i === draggedIndex) return
    if (clientX > r.left + r.width / 2) index += 1
  })
  return index
}

/** The per-note devices this track shows: in use, or added this session. Fixed order. */
export function visibleNoteDevices(track, shownIds = EMPTY) {
  if (!track) return []
  const pattern = track.type === 'Pattern'
  return NOTE_DEVICES.filter((d) => (!d.patternOnly || pattern)
    && (noteDeviceActive(track, d.id) || shownIds.includes(d.id)))
}

/** Add-menu items: the same grammar (and component) as the audio chain's picker. */
export function buildVideoPickerItems({ track, chain, shownIds, onAddNote, onAddChain }) {
  const pattern = track?.type === 'Pattern'
  const notes = NOTE_DEVICES.filter((d) => !d.patternOnly || pattern)
  const present = new Set(visibleNoteDevices(track, shownIds).map((d) => d.id))
  return [
    {
      label: `Per note (${notes.length})`,
      submenu: notes.map((d) => ({
        label: d.name,
        checked: present.has(d.id),
        disabled: present.has(d.id),
        onClick: () => onAddNote(d.id),
      })),
    },
    {
      label: `Chain (${CHAIN_PICKER.length})`,
      submenu: CHAIN_PICKER.map((type) => ({
        label: chainName(type),
        checked: chain.some((fx) => fx.type === type),
        onClick: () => onAddChain(type),
      })),
    },
  ]
}

/**
 * The Video view of the Devices tab: the selected track's picture as devices.
 * First the pinned per-note group (configs the engine evaluates per triggered
 * note, in a fixed order: no reorder exists for them), then the visual effect
 * chain in its evaluation order, then the drop zone. Reorder = drag a chain
 * device by its name: local preview, ONE setTrackVisualEffectChainOrder on drop.
 */
export default function VideoDeviceChain() {
  const selectedChainKey = useMixerStore((s) => s.selectedChainKey)
  const key = selectedChainKey ?? 'master'
  const master = key === 'master'
  const trackId = master ? null : Number(key)

  const { tracks, loaded } = useVideoTracks()
  const identity = useTrackIdentityColors(tracks)
  const track = useMemo(() => tracks.find((t) => t.id === trackId) ?? null, [tracks, trackId])
  const chain = track?.visualEffectChain ?? EMPTY
  const shownIds = useVideoDeviceStore((s) => (trackId == null ? EMPTY : s.shown[trackId] ?? EMPTY))
  const showNoteDevice = useVideoDeviceStore((s) => s.showNoteDevice)

  const [dragOrder, setDragOrder] = useState(null) // array of original indices
  const [menuPos, setMenuPos] = useState(null)
  const dragRef = useRef(null)
  const rowRef = useRef(null)

  // A chain refetch while dragging (another surface wrote) ends the preview.
  useEffect(() => { setDragOrder(null) }, [chain])

  const onPointerMove = useCallback((e) => {
    const d = dragRef.current
    if (!d) return
    if (!d.active) {
      if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD_PX) return
      d.active = true
      document.body.style.cursor = 'grabbing'
    }
    const els = Array.from(rowRef.current?.querySelectorAll('[data-video-chain-index]') ?? [])
    const rects = els.map((el) => el.getBoundingClientRect())
    const draggedSlot = els.findIndex((el) => el.getAttribute('data-video-chain-index') === String(d.fromIndex))
    const to = chainIndexForPointer(e.clientX, rects, draggedSlot)
    if (to === d.toIndex) return
    d.toIndex = to
    const order = Array.from({ length: d.length }, (_, i) => i)
    const [moved] = order.splice(d.fromIndex, 1)
    order.splice(to, 0, moved)
    setDragOrder(order)
  }, [])

  const endDrag = useCallback(() => {
    const d = dragRef.current
    dragRef.current = null
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    document.removeEventListener('pointercancel', endDrag)
    document.body.style.cursor = ''
    setDragOrder(null)
    if (d?.active && d.toIndex !== d.fromIndex) moveChainEffect(d.trackId, d.length, d.fromIndex, d.toIndex)
  }, [onPointerMove])

  useEffect(() => () => {
    document.removeEventListener('pointermove', onPointerMove)
    document.removeEventListener('pointerup', endDrag)
    document.removeEventListener('pointercancel', endDrag)
  }, [onPointerMove, endDrag])

  const startDrag = (index) => (e) => {
    if (e.button !== 0 || !track) return
    dragRef.current = {
      trackId: track.id, fromIndex: index, toIndex: index, length: chain.length, startX: e.clientX, active: false,
    }
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', endDrag)
    document.addEventListener('pointercancel', endDrag)
  }

  const onAddChain = useCallback(async (type) => {
    if (!track) return
    if (chain.some((fx) => fx.type === type)
      && !window.confirm(`This track already has a ${chainName(type)}. Add another?`)) return
    await addChainEffect(track.id, type)
  }, [track, chain])

  const onAddNote = useCallback(async (id) => {
    if (!track) return
    showNoteDevice(track.id, id)
    await setNoteDeviceEnabled(track, id, true)
  }, [track, showNoteDevice])

  const menuItems = useMemo(
    () => buildVideoPickerItems({ track, chain, shownIds, onAddNote, onAddChain }),
    [track, chain, shownIds, onAddNote, onAddChain],
  )

  const name = master ? 'Master' : (track?.name ?? `Track ${key}`)
  const identityColor = master ? undefined : identity[trackId]

  if (master || !track) {
    return (
      <div className={chainStyles.scroller} data-testid="xleth-video-chain">
        <div className={chainStyles.row}>
          <ChainHead name={name} identityColor={identityColor} videoDisabled={master} />
          <div className={styles.empty}>
            <EmptyState
              message={master
                ? 'Master has no picture. Select a track to see its video effects.'
                : (loaded ? 'This track no longer exists.' : 'Loading track…')}
            />
          </div>
        </div>
      </div>
    )
  }

  const order = dragOrder ?? chain.map((_, i) => i)
  const noteDevices = visibleNoteDevices(track, shownIds)

  return (
    <div className={chainStyles.scroller} data-testid="xleth-video-chain" aria-label={`${name} video devices`} role="list">
      <div className={chainStyles.row} ref={rowRef}>
        <ChainHead name={name} identityColor={identityColor} />

        {noteDevices.length > 0 ? (
          <div className={styles.group} role="group" aria-label="Per note" data-testid="xleth-video-note-group">
            <span className={styles.groupLabel} aria-hidden="true">Per note</span>
            {noteDevices.map((d) => (
              <div key={d.id} role="listitem" className={chainStyles.slot} data-video-note={d.id}>
                <NoteDevice track={track} id={d.id} identityColor={identityColor} />
              </div>
            ))}
          </div>
        ) : null}


        {order.map((index, pos) => {
          const fx = chain[index]
          if (!fx) return null
          const moveItems = [
            { label: 'Move left', disabled: pos === 0, onSelect: () => moveChainEffect(track.id, chain.length, index, index - 1) },
            { label: 'Move right', disabled: pos === chain.length - 1, onSelect: () => moveChainEffect(track.id, chain.length, index, index + 1) },
          ]
          return (
            <div
              key={`${index}:${fx.type}`}
              role="listitem"
              className={chainStyles.slot}
              data-video-chain-index={index}
              data-dragging={dragRef.current?.active && dragRef.current.fromIndex === index ? true : undefined}
            >
              <VideoChainDevice
                track={track}
                fx={fx}
                index={index}
                identityColor={identityColor}
                dragHandleProps={{ onPointerDown: startDrag(index) }}
                moveItems={moveItems}
              />
            </div>
          )
        })}

        <button
          type="button"
          className={chainStyles.drop}
          data-hint={`Add a video effect to ${name}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuPos((p) => (p ? null : { x: rect.left + 8, y: rect.top + 8 }))
          }}
        >
          Drop video effects here
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
