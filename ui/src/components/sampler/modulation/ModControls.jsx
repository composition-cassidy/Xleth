import Knob from '../Knob.jsx'
import { NOTE_VALUES } from './modConstants.js'
import { useModTarget } from './useModTarget.js'

// Shared control atoms for the modulation editors. Kept together so the ENV,
// LFO and curve editors read the same and stay visually consistent.

const KNOB_APPEARANCE = { tickStyle: 'none', glyph: 'rotary-arrow', accentGlow: false }

// `modTarget` is the OPT-IN cross-modulation registration ({target, index,
// stage, scale}) — a source's own RATE / RISE / DELAY / SMOOTH / PHASE / OUT
// knob, or an envelope stage time. Omit it and this is the plain Knob it has
// always been: useModTarget returns null and the `mod` prop is inert.
export function ModKnob({ modTarget, ...props }) {
  const mod = useModTarget(modTarget, { value: props.value, min: props.min, max: props.max })
  return <Knob {...KNOB_APPEARANCE} {...props} mod={mod} />
}

// Segmented button group over {v, l} options.
export function Seg({ opts, val, set, sm, title }) {
  return (
    <div className={`sampler-seg${sm ? ' sampler-seg--sm' : ''}`} title={title}>
      {opts.map((o) => (
        <button
          type="button"
          key={String(o.v)}
          onClick={() => set(o.v)}
          title={o.title}
          className={`sampler-seg-option${val === o.v ? ' is-active' : ''}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

export function Chk({ val, set, label, title }) {
  return (
    <label className="sampler-check" title={title}>
      <input type="checkbox" checked={!!val} onChange={(e) => set(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

// Note-value dropdown. `opts` defaults to the full table (incl. Off); pass a
// filtered list where a zero length makes no sense (LFO rate).
export function NoteSelect({ val, set, opts = NOTE_VALUES }) {
  return (
    <select
      className="sampler-select sampler-select--sm"
      value={String(val)}
      onChange={(e) => set(Number(e.target.value))}
    >
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  )
}

// A tiny labelled field wrapper for the knob/select rows.
export function Field({ label, children }) {
  return (
    <div className="sampler-mod-field">
      {children}
      <span className="sampler-mod-field-label">{label}</span>
    </div>
  )
}
