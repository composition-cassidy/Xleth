import { Knob, NumberBox } from '../../../ui-kit'
import FieldSelect from '../FieldSelect.jsx'
import { ModKnob, ModNumberBox } from '../kitMod.jsx'
import { formatSigned2, noteValueCodec, parseOffset } from '../samplerFormat.js'
import ModEnvPreview from './ModEnvPreview.jsx'
import { useBoxSize } from './useBoxSize.js'
import {
  NOTE_VALUES, modTimeSeconds,
  STAGE_DELAY, STAGE_ATTACK, STAGE_HOLD, STAGE_DECAY, STAGE_RELEASE,
} from './modConstants.js'
import { TARGET_ENV_STAGE_TIME, TARGET_SRC_AMOUNT } from './modTargets.js'
import styles from '../Sampler.module.css'

// ── Env editor ───────────────────────────────────────────────────────────────
// DAHDSR with a per-envelope ms / tempo-sync switch and per-segment curve, around
// the live (read-only) shape preview. `preview(patch)` mutates the config locally
// while dragging; `commit()` sends it to the engine (release / discrete change).

const STAGES = [
  { key: 'delay', label: 'Delay', stage: STAGE_DELAY },
  { key: 'attack', label: 'Attack', stage: STAGE_ATTACK },
  { key: 'hold', label: 'Hold', stage: STAGE_HOLD },
  { key: 'decay', label: 'Decay', stage: STAGE_DECAY },
]
const NOTE_CODEC = noteValueCodec(NOTE_VALUES)
const round = (v) => Math.round(v)
const curve = (v) => Number(v.toFixed(3))

export default function EnvEditor({ env, color, bpm, preview, commit, source = null, label = 'Env' }) {
  const sync = !!env.tempoSync
  const [wellRef, size] = useBoxSize()

  // Stage times are exponential-law targets in milliseconds (no scaling); Out is a
  // percent control over a 0..1 parameter. Sustain is a LEVEL: the engine rejects
  // a route to it, so it is not registered.
  const stageReg = (stage) => (source == null ? null : { target: TARGET_ENV_STAGE_TIME, index: source, stage, scale: 1 })
  const live = (key, patch) => preview({ [key]: { ...env[key], ...patch } })
  const done = (key, patch) => { preview({ [key]: { ...env[key], ...patch } }); commit() }

  const secOf = (key) => modTimeSeconds(env[key], sync, bpm)
  const shape = {
    delaySec: secOf('delay'), attackSec: secOf('attack'), holdSec: secOf('hold'),
    decaySec: secOf('decay'), releaseSec: secOf('release'),
    sustain: (env.sustainPct ?? 100) / 100,
    attackTension: env.attackTension || 0,
    decayTension: env.decayTension || 0,
    releaseTension: env.releaseTension || 0,
  }

  const time = ({ key, label: name, stage }) => (sync ? (
    <Knob
      key={key} label={name} codec={NOTE_CODEC} defaultValue={0}
      value={env[key]?.noteValue ?? 0}
      onChange={(v) => live(key, { noteValue: round(v) })}
      onCommit={(v) => done(key, { noteValue: round(v) })}
      hint={`${name}, as a note value at the project tempo`}
      data-env-stage={key}
    />
  ) : (
    <ModKnob
      key={key} label={name} unit="ms" min={0} max={5000} defaultValue={0} quantize={round}
      modTarget={stageReg(stage)}
      value={env[key]?.ms ?? 0}
      onChange={(v) => live(key, { ms: round(v) })}
      onCommit={(v) => done(key, { ms: round(v) })}
      hint={`${name} time`}
      data-env-stage={key}
    />
  ))

  const curveBox = (field, name) => (
    <NumberBox
      key={field} label={name} width={124} min={-1} max={1} step={0.01} defaultValue={0} bipolar
      format={formatSigned2} parse={parseOffset}
      value={env[field] || 0}
      onChange={(v) => preview({ [field]: curve(v) })}
      onCommit={(v) => { preview({ [field]: curve(v) }); commit() }}
      hint={`${name}: bends the segment. Negative is fast-then-slow, positive slow-then-fast, 0 is linear.`}
      data-env-field={field}
    />
  )

  return (
    <div className={styles.editor} data-editor="env">
      <div className={styles.editorHead}>
        <FieldSelect
          label="Times in" width={124} value={sync ? 'sync' : 'ms'}
          options={[{ value: 'ms', label: 'Milliseconds' }, { value: 'sync', label: 'Note values' }]}
          onChange={(v) => { preview({ tempoSync: v === 'sync' }); commit() }}
          hint="Stage times in milliseconds, or as note values at the project tempo"
          data-env-field="tempoSync"
        />
        {curveBox('attackTension', 'Attack curve')}
        {curveBox('decayTension', 'Decay curve')}
        {curveBox('releaseTension', 'Release curve')}
        <span className={styles.spacer} />
        <ModNumberBox
          label="Out" width={96} min={0} max={100} unit="%" quantize={round} defaultValue={100}
          modTarget={source == null ? null : { target: TARGET_SRC_AMOUNT, index: source, stage: 0, scale: 0.01 }}
          value={(env.outputAmount ?? 1) * 100}
          onChange={(v) => preview({ outputAmount: round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: round(v) / 100 }); commit() }}
          hint="Output: scales everything this envelope drives"
          data-env-field="outputAmount"
        />
      </div>
      <div className={styles.editorWell} ref={wellRef} data-hint={`${label}: the shape this envelope makes (read-only; edit the stages below)`}>
        <ModEnvPreview env={shape} color={color} width={size.width} height={size.height} />
      </div>
      <div className={styles.knobRow}>
        {STAGES.map(time)}
        <Knob
          label="Sustain" unit="%" min={0} max={100} defaultValue={100} quantize={round}
          value={env.sustainPct ?? 100}
          onChange={(v) => preview({ sustainPct: round(v) })}
          onCommit={(v) => { preview({ sustainPct: round(v) }); commit() }}
          hint="Sustain level while a note is held"
          data-env-stage="sustain"
        />
        {time({ key: 'release', label: 'Release', stage: STAGE_RELEASE })}
      </div>
    </div>
  )
}
