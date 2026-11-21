import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { ticksToBeats } from '../../constants/timeline.js'
import { Button, IconButton, THIN_SPACE } from '../../ui-kit'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import useTrackIdentityColors from '../inspector/useTrackIdentityColors.js'
import usePianoRollStore from '../../stores/usePianoRollStore.js'
import styles from './PatternListPanel.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcCaretLeft = iconComponent('caret-left')
const IcCaretRight = iconComponent('caret-right')
const IcPlus = iconComponent('plus')

// ── PatternListPanel ────────────────────────────────────────────────────────
// Left strip inside the timeline listing every pattern in the project as one
// flat, globally-numbered list. Drag a row onto any Pattern-type track in the
// timeline canvas to create a PatternBlock — pattern tracks are sample-
// agnostic, so any pattern can drop onto any pattern track.
//
// Payload (still carries regionId — the active block's region drives video
// routing and sampler loading downstream):
//   dataTransfer.setData('application/xleth-pattern', JSON.stringify({
//     patternId, regionId, name, lengthTicks, noteCount
//   }))
//   window.__xlethDragPattern = payload   // readable during dragover

const PATTERN_ACCENT = 'var(--theme-drag-preview-default)'

/**
 * { [patternId]: '#RRGGBB' }: the identity colour of the track a pattern's first block sits on
 * (the earliest block, as the Piano Roll colours its notes: DESIGN.md 15). A pattern has no
 * colour of its own in the project; one that is not placed has no entry and takes the value colour.
 */
export function patternOwnerColors(blocks, trackColors) {
  const first = {}
  for (const b of blocks ?? []) {
    const seen = first[b.patternId]
    if (!seen || b.positionTicks < seen.positionTicks) first[b.patternId] = b
  }
  const out = {}
  for (const [patternId, b] of Object.entries(first)) {
    const c = trackColors?.[b.trackId]
    if (c) out[patternId] = c
  }
  return out
}

/** Where a pattern's notes fall in a w x h box: x by time, y by pitch within the pattern's own range. */
export function patternPreviewRects(pattern, w, h) {
  const notes = pattern?.notes
  const len = pattern?.lengthTicks
  if (!Array.isArray(notes) || notes.length === 0 || !(len > 0) || !(w > 0) || !(h > 0)) return []
  let lo = Infinity
  let hi = -Infinity
  for (const n of notes) {
    if (!n || !Number.isFinite(n.pitch)) continue
    if (n.pitch < lo) lo = n.pitch
    if (n.pitch > hi) hi = n.pitch
  }
  if (lo === Infinity) return []
  const range = Math.max(1, hi - lo)
  const noteH = 2
  const travel = Math.max(0, h - noteH)
  const rects = []
  for (const n of notes) {
    if (!n || !Number.isFinite(n.pitch)) continue
    const x = (Math.max(0, n.positionTicks || 0) / len) * w
    if (x >= w) continue
    rects.push({
      x,
      y: travel - ((n.pitch - lo) / range) * travel,
      w: Math.max(1, Math.min(w - x, ((n.durationTicks || 0) / len) * w)),
      h: noteH,
    })
  }
  return rects
}

const PREVIEW_W = 40
const PREVIEW_H = 14

/**
 * The row's mini piano roll: one small canvas per pattern, drawn when the pattern, the colour,
 * the theme or the pixel ratio changes, never per frame. It reads the notes directly: a whole
 * pattern at 40px needs no viewport index.
 */
function PatternRowPreview({ pattern, color }) {
  const ref = useRef(null)
  const epoch = useThemeEpoch()
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext?.('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(PREVIEW_W * dpr)
    canvas.height = Math.round(PREVIEW_H * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H)
    ctx.fillStyle = color || tokenValue('--ui-value')
    for (const r of patternPreviewRects(pattern, PREVIEW_W, PREVIEW_H)) ctx.fillRect(r.x, r.y, r.w, r.h)
  }, [pattern, color, epoch])
  return <canvas ref={ref} className={styles.preview} style={{ width: PREVIEW_W, height: PREVIEW_H }} aria-hidden="true" />
}

// A pattern's length in 16th-note steps, the unit the Piano Roll grid counts in
// ("16 steps"). A fraction survives to one decimal; a whole number prints bare.
export function patternStepsLabel(lengthTicks) {
  const steps = Math.round(ticksToBeats(lengthTicks || 0) * 4 * 10) / 10
  return `${steps}${THIN_SPACE}${steps === 1 ? 'step' : 'steps'}`
}

export default function PatternListPanel({
  patterns = {},          // { id: Pattern }
  tracks = null,          // the project's tracks, for the owning track's colour
  blocks = null,          // pattern blocks: a pattern takes the colour of its first block's track
  onOpenPianoRoll,        // (patternId) => void
  onNewPattern,           // () => void
  onRename,               // (patternId, name) => void
  collapsed = false,
  onToggleCollapsed,
}) {
  const [hoverId, setHoverId] = useState(null)
  const trackColors = useTrackIdentityColors(tracks)
  const ownerColors = useMemo(() => patternOwnerColors(blocks, trackColors), [blocks, trackColors])
  // The pattern open in the Piano Roll is the selected one.
  const selectedPatternId = usePianoRollStore((s) => s.patternId)
  const [editingId, setEditingId] = useState(null)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  const startEdit = useCallback((pattern) => {
    setEditingId(pattern.id)
    setNameInput(pattern.name || `Pattern ${pattern.id}`)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [])

  const commitEdit = useCallback(() => {
    const id = editingId
    setEditingId(null)
    if (id == null) return
    const trimmed = nameInput.trim()
    const orig = patterns[id]?.name
    if (trimmed && trimmed !== orig) onRename?.(id, trimmed)
  }, [editingId, nameInput, patterns, onRename])

  const cancelEdit = useCallback(() => setEditingId(null), [])

  const onEditKeyDown = useCallback((e) => {
    if (e.key === 'Enter') commitEdit()
    else if (e.key === 'Escape') cancelEdit()
  }, [commitEdit, cancelEdit])

  // Flat, numerically-sorted pattern list (no region grouping)
  const sortedPatterns = useMemo(() => {
    return Object.values(patterns).sort((a, b) => a.id - b.id)
  }, [patterns])

  const handleDragStart = useCallback((e, pattern) => {
    const payload = {
      patternId:   pattern.id,
      regionId:    pattern.regionId,
      name:        pattern.name,
      lengthTicks: pattern.lengthTicks,
      noteCount:   pattern.notes?.length || 0,
    }
    e.dataTransfer.setData('application/xleth-pattern', JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'copy'

    // Expose payload globally so dragover can read it (HTML5 DnD limitation)
    window.__xlethDragPattern = payload

    // Custom drag image
    const el = document.createElement('div')
    el.textContent = pattern.name || `Pattern ${pattern.id}`
    el.style.cssText = `
      position: absolute; top: -1000px; left: -1000px;
      padding: 4px 10px; border-radius: 4px; font-size: 12px;
      font-family: var(--xleth-global-font-family); font-weight: 600;
      background: ${PATTERN_ACCENT}; color: #000;
      white-space: nowrap;
    `
    document.body.appendChild(el)
    e.dataTransfer.setDragImage(el, 0, 0)
    setTimeout(() => document.body.removeChild(el), 0)

    console.log(`[PatternList] Drag started: "${pattern.name}" (id=${pattern.id})`)
  }, [])

  const handleDragEnd = useCallback(() => {
    window.__xlethDragPattern = null
  }, [])

  const handleClick = useCallback((patternId) => {
    if (onOpenPianoRoll) onOpenPianoRoll(patternId)
    else timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId } }))
  }, [onOpenPianoRoll])

  if (collapsed) {
    return (
      <div className={`pattern-list-panel pattern-list-panel-collapsed ${styles.collapsed}`}>
        <IconButton size="sm" label="Expand pattern list" onClick={onToggleCollapsed} hint="Expand the pattern list">
          <IcCaretRight size={14} />
        </IconButton>
      </div>
    )
  }

  return (
    <div className={`pattern-list-panel ${styles.panel}`}>
      <div className={`pattern-list-header ${styles.header}`}>
        <span className={`pattern-list-title ${styles.title}`}>Patterns</span>
        <span className={styles.total} role="img" aria-label={`${sortedPatterns.length} patterns`}>{sortedPatterns.length}</span>
        <IconButton size="sm" label="Collapse pattern list" onClick={onToggleCollapsed} hint="Collapse the pattern list">
          <IcCaretLeft size={14} />
        </IconButton>
      </div>

      <div className={`pattern-list-body ${styles.body}`} role="listbox" aria-label="Patterns">
        {sortedPatterns.length === 0 ? (
          <div className={styles.empty}>No patterns yet</div>
        ) : (
          sortedPatterns.map((p) => {
            const isEditing = editingId === p.id
            const label = p.name || `Pattern ${p.id}`
            const selected = selectedPatternId === p.id
            const color = ownerColors[p.id] || null
            const noteCount = p.notes?.length || 0
            return (
              <div
                key={p.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                className={`pattern-list-row ${styles.row}${hoverId === p.id ? ' is-hover' : ''}`}
                data-selected={selected ? 'true' : 'false'}
                draggable={!isEditing}
                onDragStart={(e) => handleDragStart(e, p)}
                onDragEnd={handleDragEnd}
                onClick={() => { if (!isEditing) handleClick(p.id) }}
                onKeyDown={(e) => {
                  if (isEditing || e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(p.id) }
                  else if (e.key === 'F2') { e.preventDefault(); startEdit(p) }
                }}
                onMouseEnter={() => setHoverId(p.id)}
                onMouseLeave={() => setHoverId(null)}
                data-hint={`${label}: ${patternStepsLabel(p.lengthTicks)}, ${noteCount} ${noteCount === 1 ? 'note' : 'notes'}${color ? '' : ', not placed'}`}
                data-hint-mods="Click: open in the Piano Roll · Drag onto a pattern track · Double-click or F2: rename"
              >
                {/* The owning track's colour (the thread from lane to strip to here); the value
                    colour while the pattern is not placed on any track. */}
                <span className={styles.swatch} style={{ background: color || 'var(--ui-value)' }} aria-hidden="true" />
                {isEditing ? (
                  <input
                    ref={inputRef}
                    className={styles.nameInput}
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={onEditKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    aria-label="Pattern name"
                    autoFocus
                  />
                ) : (
                  <span
                    className={`pattern-list-row-name ${styles.name}`}
                    onDoubleClick={(e) => { e.stopPropagation(); startEdit(p) }}
                  >
                    {label}
                  </span>
                )}
                {/* What is in it, not how long it is: the length moved to the hint. */}
                <PatternRowPreview pattern={p} color={color} />
              </div>
            )
          })
        )}
      </div>

      {onNewPattern && (
        <div className={styles.footer}>
          <Button size="sm" className={styles.newBtn} glyph={<IcPlus size={14} />} onClick={onNewPattern} hint="Create a new pattern">
            New pattern
          </Button>
        </div>
      )}    </div>
  )
}
