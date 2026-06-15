import { Scissors, X } from 'lucide-react'
import { labelColor, formatTime } from '../../constants/labels.js'

/**
 * Props:
 *   samples    – Array<{ id, sourceId, startTime, endTime, label, name }>
 *   selectedId – string | null
 *   onSelect   – (sample) => void
 *   onDelete   – (id) => void
 *   onSplit    – (sample) => void  — opens the Split Syllables panel (Quote rows)
 */
export default function MarkedSamplesList({ samples, selectedId, onSelect, onDelete, onSplit }) {
  return (
    <div className="marked-samples-list">
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="tab-placeholder-header">
        <span className="tab-section-label">Marked Samples</span>
        <span className="picker-samples-count">{samples.length}</span>
      </div>

      {/* ── Empty state ──────────────────────────────────────────────── */}
      {samples.length === 0 && (
        <div className="picker-samples-empty">
          <p>No samples marked yet</p>
          <p className="tab-placeholder-hint">Set In / Out points then click Add Sample</p>
        </div>
      )}

      {/* ── Sample rows ──────────────────────────────────────────────── */}
      <div className="marked-samples-rows">
        {samples.map(sample => {
          const dur = Math.abs(sample.endTime - sample.startTime)
          return (
            <div
              key={sample.id}
              className={`marked-sample-item ${sample.id === selectedId ? 'selected' : ''}`}
              onClick={() => onSelect(sample)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(sample)
                }
              }}
              role="button"
              tabIndex={0}
              aria-pressed={sample.id === selectedId}
              title={`${sample.label} · ${formatTime(sample.startTime)} – ${formatTime(sample.endTime)}`}
            >
              {/* Label color dot */}
              <span
                className="marked-sample-dot"
                style={{ background: labelColor(sample.label) }}
              />

              <span className="marked-sample-main">
                <span className="marked-sample-name">{sample.name}</span>
                <span className="marked-sample-time">
                  {formatTime(sample.startTime)}-{formatTime(sample.endTime)}
                </span>
              </span>

              {/* Swapped badge */}
              {sample.hasSwappedAudio && (
                <span className="marked-sample-swapped-badge">Swapped</span>
              )}

              {/* Duration badge */}
              <span className="marked-sample-dur">{dur.toFixed(2)}s</span>

              {/* Split syllables (Quote regions only) */}
              {onSplit && sample.label === 'Quote' && (
                <button
                  type="button"
                  className="marked-sample-split"
                  onClick={e => { e.stopPropagation(); onSplit(sample) }}
                  title="Split syllables"
                >
                  <Scissors size={11} />
                </button>
              )}

              {/* Delete */}
              <button
                type="button"
                className="marked-sample-delete"
                onClick={e => { e.stopPropagation(); onDelete(sample.id) }}
                title="Remove sample"
              >
                <X size={11} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
