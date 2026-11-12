import { useState, useRef, useCallback } from 'react'
import { TRACK_HEIGHT } from '../../constants/timeline.js'
import { TRACK_PALETTE_FALLBACK } from './trackColorResolver.js'
import { Icon, IconButton, Pearl, Toggle } from '../../ui-kit'
import { pickLabelInk } from '../../ui-kit/colorMath'
import styles from './TrackHeader.module.css'

// From this lane height up the header stacks: name row, then the pearl / V row.
const STACK_HEADER_FROM = 56

/**
 * One track's header (DESIGN.md 22): a neutral g2 row. Identity is a 6px stripe
 * down the left edge and a colour chip that holds the type glyph (and opens the
 * colour popover); the clips already carry the full colour, so the header does
 * not. The name is ink on g2 in every state, muted included: only the stripe and
 * chip dim. The output pearl and the V (Visual only) toggle are visible at rest. The track-menu button is
 * not in the resting row (it gave its 28px to the name): it shows over the end of
 * the name while the row is hovered or holds focus, and the same menu opens from
 * a right-click or the menu key anywhere on the row.
 */
export default function TrackHeader({
  track, index, trackColor, labelInks = null, isFocused, isSelected,
  trackHeight = TRACK_HEIGHT,
  onMute, onSolo, onPearl, lit, onVisualOnly, onRename, onRequestContextMenu, onFocus, onSelect,
  onDragStart, onDragOver, onDrop,
  onOpenColorPicker,
  onOpenInMixer,
}) {
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  const isPatternTrack = track.type === 'Pattern'
  const color = trackColor || TRACK_PALETTE_FALLBACK[index % 16]
  // The glyph on the chip takes whichever of ink / g1 contrasts more with the identity colour.
  const chipInk = labelInks && /^#[0-9a-f]{6}$/i.test(color)
    ? pickLabelInk(color, labelInks.light, labelInks.dark).ink
    : null

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
      className={`track-header${track.muted ? ' track-header--muted' : ''}${track.visualOnly ? ' track-header--visual-only' : ''}${isPatternTrack ? ' track-header--pattern' : ''}${isFocused ? ' track-header--focused' : ''}${isSelected ? ' track-header--selected' : ''} ${styles.row}`}
      data-muted={track.muted ? 'true' : 'false'}
      data-focused={isFocused ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      data-kind={isPatternTrack ? 'pattern' : 'clip'}
      data-stack={trackHeight >= STACK_HEADER_FROM ? 'true' : 'false'}
      style={{
        height: trackHeight,
        '--track-header-fill': color,
        ...(chipInk ? { '--track-header-ink': chipInk } : {}),
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
      <span className={styles.stripe} aria-hidden="true" />

      <button
        type="button"
        className={`track-header-color-btn ${styles.chip}`}
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={(e) => {
          e.stopPropagation()
          onOpenColorPicker?.(track.id, e.currentTarget.getBoundingClientRect())
        }}
        aria-label="Change track color"
        data-hint="Track colour"
        data-hint-mods={isPatternTrack ? 'Pattern track' : 'Clip track'}
      >
        <span className={styles.chipFace}>
          {isPatternTrack ? <Icon name="piano-keys" size={14} /> : <Icon name="xleth-squiggle" size={14} />}
        </span>
      </button>

      <div className={`track-header-name-wrap ${styles.nameWrap}`} title={track.name}>
        {editing ? (
          <input
            ref={inputRef}
            className={`track-header-name-input ${styles.nameInput}`}
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            aria-label="Track name"
            autoFocus
          />
        ) : (
          <span className={`track-header-name ${styles.name}`} onDoubleClick={startEdit}>
            {track.name}
          </span>
        )}
        {track.videoHoldLastFrame && (
          <span className={styles.hold} role="img" aria-label="Hold last frame" data-hint="Hold last frame">H</span>
        )}
      </div>

      <IconButton
        size="sm"
        label="Track menu"
        className={styles.menu}
        onMouseDown={(e) => { e.stopPropagation() }}
        onClick={handleOpenMenu}
        hint="Track menu"
        hintMods="Right-click the row or press the menu key for the same menu"
      >
        <Icon name="dots-three" />
      </IconButton>

      {/* Output pearl + Visual only. The pearl is lit when the track is heard (filled vs hollow,
          never colour alone); click = on/off, right-click = solo (ui-kit/pearlRules.ts). A muted
          track also dims its stripe, chip and lane content. */}
      <div className={styles.cluster} role="group" aria-label={`${track.name} state`}>
        <Pearl
          lit={lit ?? !track.muted}
          label={track.name}
          onToggle={() => (onPearl ? onPearl(track.id, 'toggle') : onMute?.(track.id))}
          onSolo={() => (onPearl ? onPearl(track.id, 'solo') : onSolo?.(track.id))}
        />
        <Toggle
          size="sm" className={styles.state} data-kind="visual"
          on={!!track.visualOnly} onChange={() => onVisualOnly(track.id)}
          glyph={<Icon name="eye" />} aria-label={`Visual only ${track.name}`}
          hint="Visual only: silences audio, keeps grid triggers"
        />
      </div>
    </div>
  )
}
