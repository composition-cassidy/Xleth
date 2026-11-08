import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, VolumeX } from 'lucide-react'
import { IconButton, hintAttrs } from '../../ui-kit'
import { slotColorVar } from './samplerFormat.js'
import styles from './Sampler.module.css'

// ── SlotTabs ────────────────────────────────────────────────────────────────
// The sampler's sample slots (layers) as the left part of the panel's 28px header.
// Selecting a tab binds the waveform, trim, loop, prep, process and pitch controls
// to that layer. Each tab carries the slot's identity colour as a 2px top stripe:
// the same colour the waveform is drawn in.
//
// Gestures: click selects · double-click or F2 renames · drop an audio file on a
// tab to swap that layer's audio · drop on the strip background (or "+") to add a
// layer. A silent layer (muted, or not soloed while another is) dims and shows a
// mute glyph, so the state never rests on colour alone.

export const MAX_SLOTS = 8

// A drag carrying files is an audio load; anything else (a modulation route
// drag, a selection) must not make the strip light up as a drop target.
const dragHasFiles = (e) =>
  Array.from(e.dataTransfer?.types || []).includes('Files')

// Extension gate for OS drops. The picker dialog applies its own filter, so
// this only has to cover what can arrive by drag. Kept permissive: the engine
// loader reports a real error for anything it cannot decode.
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

export function slotDisplayName(slot, index) {
  return slot?.name || (index === 0 ? 'Region sample' : `Slot ${index + 1}`)
}

function SlotTab({
  slot, index, selected, audible, busy, renameSignal,
  onSelect, onRename, onDropAudio,
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [dropping, setDropping] = useState(false)
  const inputRef = useRef(null)

  const fallbackName = index === 0 ? 'Region sample' : `Slot ${index + 1}`
  const name = slotDisplayName(slot, index)

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

  // "Rename" from the slot menu targets the selected tab.
  useEffect(() => {
    if (renameSignal && selected) beginRename()
  }, [renameSignal])

  const finishRename = useCallback((accept) => {
    setEditing(false)
    if (!accept) return
    const next = draft.trim()
    // An emptied field clears the override and falls back to the filename,
    // which is what the engine's `name` field already means when it is empty.
    if (next === (slot?.name || '')) return
    onRename(index, next)
  }, [draft, index, onRename, slot])

  const path = slot?.audioFilePath || ''
  return (
    <div
      className={styles.slotTab}
      style={{ '--slot-color': slotColorVar(index) }}
      data-selected={selected || undefined}
      data-silent={audible ? undefined : 'true'}
      data-drop={dropping || undefined}
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
        const p = firstAudioPathFrom(e.dataTransfer)
        if (p) onDropAudio(index, p)
      }}
      role="tab"
      aria-selected={selected}
      aria-label={`Slot ${index + 1}: ${name}${audible ? '' : ' (silent)'}`}
      tabIndex={selected ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === 'F2') { e.preventDefault(); beginRename() }
      }}
      {...hintAttrs({
        hint: editing ? undefined : `Slot ${index + 1}: ${name}${path ? ` (${path})` : ''}`,
        hintMods: 'Double-click or F2: rename · Drop an audio file: replace this slot',
      })}
    >
      <span className={styles.slotIndex}>{index + 1}</span>
      {editing ? (
        <input
          ref={inputRef}
          className={styles.textInput}
          value={draft}
          placeholder={fallbackName}
          aria-label={`Slot ${index + 1} name`}
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
        <span className={styles.slotName}>{name}</span>
      )}
      {audible ? null : <VolumeX className={styles.slotSilent} size={12} aria-hidden="true" />}
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
  renameSignal = 0,
  busy,
}) {
  const [stripDropping, setStripDropping] = useState(false)
  const count = slots.length
  const canAdd = count < MAX_SLOTS && !busy
  const anySolo = slots.some((s) => s?.solo)

  return (
    <div
      className={styles.slotStrip}
      data-drop={stripDropping || undefined}
      role="tablist"
      aria-label="Sample slots"
      // A drop on the strip BACKGROUND (not on a tab) adds a new layer rather
      // than replacing one: the same distinction the "+" button makes.
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
        const p = firstAudioPathFrom(e.dataTransfer)
        if (p) onAddSlotFromPath(p)
      }}
    >
      {slots.map((slot, i) => (
        <SlotTab
          key={i}
          slot={slot}
          index={i}
          selected={i === selectedSlot}
          // A slot is audible unless muted, or unless something else is soloed.
          audible={anySolo ? !!slot?.solo : !slot?.mute}
          busy={busy}
          renameSignal={renameSignal}
          onSelect={onSelectSlot}
          onRename={onRenameSlot}
          onDropAudio={onDropSlotAudio}
        />
      ))}
      <IconButton
        size="sm"
        className={styles.slotAdd}
        label="Add a sample slot"
        onClick={onAddSlot}
        disabled={!canAdd}
        hint={canAdd
          ? 'Add a sample slot (a layer). Or drop an audio file on this strip.'
          : `All ${MAX_SLOTS} slots are in use`}
      >
        <Plus aria-hidden="true" />
      </IconButton>
      <span className={styles.slotCount} data-hint="Slots in use">{count}/{MAX_SLOTS}</span>
    </div>
  )
}
