import { Crosshair, GripVertical, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import useSandboxStore, {
  RIPPLE_MODE, FADE_SHAPE, PITCH_MODE, findEnvelopeOp, clampGainEnvelopeFollower, GAIN_ENVELOPE_MODE,
  GAIN_ENVELOPE_ATTACK_MS_MIN, GAIN_ENVELOPE_ATTACK_MS_MAX,
  GAIN_ENVELOPE_RELEASE_MS_MIN, GAIN_ENVELOPE_RELEASE_MS_MAX,
  AUTOTUNE_SCALE_NAME, AUTOTUNE_KEY_NAME,
  AUTOTUNE_MAX_RETUNE_MS, AUTOTUNE_MAX_SMOOTHNESS_MS,
} from '../../stores/sandboxStore.js'
import { allowedPitchClasses } from './autotuneCorrectionPreview.js'
import { FADE_SHAPES } from './sandboxToolConstants.js'
import { formatRange, formatSamplesShort } from './sandboxFormat.js'
import { opSampleRange, resolveOpRange } from './sandboxOpRange.js'

const RIPPLE_MODE_NAME = Object.fromEntries(Object.entries(RIPPLE_MODE).map(([k, v]) => [v, k]))
const FADE_SHAPE_NAME = Object.fromEntries(Object.entries(FADE_SHAPE).map(([k, v]) => [v, k]))

// ── AUTOTUNE keyboard note picker (P5-4) ─────────────────────────────────────
// One octave, laid out like a real keyboard so "root highlighted, scale notes
// lit" reads at a glance. White keys carry the 7 natural pitch classes in
// left-to-right pitch order; black keys are absolutely positioned at the
// boundary between the two white keys they sit above — good enough for a
// 1-octave utility picker, not a literal-width piano reproduction.
const KB_WHITE_PCS = [0, 2, 4, 5, 7, 9, 11]
// pc -> index (0-6) of the white key it sits just after, for positioning.
const KB_BLACK_AFTER_WHITE = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }

function AutotuneKeyboard({ rootPc, activePcs, onToggle }) {
  return (
    <div className="sandbox-autotune-keyboard" role="group" aria-label="Allowed notes">
      <div className="sandbox-autotune-keyboard-whites">
        {KB_WHITE_PCS.map((pc) => (
          <button
            key={pc}
            type="button"
            className={`sandbox-autotune-key white${activePcs.includes(pc) ? ' on' : ''}${pc === rootPc ? ' root' : ''}`}
            onClick={() => onToggle(pc)}
            title={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
          />
        ))}
      </div>
      <div className="sandbox-autotune-keyboard-blacks">
        {Object.entries(KB_BLACK_AFTER_WHITE).map(([pcStr, whiteIndex]) => {
          const pc = Number(pcStr)
          return (
            <button
              key={pc}
              type="button"
              style={{ left: `${((whiteIndex + 1) / KB_WHITE_PCS.length) * 100}%` }}
              className={`sandbox-autotune-key black${activePcs.includes(pc) ? ' on' : ''}${pc === rootPc ? ' root' : ''}`}
              onClick={() => onToggle(pc)}
              title={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
            />
          )
        })}
      </div>
    </div>
  )
}

// A short human-readable summary of an op's params — shown on every module
// row (selected or not), so the collapsed rail is still scannable.
//
// ── Seconds, not sample indices ─────────────────────────────────────────────
// These rows used to print raw indices ("12000–48000", "@ 132300, 8820 smp").
// Nobody reads a stack of those: the numbers are six digits wide, they do not
// compare against anything else on screen (the status bar and the ruler are
// both in seconds), and two ops a millisecond apart look identical at a
// glance. `rate` is the layer's own rendered sample rate; with no buffer yet
// there is nothing to convert against, and the helpers fall back to printing
// the raw index rather than inventing a rate.
function describeParams(op, rate) {
  const p = op.params || {}
  const at = (smp) => (rate ? formatSamplesShort(smp, rate) : `${smp} smp`)
  const range = (a, b) => formatRange(a, b, rate)
  switch (op.type) {
    case 'trim':
      return range(p.startSample, p.endSample)
    case 'cut':
      return `${range(p.startSample, p.endSample)} (${RIPPLE_MODE_NAME[p.mode] ?? p.mode})`
    case 'paste':
      return p.clipboardId >= 0
        ? `@ ${at(p.atSample)}, ${at(p.clipboardLengthSamples)} of audio, ${p.insert ? 'insert' : 'overwrite'}`
        : `@ ${at(p.atSample)}, ${at(p.clipboardLengthSamples)} of silence, ${p.insert ? 'insert' : 'overwrite'}`
    case 'splice':
      return `@ ${at(p.atSample)} (${RIPPLE_MODE_NAME[p.mode] ?? p.mode}${p.mode === RIPPLE_MODE.gap ? `, gap ${at(p.gapSamples)}` : ''})`
    case 'reverse':
      return range(p.startSample, p.endSample)
    case 'fade':
      return `${p.fadeIn ? 'in' : 'out'}, ${at(p.lengthSamples)} (${FADE_SHAPE_NAME[p.shape] ?? p.shape})`
    case 'gain':
      return p.normalize ? `normalize → ${p.targetPeakDb} dBFS` : `${p.gainDb} dB`
    case 'gainEnvelope': {
      // Breakpoint count plus the range it spans — enough to tell two curves
      // apart in the stack without trying to render a shape in a text row.
      const pts = p.points || []
      const modeLabel = p.mode === 1 ? 'Rel' : 'Abs'
      if (pts.length === 0) return `flat (0 dB, ${modeLabel})`
      const dbs = pts.map((q) => q.db)
      return `${pts.length} pt, ${Math.min(...dbs).toFixed(1)}…${Math.max(...dbs).toFixed(1)} dB (${modeLabel})`
    }
    case 'crossfade':
      return `@ ${at(p.atSample)}, ${at(p.lengthSamples)} (${FADE_SHAPE_NAME[p.shape] ?? p.shape})`
    case 'pitch': {
      const cents = `${p.cents >= 0 ? '+' : ''}${p.cents}¢`
      // Varispeed's length change is the thing a user most needs told, and the
      // waveform alone does not say it (a re-rendered layer just looks like a
      // different layer). Spell the speed factor out; formant lock is
      // preserve-mode-only so it is not mentioned in the other branch.
      if (p.mode === PITCH_MODE.resample) {
        const speed = Math.pow(2, (p.cents || 0) / 1200)
        return `${cents} varispeed — ×${speed.toFixed(3)} speed, ×${(1 / speed).toFixed(3)} length`
      }
      return `${cents}${p.formantPreserve ? ', formant lock' : ''}`
    }
    case 'formantShift':
      return `${p.cents >= 0 ? '+' : ''}${p.cents}¢`
    case 'declip':
      return `${range(p.startSample, p.endSample)}, thresh ${p.threshold}, max run ${at(p.maxRunSamples)}`
    case 'denoise':
      return p.noiseEndSample > p.noiseStartSample
        ? `profile ${range(p.noiseStartSample, p.noiseEndSample)}, -${p.reductionDb} dB, ×${p.sensitivity}`
        : 'no profile learned yet'
    case 'spectralPaint': {
      const dabs = p.dabs || []
      if (dabs.length === 0) return 'no dabs painted yet'
      const amounts = dabs.map((d) => d.amountDb)
      return `${dabs.length} dab${dabs.length === 1 ? '' : 's'}, ${Math.min(...amounts).toFixed(0)}…${Math.max(...amounts).toFixed(0)} dB`
    }
    case 'autotune': {
      if (p.mode === 1) {
        const pts = p.manualPoints || []
        if (pts.length === 0) return 'Manual — no curve drawn yet'
        if (!(p.correctionAmount > 0)) return `Manual, ${pts.length} pt — 0% (bypass)`
        return `Manual, ${pts.length} pt, ${p.correctionAmount}%, retune ${p.retuneSpeedMs}ms`
      }
      // Scale/key first because that is what the user picked, then the one
      // control that changes whether ANYTHING happens. A non-empty
      // allowedNotes OVERRIDES scale/key (AutotuneParams), so the row must say
      // "custom" rather than a preset name the render is ignoring.
      const notes = p.allowedNotes || []
      const scale = notes.length > 0
        ? `custom (${notes.map((n) => AUTOTUNE_KEY_NAME[n] ?? n).join(' ')})`
        : `${AUTOTUNE_KEY_NAME[p.key] ?? p.key} ${AUTOTUNE_SCALE_NAME[p.scale] ?? p.scale}`
      if (!(p.correctionAmount > 0)) return `${scale} — 0% (bypass)`
      return `${scale}, ${p.correctionAmount}%, retune ${p.retuneSpeedMs}ms, vib ${p.preserveVibrato}%`
    }
    default:
      return ''
  }
}

// One AUTOTUNE control. The slider is mirrored locally while dragging and
// only COMMITTED on release (pointerup / keyboard blur), so a drag across the
// range is one undoable edit and one re-render rather than one per tick — the
// same contract the gain-envelope drag and the spectral-paint stroke follow.
// The number box beside it commits on blur, for typing an exact value.
function AutotuneSlider({ label, unit, min, max, step, value, onCommit, disabled, title }) {
  const [local, setLocal] = useState(value)
  const [dragging, setDragging] = useState(false)
  // Track the committed value while NOT dragging, so undo/redo and a render
  // that clamps the value are both reflected without fighting the drag.
  useEffect(() => { if (!dragging) setLocal(value) }, [value, dragging])
  const shown = dragging ? local : value
  return (
    <label className="sandbox-op-slider" title={title}>
      {label}
      <input
        type="range" min={min} max={max} step={step} value={shown} disabled={disabled}
        onChange={(e) => { setDragging(true); setLocal(Number(e.target.value)) }}
        onPointerUp={() => { setDragging(false); if (local !== value) onCommit(local) }}
        onBlur={() => { setDragging(false); if (local !== value) onCommit(local) }}
      />
      <input
        type="number" className="sandbox-toolbar-number"
        min={min} max={max} step={step}
        value={shown} disabled={disabled}
        onChange={(e) => { setDragging(true); setLocal(Number(e.target.value)) }}
        onBlur={(e) => {
          setDragging(false)
          const v = Math.min(max, Math.max(min, Number(e.target.value)))
          if (v !== value) onCommit(v)
        }}
      />
      <span className="sandbox-op-slider-unit">{unit}</span>
    </label>
  )
}

// Inline param editors shown beneath the SELECTED module only. Covers every
// op param this restructuring's spec calls out by name: envelope mode +
// attack/release, pitch, formant, declip threshold, denoise profile, and
// fade curves (FADE + CROSSFADE's shared shape enum). Every other op type
// (trim/cut/paste/splice/reverse/gain) has no persistent knob — it was
// authored by drawing/re-drawing the tool that created it, same as before
// this restructuring, so selecting one just highlights the row.
function InlineOpParamEditor({
  op, layerId, setOpParams, hasSelection, onLearnNoiseProfile, setGainEnvelopeFollower,
  onClearSpectralPaint, refusedOps, refusalReason,
}) {
  const p = op.params || {}

  if (op.type === 'pitch') {
    const resample = p.mode === PITCH_MODE.resample
    return (
      <div className="sandbox-op-params-row">
        <label>
          Cents
          <input
            type="number" step="10" className="sandbox-toolbar-number"
            defaultValue={p.cents} key={`cents-${op.id}-${p.cents}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, cents: Number(e.target.value) })}
          />
        </label>
        <label title="Preserve: hold the length, rebuild the spectrum (RubberBand). Varispeed: read the waveform faster/slower, so the length moves with the pitch — the tape/turntable move.">
          Mode
          <select
            className="sandbox-toolbar-select"
            value={resample ? PITCH_MODE.resample : PITCH_MODE.preserve}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, mode: Number(e.target.value) })}
          >
            <option value={PITCH_MODE.preserve}>Preserve length</option>
            <option value={PITCH_MODE.resample}>Varispeed (resample)</option>
          </select>
        </label>
        {/* Disabled rather than hidden in varispeed: the toggle keeps its
            value across a mode flip (PitchParams retains it deliberately), so
            hiding it would make a setting that is still there look erased. */}
        <label
          className={`sandbox-op-checkbox${resample ? ' disabled' : ''}`}
          title={resample
            ? 'Varispeed moves the formants with the pitch by definition — add a FORMANT SHIFT op to move them back'
            : 'Keep the formant envelope where it started, so a big shift does not chipmunk the voice'}
        >
          <input
            type="checkbox" checked={!!p.formantPreserve} disabled={resample}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, formantPreserve: e.target.checked })}
          />
          Formant Lock
        </label>
      </div>
    )
  }
  if (op.type === 'formantShift') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Cents
          <input
            type="number" step="10" className="sandbox-toolbar-number"
            defaultValue={p.cents} key={`cents-${op.id}-${p.cents}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, cents: Number(e.target.value) })}
          />
        </label>
      </div>
    )
  }
  if (op.type === 'declip') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Threshold
          <input
            type="number" step="0.01" min="0.5" max="1" className="sandbox-toolbar-number"
            defaultValue={p.threshold} key={`thresh-${op.id}-${p.threshold}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, threshold: Number(e.target.value) })}
          />
        </label>
        <label>
          Max run (smp)
          <input
            type="number" step="1" min="1" className="sandbox-toolbar-number"
            defaultValue={p.maxRunSamples} key={`run-${op.id}-${p.maxRunSamples}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, maxRunSamples: Number(e.target.value) })}
          />
        </label>
      </div>
    )
  }
  if (op.type === 'denoise') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Reduction (dB)
          <input
            type="number" step="1" min="0" max="60" className="sandbox-toolbar-number"
            defaultValue={p.reductionDb} key={`red-${op.id}-${p.reductionDb}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, reductionDb: Number(e.target.value) })}
          />
        </label>
        <label>
          Sensitivity
          <input
            type="number" step="0.1" min="0" max="5" className="sandbox-toolbar-number"
            defaultValue={p.sensitivity} key={`sens-${op.id}-${p.sensitivity}`}
            onBlur={(e) => setOpParams(layerId, op.id, { ...p, sensitivity: Number(e.target.value) })}
          />
        </label>
        {/* DENOISE's "select region → Learn Noise Profile" gesture: commits
            whatever is currently selected as THIS op's noise region via the
            same generic setOpParams every other param edit in this file goes
            through, so it is undoable for free. */}
        <button
          className="sandbox-op-learn-noise"
          disabled={!hasSelection}
          onClick={() => onLearnNoiseProfile(layerId, op.id)}
          title={hasSelection
            ? 'Learn a noise profile from the current selection'
            : 'Select a noise-only region first'}
        >
          Learn Noise Profile
        </button>
      </div>
    )
  }
  if (op.type === 'gainEnvelope') {
    const follower = clampGainEnvelopeFollower(p)
    const isRelative = follower.mode === GAIN_ENVELOPE_MODE.relative
    return (
      <div className="sandbox-op-params-row">
        <label>
          Mode
          <select
            className="sandbox-toolbar-select"
            value={isRelative ? 'relative' : 'absolute'}
            onChange={(e) => setGainEnvelopeFollower(layerId, {
              ...follower, mode: e.target.value === 'relative' ? GAIN_ENVELOPE_MODE.relative : GAIN_ENVELOPE_MODE.absolute,
            })}
            title="Mode 1: the drawn curve IS the gain. Mode 2: the drawn curve modulates the material's own detected dynamics."
          >
            <option value="absolute">1 · Absolute</option>
            <option value="relative">2 · Relative</option>
          </select>
        </label>
        <label title={isRelative ? undefined : 'Only used in Relative mode'}>
          Attack (ms)
          <input
            type="number" step="0.5" className="sandbox-toolbar-number"
            min={GAIN_ENVELOPE_ATTACK_MS_MIN} max={GAIN_ENVELOPE_ATTACK_MS_MAX}
            value={follower.followerAttackMs} disabled={!isRelative}
            onChange={(e) => setGainEnvelopeFollower(layerId, { ...follower, followerAttackMs: Number(e.target.value) })}
          />
        </label>
        <label title={isRelative ? undefined : 'Only used in Relative mode'}>
          Release (ms)
          <input
            type="number" step="5" className="sandbox-toolbar-number"
            min={GAIN_ENVELOPE_RELEASE_MS_MIN} max={GAIN_ENVELOPE_RELEASE_MS_MAX}
            value={follower.followerReleaseMs} disabled={!isRelative}
            onChange={(e) => setGainEnvelopeFollower(layerId, { ...follower, followerReleaseMs: Number(e.target.value) })}
          />
        </label>
        <span className="sandbox-op-params-readout">
          {(p.points || []).length} breakpoint{(p.points || []).length === 1 ? '' : 's'} — drawn on the waveform (Envelope tool)
        </span>
      </div>
    )
  }
  if (op.type === 'spectralPaint') {
    const dabs = p.dabs || []
    return (
      <div className="sandbox-op-params-row">
        <span className="sandbox-op-params-readout">
          {dabs.length} dab{dabs.length === 1 ? '' : 's'} — painted on the spectrogram (Spectral tool, SPC view)
        </span>
        <button
          className="sandbox-op-learn-noise"
          disabled={dabs.length === 0}
          onClick={() => onClearSpectralPaint(layerId)}
          title="Remove every painted dab, leaving this op as an empty (pass-through) mask"
        >
          Clear
        </button>
      </div>
    )
  }
  if (op.type === 'autotune') {
    // The six controls plus scale/key. Sliders commit on RELEASE (onChange
    // fires per drag tick in React, so the value is mirrored locally and only
    // pushed on pointerup) — the same "one command per drag, not per
    // mousemove" contract setGainEnvelope and the spectral-paint stroke both
    // follow, so a drag is one undo step rather than fifty.
    //
    // Scale/key are disabled while a custom note set is active, because a
    // non-empty allowedNotes OVERRIDES them outright in the engine
    // (AutotuneParams) — leaving them live would let the user change a preset
    // and hear nothing.
    const notes = p.allowedNotes || []
    const custom = notes.length > 0
    const set = (patch) => setOpParams(layerId, op.id, { ...p, ...patch })
    // The picker's own "lit" set: the custom set once one exists, otherwise
    // the preset's own pitch classes — so the very first click on a key
    // seeds FROM the preset (toggle one note relative to what is already
    // playing) rather than starting from a blank slate the user would have
    // to rebuild note by note. Also doubles as MANUAL mode's default snap
    // set (SandboxWaveformCanvas.jsx's drawing handlers read the same op
    // params), so it stays live in both modes rather than being disabled
    // alongside Jumpiness/Vibrato below.
    const displayedPcs = custom ? notes : allowedPitchClasses(p.key, p.scale)
    const toggleNote = (pc) => {
      const base = displayedPcs.slice()
      const next = base.includes(pc) ? base.filter((n) => n !== pc) : [...base, pc].sort((a, b) => a - b)
      set({ allowedNotes: next })
    }
    // mode is an int on the wire (0 Scale / 1 Manual — AutotuneMode in
    // SandboxOp.h), same convention CutParams/SpliceParams/GainEnvelopeParams
    // already use for their own enums.
    const isManual = p.mode === 1
    const manualTitle = isManual ? 'Not used in Manual mode' : undefined
    return (
      <div className="sandbox-op-params-row sandbox-op-params-wrap">
        {refusedOps > 0 && (
          <div className="sandbox-op-refusal-banner">
            <TriangleAlert size={12} />
            <span>{refusalReason || 'Autotune declined this input.'}</span>
          </div>
        )}
        <label>
          Mode
          <select
            className="sandbox-toolbar-select" value={isManual ? 'manual' : 'scale'}
            onChange={(e) => set({ mode: e.target.value === 'manual' ? 1 : 0 })}
            title="Scale: quantize to the scale/key below. Manual: draw the target pitch curve directly on the graph."
          >
            <option value="scale">Scale</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        <label title={custom ? 'A custom note set overrides scale/key' : undefined}>
          Key
          <select
            className="sandbox-toolbar-select" value={p.key} disabled={custom}
            onChange={(e) => set({ key: Number(e.target.value) })}
          >
            {AUTOTUNE_KEY_NAME.map((n, i) => <option key={n} value={i}>{n}</option>)}
          </select>
        </label>
        <label title={custom ? 'A custom note set overrides scale/key' : undefined}>
          Scale
          <select
            className="sandbox-toolbar-select" value={p.scale} disabled={custom}
            onChange={(e) => set({ scale: Number(e.target.value) })}
          >
            {Object.entries(AUTOTUNE_SCALE_NAME).map(([v, n]) => (
              <option key={v} value={v}>{n}</option>
            ))}
          </select>
        </label>
        <AutotuneSlider label="Amount" unit="%" min={0} max={100} step={1}
          value={p.correctionAmount} onCommit={(v) => set({ correctionAmount: v })} />
        <AutotuneSlider label="Retune" unit="ms" min={0} max={AUTOTUNE_MAX_RETUNE_MS} step={1}
          value={p.retuneSpeedMs} onCommit={(v) => set({ retuneSpeedMs: v })} />
        <AutotuneSlider label="Smooth" unit="ms" min={0} max={AUTOTUNE_MAX_SMOOTHNESS_MS} step={1}
          value={p.smoothnessMs} onCommit={(v) => set({ smoothnessMs: v })} />
        <AutotuneSlider label="Jumpiness" unit="%" min={0} max={100} step={1}
          value={p.jumpiness} onCommit={(v) => set({ jumpiness: v })}
          disabled={isManual} title={manualTitle} />
        {/* holdMs == the jumpiness value itself (1% = 1ms, literal per the
            spec/CorrectionCurve.cpp) — shown as its own readout rather than
            folded into the slider's unit, so both numbers stay visible while
            dragging. */}
        {!isManual && (
          <span className="sandbox-op-params-readout sandbox-op-jumpiness-ms">
            = {p.jumpiness}ms minimum hold before a note change is accepted
          </span>
        )}
        <AutotuneSlider label="Vibrato" unit="%" min={0} max={100} step={1}
          value={p.preserveVibrato} onCommit={(v) => set({ preserveVibrato: v })}
          disabled={isManual} title={manualTitle} />
        {isManual && (
          <span className="sandbox-op-params-readout">
            {(p.manualPoints || []).length} breakpoint{(p.manualPoints || []).length === 1 ? '' : 's'} — drawn on the pitch graph above (hold ALT to free-draw)
          </span>
        )}
        <div className="sandbox-autotune-keyboard-row">
          <AutotuneKeyboard rootPc={p.key} activePcs={displayedPcs} onToggle={toggleNote} />
          {custom && (
            <button
              className="sandbox-op-learn-noise"
              onClick={() => set({ allowedNotes: [] })}
              title="Drop the custom note set and go back to the scale/key preset"
            >
              Clear notes
            </button>
          )}
        </div>
      </div>
    )
  }
  if (op.type === 'gain') {
    return (
      <div className="sandbox-op-params-row">
        <label className="sandbox-op-checkbox">
          <input
            type="checkbox" checked={!!p.normalize}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, normalize: e.target.checked })}
          />
          Normalize
        </label>
        {p.normalize ? (
          <label>
            Target (dBFS)
            <input
              type="number" step="0.5" className="sandbox-toolbar-number"
              defaultValue={p.targetPeakDb} key={`tgt-${op.id}-${p.targetPeakDb}`}
              onBlur={(e) => setOpParams(layerId, op.id, { ...p, targetPeakDb: Number(e.target.value) })}
            />
          </label>
        ) : (
          <label>
            Gain (dB)
            <input
              type="number" step="0.5" className="sandbox-toolbar-number"
              defaultValue={p.gainDb} key={`gain-${op.id}-${p.gainDb}`}
              onBlur={(e) => setOpParams(layerId, op.id, { ...p, gainDb: Number(e.target.value) })}
            />
          </label>
        )}
      </div>
    )
  }
  if (op.type === 'fade' || op.type === 'crossfade') {
    return (
      <div className="sandbox-op-params-row">
        <label>
          Curve
          <select
            className="sandbox-toolbar-select"
            value={FADE_SHAPE_NAME[p.shape] ?? 'equalPower'}
            onChange={(e) => setOpParams(layerId, op.id, { ...p, shape: FADE_SHAPE[e.target.value] })}
          >
            {FADE_SHAPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
    )
  }
  return null
}

const HAS_INLINE_PARAMS = new Set([
  'pitch', 'formantShift', 'declip', 'denoise', 'gainEnvelope', 'fade', 'crossfade', 'spectralPaint', 'gain',
  'autotune',
])

function OpModule({
  op, index, layerId, selected, onSelect, onToggleBypass, onRemove, setOpParams, hasSelection,
  onLearnNoiseProfile, setGainEnvelopeFollower, onClearSpectralPaint, refusedOps, refusalReason,
  dragging, dropEdge, onDragStart, onDragOver, onDrop, onDragEnd, sampleRate, numSamples, onReveal,
}) {
  const dropClass = dropEdge === 'above' ? ' drop-above' : dropEdge === 'below' ? ' drop-below' : ''
  // The refusal is a per-LAYER fact (only one op type can produce it today),
  // not per-op — shown on the AUTOTUNE row specifically since that's the op
  // it's actually about. A badge on the collapsed row so "declined, not
  // rendering garbage" is visible without expanding it; the full wording
  // lives in InlineOpParamEditor for when it is.
  const refused = op.type === 'autotune' && refusedOps > 0
  return (
    <div
      className={`sandbox-op-module${op.enabled ? '' : ' bypassed'}${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}${dropClass}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className="sandbox-op-row" onClick={() => onSelect(op.id)}>
        <GripVertical size={12} className="sandbox-op-grip" />
        <span className="sandbox-op-index">{String(index + 1).padStart(2, '0')}</span>
        <div className="sandbox-op-label">
          <span className="sandbox-op-type">{op.type}</span>
          <span className="sandbox-op-params">{describeParams(op, sampleRate)}</span>
        </div>
        {/* Phase 3: point the waveform at what this entry actually does. Only
            offered for ops that HAVE a locatable range — see sandboxOpRange.js
            on why a whole-buffer op shows nothing rather than framing
            everything. */}
        {!!resolveOpRange(opSampleRange(op), numSamples) && (
          <button
            className="sandbox-op-reveal"
            onClick={(e) => { e.stopPropagation(); onReveal(op) }}
            title="Zoom the waveform to the range this operation covers"
          >
            <Crosshair size={11} />
          </button>
        )}
        {refused && (
          <span className="sandbox-op-refusal-badge" title={refusalReason || 'Autotune declined this input.'}>
            <TriangleAlert size={11} />
          </span>
        )}
        <button
          className={`sandbox-op-bypass${op.enabled ? '' : ' active'}`}
          onClick={(e) => { e.stopPropagation(); onToggleBypass(layerId, op.id, op.enabled) }}
          title={op.enabled ? 'Bypass' : 'Enable'}
        >
          {op.enabled ? 'ON' : 'OFF'}
        </button>
        <button
          className="sandbox-op-remove"
          onClick={(e) => { e.stopPropagation(); onRemove(layerId, op.id) }}
          title="Remove operation"
        >
          <Trash2 size={11} />
        </button>
      </div>
      {selected && HAS_INLINE_PARAMS.has(op.type) && (
        <InlineOpParamEditor
          op={op} layerId={layerId} setOpParams={setOpParams}
          hasSelection={hasSelection} onLearnNoiseProfile={onLearnNoiseProfile}
          setGainEnvelopeFollower={setGainEnvelopeFollower}
          onClearSpectralPaint={onClearSpectralPaint}
          refusedOps={refusedOps} refusalReason={refusalReason}
        />
      )}
    </div>
  )
}

// Pure op-list rail (mockup: "OP STACK" header + ↶/↷ above ONLY the ordered
// op rows). Adding an op moved to the EFFECT ▾ menu (SandboxMenuBar.jsx,
// driven by sandboxEffectRegistry.js) and BAKE/SWAP IN moved to the bottom
// transport (SandboxTransport.jsx) — this panel now only lists, reorders,
// bypasses, removes and inline-edits whatever is already on the stack, plus
// undo/redo for the whole sandbox (shared with SandboxStatusBar's depth
// readout — same `history`/`undo`/`redo` store fields, just relocated here
// per the mockup's header).
export default function SandboxStackPanel() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const setOpBypassed = useSandboxStore((s) => s.setOpBypassed)
  const removeOp = useSandboxStore((s) => s.removeOp)
  const setOpParams = useSandboxStore((s) => s.setOpParams)
  const learnNoiseProfile = useSandboxStore((s) => s.learnNoiseProfile)
  const setGainEnvelopeFollower = useSandboxStore((s) => s.setGainEnvelopeFollower)
  const clearSpectralPaint = useSandboxStore((s) => s.clearSpectralPaint)
  const reorderOp = useSandboxStore((s) => s.reorderOp)
  const revealRange = useSandboxStore((s) => s.revealRange)
  const history = useSandboxStore((s) => s.history)
  const undo = useSandboxStore((s) => s.undo)
  const redo = useSandboxStore((s) => s.redo)
  // Lifted to the store (P5-4) so SandboxWaveformCanvas can tell whether the
  // selected op is AUTOTUNE and draw its pitch curve overlay — see
  // setSelectedOpId's own comment (sandboxStore.js).
  const selectedOpId = useSandboxStore((s) => s.selectedOpId)
  const setSelectedOpId = useSandboxStore((s) => s.setSelectedOpId)

  // Drag-to-reorder: { draggedIndex, overIndex, edge } while a drag is live,
  // else null. reorderOp's own dirty-marking (_triggerAutoRender) already
  // covers "mark the composite dirty downstream of the earliest affected
  // op" — this is purely the drag UI on top of that existing action.
  const [dragState, setDragState] = useState(null)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSelection = !!selection && selection.endSample > selection.startSample

  // Selecting a different layer (or one whose ops changed under it) should
  // not leave a stale expanded panel pointing at an op that may no longer
  // exist on the new layer.
  useEffect(() => { setSelectedOpId(null) }, [activeLayerId, setSelectedOpId])

  const handleToggleBypass = (layerId, opId, enabled) => setOpBypassed(layerId, opId, enabled)

  // Frame the op's own range on the waveform. Selecting the row already
  // highlights that range (SandboxWaveformCanvas draws it off selectedOpId);
  // this is the second half — go there when it is off screen.
  const handleReveal = (op) => {
    const range = resolveOpRange(opSampleRange(op), layer?.renderedBuffer?.numSamples ?? 0)
    if (range) revealRange(range.startSample, range.endSample)
  }
  const handleSelectOp = (opId) => setSelectedOpId(selectedOpId === opId ? null : opId)

  const handleDragStart = (index) => (e) => {
    // The whole op module is `draggable` for reorder, but its expanded
    // InlineOpParamEditor (sliders, number fields, selects, buttons) lives
    // inside that same subtree — without this guard, starting a native drag
    // gesture on a slider thumb hijacks it into a reorder drag instead of
    // moving the slider.
    if (e.target.closest('input, select, button, textarea')) {
      e.preventDefault()
      return
    }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    setDragState({ draggedIndex: index, overIndex: null, edge: null })
  }
  const handleDragOver = (index) => (e) => {
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const edge = (e.clientY - rect.top) < rect.height / 2 ? 'above' : 'below'
    setDragState((s) => (s ? { ...s, overIndex: index, edge } : s))
  }
  const handleDragEnd = () => setDragState(null)
  const handleDrop = (index) => (e) => {
    e.preventDefault()
    const state = dragState
    setDragState(null)
    if (!state || !layer || state.draggedIndex === index) return
    const from = state.draggedIndex
    let to = index + (state.edge === 'below' ? 1 : 0)
    if (to > from) to -= 1
    if (to === from) return
    reorderOp(layer.id, from, to)
  }

  // Same shared-UndoManager gating SandboxStatusBar's own buttons use — the
  // undo stack belongs to the engine, not this panel, and is shared with the
  // Timeline.
  const canUndo = history.canUndo && history.undoDomain === 'sandbox'
  const canRedo = history.canRedo && history.redoDomain === 'sandbox'
  const undoTitle = !history.canUndo
    ? 'Nothing to undo'
    : canUndo ? `Undo ${history.undoDescription}` : `Next undo is a ${history.undoDomain} edit (${history.undoDescription})`
  const redoTitle = !history.canRedo
    ? 'Nothing to redo'
    : canRedo ? `Redo ${history.redoDescription}` : `Next redo is a ${history.redoDomain} edit (${history.redoDescription})`

  return (
    <div className="sandbox-stack-panel">
      <div className="sandbox-panel-header sandbox-stack-header">
        <span>Op Stack</span>
        <div className="sandbox-stack-undo-group">
          <button className="sandbox-undo-btn" disabled={!canUndo} onClick={() => undo()} title={undoTitle}>↶</button>
          <button className="sandbox-undo-btn" disabled={!canRedo} onClick={() => redo()} title={redoTitle}>↷</button>
        </div>
        {layer && <span className="sandbox-op-count-chip">{layer.ops.length} OP{layer.ops.length === 1 ? '' : 'S'}</span>}
      </div>
      <div className="sandbox-op-list">
        {!layer && <div className="sandbox-empty-hint">No layer selected.</div>}
        {layer && layer.ops.length === 0 && (
          <div className="sandbox-empty-hint">No operations yet — add one from EFFECT ▾.</div>
        )}
        {layer?.ops.map((op, index) => (
          <OpModule
            key={op.id}
            op={op}
            index={index}
            layerId={layer.id}
            selected={op.id === selectedOpId}
            onSelect={handleSelectOp}
            onToggleBypass={handleToggleBypass}
            onRemove={removeOp}
            setOpParams={setOpParams}
            hasSelection={hasSelection}
            onLearnNoiseProfile={learnNoiseProfile}
            setGainEnvelopeFollower={setGainEnvelopeFollower}
            onClearSpectralPaint={clearSpectralPaint}
            refusedOps={layer.refusedOps}
            refusalReason={layer.refusalReason}
            dragging={dragState?.draggedIndex === index}
            dropEdge={dragState && dragState.overIndex === index ? dragState.edge : null}
            onDragStart={handleDragStart(index)}
            onDragOver={handleDragOver(index)}
            onDrop={handleDrop(index)}
            onDragEnd={handleDragEnd}
            sampleRate={layer.renderedBuffer?.sampleRate}
            numSamples={layer.renderedBuffer?.numSamples ?? 0}
            onReveal={handleReveal}
          />
        ))}
      </div>
    </div>
  )
}
