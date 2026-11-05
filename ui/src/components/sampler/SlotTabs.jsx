import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'

// ── SlotTabs ────────────────────────────────────────────────────────────────
// The sampler's 8 sample slots as a TAB STRIP, per art/new sampler design.png.
//
// This replaces the old SlotList, which rendered all 8 slots as a vertical
// table of ~58px rows — 8 layers came to ~490px of a 545px content area, so a
// full slot list pushed the waveform and everything under it off the bottom of
// a panel that is deliberately `resizable: false`. A strip costs one row
// whatever the slot count, which is what makes the rest of the layout fit.
//
// Selecting a tab binds the waveform / trim / loop / prep / mangle editor to
// that layer. Per-slot tuning and level move to the SlotInspector beside the
// waveform, where they are shown for the SELECTED slot only rather than all
// eight at once.

export const MAX_SLOTS = 8

// A drag carrying files is an audio load; anything else (a modulation route
// drag, a selection) must not make the strip light up as a drop target.
const dragHasFiles = (e) =>
  Array.from(e.dataTransfer?.types || []).includes('Files')

// Extension gate for OS drops. The picker dialog applies its own filter, so
// this only has to cover what can arrive by drag. Kept permissive — the engine
// loader reports a real error for anything it cannot decode, which is a better
// message than a silent refusal to accept the drop.
const AUDIO_EXT = /\.(wav|wave|aif|aiff|aifc|flac|mp3|ogg|opus|m4a|aac|wma)$/i

export function firstAudioPathFrom(dataTransfer) {
  const files = Array.from(dataTransfer?.files || [])
  for (const f of files) {
    // Electron exposes the real filesystem path on dropped File objects; a
    // drop from inside a browser context has none and cannot be loaded.
    const p = f?.path
    if (typeof p === 'string' && p && AUDIO_EXT.test(p)) return p
  }
  return null
}

function SlotTab({
  slot, index, selected, audible, busy,
  onSelect, onRename, onDropAudio,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [dropping, setDropping] = useState(false)
  const inputRef = useRef(null)

  const fallbackName = index === 0 ? 'Region sample' : `Slot ${index + 1}`
  const name = slot?.name || fallbackName

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const beginRename = useCallback(() => {
    setDraft(slot?.name || '')
    setEditing(true)
  }, [slot])

  const finishRename = useCallback((accept) => {
    setEditing(false)
    if (!accept) return
    const next = draft.trim()
    // An emptied field clears the override and falls back to the filename,
    // which is what the engine's `name` field already means when it is empty.
    if (next === (slot?.name || '')) return
    onRename(index, next)
  }, [draft, index, onRename, slot])

  return (
    <div
      className={[
        'slot-tab',
        selected ? 'is-selected' : '',
        audible ? '' : 'is-silent',
        dropping ? 'is-drop-target' : '',
      ].filter(Boolean).join(' ')}
      onPointerDown={() => { if (!editing) onSelect(index) }}
      onDoubleClick={(e) => { e.preventDefault(); beginRename() }}
      onDragOver={(e) => {
        if (!dragHasFiles(e) || busy) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!dragHasFiles(e) || busy) return
        e.preventDefault()
        e.stopPropagation()
        setDropping(false)
        const path = firstAudioPathFrom(e.dataTransfer)
        if (path) onDropAudio(index, path)
      }}
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === 'F2') { e.preventDefault(); beginRename() }
      }}
      title={editing ? undefined : `${name}${slot?.audioFilePath ? `\n${slot.audioFilePath}` : ''}\nDouble-click or F2 to rename · drop an audio file to load`}
    >
      <span className="slot-tab-index">{index + 1}</span>
      {editing ? (
        <input
          ref={inputRef}
          className="slot-tab-rename"
          value={draft}
          placeholder={fallbackName}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') { e.preventDefault(); finishRename(true) }
            else if (e.key === 'Escape') { e.preventDefault(); finishRename(false) }
          }}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="slot-tab-name">{name}</span>
      )}
      {!audible && <span className="slot-tab-silent" aria-label="silent" />}
    </div>
  )
}

export default function SlotTabs({
  slots,
  selectedSlot,
  onSelectSlot,
  onAddSlot,
  onAddSlotFromPath,
  onDropSlotAudio,
  onRenameSlot,
  busy,
}) {
  const [stripDropping, setStripDropping] = useState(false)
  const count = slots.length
  const canAdd = count < MAX_SLOTS && !busy
  const anySolo = slots.some((s) => s?.solo)

  return (
    <div
      className={`slot-tabs${stripDropping ? ' is-drop-target' : ''}`}
      role="tablist"
      aria-label="Sample slots"
      // A drop on the strip BACKGROUND (not on a tab) adds a new layer rather
      // than replacing one — the same distinction the "+" button makes.
      onDragOver={(e) => {
        if (!dragHasFiles(e) || !canAdd) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setStripDropping(true)
      }}
      onDragLeave={() => setStripDropping(false)}
      onDrop={(e) => {
        if (!dragHasFiles(e) || !canAdd) return
        e.preventDefault()
        setStripDropping(false)
        const path = firstAudioPathFrom(e.dataTransfer)
        if (path) onAddSlotFromPath(path)
      }}
    >
      {slots.map((slot, i) => (
        <SlotTab
          key={i}
          slot={slot}
          index={i}
          selected={i === selectedSlot}
          // A slot is audible unless muted, or unless something else is solo'd.
          audible={anySolo ? !!slot?.solo : !slot?.mute}
          busy={busy}
          onSelect={onSelectSlot}
          onRename={onRenameSlot}
          onDropAudio={onDropSlotAudio}
        />
      ))}
      <button
        type="button"
        className="slot-tab-add"
        onClick={onAddSlot}
        disabled={!canAdd}
        title={canAdd
          ? 'Add a sample layer — or drop an audio file here'
          : `All ${MAX_SLOTS} slots are in use`}
        aria-label="Add a sample layer"
      >
        <Plus size={13} />
      </button>
      <span className="slot-tabs-count">{count}/{MAX_SLOTS}</span>
    </div>
  )
}
