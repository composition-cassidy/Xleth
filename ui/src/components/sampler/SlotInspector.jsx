import { Upload, Copy, X, ClipboardPaste, ClipboardCopy } from 'lucide-react'
import SlotMini, { MINI_ORDER } from './SlotMini.jsx'

// ── SlotInspector ───────────────────────────────────────────────────────────
// Everything about the SELECTED slot, split into the two places the mockup puts
// them: an action row under the tab strip, and the 2x3 mini grid beside the
// waveform.
//
// The old SlotList showed both for all eight layers at once — 48 live
// micro-controls on a 700px-wide panel. Showing one layer's six is the whole
// point of having made the slots a tab strip.

// ── Action row ──────────────────────────────────────────────────────────────
// M / S / load / duplicate / copy / paste / remove for the selected slot.
export function SlotActions({
  slot,
  slotIndex,
  slotCount,
  maxSlots,
  busy,
  canPaste,
  onToggleMute,
  onToggleSolo,
  onSwap,
  onDuplicate,
  onCopySettings,
  onPasteSettings,
  onRemove,
}) {
  const isRegionSlot = slotIndex === 0
  const full = slotCount >= maxSlots

  return (
    <div className="slot-actions-row">
      <button
        type="button"
        className={`slot-flag${slot?.mute ? ' is-on' : ''}`}
        onClick={onToggleMute}
        title="Mute this layer"
        aria-pressed={!!slot?.mute}
      >M</button>
      <button
        type="button"
        className={`slot-flag slot-flag--solo${slot?.solo ? ' is-on' : ''}`}
        onClick={onToggleSolo}
        title="Solo this layer"
        aria-pressed={!!slot?.solo}
      >S</button>

      <span className="slot-actions-sep" aria-hidden />

      <button
        type="button"
        className="slot-icon-btn"
        onClick={onSwap}
        disabled={busy}
        title={isRegionSlot
          ? 'Swap the region’s audio (this layer’s settings are kept)'
          : 'Load / swap this layer’s audio'}
        aria-label="Load or swap this layer's audio"
      ><Upload size={12} /></button>
      <button
        type="button"
        className="slot-icon-btn"
        onClick={onDuplicate}
        disabled={busy || full}
        title={full
          ? `All ${maxSlots} slots are in use`
          : 'Duplicate this layer — audio and all its settings'}
        aria-label="Duplicate this layer"
      ><Copy size={12} /></button>

      <span className="slot-actions-sep" aria-hidden />

      {/* Copy/paste moves SETTINGS only — never the audio. See slotClipboard.js. */}
      <button
        type="button"
        className="slot-icon-btn"
        onClick={onCopySettings}
        disabled={busy}
        title="Copy this layer’s settings — tuning, trim, loop, fades, prep and mangle (not its audio)"
        aria-label="Copy this layer's settings"
      ><ClipboardCopy size={12} /></button>
      <button
        type="button"
        className="slot-icon-btn"
        onClick={onPasteSettings}
        disabled={busy || !canPaste}
        title={canPaste
          ? 'Paste settings onto this layer — sample positions are clamped to its length'
          : 'Nothing copied yet'}
        aria-label="Paste settings onto this layer"
      ><ClipboardPaste size={12} /></button>

      <button
        type="button"
        className="slot-icon-btn slot-icon-btn--danger"
        onClick={onRemove}
        // Slot 1 IS the region's sample — it can never be removed.
        disabled={isRegionSlot || busy}
        title={isRegionSlot
          ? 'Slot 1 holds the region’s own sample and cannot be removed'
          : 'Remove this layer'}
        aria-label="Remove this layer"
      ><X size={12} /></button>
    </div>
  )
}

// ── Mini grid ───────────────────────────────────────────────────────────────
// OCT / SEM / FINE over CRS / VOL / PAN, laid out 3-across as in the mockup.
export function SlotMinis({ slot, slotIndex, onPreviewField, onCommitField, disabled }) {
  return (
    <div className="slot-minis-grid">
      {MINI_ORDER.map((f) => (
        <SlotMini
          key={f}
          field={f}
          slotIndex={slotIndex}
          value={Number(slot?.[f] ?? (f === 'volume' ? 1 : 0))}
          onPreview={(field, v) => onPreviewField(slotIndex, field, v)}
          onCommit={(field, v) => onCommitField(slotIndex, field, v)}
          disabled={disabled}
        />
      ))}
    </div>
  )
}
