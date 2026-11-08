import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import { ticksToBeats } from '../../constants/timeline.js'
import { Button, IconButton, THIN_SPACE } from '../../ui-kit'
import usePianoRollStore from '../../stores/usePianoRollStore.js'
import PatternPreviewTooltip from './patternPreview/PatternPreviewTooltip.jsx'
import styles from './PatternListPanel.module.css'

const HOVER_PREVIEW_DELAY_MS = 220

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

// A pattern's length in 16th-note steps, the unit the Piano Roll grid counts in
// ("16 steps"). A fraction survives to one decimal; a whole number prints bare.
export function patternStepsLabel(lengthTicks) {
  const steps = Math.round(ticksToBeats(lengthTicks || 0) * 4 * 10) / 10
  return `${steps}${THIN_SPACE}${steps === 1 ? 'step' : 'steps'}`
}

export default function PatternListPanel({
  patterns = {},          // { id: Pattern }
  onOpenPianoRoll,        // (patternId) => void
  onNewPattern,           // () => void
  onRename,               // (patternId, name) => void
  collapsed = false,
  onToggleCollapsed,
}) {
  const [hoverId, setHoverId] = useState(null)
  // The pattern open in the Piano Roll is the selected one.
  const selectedPatternId = usePianoRollStore((s) => s.patternId)
  const [editingId, setEditingId] = useState(null)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  // ── Hover-preview tooltip ─────────────────────────────────────────────────
  // `hoverId` above drives the instant `.is-hover` row highlight; the preview
  // card itself only appears after a short hover-intent delay so skimming
  // down the list doesn't flicker a tooltip per row.
  const [previewTarget, setPreviewTarget] = useState(null) // { patternId, anchorRect }
  const rowElsRef = useRef(new Map()) // patternId -> row DOM node
  const previewTimerRef = useRef(null)

  const clearPreviewTimer = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current)
      previewTimerRef.current = null
    }
  }, [])

  const handleRowMouseEnter = useCallback((patternId) => {
    setHoverId(patternId)
    clearPreviewTimer()
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null
      const rowEl = rowElsRef.current.get(patternId)
      if (!rowEl) return
      setPreviewTarget({ patternId, anchorRect: rowEl.getBoundingClientRect() })
    }, HOVER_PREVIEW_DELAY_MS)
  }, [clearPreviewTimer])

  const handleRowMouseLeave = useCallback(() => {
    setHoverId(null)
    clearPreviewTimer()
    setPreviewTarget(null)
  }, [clearPreviewTimer])

  // Dismiss on scroll/resize — a fixed-position card would otherwise detach
  // from its anchor row (mirrors TrackColorPopover.jsx's same guard).
  useEffect(() => {
    if (!previewTarget) return
    const dismiss = () => setPreviewTarget(null)
    window.addEventListener('resize', dismiss)
    window.addEventListener('wheel', dismiss, { passive: true })
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('wheel', dismiss)
    }
  }, [previewTarget])

  useEffect(() => clearPreviewTimer, [clearPreviewTimer])

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
          <ChevronRight size={14} />
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
          <ChevronLeft size={14} />
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
            return (
              <div
                key={p.id}
                ref={(el) => {
                  if (el) rowElsRef.current.set(p.id, el)
                  else rowElsRef.current.delete(p.id)
                }}
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
                onMouseEnter={() => handleRowMouseEnter(p.id)}
                onMouseLeave={handleRowMouseLeave}
                data-hint={`${label}: ${p.notes?.length || 0} notes`}
                data-hint-mods="Click: open in the Piano Roll · Drag onto a pattern track · Double-click or F2: rename"
              >
                <span className={styles.swatch} style={{ background: PATTERN_ACCENT }} aria-hidden="true" />
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
                <span className={styles.meta}>{patternStepsLabel(p.lengthTicks)}</span>
              </div>
            )
          })
        )}
      </div>

      {onNewPattern && (
        <div className={styles.footer}>
          <Button size="sm" className={styles.newBtn} glyph={<Plus size={12} />} onClick={onNewPattern} hint="Create a new pattern">
            New pattern
          </Button>
        </div>
      )}

      {previewTarget && patterns[previewTarget.patternId] && (
        <PatternPreviewTooltip
          pattern={patterns[previewTarget.patternId]}
          anchorRect={previewTarget.anchorRect}
          onRequestClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  )
}
