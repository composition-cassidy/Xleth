import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import PatternPreviewTooltip from './patternPreview/PatternPreviewTooltip.jsx'

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

export default function PatternListPanel({
  patterns = {},          // { id: Pattern }
  onOpenPianoRoll,        // (patternId) => void
  onNewPattern,           // () => void
  onRename,               // (patternId, name) => void
  collapsed = false,
  onToggleCollapsed,
}) {
  const [hoverId, setHoverId] = useState(null)
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
      <div className="pattern-list-panel pattern-list-panel-collapsed">
        <button
          className="pattern-list-expand-btn"
          onClick={onToggleCollapsed}
          title="Expand pattern list"
        >
          <ChevronRight size={14} />
        </button>
      </div>
    )
  }

  return (
    <div className="pattern-list-panel">
      <div className="pattern-list-header">
        <span className="pattern-list-title">Patterns</span>
        <button
          className="pattern-list-collapse-btn"
          onClick={onToggleCollapsed}
          title="Collapse"
        >
          <ChevronLeft size={14} />
        </button>
      </div>

      <div className="pattern-list-body">
        {sortedPatterns.length === 0 ? (
          <div className="pattern-list-empty">No patterns yet</div>
        ) : (
          sortedPatterns.map((p) => {
            const isEditing = editingId === p.id
            return (
              <div
                key={p.id}
                ref={(el) => {
                  if (el) rowElsRef.current.set(p.id, el)
                  else rowElsRef.current.delete(p.id)
                }}
                className={`pattern-list-row ${hoverId === p.id ? 'is-hover' : ''}`}
                draggable={!isEditing}
                onDragStart={(e) => handleDragStart(e, p)}
                onDragEnd={handleDragEnd}
                onClick={() => { if (!isEditing) handleClick(p.id) }}
                onMouseEnter={() => handleRowMouseEnter(p.id)}
                onMouseLeave={handleRowMouseLeave}
                title={isEditing ? undefined : `${p.name || `Pattern ${p.id}`} — ${p.notes?.length || 0} note(s)`}
              >
                <span className="pattern-list-row-swatch" style={{ background: PATTERN_ACCENT }} />
                {isEditing ? (
                  <input
                    ref={inputRef}
                    className="pattern-list-row-name-input"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={onEditKeyDown}
                    onClick={(e) => e.stopPropagation()}
                    autoFocus
                  />
                ) : (
                  <span
                    className="pattern-list-row-name"
                    onDoubleClick={(e) => { e.stopPropagation(); startEdit(p) }}
                  >
                    {p.name || `Pattern ${p.id}`}
                  </span>
                )}
                <span className="pattern-list-row-meta">{p.notes?.length || 0}</span>
              </div>
            )
          })
        )}
      </div>

      {onNewPattern && (
        <div className="pattern-list-footer">
          <button className="pattern-list-new-btn" onClick={onNewPattern} title="New pattern">
            <Plus size={12} />
            <span>New Pattern</span>
          </button>
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
