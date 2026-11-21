import styles from './ThemeEditor.module.css'

interface Props {
  value: string   // 6-digit hex
  onChange: (hex: string) => void
  /** Accessible name, e.g. the token being edited. */
  label?: string
}

function toInputHex(v: string): string {
  const t = v.trim()
  if (t.length === 7 && t.startsWith('#')) return t
  if (t.length === 4 && t.startsWith('#')) {
    const [, a, b, c] = t
    return `#${a}${a}${b}${b}${c}${c}`
  }
  return '#888888'
}

export default function ColorPicker({ value, onChange, label = 'Colour' }: Props) {
  const hex = toInputHex(value)
  return (
    <div className={styles.picker}>
      <input
        type="color"
        className={styles.pickerInput}
        value={hex}
        aria-label={label}
        onChange={e => onChange(e.target.value)}
      />
      <span className={styles.pickerHex}>{hex.toUpperCase()}</span>
    </div>
  )
}
