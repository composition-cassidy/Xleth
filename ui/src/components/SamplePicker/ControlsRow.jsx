import { useState, useRef, useCallback } from 'react'
import { Play, Pause, Plus } from 'lucide-react'
import XlethSelect from '../common/XlethSelect.jsx'

function formatTime(s) {
  if (s === null || !isFinite(s)) return '--'
  const m   = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${String(Math.floor(sec)).padStart(2, '0')}.${String(Math.floor((sec % 1) * 100)).padStart(2, '0')}`
}

/**
 * Props:
 *   playing          – boolean
 *   label            – string
 *   sampleName       – string
 *   currentTime      – number
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
  currentTime,
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

  const canAdd   = inPoint !== null && outPoint !== null
    && Math.abs(outPoint - inPoint) >= 0.01

  const selDuration = (inPoint !== null && outPoint !== null)
    ? Math.abs(outPoint - inPoint)
    : null
  const hasAuditionSelection = selDuration !== null && selDuration >= 0.01

  // ── Custom label ──────────────────────────────────────────────────────────
  const handleSelectChange = useCallback((value) => {
    if (value === '__add_custom__') {
      setAddingCustom(true)
      setCustomLabelDraft('')
      // Focus the inline input on next tick
      setTimeout(() => customInputRef.current?.focus(), 0)
    } else {
      onLabelChange(value)
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
        <span className="picker-time-label">Now</span>
        <span className="picker-time-value">{formatTime(currentTime)}</span>
        <span className="picker-time-sep">·</span>
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
        {duration > 0 && (
          <>
            <span className="picker-time-sep">·</span>
            <span className="picker-time-label">Total</span>
            <span className="picker-time-value">{formatTime(duration)}</span>
          </>
        )}
      </div>

      <div className="picker-controls-row">
        {/* ── Play Selection ─────────────────────────────────────────── */}
        <button
          className={`picker-btn picker-play-btn ${playing ? 'active' : ''}`}
          onClick={onPlaySelection}
          title={playing
            ? 'Pause (Space)'
            : hasAuditionSelection
              ? 'Play Selection (Space)'
              : 'Play from Current Position (Space)'}
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
          <div
            className="picker-label-select-wrap"
            style={{ '--label-color': `var(--theme-label-${label.toLowerCase()}, var(--theme-label-custom))` }}
          >
            <XlethSelect
              value={label}
              options={[
                ...allLabels.map(l => ({ value: l, label: l })),
                { value: '__add_custom__', label: '+ Add Custom...' },
              ]}
              onChange={handleSelectChange}
              ariaLabel="Sample label"
              className="picker-label-select"
            />
          </div>
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
