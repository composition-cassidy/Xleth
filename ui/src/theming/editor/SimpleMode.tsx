interface KnobDef {
  token: string
  label: string
  hint: string
}

const KNOBS: KnobDef[] = [
  { token: '--theme-bg-primary', label: 'Background',  hint: 'Main app background' },
  { token: '--theme-bg-surface', label: 'Surface',     hint: 'Panels and cards' },
  { token: '--theme-accent',     label: 'Accent',      hint: 'Highlights and interactive elements' },
  { token: '--theme-text',       label: 'Text',        hint: 'Primary text color' },
  { token: '--theme-danger',     label: 'Danger',      hint: 'Destructive actions and errors' },
]

interface Props {
  tokens: Record<string, string>
  onTokenChange: (name: string, value: string) => void
}

export default function SimpleMode({ tokens, onTokenChange }: Props) {
  return (
    <div className="simple-mode">
      <div className="simple-mode-header">Quick Customize</div>
      <div className="simple-mode-knobs">
        {KNOBS.map(k => {
          const raw = tokens[k.token] ?? '#888888'
          // Normalize to 6-digit hex for <input type="color">
          const hex = raw.startsWith('#') && (raw.length === 7 || raw.length === 4)
            ? raw
            : '#888888'
          return (
            <div key={k.token} className="simple-mode-knob">
              <label className="simple-mode-knob-label" title={k.hint}>
                {k.label}
              </label>
              <div className="simple-mode-swatch-row">
                <input
                  type="color"
                  className="simple-mode-color-input"
                  value={hex}
                  onChange={e => onTokenChange(k.token, e.target.value)}
                />
                <span className="simple-mode-hex">{hex.toUpperCase()}</span>
              </div>
              <span className="simple-mode-hint">{k.hint}</span>
            </div>
          )
        })}
      </div>
      <div className="simple-mode-footer-note">
        Advanced mode unlocks all 516 tokens individually.
      </div>
    </div>
  )
}
