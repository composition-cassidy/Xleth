import { useState, useRef } from 'react'

// Module-level: lets onDragOver detect cross-group drags without reading dataTransfer
// (HTML5 security model blocks dataTransfer reads outside dragstart/drop).
let activeDragKind = null

export default function EffectRow({
  glyph, enabled, label, hasParams,
  defaultExpanded = false,
  groupKind, sourceIndex, onReorder,
  onRemove, onToggle, children,
}) {
  const [expanded,   setExpanded]   = useState(defaultExpanded)
  const [isDragging, setIsDragging] = useState(false)
  const [dropPos,    setDropPos]    = useState(null) // 'above' | 'below' | null
  const rowRef = useRef(null)
  const wrapRef = useRef(null)

  // ── Drag source ────────────────────────────────────────────────────────────

  const onGripMouseDown = () => {
    if (rowRef.current) rowRef.current.draggable = true
  }

  const onDragStart = (e) => {
    activeDragKind = groupKind
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(sourceIndex))
    document.documentElement.classList.add('fx-drag-active')
    setIsDragging(true)
  }

  const onDragEnd = () => {
    activeDragKind = null
    if (rowRef.current) rowRef.current.draggable = false
    document.documentElement.classList.remove('fx-drag-active')
    setIsDragging(false)
    setDropPos(null)
  }

  // ── Drop target ────────────────────────────────────────────────────────────

  const onDragOver = (e) => {
    if (activeDragKind !== groupKind) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = wrapRef.current?.getBoundingClientRect()
    if (!rect) return
    setDropPos(e.clientY < rect.top + rect.height / 2 ? 'above' : 'below')
  }

  const onDragLeave = () => setDropPos(null)

  const onDrop = (e) => {
    if (activeDragKind !== groupKind) return
    e.preventDefault()
    const fromIdx = parseInt(e.dataTransfer.getData('text/plain'), 10)
    if (isNaN(fromIdx) || fromIdx === sourceIndex) { setDropPos(null); return }
    // insertBefore: if dropping below, insert after this row (sourceIndex + 1)
    const insertBefore = dropPos === 'above' ? sourceIndex : sourceIndex + 1
    setDropPos(null)
    onReorder?.(fromIdx, insertBefore)
  }

  return (
    <div
      ref={wrapRef}
      className="fx-row-wrap"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dropPos === 'above' && <div className="fx-drop-indicator" />}

      <div
        ref={rowRef}
        className={`fx-row${isDragging ? ' dragging' : ''}`}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="fx-row-header">
          <span className="fx-glyph">{glyph}</span>
          {hasParams
            ? <span className={`fx-chevron ${expanded ? 'expanded' : ''}`}
                    onClick={() => setExpanded(v => !v)}>▶</span>
            : <span className="fx-chevron-ph" />
          }
          <input
            type="checkbox"
            className="fx-checkbox"
            checked={!!enabled}
            onChange={onToggle}
          />
          <span
            className={`fx-name ${!enabled ? 'disabled' : ''}`}
            onClick={hasParams ? () => setExpanded(v => !v) : undefined}
            style={hasParams ? { cursor: 'pointer' } : undefined}
          >{label}</span>
          {onRemove && (
            <button className="fx-remove" onClick={onRemove}>✕</button>
          )}
          <span
            className="fx-grip"
            title="Drag to reorder"
            onMouseDown={onGripMouseDown}
            onMouseUp={() => { if (rowRef.current) rowRef.current.draggable = false }}
          >⋮⋮</span>
        </div>
        {expanded && hasParams && (
          <div className="fx-row-body">{children}</div>
        )}
      </div>

      {dropPos === 'below' && <div className="fx-drop-indicator" />}
    </div>
  )
}
