// Note Fade panel — Pattern Track only.
//
// Applies an automatic fade-in and/or fade-out to EVERY note's video on the
// track. A pattern note's video cell already spans exactly the note (grid cells
// have no hold-through-gap), so the whole feature is an opacity envelope over
// the note — the engine evaluates it in FrameCollector, the one path preview,
// export and snapshot transitions all share.
//
// Deliberately a separate per-track config rather than a Visual FX chain entry,
// for the same reason SLIDE NOTE EFFECT is: the chain is type-agnostic and
// GPU-side, and this is meaningless on a Clip track (which has its own
// hand-authored per-clip fade) and needs beat-space note timing the chain
// passes never see. Both surfaces that render this — TrackCard and
// TrackVideoProperties — gate it on track.type === 'Pattern'.
//
// Styling reuses the .grid-tab-slide-* classes on purpose: the Track Video
// Properties panel restyles those for its own shell (.tvp-root overrides in
// app.css), so borrowing them makes this section correct in BOTH surfaces with
// no new CSS to keep in sync.
import XlethSelect from '../common/XlethSelect.jsx'
import Fader from '../controls/Fader.jsx'
import { quantizedFromNorm } from '../../utils/sliderHelpers.js'

// Mirrors NoteFadeSettings::LengthMode (engine/src/model/TimelineTypes.h).
const MODE_OPTIONS = [
  { value: 0, label: 'Follow Note Length' },
  { value: 1, label: 'Note Division' },
  { value: 2, label: 'Milliseconds' },
]

// Denominator D, fade length = 4/D beats — the same convention the Sampler and
// Phanjer tempo-sync dropdowns use, so D=4 is exactly one beat. Ordered
// shortest fade first. One beat is the longest fixed division offered; longer
// than that, Follow Note Length is the setting you actually want.
const DIVISION_OPTIONS = [
  { value: 64, label: '1/64' },
  { value: 32, label: '1/32' },
  { value: 16, label: '1/16' },
  { value: 8,  label: '1/8'  },
  { value: 4,  label: '1/4 (1 beat)' },
]

// Named for their shape near SILENCE, not near full opacity: the engine feeds
// the fade-out its curve reversed, so this is the only naming under which one
// option means the same thing on both sides.
const CURVE_OPTIONS = [
  { value: 0, label: 'Linear' },
  { value: 1, label: 'Smooth' },
  { value: 2, label: 'Snappy' },
  { value: 3, label: 'Gentle' },
]

// Must match NoteFadeSettings::Side's field initialisers in the engine — an
// absent key falls back to the struct default there, so the two have to agree
// or the readout would show something the renderer is not using.
const DEFAULT_SIDE = {
  mode: 0,
  percent: 10,
  divisionDenominator: 16,
  ms: 60,
  curve: 0,
}

function FadeSideControls({ title, side, onChange }) {
  const mode     = side.mode ?? DEFAULT_SIDE.mode
  const percent  = side.percent ?? DEFAULT_SIDE.percent
  const division = side.divisionDenominator ?? DEFAULT_SIDE.divisionDenominator
  const ms       = side.ms ?? DEFAULT_SIDE.ms
  const curve    = side.curve ?? DEFAULT_SIDE.curve

  return (
    <>
      <div className="grid-tab-notefade-subhead">{title}</div>
      <div className="grid-tab-slide-params">
        <label>Length</label>
        <XlethSelect
          className="grid-tab-slide-param-select"
          value={mode}
          options={MODE_OPTIONS}
          onChange={value => onChange({ mode: value })}
          ariaLabel={`${title} length mode`}
        />
        <span />

        {mode === 0 && (
          <>
            <label>Amount</label>
            <Fader
              orientation="horizontal" fill thickness={14}
              value={percent} min={0} max={100} defaultValue={DEFAULT_SIDE.percent}
              fromNorm={quantizedFromNorm(0, 100, 1)}
              onCommit={value => onChange({ percent: value })}
            />
            <span className="grid-tab-slide-readout">{Math.round(percent)}%</span>
          </>
        )}

        {mode === 1 && (
          <>
            <label>Note</label>
            <XlethSelect
              className="grid-tab-slide-param-select"
              value={division}
              options={DIVISION_OPTIONS}
              onChange={value => onChange({ divisionDenominator: value })}
              ariaLabel={`${title} note division`}
            />
            <span />
          </>
        )}

        {mode === 2 && (
          <>
            <label>Time</label>
            <input
              className="grid-tab-slide-param-input"
              type="number" min={0} max={5000} step={10}
              defaultValue={ms}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={(e) => onChange({ ms: parseFloat(e.target.value) || 0 })}
            />
            <span className="grid-tab-slide-readout">{Math.round(ms)}ms</span>
          </>
        )}

        <label>Curve</label>
        <XlethSelect
          className="grid-tab-slide-param-select"
          value={curve}
          options={CURVE_OPTIONS}
          onChange={value => onChange({ curve: value })}
          ariaLabel={`${title} curve`}
        />
        <span />
      </div>
    </>
  )
}

export default function NoteFadeSection({ track, fetchTracks }) {
  const nf      = track.noteFade ?? {}
  const enabled = nf.enabled ?? false
  const fadeIn  = nf.fadeIn ?? DEFAULT_SIDE
  const fadeOut = nf.fadeOut ?? DEFAULT_SIDE

  // The engine merges a partial patch onto what the track already holds, but
  // the whole object is sent anyway so the sides stay consistent with what this
  // panel is displaying even if another surface wrote in between.
  const set = async (patch) => {
    await window.xleth?.timeline?.setTrackNoteFade(track.id, {
      enabled, fadeIn, fadeOut, ...patch,
    })
    fetchTracks()
  }

  return (
    <div className="grid-tab-track-slide grid-tab-track-notefade">
      <div className="grid-tab-slide-header">NOTE FADE</div>

      <label className="grid-tab-notefade-enable">
        <input
          type="checkbox"
          className="fx-checkbox"
          checked={enabled}
          onChange={() => set({ enabled: !enabled })}
        />
        <span>Fade every note</span>
      </label>

      {enabled && (
        <>
          <FadeSideControls
            title="Fade In"
            side={fadeIn}
            onChange={(patch) => set({ fadeIn: { ...fadeIn, ...patch } })}
          />
          <FadeSideControls
            title="Fade Out"
            side={fadeOut}
            onChange={(patch) => set({ fadeOut: { ...fadeOut, ...patch } })}
          />
          {/* A fade longer than the note it lands on is clamped to the note
              rather than bleeding past it, and two over-long fades split the
              note evenly — worth saying, because the fixed-length modes make
              that reachable on short notes without any warning otherwise. */}
          <div className="fx-param-note">
            Fixed lengths are clamped to each note; a note shorter than the fade
            gets a proportionally shorter one.
          </div>
        </>
      )}
    </div>
  )
}
