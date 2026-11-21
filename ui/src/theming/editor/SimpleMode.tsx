import { useEffect, useRef, useState } from 'react'
import { formatValue } from '../../ui-kit/format'
import NumberBox from '../../ui-kit/NumberBox'
import {
  APPEARANCE_CONTRAST_MAX,
  APPEARANCE_CONTRAST_MIN,
  APPEARANCE_TINT_MAX,
} from '../runtime/appearanceTheme.js'
import { readChromeKnobs, type ChromeKnobs } from '../runtime/chromeKnobs'
import { TINT_CHROMA_CAP } from '../runtime/chromeTint'
import ChromeReadouts from './ChromeReadouts'
import styles from './SimpleMode.module.css'

interface Props {
  /** The resolved token map of the working theme (not just its explicit overrides). */
  values: Record<string, string>
  /** Re-derive the surfaces from these knobs. */
  onChromeChange: (knobs: ChromeKnobs) => void
  /** Set one of the colour tokens (accent, danger). */
  onTokenChange: (name: string, value: string) => void
  /** Take the tint to zero, keeping brightness and contrast. */
  onNeutralize: () => void
}

interface SliderProps {
  id: string
  label: string
  /** Plain-language note beside the control: what it does and where it stops. */
  hint: string
  min: number
  max: number
  step: number
  value: number
  format: (v: number) => string
  onChange: (v: number) => void
}

/** A label, a kit NumberBox (drag it or type a value) and a one-line note. */
function Slider({ id, label, hint, min, max, step, value, format, onChange }: SliderProps) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <NumberBox
        id={id}
        label={label}
        hideLabel
        width={88}
        min={min}
        max={max}
        step={step}
        format={format}
        quantize={(v) => Math.round(v / step) * step}
        value={value}
        onChange={onChange}
        hint={label}
        hintMods={hint}
      />
      <span className={styles.note}>{hint}</span>
    </div>
  )
}

const hex6 = (raw: string | undefined, fallback: string) =>
  raw && /^#[0-9a-f]{6}$/i.test(raw) ? raw : fallback

/**
 * Quick customise. Surfaces are limited to the neutral ramp's own controls (brightness,
 * text contrast and a capped tint), so a theme made here cannot wander into a coloured
 * shell by accident. Accent and danger are free colours. Every other token is Advanced.
 */
export default function SimpleMode({ values, onChromeChange, onTokenChange, onNeutralize }: Props) {
  // The knobs are authoritative while the editor is open: a grey theme has no hue to read
  // back, and ink saturates at the pole, so re-reading each render would make the sliders jump.
  const [knobs, setKnobs] = useState<ChromeKnobs>(() => readChromeKnobs(values))
  const lastHue = useRef(knobs.hue)

  // A different theme (or Neutralize) changes the resolved surfaces from outside: re-read.
  const surfaceKey = `${values['--theme-ui-g1']}|${values['--theme-ui-ink']}`
  const ownKey = useRef(surfaceKey)
  useEffect(() => {
    if (surfaceKey === ownKey.current) return
    ownKey.current = surfaceKey
    setKnobs(readChromeKnobs(values, lastHue.current))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [surfaceKey])

  const set = (patch: Partial<ChromeKnobs>) => {
    const next = { ...knobs, ...patch }
    if (patch.hue !== undefined) lastHue.current = patch.hue
    setKnobs(next)
    onChromeChange(next)
  }

  const accent = hex6(values['--theme-accent'], '#33CED6')
  const danger = hex6(values['--theme-danger'], '#FF4757')
  const overCap = knobs.tint > 100

  return (
    <div className={styles.root}>
      <section className={styles.section} aria-labelledby="simple-colours">
        <h3 id="simple-colours" className={styles.heading}>Colours</h3>
        {([
          ['Accent', '--theme-accent', accent, 'Highlights, active controls and selection'],
          ['Danger', '--theme-danger', danger, 'Destructive actions, clipping and errors'],
        ] as const).map(([label, token, value, hint]) => (
          <div className={styles.row} key={token}>
            <label className={styles.label} htmlFor={`simple-${token}`}>{label}</label>
            <span className={styles.colourCell}>
              <input
                id={`simple-${token}`}
                type="color"
                className={styles.color}
                value={value}
                data-hint={label}
                data-hint-mods={hint}
                onChange={(e) => onTokenChange(token, e.target.value)}
              />
              <span className={styles.value}>{value.toUpperCase()}</span>
            </span>
            <span className={styles.note}>{hint}</span>
          </div>
        ))}
      </section>

      <section className={styles.section} aria-labelledby="simple-surfaces">
        <h3 id="simple-surfaces" className={styles.heading}>Surfaces</h3>
        <Slider
          id="simple-brightness"
          label="Brightness"
          hint="Lowest is near-black with light text; highest is light grey with dark text"
          min={0} max={100} step={1}
          value={knobs.brightness}
          format={(v) => formatValue(v, '%')}
          onChange={(v) => set({ brightness: v })}
        />
        <Slider
          id="simple-contrast"
          label="Text contrast"
          hint="Separation between text and its panel; never below the 4.5 to 1 floor"
          min={APPEARANCE_CONTRAST_MIN} max={APPEARANCE_CONTRAST_MAX} step={5}
          value={knobs.contrast}
          format={(v) => formatValue(v, '%')}
          onChange={(v) => set({ contrast: v })}
        />
        <Slider
          id="simple-tint"
          label="Tint"
          hint={overCap
            ? `Past the neutral cap (chroma ${TINT_CHROMA_CAP}): the chrome is tinted`
            : `Colour cast on panels. 100 % is the neutral cap (chroma ${TINT_CHROMA_CAP}); past it the chrome is tinted`}
          min={0} max={APPEARANCE_TINT_MAX} step={5}
          value={knobs.tint}
          format={(v) => formatValue(v, '%')}
          onChange={(v) => set({ tint: v })}
        />
        <Slider
          id="simple-tint-hue"
          label="Tint hue"
          hint="Direction of the cast. No effect at 0 %"
          min={0} max={359} step={1}
          value={knobs.hue}
          format={(v) => `${Math.round(v)}°`}
          onChange={(v) => set({ hue: v })}
        />
      </section>

      <section className={styles.section} aria-labelledby="simple-readouts">
        <h3 id="simple-readouts" className={styles.heading}>Contrast</h3>
        <ChromeReadouts values={values} onNeutralize={onNeutralize} />
      </section>

      <p className={styles.footer}>Advanced mode unlocks every token individually.</p>
    </div>
  )
}
