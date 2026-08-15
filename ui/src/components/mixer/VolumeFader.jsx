import { useCallback, useState } from 'react'
import Fader, { linearToPos, gainFromPos, dbToLinear, formatDB } from '../controls/Fader.jsx'

// VolumeFader — mixer-specific instance of the shared Fader primitive (see
// ui/src/components/controls/Fader.jsx). This file no longer owns any drag
// math or pointer plumbing — that, plus the dB taper (posToDB/dbToLinear/
// linearToPos/formatDB) originally lifted from here, now lives entirely in
// Fader.jsx. All that's left mixer-side is the fixed layout (fills the
// strip's fader column, 22px thick) and the unity detent.
//
// onChange is wired to onLiveChange only, not onCommit — the per-track fader
// has always pushed straight to the store/bridge on every live tick (there
// is no separate release-only commit today), and this preserves that.
export default function VolumeFader({ value, onChange }) {
  return (
    <Fader
      orientation="vertical"
      value={value}
      toNorm={linearToPos}
      fromNorm={gainFromPos}
      defaultValue={1.0}
      detents={[1.0]}
      fill
      thickness={22}
      onLiveChange={onChange}
    />
  )
}

// dB readout — lifted out of the fader body so it sits above the meter/fader
// pair and is never occluded by the thumb at full travel.  Owns its own
// double-click-to-type editing, reusing the same taper helpers as the fader.
export function FaderReadout({ value, onChange }) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState('')

  const handleDoubleClick = useCallback(() => {
    setEditing(true)
    setEditText(formatDB(value))
  }, [value])

  const commitEdit = useCallback(() => {
    const n = parseFloat(editText)
    if (!isNaN(n)) {
      const clamped = Math.max(-96, Math.min(12, n))
      const gain = clamped <= -96 ? 0 : dbToLinear(clamped)
      onChange?.(gain)
    }
    setEditing(false)
  }, [editText, onChange])

  return (
    <div className="mixer-fader-readout">
      {editing ? (
        <input
          autoFocus
          type="text"
          className="mixer-fader-readout-input"
          value={editText}
          onChange={e => setEditText(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={e => {
            if (e.key === 'Enter') commitEdit()
            else if (e.key === 'Escape') setEditing(false)
          }}
          onMouseDown={e => e.stopPropagation()}
        />
      ) : (
        <span
          className="mixer-fader-readout-text"
          onDoubleClick={handleDoubleClick}
          title="Double-click to type dB · Drag the fader · Shift = fine · Ctrl+click = 0dB"
        >
          {formatDB(value)}<span className="mixer-fader-readout-unit">db</span>
        </span>
      )}
    </div>
  )
}
