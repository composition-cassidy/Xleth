import { useCallback, useRef } from 'react'
import { Plus } from 'lucide-react'
import TrackHeader from './TrackHeader.jsx'
import { RULER_HEIGHT, HEADER_WIDTH } from '../../constants/timeline.js'

export default function TrackHeaderList({
  tracks, patterns, currentPatternIdByTrack,
  onAddTrack, onMute, onSolo, onRename, onRemove, onReorder, onRequestContextMenu,
  scrollContainerRef,
}) {
  const dragIndexRef = useRef(null)

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
    <div className="timeline-header-column" style={{ width: HEADER_WIDTH }}>
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
          return (
            <TrackHeader
              key={track.id}
              track={track}
              index={i}
              currentPattern={currentPattern}
              onMute={onMute}
              onSolo={onSolo}
              onRename={onRename}
              onRemove={onRemove}
              onRequestContextMenu={onRequestContextMenu}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDrop={onDrop}
            />
          )
        })}

        {/* Add Track button */}
        <button className="timeline-add-track" onClick={onAddTrack} title="Add track">
          <Plus size={14} />
          <span>Add Track</span>
        </button>
      </div>
    </div>
  )
}
