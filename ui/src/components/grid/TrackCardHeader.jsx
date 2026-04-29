import { useState, useRef, useCallback } from 'react'

const SUB_UNITS_PER_COLUMN = 8
const SUB_UNITS_PER_ROW    = 8

export default function TrackCardHeader({ track, slot, badges, fetchTracks }) {
  const [editing, setEditing] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const inputRef = useRef(null)

  const startEdit = useCallback(() => {
    setEditing(true)
    setNameInput(track.name)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [track.name])

  const commitEdit = useCallback(async () => {
    setEditing(false)
    const trimmed = nameInput.trim()
    if (trimmed && trimmed !== track.name) {
      await window.xleth?.timeline?.setTrackName(track.id, trimmed)
      fetchTracks()
    }
  }, [nameInput, track.name, track.id, fetchTracks])

  const onKeyDown = useCallback((e) => {
    if (e.key === 'Enter') commitEdit()
    else if (e.key === 'Escape') setEditing(false)
  }, [commitEdit])

  const cellLabel = slot
    ? `cell (${slot.gridX / SUB_UNITS_PER_COLUMN | 0},${slot.gridY / SUB_UNITS_PER_ROW | 0})${
        slot.spanX < SUB_UNITS_PER_COLUMN || slot.spanY < SUB_UNITS_PER_ROW ? ' sub' : ''}`
    : null

  return (
    <div className="grid-tab-track-header">
      <div className="grid-tab-track-header-left">
        {editing ? (
          <input
            ref={inputRef}
            className="grid-tab-track-name-input"
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={onKeyDown}
          />
        ) : (
          <span className="grid-tab-track-name" onDoubleClick={startEdit}>
            {track.name}
          </span>
        )}
        <span className="grid-tab-track-type-badge">{track.type}</span>
      </div>
      <div className="grid-tab-track-header-right">
        {!slot && <span className="grid-tab-track-unassigned">unassigned</span>}
        {slot && cellLabel && (
          <span className="grid-tab-track-unassigned">{cellLabel}</span>
        )}
        {badges.map(b => (
          <span key={b} className="grid-tab-track-pill">{b}</span>
        ))}
      </div>
    </div>
  )
}
