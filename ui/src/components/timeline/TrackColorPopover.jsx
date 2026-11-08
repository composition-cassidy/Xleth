import { useState, useEffect } from 'react'
import { Menu, MenuItem, MenuSeparator, MenuCustom } from '../../ui-kit'
import {
  normalizeTrackColorAssignment,
  isValidTrackCustomColor,
  normalizeTrackCustomColor,
  TRACK_PALETTE_FALLBACK,
} from './trackColorResolver.js'
import { trackColorName, trackColorSlotLabel } from './trackColorNames.js'
import styles from './TrackColorPopover.module.css'

const COLUMNS = 8

/**
 * The track colour popover (DESIGN.md 22): a kit Menu holding Auto, the 16 identity
 * swatches (each named in the hint bar and in its accessible name) and a custom colour.
 * The selected swatch is outlined, never fill alone. Arrow keys walk the swatches
 * (left and right by one, up and down by a row).
 */
export default function TrackColorPopover({
  anchorRect, track, palette,
  onChooseAuto, onChooseSlot, onChooseCustom,
  resolvedTrackColor,
  onClose,
}) {
  const { mode, slot, customColor } = normalizeTrackColorAssignment(track)

  const initDraft = (mode === 'custom' && customColor) ? customColor : (resolvedTrackColor || TRACK_PALETTE_FALLBACK[0])
  const [draftHex, setDraftHex] = useState(initDraft)

  useEffect(() => {
    setDraftHex(
      (mode === 'custom' && customColor) ? customColor : (resolvedTrackColor || TRACK_PALETTE_FALLBACK[0])
    )
  }, [mode, customColor, resolvedTrackColor])

  const draftValid = isValidTrackCustomColor(draftHex)
  const colorInputVal = draftValid ? draftHex.toLowerCase() : '#4cc9f0'

  function handleColorChange(e) {
    const hex = e.target.value.toUpperCase()
    setDraftHex(hex)
    if (isValidTrackCustomColor(hex)) onChooseCustom?.(normalizeTrackCustomColor(hex))
  }

  function handleTextKeyDown(e) {
    // The menu's own arrow and Home/End handling would take the caret keys; Escape still closes it.
    if (e.key !== 'Escape') e.stopPropagation()
    if (e.key === 'Enter') {
      const normalized = normalizeTrackCustomColor(draftHex)
      if (normalized) onChooseCustom?.(normalized)
    }
  }

  function handleTextBlur() {
    const normalized = normalizeTrackCustomColor(draftHex)
    if (normalized) {
      setDraftHex(normalized)
      onChooseCustom?.(normalized)
    }
  }

  // A fixed-position popover detaches from its anchor when the view moves.
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  function handleGridKeyDown(e) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLUMNS, ArrowDown: COLUMNS }[e.key]
    if (!step) return
    const swatches = Array.from(e.currentTarget.querySelectorAll('button'))
    const at = swatches.indexOf(document.activeElement)
    if (at < 0) return
    const next = at + step
    // Leaving the grid vertically hands over to the menu's own walk (Auto above, Custom below).
    if (next < 0 || next >= swatches.length) { if (Math.abs(step) === 1) e.preventDefault(); return }
    e.preventDefault()
    e.stopPropagation()
    swatches[next].focus()
  }

  return (
    <Menu x={anchorRect.left} y={anchorRect.bottom + 4} onClose={onClose} label="Track color" className={styles.menu}>
      <MenuItem checked={mode === 'auto'} onSelect={onChooseAuto}>Auto</MenuItem>
      <MenuSeparator />
      <MenuCustom>
        <div className={styles.grid} role="group" aria-label="Identity colours" onKeyDown={handleGridKeyDown}>
          {palette.map((hex, i) => {
            const slotNum = i + 1
            const selected = mode === 'paletteSlot' && slot === slotNum
            return (
              <button
                key={slotNum}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                tabIndex={-1}
                className={styles.swatch}
                data-selected={selected ? 'true' : 'false'}
                style={{ '--swatch': hex }}
                onClick={() => onChooseSlot(slotNum)}
                aria-label={`Use track color ${slotNum}: ${trackColorName(hex)}`}
                data-hint={trackColorSlotLabel(slotNum, hex)}
                data-hint-mods={selected ? 'Current colour' : 'Click: use this colour'}
              />
            )
          })}
        </div>
      </MenuCustom>
      <MenuSeparator />
      <MenuCustom>
        <div className={styles.custom} data-selected={mode === 'custom' ? 'true' : 'false'}>
          <span className={styles.customLabel}>Custom</span>
          <div className={styles.customRow}>
            <input
              type="color"
              className={styles.colorInput}
              value={colorInputVal}
              onChange={handleColorChange}
              aria-label="Custom track color"
              data-hint="Pick a custom colour"
            />
            <input
              type="text"
              className={`${styles.hexInput}${draftHex.length > 0 && !draftValid ? ` ${styles.invalid}` : ''}`}
              value={draftHex}
              onChange={(e) => setDraftHex(e.target.value)}
              onKeyDown={handleTextKeyDown}
              onBlur={handleTextBlur}
              aria-label="Custom track color hex"
              aria-invalid={draftHex.length > 0 && !draftValid ? true : undefined}
              placeholder="#RRGGBB"
              maxLength={7}
              spellCheck={false}
              data-hint="Hex colour"
              data-hint-mods="Enter: apply"
            />
          </div>
          {draftHex.length > 0 && !draftValid && (
            <div className={styles.error} role="alert">Use #RRGGBB format</div>
          )}
        </div>
      </MenuCustom>
    </Menu>
  )
}
