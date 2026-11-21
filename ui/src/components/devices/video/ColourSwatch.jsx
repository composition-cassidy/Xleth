import React, { useEffect, useRef, useState } from 'react'
import styles from './videoDevices.module.css'

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))

export function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

export function hexToRgb(hex) {
  const s = String(hex).replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(s)) return null
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255)
}

/**
 * A colour parameter: a swatch that opens the system colour dialog. While the
 * dialog is open the swatch previews locally; the value is committed ONCE, when
 * the dialog closes (the native `change` event). React's onChange is the
 * per-movement `input` event, which used to send three engine writes (and three
 * undo entries) for every pixel the pointer moved inside the dialog.
 *
 * Props: label (accessible name and visible caption), rgb [r,g,b] 0..1,
 * onCommit([r,g,b]), disabled, hint.
 */
export default function ColourSwatch({ label, rgb, onCommit, disabled = false, hint }) {
  const inputRef = useRef(null)
  const [draft, setDraft] = useState(null)
  const hex = draft ?? rgbToHex(rgb)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  useEffect(() => { setDraft(null) }, [rgb?.[0], rgb?.[1], rgb?.[2]])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return undefined
    const onNativeChange = () => {
      const next = hexToRgb(el.value)
      if (next) commitRef.current?.(next)
    }
    el.addEventListener('change', onNativeChange)
    return () => el.removeEventListener('change', onNativeChange)
  }, [])

  return (
    <label className={styles.swatchCell} data-hint={hint ?? `${label}: ${hex.toUpperCase()}. Click to choose a colour.`}>
      <span className={styles.caption}>{label}</span>
      <span className={styles.swatch} style={{ '--swatch': hex }} aria-hidden="true" />
      <span className={styles.readout}>{hex.toUpperCase()}</span>
      <input
        ref={inputRef}
        className={styles.swatchInput}
        type="color"
        aria-label={label}
        value={hex}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
      />
    </label>
  )
}
