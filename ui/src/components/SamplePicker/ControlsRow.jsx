import { useState, useRef, useCallback } from 'react'
import { Play, Pause, Plus } from 'lucide-react'

function formatTime(s) {
  if (s === null || !isFinite(s)) return '—'
  const m   = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(Math.floor(sec)).padStart(2, '0')}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}`
}

/**
 * Props:
 *   playing          – boolean
 *   label            – string
 *   sampleName       – string
 *   inPoint          – number | null
 *   outPoint         – number | null
 *   duration         – number
 *   allLabels        – string[]  (default + custom)
 *   onPlaySelection  – () => void
 *   onSetIn          – () => void
 *   onSetOut         – () => void
 *   onLabelChange    – (label: string) => void
 *   onNameChange     – (name: string) => void
 *   onAddSample      – () => void
 *   onAddCustomLabel – (name: string) => void
 */
export default function ControlsRow({
  playing,
  label,
  sampleName,
  inPoint,
  outPoint,
  duration,
  allLabels,
  onPlaySelection,
  onSetIn,
  onSetOut,
  onLabelChange,
  onNameChange,
  onAddSample,
  onAddCustomLabel,
}) {
  const [addingCustom,    setAddingCustom]    = useState(false)
  const [customLabelDraft, setCustomLabelDraft] = useState('')
  const customInputRef = useRef(null)

  const canPlay  = inPoint !== null && outPoint !== null
  const canAdd   = inPoint !== null && outPoint !== null
    && Math.abs(outPoint - inPoint) >= 0.01

  const selDuration = (inPoint !== null && outPoint !== null)
    ? Math.abs(outPoint - inPoint)
    : null

  // ── Custom label ──────────────────────────────────────────────────────────
  const handleSelectChange = useCallback((e) => {
    const val = e.target.value
    if (val === '__add_custom__') {
      setAddingCustom(true)
      setCustomLabelDraft('')
      // Focus the inline input on next tick
      setTimeout(() => customInputRef.current?.focus(), 0)
    } else {
      onLabelChange(val)
    }
  }, [onLabelChange])

  const commitCustomLabel = useCallback(() => {
    const trimmed = customLabelDraft.trim()
    if (trimmed) {
      onAddCustomLabel(trimmed)
    }
    setAddingCustom(false)
    setCustomLabelDraft('')
  }, [customLabelDraft, onAddCustomLabel])

  const handleCustomKeyDown = useCallback((e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitCustomLabel() }
    if (e.key === 'Escape') { setAddingCustom(false); setCustomLabelDraft('') }
    e.stopPropagation()  // prevent picker-level shortcuts
  }, [commitCustomLabel])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="picker-controls">
      {/* ── Time display ─────────────────────────────────────────────── */}
      <div className="picker-time-display">
        <span className="picker-time-label">In</span>
        <span className="picker-time-value">{formatTime(inPoint)}</span>
        <span className="picker-time-sep">·</span>
        <span className="picker-time-label">Out</span>
        <span className="picker-time-value">{formatTime(outPoint)}</span>
        {selDuration !== null && (
          <>
            <span className="picker-time-sep">·</span>
            <span className="picker-time-label">Dur</span>
            <span className="picker-time-value">{selDuration.toFixed(2)}s</span>
          </>
        )}
      </div>

      <div className="picker-controls-row">
        {/* ── Play Selection ─────────────────────────────────────────── */}
        <button
          className={`picker-btn picker-play-btn ${playing ? 'active' : ''}`}
          onClick={onPlaySelection}
          title={playing ? 'Pause (Space)' : 'Play Selection (Space)'}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>

        {/* ── Set In ───────────────────────────────────────────────── */}
        <button
          className="picker-btn picker-set-btn"
          onClick={onSetIn}
          title="Set In point (I)"
        >
          <span>Set In</span>
          <kbd>I</kbd>
        </button>

        {/* ── Set Out ──────────────────────────────────────────────── */}
        <button
          className="picker-btn picker-set-btn"
          onClick={onSetOut}
          title="Set Out point (O)"
        >
          <span>Set Out</span>
          <kbd>O</kbd>
        </button>

        <div className="picker-controls-divider" />

        {/* ── Label dropdown or custom input ───────────────────────── */}
        {addingCustom ? (
          <input
            ref={customInputRef}
            className="picker-custom-label-input"
            placeholder="Label name…"
            value={customLabelDraft}
            onChange={e => setCustomLabelDraft(e.target.value)}
            onKeyDown={handleCustomKeyDown}
            onBlur={commitCustomLabel}
            maxLength={24}
          />
        ) : (
          <select
            className="picker-label-select"
            value={label}
            onChange={handleSelectChange}
            style={{ '--label-color': `var(--label-${label.toLowerCase()}, var(--label-custom))` }}
          >
            {allLabels.map(l => (
              <option key={l} value={l}>{l}</option>
            ))}
            <option value="__add_custom__">+ Add Custom…</option>
          </select>
        )}

        {/* ── Sample name ──────────────────────────────────────────── */}
        <input
          className="picker-name-input"
          type="text"
          value={sampleName}
          onChange={e => onNameChange(e.target.value)}
          onKeyDown={e => e.stopPropagation()}  // prevent I/O shortcuts
          placeholder="Sample name…"
          maxLength={48}
        />

        {/* ── Add Sample ───────────────────────────────────────────── */}
        <button
          className="picker-btn picker-add-btn"
          onClick={onAddSample}
          disabled={!canAdd}
          title="Add sample to project"
        >
          <Plus size={13} />
          <span>Add Sample</span>
        </button>
      </div>
    </div>
  )
}
