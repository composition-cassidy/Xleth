import { useCallback, useRef, useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import TrackHeader from './TrackHeader.jsx'
import TrackColorPopover from './TrackColorPopover.jsx'
import { RULER_HEIGHT, HEADER_WIDTH } from '../../constants/timeline.js'
import { resolveAutoTrackColor, normalizeTrackPalette, TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { tokenValue } from '../../theming/tokenValue.ts'

export default function TrackHeaderList({
  tracks, patterns, currentPatternIdByTrack,
  focusedTrackId, onFocusTrack,
  onAddTrack, onMute, onSolo, onVisualOnly, onRename, onRemove, onReorder, onRequestContextMenu,
  onSetTrackColor,
  scrollContainerRef,
  width = HEADER_WIDTH,
}) {
  const dragIndexRef = useRef(null)

  const [openColorPickerId, setOpenColorPickerId] = useState(null)
  const [colorPickerAnchorRect, setColorPickerAnchorRect] = useState(null)

  const [, _themeRev] = useState(0)
  useEffect(() => {
    const h = () => _themeRev(n => n + 1)
    document.addEventListener('xleth-theme-changed', h)
    return () => document.removeEventListener('xleth-theme-changed', h)
  }, [])

  const rawPalette = Array.from({ length: 16 }, (_, i) =>
    tokenValue(`--theme-track-palette-${i + 1}`)
  )
  const trackPalette = normalizeTrackPalette(rawPalette)

  const handleOpenColorPicker = useCallback((trackId, rect) => {
    setOpenColorPickerId(prev => prev === trackId ? null : trackId)
    setColorPickerAnchorRect(rect)
  }, [])

  const handleCloseColorPicker = useCallback(() => {
    setOpenColorPickerId(null)
    setColorPickerAnchorRect(null)
  }, [])

  const handleChooseAuto = useCallback((trackId) => {
    onSetTrackColor?.(trackId, { mode: 'auto' })
    handleCloseColorPicker()
  }, [onSetTrackColor, handleCloseColorPicker])

  const handleChooseSlot = useCallback((trackId, slot) => {
    onSetTrackColor?.(trackId, { mode: 'paletteSlot', slot })
    handleCloseColorPicker()
  }, [onSetTrackColor, handleCloseColorPicker])

  const handleChooseCustom = useCallback((trackId, customColor) => {
    onSetTrackColor?.(trackId, { mode: 'custom', customColor })
  }, [onSetTrackColor])

  const onDragStart = useCallback((e, index) => {
    dragIndexRef.current = index
    e.dataTransfer.effectAllowed = 'move'
    e.currentTarget.classList.add('dragging')
  }, [])

  const onDragOver = useCallback((e, index) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const onDrop = useCallback((e, targetIndex) => {
    e.preventDefault()
    const srcIndex = dragIndexRef.current
    if (srcIndex == null || srcIndex === targetIndex) return
    console.log(`[Timeline] Track reorder: ${srcIndex} → ${targetIndex}`)
    onReorder(srcIndex, targetIndex)
    dragIndexRef.current = null
  }, [onReorder])

  // Sync vertical scroll with canvas
  const handleScroll = useCallback((e) => {
    if (scrollContainerRef?.current) {
      scrollContainerRef.current.scrollTop = e.currentTarget.scrollTop
    }
  }, [scrollContainerRef])

  return (
    <div className="timeline-header-column" style={{ width }}>
      {/* Spacer aligns with ruler */}
      <div className="timeline-header-spacer" style={{ height: RULER_HEIGHT }} />

      {/* Track headers (scrollable) */}
      <div className="timeline-header-scroll" onScroll={handleScroll}>
        {tracks.map((track, i) => {
          // Pattern tracks are sample-agnostic; the active pattern comes from
          // whichever block is under the playhead (resolved by parent).
          let currentPattern = null
          if (track.type === 'Pattern') {
            const patId = currentPatternIdByTrack?.[track.id]
            if (patId != null && patId >= 0) currentPattern = patterns?.[patId] || null
          }
          const trackColor = resolveAutoTrackColor(track, i, trackPalette, TRACK_PALETTE_FALLBACK[i % 16])
          return (
            <TrackHeader
              key={track.id}
              track={track}
              index={i}
              trackColor={trackColor}
              currentPattern={currentPattern}
              isFocused={focusedTrackId === track.id}
              onMute={onMute}
              onSolo={onSolo}
              onVisualOnly={onVisualOnly}
              onRename={onRename}
              onRemove={onRemove}
              onRequestContextMenu={onRequestContextMenu}
              onFocus={onFocusTrack}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
              onOpenColorPicker={handleOpenColorPicker}
            />
          )
        })}

        {/* Add Track button */}
        <button className="timeline-add-track" onClick={onAddTrack} title="Add track">
          <Plus size={14} />
          <span>Add Track</span>
        </button>
      </div>

      {openColorPickerId !== null && colorPickerAnchorRect !== null && (() => {
        const openTrack = tracks.find(t => t.id === openColorPickerId)
        if (!openTrack) return null
        const openTrackIndex = tracks.findIndex(t => t.id === openColorPickerId)
        const resolvedColor = resolveAutoTrackColor(
          openTrack, openTrackIndex, trackPalette,
          TRACK_PALETTE_FALLBACK[openTrackIndex % 16]
        )
        return (
          <TrackColorPopover
            anchorRect={colorPickerAnchorRect}
            track={openTrack}
            palette={trackPalette}
            resolvedTrackColor={resolvedColor}
            onChooseAuto={() => handleChooseAuto(openColorPickerId)}
            onChooseSlot={(slot) => handleChooseSlot(openColorPickerId, slot)}
            onChooseCustom={(hex) => handleChooseCustom(openColorPickerId, hex)}
            onClose={handleCloseColorPicker}
          />
        )
      })()}
    </div>
  )
}
