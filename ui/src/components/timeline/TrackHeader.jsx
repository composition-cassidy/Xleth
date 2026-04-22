import { useState, useRef, useCallback } from 'react'
import { Trash2, Music, Sliders } from 'lucide-react'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import { hexToRgba } from './timelineDrawing.js'
import { timelineEvents } from '../../timelineEvents.js'
import { tokenValue } from '../../theming/tokenValue.ts'

const LABEL_TOKENS = [
  '--theme-label-kick',   '--theme-label-snare',
  '--theme-label-hihat',  '--theme-label-crash',
  '--theme-label-pitch',  '--theme-label-quote',
  '--theme-label-custom', '--theme-border-focus',
]

export default function TrackHeader({
  track, index, currentPattern,
  onMute, onSolo, onRename, onRemove, onRequestContextMenu,
  onDragStart, onDragOver, onDrop,
}) {
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  const isPatternTrack = track.type === 'Pattern'
  // Pattern tracks are sample-agnostic — pick a stable accent by slot index
  // like Clip tracks, not from a bound region.
  const color = tokenValue(LABEL_TOKENS[index % LABEL_TOKENS.length])

  const startEdit = useCallback(() => {
    setEditing(true)
    setNameInput(track.name)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [track.name])

  const commitEdit = useCallback(() => {
    setEditing(false)
    const trimmed = nameInput.trim()
    if (trimmed && trimmed !== track.name) {
      onRename(track.id, trimmed)
    }
  }, [nameInput, track.id, track.name, onRename])

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') commitEdit()
    if (e.key === 'Escape') setEditing(false)
  }, [commitEdit])

  const hasActivePattern = currentPattern?.id != null && currentPattern.id >= 0
  const handleOpenSampler = useCallback((e) => {
    e.stopPropagation()
    if (!hasActivePattern) {
      console.warn('[TrackHeader] No active pattern block on track — cannot open sampler')
      return
    }
    timelineEvents.dispatchEvent(new CustomEvent('open-sampler-settings', { detail: { patternId: currentPattern.id, regionId: currentPattern.regionId } }))
  }, [currentPattern, hasActivePattern])

  return (
    <div
      className={`track-header ${track.muted ? 'track-header--muted' : ''} ${isPatternTrack ? 'track-header--pattern' : ''}`}
      style={{
        height: TRACK_HEIGHT,
        ...(isPatternTrack && { background: `linear-gradient(90deg, ${hexToRgba(color, 0.06)} 0%, transparent 60%)` }),
      }}
      draggable
      onDragStart={(e) => onDragStart(e, index)}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      onContextMenu={(e) => {
        e.preventDefault()
        onRequestContextMenu?.(track, e.clientX, e.clientY)
      }}
    >
      {/* Color bar — label-colored for pattern tracks */}
      <div className="track-header-color" style={{ background: color }} />

      {/* Name + (optional) region sub-label for pattern tracks */}
      <div className="track-header-name-wrap">
        {editing ? (
          <input
            ref={inputRef}
            className="track-header-name-input"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
            autoFocus
          />
        ) : (
          <span className="track-header-name" onDoubleClick={startEdit}>
            {isPatternTrack && <Music size={12} style={{ marginRight: 4, verticalAlign: '-1px', opacity: 0.85 }} />}
            {track.name}
          </span>
        )}
        <span className="track-header-subname">
          <span className="track-header-type-badge">{isPatternTrack ? 'PATTERN' : 'CLIP'}</span>
          {track.videoHoldLastFrame && (
            <span className="track-header-hold-badge" title="Hold Last Frame">H</span>
          )}
        </span>
      </div>

      {/* Sampler button — only for pattern tracks, disabled if no active block */}
      {isPatternTrack && (
        <button
          className="track-header-btn"
          onClick={handleOpenSampler}
          disabled={!hasActivePattern}
          title={hasActivePattern ? 'Open Sampler Settings' : 'No active pattern — drop a pattern onto this track'}
        >
          <Sliders size={12} />
        </button>
      )}

      {/* Mute / Solo buttons */}
      <button
        className={`track-header-btn ${track.muted ? 'muted' : ''}`}
        onClick={() => onMute(track.id)}
        title="Mute"
      >
        M
      </button>
      <button
        className={`track-header-btn ${track.solo ? 'active' : ''}`}
        onClick={() => onSolo(track.id)}
        title="Solo"
      >
        S
      </button>
      <button
        className="track-delete-btn"
        onClick={() => onRemove(track.id)}
        title="Delete track"
      >
        <Trash2 size={12} />
      </button>
    </div>
  )
}
