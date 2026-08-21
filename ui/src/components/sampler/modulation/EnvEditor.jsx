import ModEnvPreview from './ModEnvPreview.jsx'
import { ModKnob, Seg, NoteSelect, Field } from './ModControls.jsx'
import {
  modTimeSeconds,
  STAGE_DELAY, STAGE_ATTACK, STAGE_HOLD, STAGE_DECAY, STAGE_RELEASE,
} from './modConstants.js'
import { TARGET_ENV_STAGE_TIME, TARGET_SRC_AMOUNT } from './modTargets.js'

// ── ENV editor ───────────────────────────────────────────────────────────────
// DAHDSR with a per-envelope ms/BPM toggle and per-segment tension, above a
// live read-only shape preview. `preview(patch)` mutates the config locally
// (drag), `commit()` sends it to the engine (mouseup / discrete change).

const STAGE_FIELDS = [
  { key: 'delay', label: 'DEL', stage: STAGE_DELAY },
  { key: 'attack', label: 'ATK', stage: STAGE_ATTACK },
  { key: 'hold', label: 'HLD', stage: STAGE_HOLD },
  { key: 'decay', label: 'DEC', stage: STAGE_DECAY },
]

// Sustain is deliberately absent from the registrations below: it is a LEVEL,
// not a time, and the engine rejects a route to it.
export default function EnvEditor({ env, color, bpm, preview, commit, source = null }) {
  const sync = !!env.tempoSync

  // Cross-modulation registrations for this envelope's own parameters. Stage
  // times are exponential-law targets in milliseconds, so they need no scaling;
  // OUT is a percent knob over a 0..1 parameter.
  const stageReg = (stage) =>
    (source == null ? null : { target: TARGET_ENV_STAGE_TIME, index: source, stage, scale: 1 })

  // Patch one nested ModTime field (ms in Hz mode, noteValue in BPM mode).
  const setTimeLive = (key, patch) => preview({ [key]: { ...env[key], ...patch } })
  const setTimeFinal = (key, patch) => { preview({ [key]: { ...env[key], ...patch } }); commit() }

  const secOf = (key) => modTimeSeconds(env[key], sync, bpm)
  const previewEnv = {
    delaySec: secOf('delay'),
    attackSec: secOf('attack'),
    holdSec: secOf('hold'),
    decaySec: secOf('decay'),
    releaseSec: secOf('release'),
    sustain: (env.sustainPct ?? 100) / 100,
    attackTension: env.attackTension || 0,
    decayTension: env.decayTension || 0,
    releaseTension: env.releaseTension || 0,
  }

  const renderTime = (key, label, stage) => {
    if (sync) {
      return (
        <Field key={key} label={label}>
          <NoteSelect val={env[key]?.noteValue ?? 0} set={(v) => setTimeFinal(key, { noteValue: v })} />
        </Field>
      )
    }
    return (
      <ModKnob
        key={key}
        label={label}
        modTarget={stageReg(stage)}
        value={env[key]?.ms ?? 0}
        min={0} max={5000} defaultValue={0}
        size={40}
        color={color}
        formatValue={(v) => `${Math.round(v)}`}
        onLiveChange={(v) => setTimeLive(key, { ms: Math.round(v) })}
        onCommit={(v) => setTimeFinal(key, { ms: Math.round(v) })}
      />
    )
  }

  return (
    <div className="sampler-mod-editor">
      <div className="sampler-mod-editor-head">
        <Seg
          sm
          opts={[{ v: false, l: 'ms' }, { v: true, l: 'BPM' }]}
          val={sync}
          set={(v) => { preview({ tempoSync: v }); commit() }}
          title="Envelope times in milliseconds or tempo-synced note values"
        />
        <div className="sampler-mod-head-spacer" />
        <ModKnob
          label="OUT"
          modTarget={source == null ? null : { target: TARGET_SRC_AMOUNT, index: source, stage: 0, scale: 0.01 }}
          value={(env.outputAmount ?? 1) * 100}
          min={0} max={100} defaultValue={100}
          size={34}
          color={color}
          formatValue={(v) => `${Math.round(v)}%`}
          onLiveChange={(v) => preview({ outputAmount: Math.round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: Math.round(v) / 100 }); commit() }}
        />
      </div>

      <div className="sampler-mod-graph-well">
        <ModEnvPreview env={previewEnv} color={color} width={460} height={120} />
      </div>

      <div className="sampler-mod-knob-row">
        {STAGE_FIELDS.map((s) => renderTime(s.key, s.label, s.stage))}
        <ModKnob
          label="SUS"
          value={env.sustainPct ?? 100}
          min={0} max={100} defaultValue={100}
          size={40}
          color={color}
          formatValue={(v) => `${Math.round(v)}%`}
          onLiveChange={(v) => preview({ sustainPct: Math.round(v) })}
          onCommit={(v) => { preview({ sustainPct: Math.round(v) }); commit() }}
        />
        {renderTime('release', 'REL', STAGE_RELEASE)}
      </div>

      <div className="sampler-mod-knob-row sampler-mod-knob-row--tension">
        <ModKnob
          label="ATK T" value={env.attackTension || 0} min={-1} max={1} defaultValue={0}
          size={28} dragRange={120} capStyle="soft-disk" color="var(--theme-accent)"
          formatValue={(v) => v.toFixed(2)}
          onLiveChange={(v) => preview({ attackTension: Number(v.toFixed(3)) })}
          onCommit={(v) => { preview({ attackTension: Number(v.toFixed(3)) }); commit() }}
        />
        <ModKnob
          label="DEC T" value={env.decayTension || 0} min={-1} max={1} defaultValue={0}
          size={28} dragRange={120} capStyle="soft-disk" color="var(--theme-accent)"
          formatValue={(v) => v.toFixed(2)}
          onLiveChange={(v) => preview({ decayTension: Number(v.toFixed(3)) })}
          onCommit={(v) => { preview({ decayTension: Number(v.toFixed(3)) }); commit() }}
        />
        <ModKnob
          label="REL T" value={env.releaseTension || 0} min={-1} max={1} defaultValue={0}
          size={28} dragRange={120} capStyle="soft-disk" color="var(--theme-accent)"
          formatValue={(v) => v.toFixed(2)}
          onLiveChange={(v) => preview({ releaseTension: Number(v.toFixed(3)) })}
          onCommit={(v) => { preview({ releaseTension: Number(v.toFixed(3)) }); commit() }}
        />
        <span className="sampler-mod-tension-caption">Tension</span>
      </div>
    </div>
  )
}
