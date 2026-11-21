import {
  DeviceSection, IconButton, Knob, NumberBox, Select, Toggle, formatValue,
} from '../../ui-kit'
import FieldSelect from './FieldSelect.jsx'
import { ModNumberBox } from './kitMod.jsx'
import PreviewRoutingControl from './PreviewRoutingControl.jsx'
import { PREP_ALGOS } from './SamplerMainView.jsx'
import { formatOffset, formatSigned2, formatTime, parseOffset } from './samplerFormat.js'
import {
  MANGLE_GROUPS, MANGLE_HINTS, MANGLE_MAX, MANGLE_OFF, displayChain, mangleAmountIsBipolar,
  mangleChainHint, mangleInstanceActive, mangleModeLabel,
} from './mangleModes.js'
import { TARGET_SLOT_MANGLE_AMOUNT, TARGET_SLOT_MANGLE_MIX } from './modulation/modTargets.js'
import styles from './Sampler.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowDown = iconComponent('arrow-down')
const IcArrowUp = iconComponent('arrow-up')
const IcPlus = iconComponent('plus')
const IcX = iconComponent('x')

// ── Playback view ───────────────────────────────────────────────────────────
// How notes become voices, in signal order: a row of Voice → Glide →
// Arpeggiator, then Per-note effects (Mangle, the selected slot's chain) on a row
// of its own, and one info row with the stretch details and where the audition
// is heard. Docked, the two rows sit side by side.

const ARP_DIRECTIONS = [
  { value: 0, label: 'Up' },
  { value: 1, label: 'Down' },
  { value: 2, label: 'Up and down' },
  { value: 3, label: 'Sticky' },
]
const ARP_RANGES = [1, 2, 3, 4].map((n) => ({ value: n, label: `${n} octave${n > 1 ? 's' : ''}` }))
const ARP_DIVISIONS = [1, 2, 4, 8, 16, 32, 64].map((d) => ({ value: d, label: `1/${d}` }))

const MANGLE_OPTIONS = [
  { value: MANGLE_OFF, label: 'Off' },
  ...MANGLE_GROUPS.flatMap((g) => g.modes.map((m) => ({ value: m.v, label: m.l, group: g.label }))),
]

const round = (v) => Math.round(v)

function MangleRow({ inst, index, count, slotIndex, actions }) {
  const mode = inst.mode ?? 0
  const active = mangleInstanceActive(inst)
  const n = index + 1
  return (
    <div className={styles.mangleRow} role="group" aria-label={`Mangle ${n}`} data-mangle-row={index} data-mode={mode} data-active={active || undefined}>
      <span className={styles.mangleIndex} aria-hidden="true">{n}</span>
      <Select
        size="sm"
        className={styles.mangleMode}
        ariaLabel={`Mangle ${n} mode`}
        value={mode}
        options={MANGLE_OPTIONS}
        onChange={(v) => actions.commitChainField(index, 'mode', Number(v))}
        hint={MANGLE_HINTS[mode] || (mode ? mangleModeLabel(mode) : 'Off: this instance passes the note through')}
      />
      <ModNumberBox
        label="Amount"
        width={104}
        value={(inst.amount ?? 0) * 100}
        min={0} max={100} unit="%" quantize={round}
        defaultValue={mangleAmountIsBipolar(mode) ? 50 : 0}
        bipolar={mangleAmountIsBipolar(mode)} centre={50}
        modTarget={{ target: TARGET_SLOT_MANGLE_AMOUNT, index: slotIndex, stage: index, scale: 0.01 }}
        onChange={(v) => actions.previewChainField(index, 'amount', Math.round(v) / 100)}
        onCommit={(v) => actions.commitChainField(index, 'amount', Math.round(v) / 100)}
        hint={mangleAmountIsBipolar(mode)
          ? 'Amount: sweeps the cutoff around the key-tracked base. 50 % is neutral.'
          : 'Amount: how hard this mode works. 0 % is off.'}
        data-mangle="amount"
      />
      <ModNumberBox
        label="Mix"
        width={88}
        value={(inst.mix ?? 1) * 100}
        min={0} max={100} unit="%" quantize={round} defaultValue={100}
        modTarget={{ target: TARGET_SLOT_MANGLE_MIX, index: slotIndex, stage: index, scale: 0.01 }}
        onChange={(v) => actions.previewChainField(index, 'mix', Math.round(v) / 100)}
        onCommit={(v) => actions.commitChainField(index, 'mix', Math.round(v) / 100)}
        hint="Mix: blend of this instance's output with its input"
        data-mangle="mix"
      />
      <Toggle
        size="sm"
        on={!inst.bypass}
        onChange={(on) => actions.commitChainField(index, 'bypass', !on)}
        aria-label={`Mangle ${n} on`}
        hint={inst.bypass ? 'Bypassed: skipped at no cost. Click to turn it on.' : 'On. Click to bypass this instance.'}
        data-mangle="on"
      >On</Toggle>
      <IconButton size="sm" label={`Move mangle ${n} earlier`} disabled={index === 0}
        onClick={() => actions.moveMangleInstance(index, -1)} data-mangle="up"
        hint="Move earlier in the chain (its modulation routes move with it)">
        <IcArrowUp aria-hidden="true" />
      </IconButton>
      <IconButton size="sm" label={`Move mangle ${n} later`} disabled={index === count - 1}
        onClick={() => actions.moveMangleInstance(index, 1)} data-mangle="down"
        hint="Move later in the chain (its modulation routes move with it)">
        <IcArrowDown aria-hidden="true" />
      </IconButton>
      <IconButton size="sm" label={`Remove mangle ${n}`} onClick={() => actions.removeMangleInstance(index)}
        data-mangle="remove" hint="Remove this instance and its modulation routes">
        <IcX aria-hidden="true" />
      </IconButton>
    </div>
  )
}

export default function SamplerPlaybackView({
  regionId, settings, slotIndex, sourceDuration, prepBusy, prepBypassed, actions,
}) {
  const s = settings
  const chain = displayChain(s.mangleChain)
  const mangleOn = chain.some(mangleInstanceActive)
  const sync = s.arpTempoSync !== false
  const algo = PREP_ALGOS.find((a) => a.value === s.prepAlgorithm)?.label ?? '—'
  const baked = (sourceDuration || 0) * (s.prepStretch ?? 1) * 1000

  return (
    <div className={styles.playback} data-view="playback">
      <div className={styles.sections}>
       <div className={styles.sectionRow}>
        <DeviceSection title="Voice" data-section="voice" className={styles.section}>
          <div className={styles.stack}>
            <FieldSelect
              label="Voicing" width={72} value={s.monoEnabled ? 'mono' : 'poly'}
              options={[{ value: 'mono', label: 'Mono' }, { value: 'poly', label: 'Poly' }]}
              onChange={(v) => actions.commitField('monoEnabled', v === 'mono')}
              hint="Mono: a new note takes over the last one. Poly: up to Voices notes at once."
              data-field="monoEnabled"
            />
            <NumberBox
              label="Voices" width={140} value={s.voiceCount ?? 32}
              min={1} max={32} step={1} quantize={round} defaultValue={32} pxPerRange={160}
              disabled={!!s.monoEnabled}
              onChange={(v) => actions.setField('voiceCount', Math.round(v))}
              onCommit={(v) => actions.commit({ voiceCount: Math.round(v) })}
              hint="Polyphony: how many notes sound at once (1 to 32). Mono plays one."
              data-field="voiceCount"
            />
            <Toggle
              size="sm" on={!!s.legatoEnabled}
              onChange={(next) => actions.commitField('legatoEnabled', next)}
              hint="Legato: an overlapping note continues the current one instead of restarting it"
              data-field="legatoEnabled"
            >Legato</Toggle>
          </div>
        </DeviceSection>

        <DeviceSection title="Glide" data-section="glide" className={styles.section}>
          <div className={styles.stack}>
            <div className={styles.knobRow}>
              <Knob
                label="Time" unit="ms" min={0} max={2000} defaultValue={0} quantize={round}
                value={s.portamentoTimeMs ?? 0}
                onChange={(v) => { const ms = Math.round(v); actions.setFields({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 }) }}
                onCommit={(v) => { const ms = Math.round(v); actions.commit({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 }) }}
                hint="Glide time between notes. 0 ms turns glide off."
                data-field="portamentoTimeMs"
              />
              <Knob
                label="Curve" min={-1} max={1} defaultValue={0} bipolar step={0.01}
                format={formatSigned2} parse={parseOffset}
                value={s.portamentoCurve ?? 0}
                onChange={(v) => actions.setField('portamentoCurve', Number(v.toFixed(3)))}
                onCommit={(v) => actions.commit({ portamentoCurve: Number(v.toFixed(3)) })}
                hint="Glide shape: negative starts fast, positive starts slow, 0 is linear"
                data-field="portamentoCurve"
              />
            </div>
            <FieldSelect
              label="Glide" width={84} value={s.portamentoMode ?? 0}
              options={[{ value: 0, label: 'Always' }, { value: 1, label: 'Scaled' }]}
              onChange={(v) => actions.commitField('portamentoMode', Number(v))}
              hint="Always: every note glides for the full time. Scaled: glide time scales with the interval."
              data-field="portamentoMode"
            />
          </div>
        </DeviceSection>

        <DeviceSection
          title="Arpeggiator"
          className={styles.section}
          data-section="arp"
          actions={(
            <>
            {s.arpEnabled ? null : <span className={styles.caption}>Off</span>}
            <Toggle
              size="sm" on={!!s.arpEnabled} aria-label="Arpeggiator"
              onChange={(next) => actions.commitField('arpEnabled', next)}
              hint="Arpeggiate held notes"
              data-field="arpEnabled"
            >On</Toggle>
            </>
          )}
        >
          <div className={styles.arpBody}>
            <div className={styles.stack}>
              <FieldSelect
                label="Range" value={s.arpRange ?? 1} options={ARP_RANGES}
                onChange={(v) => actions.commitField('arpRange', Number(v))} data-field="arpRange"
                hint="How many octaves the arpeggio spans"
              />
              <FieldSelect
                label="Direction" value={Math.max(0, Math.min(3, s.arpDirection ?? 0))}
                options={ARP_DIRECTIONS}
                onChange={(v) => actions.commitField('arpDirection', Number(v))} data-field="arpDirection"
                hint="Sticky holds the order the notes were played in"
              />
              <div className={styles.field}>
                <span className={styles.fieldLabel}>Rate</span>
                <Toggle
                  size="sm" on={sync}
                  onChange={(next) => actions.commitField('arpTempoSync', next)}
                  hint="Step length as a note value at the project tempo; off = milliseconds"
                  data-field="arpTempoSync"
                >Sync</Toggle>
                {sync ? (
                  <Select
                    size="sm" className={styles.arpRate} ariaLabel="Arpeggiator rate"
                    value={s.arpDivision ?? 8} options={ARP_DIVISIONS}
                    onChange={(v) => actions.commitField('arpDivision', Number(v))}
                    hint="Step length as a note value" data-field="arpDivision"
                  />
                ) : null}
              </div>
            </div>
            <div className={styles.knobRow}>
              {sync ? null : (
                <Knob
                  label="Rate" unit="ms" min={10} max={2000} defaultValue={125} quantize={round}
                  value={s.arpFreeTimeMs ?? 125}
                  onChange={(v) => actions.setField('arpFreeTimeMs', Math.round(v))}
                  onCommit={(v) => actions.commit({ arpFreeTimeMs: Math.round(v) })}
                  hint="Step length in milliseconds" data-field="arpFreeTimeMs"
                />
              )}
              <Knob
                label="Gate" unit="%" min={1} max={100} defaultValue={80} quantize={round}
                value={(s.arpGate ?? 0.8) * 100}
                onChange={(v) => actions.setField('arpGate', Math.round(v) / 100)}
                onCommit={(v) => actions.commit({ arpGate: Math.round(v) / 100 })}
                hint="How much of each step the note sounds" data-field="arpGate"
              />
            </div>
          </div>
        </DeviceSection>

       </div>

       <div className={styles.sectionRow}>
        <DeviceSection
          title="Per-note effects"
          className={styles.section}
          data-section="mangle"
          data-active={mangleOn || undefined}
          actions={(
            <>
              <span className={styles.caption}>{`Mangle · slot ${slotIndex + 1}${mangleOn ? ' · per note' : ''}`}</span>
              <IconButton
                size="sm" label="Add a mangle instance" disabled={chain.length >= MANGLE_MAX}
                onClick={actions.addMangleInstance} data-mangle="add"
                hint={chain.length >= MANGLE_MAX ? `The chain holds ${MANGLE_MAX} instances` : 'Add an instance to the end of the chain'}
              >
                <IcPlus aria-hidden="true" />
              </IconButton>
            </>
          )}
        >
          <div className={styles.mangleBody}>
            {chain.map((inst, i) => (
              <MangleRow key={i} inst={inst} index={i} count={chain.length} slotIndex={slotIndex} actions={actions} />
            ))}
            <span className={styles.caption} data-mangle="hint">{mangleChainHint(s.mangleChain)}</span>
          </div>
        </DeviceSection>
       </div>
      </div>

      <div className={styles.infoRow}>
        <span className={styles.caption} data-hint="Time stretch (Sample view) bakes this slot offline; the file on disk is untouched">
          {`Stretch: ${algo} · ${formatValue((s.prepStretch ?? 1) * 100, '%')} · ${formatOffset(s.prepShiftCents ?? 0, 'ct')} · ${formatTime((sourceDuration || 0) * 1000)} → ${formatTime(baked)} · ${prepBusy ? 'baking…' : (prepBypassed ? 'off' : 'baked')}`}
        </span>
        <span className={styles.spacer} />
        <PreviewRoutingControl regionId={regionId} />
      </div>
    </div>
  )
}
