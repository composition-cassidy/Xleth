import { X } from 'lucide-react'
import { labelColor, formatTime } from '../../constants/labels.js'

/**
 * Props:
 *   samples    – Array<{ id, sourceId, startTime, endTime, label, name }>
 *   selectedId – string | null
 *   onSelect   – (sample) => void
 *   onDelete   – (id) => void
 */
export default function MarkedSamplesList({ samples, selectedId, onSelect, onDelete }) {
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
              title={`${sample.label} · ${formatTime(sample.startTime)} – ${formatTime(sample.endTime)}`}
            >
              {/* Label color dot */}
              <span
                className="marked-sample-dot"
                style={{ background: labelColor(sample.label) }}
              />

              {/* Name */}
              <span className="marked-sample-name">{sample.name}</span>

              {/* Swapped badge */}
              {sample.hasSwappedAudio && (
                <span className="marked-sample-swapped-badge">Swapped</span>
              )}

              {/* Time range */}
              <span className="marked-sample-time">
                {formatTime(sample.startTime)}–{formatTime(sample.endTime)}
              </span>

              {/* Duration badge */}
              <span className="marked-sample-dur">{dur.toFixed(2)}s</span>

              {/* Delete */}
              <button
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
