import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  normalizeTrackColorAssignment,
  isValidTrackCustomColor,
  normalizeTrackCustomColor,
} from './trackColorResolver.js'

export default function TrackColorPopover({
  anchorRect, track, palette,
  onChooseAuto, onChooseSlot, onChooseCustom,
  resolvedTrackColor,
  onClose,
}) {
  const popRef = useRef(null)
  const { mode, slot, customColor } = normalizeTrackColorAssignment(track)

  const top = anchorRect.bottom + 4
  const left = anchorRect.left

  const initDraft = (mode === 'custom' && customColor) ? customColor : (resolvedTrackColor || '#4CC9F0')
  const [draftHex, setDraftHex] = useState(initDraft)

  useEffect(() => {
    setDraftHex(
      (mode === 'custom' && customColor) ? customColor : (resolvedTrackColor || '#4CC9F0')
    )
  }, [mode, customColor, resolvedTrackColor])

  const draftValid = isValidTrackCustomColor(draftHex)
  const colorInputVal = draftValid ? draftHex.toLowerCase() : '#4cc9f0'

  function handleColorChange(e) {
    const hex = e.target.value.toUpperCase()
    setDraftHex(hex)
    if (isValidTrackCustomColor(hex)) onChooseCustom?.(normalizeTrackCustomColor(hex))
  }

  function handleTextChange(e) {
    setDraftHex(e.target.value)
  }

  function handleTextKeyDown(e) {
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

  // Viewport clamp after mount
  useEffect(() => {
    const el = popRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.right > window.innerWidth)   el.style.left = `${window.innerWidth  - rect.width  - 4}px`
    if (rect.bottom > window.innerHeight) el.style.top  = `${window.innerHeight - rect.height - 4}px`
  }, [top, left])

  // Outside click
  useEffect(() => {
    const handler = (e) => {
      if (popRef.current && !popRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  // Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Close on scroll or resize (fixed position detaches from anchor)
  useEffect(() => {
    const close = () => onClose()
    window.addEventListener('resize', close)
    window.addEventListener('wheel', close, { passive: true })
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('wheel', close)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={popRef}
      className="track-color-popover"
      style={{ top, left }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="track-color-popover-title">Track color</div>

      <button
        className={`track-color-auto-option${mode === 'auto' ? ' is-selected' : ''}`}
        onClick={onChooseAuto}
        aria-pressed={mode === 'auto'}
      >
        Auto
      </button>

      <div className="track-color-swatch-grid">
        {palette.map((hex, i) => {
          const slotNum = i + 1
          const selected = mode === 'paletteSlot' && slot === slotNum
          return (
            <button
              key={slotNum}
              className={`track-color-swatch${selected ? ' is-selected' : ''}`}
              style={{ background: hex }}
              onClick={() => onChooseSlot(slotNum)}
              title={`Use track color ${slotNum}`}
              aria-label={`Use track color ${slotNum}`}
              aria-pressed={selected}
            />
          )
        })}
      </div>

      <div className={`track-color-custom-section${mode === 'custom' ? ' is-selected' : ''}`}>
        <div className="track-color-custom-label">Custom</div>
        <div className="track-color-custom-row">
          <input
            type="color"
            className="track-color-custom-input"
            value={colorInputVal}
            onChange={handleColorChange}
            aria-label="Custom track color"
          />
          <input
            type="text"
            className={`track-color-hex-input${draftHex.length > 0 && !draftValid ? ' is-invalid' : ''}`}
            value={draftHex}
            onChange={handleTextChange}
            onKeyDown={handleTextKeyDown}
            onBlur={handleTextBlur}
            aria-label="Custom track color hex"
            placeholder="#RRGGBB"
            maxLength={7}
            spellCheck={false}
          />
        </div>
        {draftHex.length > 0 && !draftValid && (
          <div className="track-color-custom-error" aria-live="polite">
            Use #RRGGBB format
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
