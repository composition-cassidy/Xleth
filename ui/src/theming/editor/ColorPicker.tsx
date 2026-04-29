interface Props {
  value: string   // 6-digit hex
  onChange: (hex: string) => void
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

export default function ColorPicker({ value, onChange }: Props) {
  const hex = toInputHex(value)
  return (
    <div className="color-picker">
      {/* Phase 4: gradient picker replaces this input */}
      <input
        type="color"
        className="color-picker-input"
        value={hex}
        onChange={e => onChange(e.target.value)}
      />
      <span className="color-picker-hex">{hex.toUpperCase()}</span>
    </div>
  )
}
