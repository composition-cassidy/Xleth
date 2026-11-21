import { useState } from 'react'
import { Button, Dialog, SegmentedControl, Slider } from '../ui-kit'
import ColourSwatch, { hexToRgb, rgbToHex } from './devices/video/ColourSwatch.jsx'
import styles from './GeneratedMediaDialog.module.css'

const KINDS = [
  { value: 'solid', label: 'Solid colour', hint: 'One flat colour filling the frame.' },
  { value: 'gradient', label: 'Gradient', hint: 'A blend between two colours.' },
]

const DIRECTIONS = [
  { value: 'horizontal', label: 'Left to right' },
  { value: 'vertical', label: 'Top to bottom' },
  { value: 'diagonal', label: 'Diagonal' },
  { value: 'radial', label: 'Radial' },
]

// #rrggbb + opacity 0..100 -> #rrggbbaa (what still-media.js parses).
const withAlpha = (hex, opacity) => hex + Math.round(opacity * 2.55).toString(16).padStart(2, '0')
const formatPercent = (v) => `${Math.round(v)}%`

// CSS twin of the BMP the main process draws (still-media.js renderGenerated).
// CSS blends gradients premultiplied too, so a fade to transparent matches.
function previewBackground({ kind, color, from, to, direction }) {
  if (kind === 'solid') return color
  if (direction === 'radial') return `radial-gradient(circle farthest-side, ${from}, ${to})`
  const angle = { horizontal: '90deg', vertical: '180deg', diagonal: '135deg' }[direction]
  return `linear-gradient(${angle}, ${from}, ${to})`
}

/**
 * New solid colour or gradient source. `onCreate(spec)` gets
 * { kind, color } or { kind, from, to, direction } with #rrggbb colours.
 */
export default function GeneratedMediaDialog({ onCreate, onClose, busy = false }) {
  const [kind, setKind] = useState('solid')
  // Each colour is { hex: '#rrggbb', opacity: 0..100 }.
  const [color, setColor] = useState({ hex: '#000000', opacity: 100 })
  const [from, setFrom] = useState({ hex: '#000000', opacity: 100 })
  const [to, setTo] = useState({ hex: '#ffffff', opacity: 100 })
  const [direction, setDirection] = useState('horizontal')
  const rgba = (c) => withAlpha(c.hex, c.opacity)
  const spec = kind === 'solid'
    ? { kind, color: rgba(color) }
    : { kind, from: rgba(from), to: rgba(to), direction }
  const swatch = (label, c, set) => (
    <div className={styles.colour}>
      <ColourSwatch label={label} rgb={hexToRgb(c.hex)} onCommit={(rgb) => set({ ...c, hex: rgbToHex(rgb) })} disabled={busy} />
      <Slider
        label={`${label} opacity`} min={0} max={100} defaultValue={100} step={1}
        value={c.opacity} format={formatPercent} disabled={busy}
        onChange={(v) => set({ ...c, opacity: v })} onCommit={(v) => set({ ...c, opacity: v })}
        hint={`${label} opacity: 0% is fully transparent`}
      />
      <span className={styles.readout}>{formatPercent(c.opacity)}</span>
    </div>
  )

  return (
    <Dialog
      title="New colour source"
      width="sm"
      onClose={busy ? undefined : onClose}
      onEnter={() => !busy && onCreate(spec)}
      actions={
        <>
          <Button size="lg" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="lg" variant="primary" onClick={() => onCreate(spec)} disabled={busy} data-autofocus>
            {busy ? 'Adding…' : 'Add to project'}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <SegmentedControl size="sm" label="Kind" options={KINDS} value={kind} onChange={setKind} />
        <div className={styles.preview} aria-hidden="true">
          <div className={styles.previewFill} style={{ background: previewBackground(spec) }} />
        </div>
        <div className={styles.swatches}>
          {kind === 'solid'
            ? swatch('Colour', color, setColor)
            : <>{swatch('From', from, setFrom)}{swatch('To', to, setTo)}</>}
        </div>
        {kind === 'gradient' && (
          <SegmentedControl size="sm" label="Direction" options={DIRECTIONS} value={direction} onChange={setDirection} />
        )}
      </div>
    </Dialog>
  )
}
