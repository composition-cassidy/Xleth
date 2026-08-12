import { useCallback, useRef, useState } from 'react'
import { Plus, X, Upload } from 'lucide-react'

// ── SlotList ────────────────────────────────────────────────────────────────
// The sampler's 8 sample slots. Slot 1 always plays the region's own audio
// (loaded/swapped through the normal region-audio path); slots 2-8 carry their
// own file. Selecting a row binds the Sample tab's waveform/trim/loop editor
// to that slot.
//
// Every mini control follows the panel rule for continuous values: drag paints
// a LOCAL preview only, and a single commit fires on mouseup. Nothing touches
// IPC while the pointer is down.

export const MAX_SLOTS = 8

// Per-control drag config: [min, max, step-per-pixel, integer?]
const DRAG_SPECS = {
  octave:   { min: -4,   max: 4,   perPx: 0.05,  int: true,  label: 'OCT'  },
  semitone: { min: -12,  max: 12,  perPx: 0.12,  int: true,  label: 'SEM'  },
  fine:     { min: -100, max: 100, perPx: 1.0,   int: false, label: 'FINE' },
  coarse:   { min: -48,  max: 48,  perPx: 0.25,  int: true,  label: 'CRS'  },
  volume:   { min: 0,    max: 2,   perPx: 0.01,  int: false, label: 'VOL'  },
  pan:      { min: -1,   max: 1,   perPx: 0.01,  int: false, label: 'PAN'  },
}

function formatValue(field, v) {
  if (field === 'volume') return v.toFixed(2)
  if (field === 'pan') {
    if (Math.abs(v) < 0.005) return 'C'
    return (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100)
  }
  if (field === 'fine') return (v > 0 ? '+' : '') + v.toFixed(0)
  return (v > 0 ? '+' : '') + String(v)
}

// A compact drag field. Local preview while dragging; one commit on release.
function MiniDrag({ field, value, onPreview, onCommit, disabled }) {
  const spec = DRAG_SPECS[field]
  const [dragging, setDragging] = useState(false)
  const stateRef = useRef({ startY: 0, startVal: 0, latest: 0 })

  const clamp = useCallback((v) => {
    const c = Math.min(spec.max, Math.max(spec.min, v))
    return spec.int ? Math.round(c) : c
  }, [spec])

  const onPointerDown = useCallback((e) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    stateRef.current = { startY: e.clientY, startVal: value, latest: value }
    setDragging(true)
  }, [disabled, value])

  const onPointerMove = useCallback((e) => {
    if (!dragging) return
    // Up = increase. Shift = fine (1/8 speed).
    const dy = stateRef.current.startY - e.clientY
    const scale = e.shiftKey ? spec.perPx / 8 : spec.perPx
    const next = clamp(stateRef.current.startVal + dy * scale)
    stateRef.current.latest = next
    onPreview(field, next)          // LOCAL only — no IPC during drag
  }, [dragging, clamp, spec, onPreview, field])

  const endDrag = useCallback((e) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    setDragging(false)
    onCommit(field, stateRef.current.latest)   // single commit on release
  }, [dragging, onCommit, field])

  // Double-click resets to the neutral value.
  const onDoubleClick = useCallback((e) => {
    if (disabled) return
    e.preventDefault()
    e.stopPropagation()
    const neutral = field === 'volume' ? 1 : 0
    onCommit(field, neutral)
  }, [disabled, field, onCommit])

  const nonNeutral = field === 'volume'
    ? Math.abs(value - 1) > 0.005
    : Math.abs(value) > (spec.int ? 0.5 : 0.005)

  return (
    <div
      className={`slot-mini${dragging ? ' is-dragging' : ''}${nonNeutral ? ' is-active' : ''}${disabled ? ' is-disabled' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={onDoubleClick}
      title={`${spec.label} — drag to adjust, shift for fine, double-click to reset`}
      role="slider"
      aria-label={spec.label}
      aria-valuenow={value}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={disabled ? -1 : 0}
    >
      <span className="slot-mini-label">{spec.label}</span>
      <span className="slot-mini-value">{formatValue(field, value)}</span>
    </div>
  )
}

export default function SlotList({
  slots,
  selectedSlot,
  onSelectSlot,
  onPreviewSlotField,
  onCommitSlotField,
  onToggleMute,
  onToggleSolo,
  onAddSlot,
  onSwapSlot,
  onRemoveSlot,
  busy,
}) {
  const count = slots.length
  const canAdd = count < MAX_SLOTS && !busy
  const anySolo = slots.some((s) => s?.solo)

  return (
    <div className="slot-list">
      <div className="slot-list-header">
        <span className="slot-list-title">Slots</span>
        <span className="slot-list-count">{count} / {MAX_SLOTS}</span>
        <button
          type="button"
          className="slot-add-btn"
          onClick={onAddSlot}
          disabled={!canAdd}
          title={canAdd ? 'Add a sample layer' : 'All 8 slots are in use'}
        >
          <Plus size={12} />
          <span>Add</span>
        </button>
      </div>

      <div className="slot-rows">
        {slots.map((slot, i) => {
          const isSel = i === selectedSlot
          // A slot is audible unless muted, or unless something else is solo'd.
          const audible = anySolo ? !!slot.solo : !slot.mute
          const name = slot.name || (i === 0 ? 'Region sample' : 'Empty')
          return (
            <div
              key={i}
              className={`slot-row${isSel ? ' is-selected' : ''}${audible ? '' : ' is-silent'}`}
              onPointerDown={() => onSelectSlot(i)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectSlot(i) }
              }}
              aria-pressed={isSel}
            >
              <span className="slot-index">{i + 1}</span>

              <span className="slot-name" title={slot.audioFilePath || name}>{name}</span>

              <div className="slot-actions">
                <button
                  type="button"
                  className={`slot-flag${slot.mute ? ' is-on' : ''}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onToggleMute(i) }}
                  title="Mute this layer"
                  aria-pressed={!!slot.mute}
                >M</button>
                <button
                  type="button"
                  className={`slot-flag slot-flag--solo${slot.solo ? ' is-on' : ''}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onToggleSolo(i) }}
                  title="Solo this layer"
                  aria-pressed={!!slot.solo}
                >S</button>
                <button
                  type="button"
                  className="slot-icon-btn"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onSwapSlot(i) }}
                  disabled={busy}
                  title={i === 0
                    ? 'Swap the region’s audio (slot 1 settings are kept)'
                    : 'Load / swap this layer’s audio'}
                >
                  <Upload size={11} />
                </button>
                <button
                  type="button"
                  className="slot-icon-btn slot-icon-btn--danger"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); onRemoveSlot(i) }}
                  // Slot 1 IS the region's sample — it can never be removed.
                  disabled={i === 0 || busy}
                  title={i === 0
                    ? 'Slot 1 holds the region’s own sample and cannot be removed'
                    : 'Remove this layer'}
                >
                  <X size={11} />
                </button>
              </div>

              <div className="slot-minis">
                {['octave', 'semitone', 'fine', 'coarse', 'volume', 'pan'].map((f) => (
                  <MiniDrag
                    key={f}
                    field={f}
                    value={Number(slot[f] ?? (f === 'volume' ? 1 : 0))}
                    onPreview={(field, v) => onPreviewSlotField(i, field, v)}
                    onCommit={(field, v) => onCommitSlotField(i, field, v)}
                    disabled={busy}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
