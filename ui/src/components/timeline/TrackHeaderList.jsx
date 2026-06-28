import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { Plus, EyeOff, Sliders } from 'lucide-react'
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
  trackHeight,
  // FXG.4-h-r1: macro automation child-lane rows (from the derived row layout),
  // rendered as compact labels directly below their parent track header so the
  // header column stays vertically aligned with the canvas lane bands.
  macroRows = [],
  onHideMacroLane,
}) {
  const dragIndexRef = useRef(null)

  // Group lane rows by parent track for O(1) lookup while mapping tracks.
  const lanesByTrack = useMemo(() => {
    const map = new Map()
    for (const row of macroRows) {
      if (!map.has(row.parentTrackId)) map.set(row.parentTrackId, [])
      map.get(row.parentTrackId).push(row)
    }
    return map
  }, [macroRows])

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
          const laneRows = lanesByTrack.get(track.id) ?? []
          return (
            <div key={track.id} className="track-header-group">
              <TrackHeader
                track={track}
                index={i}
                trackHeight={trackHeight}
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
              {laneRows.map((lane) => (
                <div
                  key={lane.id}
                  className={`track-header-macro-lane${lane.targetUnavailable ? ' track-header-macro-lane--orphan' : ''}`}
                  style={{ height: lane.height, borderLeftColor: trackColor }}
                  title={lane.label}
                >
                  <Sliders size={10} className="track-header-macro-lane-icon" strokeWidth={2} />
                  <span className="track-header-macro-lane-label">{lane.label}</span>
                  {onHideMacroLane && (
                    <button
                      className="track-header-macro-lane-hide"
                      title="Hide automation lane"
                      aria-label="Hide automation lane"
                      onClick={() => onHideMacroLane(lane.parentTrackId, lane.macroNodeId)}
                    >
                      <EyeOff size={10} strokeWidth={2} />
                    </button>
                  )}
                </div>
              ))}
            </div>
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
