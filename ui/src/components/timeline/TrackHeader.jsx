import { useState, useRef, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import { TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { PianoIcon, WaveformIcon, EllipsisIcon } from './TrackTypeIcons.jsx'

export default function TrackHeader({
  track, index, trackColor, isFocused, isSelected,
  trackHeight = TRACK_HEIGHT,
  onMute, onSolo, onVisualOnly, onRename, onRemove, onRequestContextMenu, onFocus, onSelect,
  onDragStart, onDragOver, onDrop,
  onOpenColorPicker,
  onOpenInMixer,
}) {
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  const isPatternTrack = track.type === 'Pattern'
  const color = trackColor || TRACK_PALETTE_FALLBACK[index % 16]

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

  const handleOpenMenu = useCallback((e) => {
    e.stopPropagation()
    onFocus?.(track.id)
    onRequestContextMenu?.(track, e.clientX, e.clientY)
  }, [track, onFocus, onRequestContextMenu])

  const handleHeaderDoubleClick = useCallback((e) => {
    // The name label has its own double-click (rename) and buttons handle
    // their own clicks — only jump to the mixer for the rest of the row.
    if (e.target.closest('button, input, .track-header-name')) return
    onOpenInMixer?.(track.id)
  }, [track.id, onOpenInMixer])

  return (
    <div
      className={`track-header${track.muted ? ' track-header--muted' : ''}${track.visualOnly ? ' track-header--visual-only' : ''}${isPatternTrack ? ' track-header--pattern' : ''}${isFocused ? ' track-header--focused' : ''}${isSelected ? ' track-header--selected' : ''}`}
      style={{
        height: trackHeight,
        '--track-header-fill': color,
      }}
      draggable
      onMouseDown={() => onFocus?.(track.id)}
      onClick={(event) => onSelect?.(track.id, event)}
      onDoubleClick={handleHeaderDoubleClick}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault()
        onFocus?.(track.id)
        onRequestContextMenu?.(track, e.clientX, e.clientY)
      }}
    >
      {isFocused && <div className="track-header-focus-bar" />}

      {/* Colored identity block — solid fill for Pattern tracks, a soft white
          glow bleeding in from the right edge for Clip tracks. */}
      <div className="track-header-block">
        <button
          className="track-header-color-btn"
          onMouseDown={(e) => { e.stopPropagation() }}
          onClick={(e) => {
            e.stopPropagation()
            onOpenColorPicker?.(track.id, e.currentTarget.getBoundingClientRect())
          }}
          title="Change track color"
          aria-label="Change track color"
        />

        <div className="track-header-name-wrap" title={track.name}>
          <button
            className="track-header-menu-btn"
            onMouseDown={(e) => { e.stopPropagation() }}
            onClick={handleOpenMenu}
            title="Track menu"
            aria-label="Track menu"
          >
            <EllipsisIcon size={11} />
          </button>

          {editing ? (
            <input
              ref={inputRef}
              className="track-header-name-input"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={commitEdit}
              onKeyDown={onKeyDown}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              autoFocus
            />
          ) : (
            <span className="track-header-name" onDoubleClick={startEdit}>
              {track.name}
            </span>
          )}
          {track.videoHoldLastFrame && (
            <span className="track-header-hold-badge" title="Hold Last Frame">H</span>
          )}
        </div>

        <div className="track-header-type-icon" aria-hidden="true">
          {isPatternTrack ? <PianoIcon size={13} /> : <WaveformIcon size={13} />}
        </div>
      </div>

      {/* M / S / V cluster — consistent with the mixer strip */}
      <div className="track-header-controls">
        <div className="track-header-btn-cluster">
          <button
            className={`track-header-btn track-header-btn--mute${track.muted ? ' active' : ''}`}
            onClick={() => onMute(track.id)}
            title="Mute"
          >M</button>
          <button
            className={`track-header-btn track-header-btn--solo${track.solo ? ' active' : ''}`}
            onClick={() => onSolo(track.id)}
            title="Solo"
          >S</button>
          <button
            className={`track-header-btn track-header-btn--visual${track.visualOnly ? ' active' : ''}`}
            onClick={() => onVisualOnly(track.id)}
            title="Visual Only — silences audio, keeps grid triggers"
          >V</button>
        </div>

        <button
          className="track-delete-btn"
          onClick={() => onRemove(track.id)}
          title="Delete track"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  )
}
