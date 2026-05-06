import { useState } from 'react'
import { MousePointer2, Pencil, Scissors, Eraser, ZoomIn, ZoomOut, Sliders, ExternalLink, ArrowDownToLine, Waves } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'

const TOOLS = [
  { id: 'select', icon: MousePointer2, label: 'Select (S)' },
  { id: 'pencil', icon: Pencil,        label: 'Pencil (P)' },
  { id: 'split',  icon: Scissors,      label: 'Split (C)' },
  { id: 'delete', icon: Eraser,        label: 'Delete (D)' },
]

const NOTE_LENGTHS = [
  { ticks: 960, label: '1/4'  },
  { ticks: 480, label: '1/8'  },
  { ticks: 240, label: '1/16' },
  { ticks: 120, label: '1/32' },
]

const NEW_PATTERN_VALUE = '__new__'

export default function PianoRollToolbar({
  patternName,
  activeTool, onToolChange,
  slideMode = false, onSlideModeChange,
  stickyNoteLength, onStickyNoteLengthChange,
  onZoomIn, onZoomOut,
  onOpenSamplerSettings,
  onClose,
  // Detach / float props
  floating = false, onDetach, onDock,
  // Pattern selector props
  availablePatterns, currentPatternId, onSwitchPattern, onNewPattern,
  // Region selector props
  regions, currentRegionId, onRegionChange,
}) {
  const hasPatternDropdown = Array.isArray(availablePatterns) && availablePatterns.length > 0

  const [editingTitle, setEditingTitle] = useState(false)
  const [titleInput, setTitleInput] = useState('')

  const startEditTitle = () => {
    if (currentPatternId == null) return
    setTitleInput(patternName || '')
    setEditingTitle(true)
  }
  const commitTitle = async () => {
    setEditingTitle(false)
    const name = titleInput.trim()
    if (!name || name === patternName || currentPatternId == null) return
    try { await window.xleth?.timeline?.setPatternName?.(currentPatternId, name) }
    catch (e) { console.warn('[PianoRollToolbar] setPatternName failed', e) }
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
  }

  const handlePatternChange = (e) => {
    const val = e.target.value
    if (val === NEW_PATTERN_VALUE) {
      onNewPattern?.()
      return
    }
    const id = Number(val)
    if (!Number.isNaN(id)) onSwitchPattern?.(id)
  }

  return (
    <div className="piano-roll-toolbar">
      <div className="piano-roll-toolbar-group piano-roll-toolbar-title-wrap">
        {!floating && (editingTitle ? (
          <input
            autoFocus
            className="piano-roll-toolbar-title-input"
            value={titleInput}
            onChange={(e) => setTitleInput(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              else if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="piano-roll-toolbar-title"
            onDoubleClick={startEditTitle}
            title="Double-click to rename"
          >{patternName || 'Pattern'}</span>
        ))}
        {hasPatternDropdown && (
          <select
            className="piano-roll-pattern-select"
            value={currentPatternId ?? ''}
            onChange={handlePatternChange}
            title="Pattern"
          >
            {availablePatterns.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value={NEW_PATTERN_VALUE}>+ New Pattern</option>
          </select>
        )}
      </div>
      {Array.isArray(regions) && regions.length > 0 && (
        <div className="piano-roll-toolbar-group">
          <select
            className="piano-roll-region-select"
            value={currentRegionId ?? ''}
            onChange={(e) => onRegionChange?.(Number(e.target.value))}
            title="Sample region"
          >
            {regions.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      )}
      <div className="piano-roll-toolbar-group">
        {TOOLS.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              className={`timeline-toolbar-button ${activeTool === t.id ? 'active' : ''}`}
              title={t.label}
              onClick={() => onToolChange(t.id)}
            >
              <Icon size={14} />
            </button>
          )
        })}
      </div>
      <div className="piano-roll-toolbar-group">
        <button
          className={`timeline-toolbar-button ${slideMode ? 'active' : ''}`}
          title="Slide Note — new notes will be drawn as slide notes"
          onClick={() => onSlideModeChange?.(!slideMode)}
        >
          <Waves size={14} />
        </button>
      </div>
      <div className="piano-roll-toolbar-group">
        <select
          className="piano-roll-note-length"
          value={stickyNoteLength}
          onChange={(e) => onStickyNoteLengthChange(Number(e.target.value))}
          title="Note length"
        >
          {NOTE_LENGTHS.map((n) => (
            <option key={n.ticks} value={n.ticks}>{n.label}</option>
          ))}
        </select>
      </div>
      <div className="piano-roll-toolbar-group">
        <button
          className="timeline-toolbar-button"
          title="Sampler Settings"
          onClick={onOpenSamplerSettings}
        >
          <Sliders size={14} />
        </button>
      </div>
      <div className="piano-roll-toolbar-group">
        <button className="timeline-toolbar-button" title="Zoom out" onClick={onZoomOut}>
          <ZoomOut size={14} />
        </button>
        <button className="timeline-toolbar-button" title="Zoom in" onClick={onZoomIn}>
          <ZoomIn size={14} />
        </button>
      </div>
      <div className="piano-roll-toolbar-group" style={{ marginLeft: 'auto' }}>
        {floating ? (
          <button className="timeline-toolbar-button" title="Dock" onClick={onDock}>
            <ArrowDownToLine size={14} />
          </button>
        ) : (
          onDetach && (
            <button className="timeline-toolbar-button" title="Detach (float)" onClick={onDetach}>
              <ExternalLink size={14} />
            </button>
          )
        )}
        <button className="timeline-toolbar-button" title={floating ? 'Close' : 'Back to Timeline'} onClick={onClose}>
          ✕
        </button>
      </div>
    </div>
  )
}
