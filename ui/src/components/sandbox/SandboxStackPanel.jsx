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
import { Button, Checkbox, IconButton, MINUS, NumberBox, PanelHeader, Select, Toggle } from '../../ui-kit'
import { useEffectMenuButton } from './SandboxMenuBar.jsx'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcDotsSixVertical = iconComponent('dots-six-vertical')
const IcFrameCorners = iconComponent('frame-corners')
const IcPlus = iconComponent('plus')
const IcTrash = iconComponent('trash')
const IcWarning = iconComponent('warning')

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

/** A lit key is also marked in text for assistive tech (aria-pressed) and the root carries a dot, so state is not colour alone. */
function AutotuneKeyboard({ rootPc, activePcs, onToggle }) {
  return (
    <div className={styles.keyboard} role="group" aria-label="Allowed notes">
      <div className={styles.keyboardWhites}>
        {KB_WHITE_PCS.map((pc) => (
          <button
            key={pc}
            type="button"
            className={styles.keyWhite}
            data-on={activePcs.includes(pc) || undefined}
            data-root={pc === rootPc || undefined}
            aria-pressed={activePcs.includes(pc)}
            aria-label={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
            onClick={() => onToggle(pc)}
            title={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
          />
        ))}
      </div>
      <div className={styles.keyboardBlacks}>
        {Object.entries(KB_BLACK_AFTER_WHITE).map(([pcStr, whiteIndex]) => {
          const pc = Number(pcStr)
          return (
            <button
              key={pc}
              type="button"
              style={{ left: `${((whiteIndex + 1) / KB_WHITE_PCS.length) * 100}%` }}
              className={styles.keyBlack}
              data-on={activePcs.includes(pc) || undefined}
              data-root={pc === rootPc || undefined}
              aria-pressed={activePcs.includes(pc)}
              aria-label={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
              onClick={() => onToggle(pc)}
              title={`${AUTOTUNE_KEY_NAME[pc]}${pc === rootPc ? ' (root)' : ''}`}
            />
          )
        })}
      </div>
    </div>
  )
}

/** A fade curve as the row names it: "equal power", not the enum key "equalPower". */
const curveName = (shape) => {
  const key = FADE_SHAPE_NAME[shape]
  return (FADE_SHAPES.find((s) => s.value === key)?.label ?? String(key ?? shape)).toLowerCase()
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
    case 'fade': {
      // A fade can sit anywhere (the engine fades [start, start + length)), so
      // the row says where, not only how long.
      const where = Number.isFinite(p.startSample)
        ? `${at(p.startSample)} → ${at(p.startSample + p.lengthSamples)}`
        : at(p.lengthSamples)
      return `${p.fadeIn ? 'in' : 'out'}, ${where}, ${curveName(p.shape)}`
    }
    case 'gain': {
      // endSample -1 is the engine's "to the end": a gain over the whole layer.
      const scope = p.endSample > p.startSample ? range(p.startSample, p.endSample) : 'whole layer'
      return p.normalize ? `normalize → ${p.targetPeakDb} dBFS, ${scope}` : `${signed(p.gainDb ?? 0)} dB, ${scope}`
    }
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
      return `@ ${at(p.atSample)}, ${at(p.lengthSamples)}, ${curveName(p.shape)}`
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

// One numeric op parameter: a kit NumberBox (drag it or type a value). It previews locally while dragging and
// COMMITS once on release, Enter or blur, so a drag across the range is one undoable edit and one re-render
// rather than one per tick — the contract the gain-envelope drag and the spectral-paint stroke follow.
// Three across in the sidebar. At the 64px these used to be, the label was cut to its first letter ("C…")
// beside the value it named.
const PARAM_W = 92

function Param({ label, value, onCommit, disabled, hint, ...range }) {
  return (
    <NumberBox
      label={label}
      width={PARAM_W}
      value={value}
      disabled={disabled}
      hint={label}
      hintMods={hint}
      onCommit={onCommit}
      {...range}
    />
  )
}

const signed = (v, suffix = '') => `${v >= 0 ? '+' : MINUS}${Math.abs(Math.round(v * 100) / 100)}${suffix}`
const fixed = (digits) => (v) => v.toFixed(digits).replace('-', MINUS)

const PITCH_MODE_OPTIONS = [
  { value: PITCH_MODE.preserve, label: 'Preserve length' },
  { value: PITCH_MODE.resample, label: 'Varispeed (resample)' },
]
const ENVELOPE_MODE_OPTIONS = [
  { value: 'absolute', label: '1 · Absolute' },
  { value: 'relative', label: '2 · Relative' },
]
const AUTOTUNE_MODE_OPTIONS = [
  { value: 'scale', label: 'Scale' },
  { value: 'manual', label: 'Manual' },
]
const AUTOTUNE_KEY_OPTIONS = AUTOTUNE_KEY_NAME.map((n, i) => ({ value: i, label: n }))
const AUTOTUNE_SCALE_OPTIONS = Object.entries(AUTOTUNE_SCALE_NAME).map(([v, n]) => ({ value: Number(v), label: n }))
const FADE_SHAPE_OPTIONS = FADE_SHAPES.map(({ value, label }) => ({ value, label }))

function Field({ label, children, title }) {
  return (
    <span className={styles.field} title={title}>
      <span className={styles.fieldLabel}>{label}</span>
      {children}
    </span>
  )
}

// Inline param editors shown beneath the SELECTED module only. Covers every
// op param this restructuring's spec calls out by name: envelope mode +
// attack/release, pitch, formant, declip threshold, denoise profile, and
// fade curves (FADE + CROSSFADE's shared shape enum). Every other op type
// (trim/cut/paste/splice/reverse) has no persistent knob — it was authored by
// drawing/re-drawing the tool that created it, so selecting one just
// highlights the row.
function InlineOpParamEditor({
  op, layerId, setOpParams, hasSelection, onLearnNoiseProfile, setGainEnvelopeFollower,
  onClearSpectralPaint, refusedOps, refusalReason,
}) {
  const p = op.params || {}

  if (op.type === 'pitch') {
    const resample = p.mode === PITCH_MODE.resample
    return (
      <div className={styles.params}>
        <Param
          label="Cents" min={-4800} max={4800} step={10} defaultValue={0} value={p.cents}
          format={(v) => signed(v, '¢')} quantize={Math.round}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, cents: v })}
        />
        <Field
          label="Mode"
          title="Preserve: hold the length, rebuild the spectrum (RubberBand). Varispeed: read the waveform faster or slower, so the length moves with the pitch — the tape or turntable move."
        >
          <Select
            size="sm" ariaLabel="Pitch mode" options={PITCH_MODE_OPTIONS}
            value={resample ? PITCH_MODE.resample : PITCH_MODE.preserve}
            onChange={(mode) => setOpParams(layerId, op.id, { ...p, mode: Number(mode) })}
          />
        </Field>
        {/* Disabled rather than hidden in varispeed: the toggle keeps its
            value across a mode flip (PitchParams retains it deliberately), so
            hiding it would make a setting that is still there look erased. */}
        <span
          title={resample
            ? 'Varispeed moves the formants with the pitch by definition — add a Formant shift op to move them back'
            : 'Keep the formant envelope where it started, so a big shift does not chipmunk the voice'}
        >
          <Checkbox
            checked={!!p.formantPreserve} disabled={resample}
            onChange={(formantPreserve) => setOpParams(layerId, op.id, { ...p, formantPreserve })}
          >
            Formant lock
          </Checkbox>
        </span>
      </div>
    )
  }
  if (op.type === 'formantShift') {
    return (
      <div className={styles.params}>
        <Param
          label="Cents" min={-4800} max={4800} step={10} defaultValue={0} value={p.cents}
          format={(v) => signed(v, '¢')} quantize={Math.round}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, cents: v })}
        />
      </div>
    )
  }
  if (op.type === 'declip') {
    return (
      <div className={styles.params}>
        <Param
          label="Threshold" min={0.5} max={1} step={0.01} format={fixed(2)} value={p.threshold}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, threshold: v })}
        />
        <Param
          label="Max run" min={1} max={4096} step={1} quantize={Math.round}
          format={(v) => `${Math.round(v)} smp`} value={p.maxRunSamples}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, maxRunSamples: v })}
        />
      </div>
    )
  }
  if (op.type === 'denoise') {
    return (
      <div className={styles.params}>
        <Param
          label="Reduction" min={0} max={60} step={1} unit="dB" quantize={Math.round} value={p.reductionDb}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, reductionDb: v })}
        />
        <Param
          label="Sensitivity" min={0} max={5} step={0.1} format={fixed(1)} value={p.sensitivity}
          onCommit={(v) => setOpParams(layerId, op.id, { ...p, sensitivity: v })}
        />
        {/* The "select region, then learn noise profile" gesture: commits
            whatever is currently selected as THIS op's noise region via the
            same generic setOpParams every other param edit in this file goes
            through, so it is undoable for free. */}
        <span title={hasSelection ? 'Learn a noise profile from the current selection' : 'Select a noise-only region first'}>
          <Button size="sm" disabled={!hasSelection} onClick={() => onLearnNoiseProfile(layerId, op.id)}>
            Learn noise profile
          </Button>
        </span>
      </div>
    )
  }
  if (op.type === 'gainEnvelope') {
    const follower = clampGainEnvelopeFollower(p)
    const isRelative = follower.mode === GAIN_ENVELOPE_MODE.relative
    return (
      <div className={styles.params}>
        <Field label="Mode" title="Mode 1: the drawn curve IS the gain. Mode 2: the drawn curve modulates the material's own detected dynamics.">
          <Select
            size="sm" ariaLabel="Envelope mode" options={ENVELOPE_MODE_OPTIONS}
            value={isRelative ? 'relative' : 'absolute'}
            onChange={(mode) => setGainEnvelopeFollower(layerId, {
              ...follower, mode: mode === 'relative' ? GAIN_ENVELOPE_MODE.relative : GAIN_ENVELOPE_MODE.absolute,
            })}
          />
        </Field>
        <Param
          label="Attack" unit="ms" step={0.5} disabled={!isRelative}
          min={GAIN_ENVELOPE_ATTACK_MS_MIN} max={GAIN_ENVELOPE_ATTACK_MS_MAX}
          value={follower.followerAttackMs}
          hint={isRelative ? undefined : 'Only used in Relative mode'}
          onCommit={(v) => setGainEnvelopeFollower(layerId, { ...follower, followerAttackMs: v })}
        />
        <Param
          label="Release" unit="ms" step={5} disabled={!isRelative}
          min={GAIN_ENVELOPE_RELEASE_MS_MIN} max={GAIN_ENVELOPE_RELEASE_MS_MAX}
          value={follower.followerReleaseMs}
          hint={isRelative ? undefined : 'Only used in Relative mode'}
          onCommit={(v) => setGainEnvelopeFollower(layerId, { ...follower, followerReleaseMs: v })}
        />
        <span className={styles.readout}>
          {(p.points || []).length} breakpoint{(p.points || []).length === 1 ? '' : 's'} — drawn on the waveform (Envelope tool)
        </span>
      </div>
    )
  }
  if (op.type === 'spectralPaint') {
    const dabs = p.dabs || []
    return (
      <div className={styles.params}>
        <span className={styles.readout}>
          {dabs.length} dab{dabs.length === 1 ? '' : 's'} — painted on the spectrogram (Paint tool, spectral view)
        </span>
        <span title="Remove every painted dab, leaving this op as an empty (pass-through) mask">
          <Button size="sm" disabled={dabs.length === 0} onClick={() => onClearSpectralPaint(layerId)}>Clear dabs</Button>
        </span>
      </div>
    )
  }
  if (op.type === 'autotune') {
    // The six controls plus scale/key. Each NumberBox previews locally and commits on release — the same
    // "one command per drag, not per mousemove" contract setGainEnvelope and the spectral-paint stroke follow,
    // so a drag is one undo step rather than fifty.
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
    // playing) rather than starting from a blank slate. Also doubles as MANUAL
    // mode's default snap set (SandboxWaveformCanvas.jsx's drawing handlers read
    // the same op params), so it stays live in both modes.
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
    const manualHint = isManual ? 'Not used in Manual mode' : undefined
    return (
      <div className={styles.params} data-wrap>
        {refusedOps > 0 && (
          <div className={styles.refusal}>
            <IcWarning size={14} aria-hidden="true" />
            <span>{refusalReason || 'Autotune declined this input.'}</span>
          </div>
        )}
        <Field label="Mode" title="Scale: quantize to the scale and key below. Manual: draw the target pitch curve directly on the graph.">
          <Select
            size="sm" ariaLabel="Autotune mode" options={AUTOTUNE_MODE_OPTIONS}
            value={isManual ? 'manual' : 'scale'}
            onChange={(mode) => set({ mode: mode === 'manual' ? 1 : 0 })}
          />
        </Field>
        <Field label="Key" title={custom ? 'A custom note set overrides scale and key' : undefined}>
          <Select
            size="sm" ariaLabel="Autotune key" options={AUTOTUNE_KEY_OPTIONS} value={p.key} disabled={custom}
            onChange={(key) => set({ key: Number(key) })}
          />
        </Field>
        <Field label="Scale" title={custom ? 'A custom note set overrides scale and key' : undefined}>
          <Select
            size="sm" ariaLabel="Autotune scale" options={AUTOTUNE_SCALE_OPTIONS} value={Number(p.scale)} disabled={custom}
            onChange={(scale) => set({ scale: Number(scale) })}
          />
        </Field>
        <Param label="Amount" unit="%" min={0} max={100} step={1} quantize={Math.round}
          value={p.correctionAmount} onCommit={(v) => set({ correctionAmount: v })} />
        <Param label="Retune" unit="ms" min={0} max={AUTOTUNE_MAX_RETUNE_MS} step={1} quantize={Math.round}
          value={p.retuneSpeedMs} onCommit={(v) => set({ retuneSpeedMs: v })} />
        <Param label="Smooth" unit="ms" min={0} max={AUTOTUNE_MAX_SMOOTHNESS_MS} step={1} quantize={Math.round}
          value={p.smoothnessMs} onCommit={(v) => set({ smoothnessMs: v })} />
        <Param label="Jumpiness" unit="%" min={0} max={100} step={1} quantize={Math.round}
          value={p.jumpiness} onCommit={(v) => set({ jumpiness: v })}
          disabled={isManual} hint={manualHint} />
        {/* holdMs == the jumpiness value itself (1% = 1ms, literal per the
            spec/CorrectionCurve.cpp) — shown as its own readout rather than
            folded into the control's unit, so both numbers stay visible while
            dragging. */}
        {!isManual && (
          <span className={styles.readout}>
            = {p.jumpiness}ms minimum hold before a note change is accepted
          </span>
        )}
        <Param label="Vibrato" unit="%" min={0} max={100} step={1} quantize={Math.round}
          value={p.preserveVibrato} onCommit={(v) => set({ preserveVibrato: v })}
          disabled={isManual} hint={manualHint} />
        {isManual && (
          <span className={styles.readout}>
            {(p.manualPoints || []).length} breakpoint{(p.manualPoints || []).length === 1 ? '' : 's'} — drawn on the pitch graph above (hold Alt to free-draw)
          </span>
        )}
        <div className={styles.keyboardRow}>
          <AutotuneKeyboard rootPc={p.key} activePcs={displayedPcs} onToggle={toggleNote} />
          {custom && (
            <span title="Drop the custom note set and go back to the scale and key preset">
              <Button size="sm" onClick={() => set({ allowedNotes: [] })}>Clear notes</Button>
            </span>
          )}
        </div>
      </div>
    )
  }
  if (op.type === 'gain') {
    return (
      <div className={styles.params}>
        <Checkbox checked={!!p.normalize} onChange={(normalize) => setOpParams(layerId, op.id, { ...p, normalize })}>
          Normalize
        </Checkbox>
        {p.normalize ? (
          <Param
            label="Target" min={-60} max={0} step={0.5} unit="dB" defaultValue={-1} value={p.targetPeakDb}
            onCommit={(v) => setOpParams(layerId, op.id, { ...p, targetPeakDb: v })}
          />
        ) : (
          <Param
            label="Gain" min={-60} max={60} step={0.5} unit="dB" defaultValue={0} value={p.gainDb}
            onCommit={(v) => setOpParams(layerId, op.id, { ...p, gainDb: v })}
          />
        )}
      </div>
    )
  }
  if (op.type === 'fade' || op.type === 'crossfade') {
    return (
      <div className={styles.params}>
        <Field label="Curve">
          <Select
            size="sm" ariaLabel="Fade curve" options={FADE_SHAPE_OPTIONS}
            value={FADE_SHAPE_NAME[p.shape] ?? 'equalPower'}
            onChange={(shape) => setOpParams(layerId, op.id, { ...p, shape: FADE_SHAPE[shape] })}
          />
        </Field>
      </div>
    )
  }
  return null
}

const HAS_INLINE_PARAMS = new Set([
  'pitch', 'formantShift', 'declip', 'denoise', 'gainEnvelope', 'fade', 'crossfade', 'spectralPaint', 'gain',
  'autotune',
])

/** "gainEnvelope" -> "Gain envelope" */
const opTypeLabel = (type) => {
  const spaced = String(type).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function OpModule({
  op, index, layerId, selected, onSelect, onToggleBypass, onRemove, setOpParams, hasSelection,
  onLearnNoiseProfile, setGainEnvelopeFollower, onClearSpectralPaint, refusedOps, refusalReason,
  dragging, dropEdge, onDragStart, onDragOver, onDrop, onDragEnd, sampleRate, numSamples, onReveal,
}) {
  // The refusal is a per-LAYER fact (only one op type can produce it today),
  // not per-op — shown on the AUTOTUNE row specifically since that's the op
  // it's actually about. A badge on the collapsed row so "declined, not
  // rendering garbage" is visible without expanding it; the full wording
  // lives in InlineOpParamEditor for when it is.
  const refused = op.type === 'autotune' && refusedOps > 0
  return (
    <div
      className={styles.op}
      data-bypassed={!op.enabled || undefined}
      data-selected={selected || undefined}
      data-dragging={dragging || undefined}
      data-drop={dropEdge || undefined}
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <div className={styles.opRow} data-op-row onClick={() => onSelect(op.id)}>
        <IcDotsSixVertical size={14} className={styles.grip} aria-hidden="true" />
        <span className={styles.opIndex}>{String(index + 1).padStart(2, '0')}</span>
        <div className={styles.opLabel}>
          <span className={styles.opType}>{opTypeLabel(op.type)}</span>
          <span className={styles.opParams} data-op-params>{describeParams(op, sampleRate)}</span>
        </div>
        {/* Point the waveform at what this entry actually does. Only offered for ops that HAVE a locatable
            range — see sandboxOpRange.js on why a whole-buffer op shows nothing rather than framing everything. */}
        {!!resolveOpRange(opSampleRange(op), numSamples) && (
          <IconButton
            size="sm" variant="ghost" label={`Zoom to ${opTypeLabel(op.type)} range`}
            hint="Zoom to range" hintMods="Zoom the waveform to the range this operation covers"
            onClick={(e) => { e.stopPropagation(); onReveal(op) }}
          >
            <IcFrameCorners />
          </IconButton>
        )}
        {refused && (
          <span className={styles.refusalBadge} title={refusalReason || 'Autotune declined this input.'}>
            <IcWarning size={14} aria-label="Autotune declined this input" />
          </span>
        )}
        <Toggle
          size="sm"
          on={!!op.enabled}
          aria-label={`${opTypeLabel(op.type)} ${op.enabled ? 'on' : 'bypassed'}`}
          hint={op.enabled ? 'Bypass' : 'Enable'}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onToggleBypass(layerId, op.id, op.enabled)}
        >
          {op.enabled ? 'On' : 'Off'}
        </Toggle>
        <IconButton
          size="sm" variant="ghost" label={`Remove ${opTypeLabel(op.type)}`} hint="Remove operation"
          onClick={(e) => { e.stopPropagation(); onRemove(layerId, op.id) }}
        >
          <IcTrash />
        </IconButton>
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

// The edit stack: every edit and effect applied to the ACTIVE layer, in the
// order the engine runs them. It sits directly under the layer list in the
// sidebar, so the two read as one hierarchy — a layer, then what has been done
// to it. Rows are listed, reordered (drag), bypassed, removed and edited in
// place here; the header's Add button opens the same Effects menu the action
// bar does (SandboxMenuBar.jsx, driven by sandboxEffectRegistry.js), because
// "add something" belongs where the result lands as well as where the commands
// live. Undo and redo moved to the action bar: they act on the whole Sandbox,
// not on this list.
export default function SandboxStackPanel({ onOpenAdvancedSeparation }) {
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
  const addMenu = useEffectMenuButton(onOpenAdvancedSeparation)
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

  return (
    <section className={styles.stack} aria-label="Edit stack">
      <PanelHeader
        title="Edit stack"
        meta={layer ? `${layer.ops.length} on ${layer.name}` : undefined}
      >
        <IconButton
          size="sm" label="Add an edit or effect" disabled={!layer}
          aria-haspopup="menu" aria-expanded={addMenu.open}
          onClick={addMenu.onClick}
          hint="Add an edit or effect"
          hintMods="Opens the Effects menu. New entries go to the end of the stack"
        >
          <IcPlus />
        </IconButton>
      </PanelHeader>
      {addMenu.menu}
      <div className={styles.opList}>
        {!layer && <div className={styles.empty}>No layer selected.</div>}
        {layer && layer.ops.length === 0 && (
          <div className={styles.empty}>
            Nothing applied yet. Every edit and effect lands here in order, where you can change, bypass, reorder or remove it.
          </div>
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
    </section>
  )
}
