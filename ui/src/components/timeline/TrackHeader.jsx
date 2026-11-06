import { useState, useRef, useCallback } from 'react'
import { Trash2 } from 'lucide-react'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import { TRACK_PALETTE_FALLBACK, pickPatternAccentText } from './trackColorResolver.js'
import { PianoIcon, WaveformIcon, EllipsisIcon } from './TrackTypeIcons.jsx'
import { Toggle } from '../../ui-kit'
import { pickLabelInk } from '../../ui-kit/colorMath'
import styles from './TrackHeader.module.css'

// Below this lane height the header drops its type-icon row so the name fits.
const COMPACT_HEADER_BELOW = 32

export default function TrackHeader({
  track, index, trackColor, labelInks = null, isFocused, isSelected,
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
  // Pattern headers are tinted glass (text in the track colour on a dark wash);
  // clip headers are a solid identity fill, so their text takes the automatic
  // label ink: whichever of ink / g1 contrasts more with that colour.
  const headerTextColor = isPatternTrack
    ? pickPatternAccentText(color)
    : (labelInks && /^#[0-9a-f]{6}$/i.test(color) ? pickLabelInk(color, labelInks.light, labelInks.dark).ink : null)

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
      className={`track-header${track.muted ? ' track-header--muted' : ''}${track.visualOnly ? ' track-header--visual-only' : ''}${isPatternTrack ? ' track-header--pattern' : ''}${isFocused ? ' track-header--focused' : ''}${isSelected ? ' track-header--selected' : ''} ${trackHeight < COMPACT_HEADER_BELOW ? styles.compact : ''}`}
      style={{
        height: trackHeight,
        '--track-header-fill': color,
        ...(headerTextColor ? { '--track-header-text': headerTextColor } : {}),
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

      {/* Colored identity block — flat solid fill for Clip tracks; tinted
          glass + diagonal hatch + inset stroke (all CSS-derived from
          --track-header-fill) for Pattern tracks. */}
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

      {/* M / S / V: kit Toggles, visible at rest. On = the inverted ink chip
          (solo in the solo colour); a muted track also dims its lane content
          and its identity block, so state is never colour alone. */}
      <div className={styles.controls}>
        <div className={styles.cluster} role="group" aria-label={`${track.name} state`}>
          <Toggle
            size="sm" className={styles.state} data-kind="mute"
            on={!!track.muted} onChange={() => onMute(track.id)}
            glyph="M" aria-label={`Mute ${track.name}`}
            hint="Mute: silences the track; its clips dim"
          />
          <Toggle
            size="sm" className={styles.state} data-kind="solo"
            on={!!track.solo} onChange={() => onSolo(track.id)}
            glyph="S" aria-label={`Solo ${track.name}`}
            hint="Solo: hear only soloed tracks"
          />
          <Toggle
            size="sm" className={styles.state} data-kind="visual"
            on={!!track.visualOnly} onChange={() => onVisualOnly(track.id)}
            glyph="V" aria-label={`Visual only ${track.name}`}
            hint="Visual only: silences audio, keeps grid triggers"
          />
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
