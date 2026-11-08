import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import {
  Button, DeviceSection, IconButton, Knob, Menu, MenuItem, MenuSeparator, NumberBox,
  SegmentedControl, Select, Toggle, formatValue,
} from '../../ui-kit'
import SamplerWaveform from './SamplerWaveform.jsx'
import { ModKnob, ModNumberBox } from './kitMod.jsx'
import {
  formatGainDb, formatOffset, formatPan, formatSamplePosition, formatTime, noteName,
  noteValueCodec, parseGainDb, parseNote, parseOffset, parsePan, parseSamplePosition,
  sampleCountText, samplesToMs, slotColorVar, slotColorVarName,
} from './samplerFormat.js'
import { slotDisplayName } from './SlotTabs.jsx'
import {
  TARGET_SLOT_VOLUME, TARGET_SLOT_PAN, TARGET_SLOT_SEM, TARGET_SLOT_FINE, TARGET_SLOT_COARSE,
  TARGET_ENV_STAGE_TIME,
} from './modulation/modTargets.js'
import {
  ENV_SOURCE_0, NOTE_VALUES, STAGE_DELAY, STAGE_ATTACK, STAGE_HOLD, STAGE_DECAY, STAGE_RELEASE,
} from './modulation/modConstants.js'
import useSamplerModulationStore from '../../stores/samplerModulationStore.js'
import styles from './Sampler.module.css'

// ── Main view ───────────────────────────────────────────────────────────────
// The waveform is the hero: a recessed g0 well drawn in the selected slot's
// identity colour, with the slot's own header row (name, source, root note,
// mute / solo, slot menu, snap and zoom). Beside it a fixed 240px column of
// per-slot pitch, level, prep and process. Below it, one row of section strips
// in signal order: Mode → Trim → Loop → Amp envelope. Everything fits the
// default dock height at 1080p (28 header + 305 body + 28 audition bar).

// PREP algorithms. Values are engine StretchMethod ids, the same five the
// timeline's clip stretch uses, ordered by how often they are the right answer.
export const PREP_ALGOS = [
  { value: 2, label: 'Rubber Band' },
  { value: 3, label: 'WSOLA' },
  { value: 1, label: 'TD-PSOLA' },
  { value: 5, label: 'WORLD' },
  { value: 4, label: 'Phase Vocoder' },
]

// SampleLoopMode: 0 = Forward, 1 = Ping-pong, 2 = Reverse.
const LOOP_MODES = [
  { value: 0, label: 'Forward', hint: 'Loop plays start to end, then jumps back' },
  { value: 1, label: 'Ping-pong', hint: 'Loop plays forward, then backward' },
  { value: 2, label: 'Reverse', hint: 'Loop plays end to start' },
]

// `crossfadeEnabled` is the sampler-level ONE-SHOT / SUSTAINED switch (engine
// Sampler::setCrossfadeMode), not a crossfade toggle. Labelled by what it does.
const MODE_OPTIONS = [
  { value: 'oneshot', label: 'One-shot', hint: 'Notes play to the end of the trim and ignore the loop' },
  { value: 'sustained', label: 'Sustained', hint: 'Notes follow their length and the loop plays while held' },
]
const MODE_HINT = 'Applies to every slot. One-shot: a note plays to the end of the trim, releasing a key does not stop it, and the loop is off (pattern notes still stop at their drawn length). Sustained: notes follow their length and the loop plays while a note is held.'

const PROCESS = [
  { field: 'dcOffsetRemoved', label: 'Remove DC', name: 'Remove DC offset', what: 'centres the waveform on zero' },
  { field: 'normalized', label: 'Normalize', name: 'Normalize', what: 'scales the peak to full level' },
  { field: 'polarityReversed', label: 'Polarity', name: 'Reverse polarity', what: 'flips the waveform upside down' },
  { field: 'reversed', label: 'Reverse', name: 'Reverse', what: 'plays the sample backwards' },
]

const ENV_STAGES = [
  { key: 'delay', label: 'Delay', stage: STAGE_DELAY },
  { key: 'attack', label: 'Attack', stage: STAGE_ATTACK },
  { key: 'hold', label: 'Hold', stage: STAGE_HOLD },
  { key: 'decay', label: 'Decay', stage: STAGE_DECAY },
]
const NOTE_CODEC = noteValueCodec(NOTE_VALUES)

// The strips need about this many px; below it the amp envelope folds to its
// title (it is Env 1, also edited in Modulation) so Mode, Trim and Loop stay whole.
const STRIPS_FULL_W = 1230

const round = (v) => Math.round(v)

// ── Pitch and level ───────────────────────────────────────────────────────────
function PitchLevel({ slot, slotIndex, disabled, onPreview, onCommit }) {
  const v = (f, d = 0) => Number(slot?.[f] ?? d)
  const box = (field, props) => (
    <ModNumberBox
      key={field}
      width={109}
      disabled={disabled}
      value={v(field, field === 'volume' ? 1 : 0)}
      onChange={(x) => onPreview(slotIndex, field, x)}
      onCommit={(x) => onCommit(slotIndex, field, x)}
      data-slot-field={field}
      {...props}
    />
  )
  const reg = (target) => ({ target, index: slotIndex, stage: 0, scale: 1 })
  return (
    <div className={styles.sideSection}>
      <DeviceSection title="Pitch and level" className={styles.sideStrip}>
        <div className={styles.grid2}>
          {/* Octave is deliberately not a modulation target: the engine has none. */}
          {box('octave', { label: 'Octave', min: -4, max: 4, step: 1, quantize: round, defaultValue: 0, bipolar: true,
            format: (x) => formatOffset(x, 'oct'), parse: parseOffset, pxPerRange: 160, hint: 'Transpose this slot by octaves' })}
          {box('semitone', { label: 'Semi', min: -12, max: 12, step: 1, quantize: round, defaultValue: 0, bipolar: true,
            format: (x) => formatOffset(x, 'st'), parse: parseOffset, pxPerRange: 192, modTarget: reg(TARGET_SLOT_SEM),
            hint: 'Transpose this slot in semitones' })}
          {box('fine', { label: 'Fine', min: -100, max: 100, step: 1, defaultValue: 0, bipolar: true,
            format: (x) => formatOffset(x, 'ct'), parse: parseOffset, modTarget: reg(TARGET_SLOT_FINE),
            hint: 'Fine tune this slot in cents' })}
          {box('coarse', { label: 'Coarse', min: -48, max: 48, step: 1, quantize: round, defaultValue: 0, bipolar: true,
            format: (x) => formatOffset(x, 'st'), parse: parseOffset, pxPerRange: 384, modTarget: reg(TARGET_SLOT_COARSE),
            hint: 'Coarse tune this slot in semitones (±4 octaves)' })}
          {box('volume', { label: 'Volume', min: 0, max: 2, step: 0.01, defaultValue: 1,
            format: formatGainDb, parse: parseGainDb, modTarget: reg(TARGET_SLOT_VOLUME),
            hint: 'Level of this slot. Linear gain 0 to 2 (up to +6.0 dB)' })}
          {box('pan', { label: 'Pan', min: -1, max: 1, step: 0.01, defaultValue: 0, bipolar: true,
            format: formatPan, parse: parsePan, modTarget: reg(TARGET_SLOT_PAN), hint: 'Stereo position of this slot' })}
        </div>
      </DeviceSection>
    </div>
  )
}

// ── Prep ──────────────────────────────────────────────────────────────────────
function Prep({ settings, busy, bypassed, onLive, onCommit }) {
  const status = busy ? 'Baking…' : (bypassed ? 'Unity, no bake' : null)
  return (
    <div className={styles.sideSection}>
      <DeviceSection
        title="Prep"
        className={styles.sideStrip}
        actions={(
          <>
            {status ? <span className={styles.caption} role="status">{status}</span> : null}
            <Button
              size="sm"
              disabled={bypassed}
              onClick={() => onCommit({ prepStretch: 1, prepShiftCents: 0 })}
              hint="Return to unity stretch and zero shift: the slot plays its raw sample with no bake"
            >Reset</Button>
          </>
        )}
      >
        <div className={styles.prepRow} data-bypassed={bypassed || undefined}>
          <Select
            size="sm"
            className={styles.prepAlgo}
            ariaLabel="Prep algorithm"
            value={settings.prepAlgorithm}
            options={PREP_ALGOS}
            onChange={(v) => onCommit({ prepAlgorithm: Number(v) })}
            hint="Stretch algorithm for the offline bake. The bake replaces the slot's playback copy; the file on disk is untouched."
          />
          <Knob
            label="Stretch"
            value={(settings.prepStretch ?? 1) * 100}
            min={25} max={400} defaultValue={100} unit="%" quantize={round}
            onChange={(x) => onLive({ prepStretch: Math.round(x) / 100 })}
            onCommit={(x) => onCommit({ prepStretch: Math.round(x) / 100 })}
            hint="Length of the baked sample, without changing pitch. 100 % = unchanged."
            data-field="prepStretch"
          />
          <Knob
            label="Shift"
            value={settings.prepShiftCents ?? 0}
            min={-2400} max={2400} defaultValue={0} step={1} quantize={round} bipolar
            format={(x) => formatOffset(x, 'ct')} parse={parseOffset}
            onChange={(x) => onLive({ prepShiftCents: Math.round(x) })}
            onCommit={(x) => onCommit({ prepShiftCents: Math.round(x) })}
            hint="Pitch of the baked sample in cents, without changing length (±2 octaves)"
            data-field="prepShiftCents"
          />
        </div>
      </DeviceSection>
    </div>
  )
}

// ── Process ───────────────────────────────────────────────────────────────────
function Process({ settings, onToggle }) {
  return (
    <div className={styles.sideSection}>
      <DeviceSection title="Process" className={styles.sideStrip}>
        <div className={styles.grid2}>
          {PROCESS.map((p) => (
            <Toggle
              key={p.field}
              size="sm"
              className={styles.fill}
              on={!!settings[p.field]}
              onChange={(next) => onToggle(p.field, next)}
              aria-label={p.name}
              hint={`${p.name}: ${p.what}. Rewrites this slot's playback copy, not the file. Click again, or Ctrl+Z, to undo.`}
              data-field={p.field}
            >{p.label}</Toggle>
          ))}
        </div>
      </DeviceSection>
    </div>
  )
}

// ── Amp envelope (Env 1) ──────────────────────────────────────────────────────
function AmpEnvelope({ folded, onFoldChange }) {
  const env = useSamplerModulationStore((s) => s.config?.envs?.[0])
  const previewEnv = useSamplerModulationStore((s) => s.previewEnv)
  const commitMod = useSamplerModulationStore((s) => s.commit)
  const hint = 'Env 1 is the amp envelope. Its curves, and tempo sync, are in Modulation.'

  if (!env) {
    return (
      <DeviceSection title="Amp envelope" folded={folded} onFoldChange={onFoldChange}>
        <span className={styles.caption}>Loading…</span>
      </DeviceSection>
    )
  }
  const sync = !!env.tempoSync
  const live = (patch) => previewEnv(0, patch)
  const done = (patch) => { previewEnv(0, patch); commitMod() }
  const stageReg = (stage) => ({ target: TARGET_ENV_STAGE_TIME, index: ENV_SOURCE_0, stage, scale: 1 })

  const time = ({ key, label, stage }) => (sync ? (
    <Knob
      key={key} label={label} codec={NOTE_CODEC} defaultValue={0}
      value={env[key]?.noteValue ?? 0}
      onChange={(x) => live({ [key]: { ...env[key], noteValue: Math.round(x) } })}
      onCommit={(x) => done({ [key]: { ...env[key], noteValue: Math.round(x) } })}
      hint={`${label}, as a note value at the project tempo. ${hint}`}
    />
  ) : (
    <ModKnob
      key={key} label={label} unit="ms" min={0} max={5000} defaultValue={0} quantize={round}
      modTarget={stageReg(stage)}
      value={env[key]?.ms ?? 0}
      onChange={(x) => live({ [key]: { ...env[key], ms: Math.round(x) } })}
      onCommit={(x) => done({ [key]: { ...env[key], ms: Math.round(x) } })}
      hint={`${label} time. ${hint}`}
    />
  ))

  return (
    <DeviceSection title="Amp envelope" folded={folded} onFoldChange={onFoldChange} data-section="amp">
      <div className={styles.knobRow}>
        {ENV_STAGES.map(time)}
        <Knob
          label="Sustain" unit="%" min={0} max={100} defaultValue={100} quantize={round}
          value={env.sustainPct ?? 100}
          onChange={(x) => live({ sustainPct: Math.round(x) })}
          onCommit={(x) => done({ sustainPct: Math.round(x) })}
          hint={`Sustain level while a note is held. ${hint}`}
        />
        {time({ key: 'release', label: 'Release', stage: STAGE_RELEASE })}
      </div>
    </DeviceSection>
  )
}

// ── Slot menu ─────────────────────────────────────────────────────────────────
function SlotMenu({ slotIndex, slotCount, maxSlots, busy, canPaste, actions }) {
  const [at, setAt] = useState(null)
  const btnRef = useRef(null)
  const isRegion = slotIndex === 0
  const full = slotCount >= maxSlots
  return (
    <>
      <IconButton
        ref={btnRef}
        size="sm"
        label={`Slot ${slotIndex + 1} actions`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={() => {
          const r = btnRef.current?.getBoundingClientRect()
          setAt(r ? { x: r.left, y: r.bottom } : { x: 0, y: 0 })
        }}
        hint="Load or replace audio, duplicate, copy and paste settings, rename, remove"
      >
        <MoreHorizontal aria-hidden="true" />
      </IconButton>
      {at ? (
        <Menu x={at.x} y={at.y} onClose={() => setAt(null)} label={`Slot ${slotIndex + 1} actions`}>
          <MenuItem disabled={busy} onSelect={actions.swap}>
            {isRegion ? 'Replace region audio…' : 'Replace slot audio…'}
          </MenuItem>
          <MenuItem disabled={busy || full} onSelect={actions.duplicate}>Duplicate slot</MenuItem>
          <MenuSeparator />
          <MenuItem disabled={busy} onSelect={actions.copy}>Copy settings</MenuItem>
          <MenuItem disabled={busy || !canPaste} onSelect={actions.paste}>Paste settings</MenuItem>
          <MenuItem onSelect={actions.rename}>Rename</MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={isRegion || busy} onSelect={actions.remove}>
            {isRegion ? 'Slot 1 holds the region sample' : 'Remove slot'}
          </MenuItem>
        </Menu>
      ) : null}
    </>
  )
}

// ── The view ──────────────────────────────────────────────────────────────────
export default function SamplerMainView({
  regionId, slots, slotIndex, maxSlots, settings, numSamples, sampleRate, sourceName, sourcePath,
  sourceDuration, slotBusy, canPaste, prepBusy, prepBypassed, autoBusy, autoResult, playPosition,
  snapZero, onSnapZero, waveView, onWaveViewChange, sampleDragRange, actions,
}) {
  const slot = slots[slotIndex] || {}
  const sr = sampleRate || 48000

  const stripsRef = useRef(null)
  const [stripsW, setStripsW] = useState(0)
  const [ampFoldUser, setAmpFoldUser] = useState(null)
  useEffect(() => {
    const el = stripsRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width || 0)
      setStripsW((cur) => (cur === w ? cur : w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const ampFolded = ampFoldUser ?? (stripsW > 0 && stripsW < STRIPS_FULL_W)

  // Sample-position knobs: the range stays absolute (so the readout and type-in
  // mean what they say); what scales with zoom is the TRAVEL, so a drag across
  // 180 px moves exactly one visible window, as on the waveform.
  const pos = (field, label, value, extra = {}) => (
    <Knob
      key={field}
      label={label}
      value={value}
      min={0}
      max={Math.max(1, extra.max ?? numSamples)}
      defaultValue={extra.defaultValue ?? 0}
      quantize={round}
      step={1}
      pxPerRange={sampleDragRange}
      format={extra.format ?? ((x) => formatSamplePosition(x, sr))}
      parse={(t) => parseSamplePosition(t, sr, { total: numSamples, sentinel: extra.sentinel })}
      onChange={extra.onChange}
      onCommit={extra.onCommit}
      hint={`${extra.hint} ${sampleCountText(value)}. Type a time, or a sample count with "smp".`}
      data-field={field}
    />
  )
  const lengthShown = settings.smpLength === 0 ? numSamples : settings.smpLength
  const loopEndShown = settings.loopEnd === 0 ? numSamples : settings.loopEnd
  const sustained = !!settings.crossfadeEnabled
  const zoomText = numSamples <= 0 ? '' : (waveView.len <= 0 || waveView.len >= numSamples
    ? 'Full' : formatTime(samplesToMs(waveView.len, sr)))

  return (
    <div className={styles.main} data-view="main">
      <div className={styles.left}>
        {/* ── Waveform well ─────────────────────────────────────────────── */}
        <div className={styles.well} style={{ '--slot-color': slotColorVar(slotIndex) }}>
          <div className={styles.wellHead}>
            <span className={styles.swatch} aria-hidden="true" />
            <span className={styles.wellName} data-hint={sourcePath || sourceName}>
              {slotIndex + 1} · {slotDisplayName(slot, slotIndex)}
            </span>
            <span className={styles.wellMeta} data-hint={`${sourceName} · ${sampleCountText(numSamples)}`}>
              {formatValue(sr, 'Hz')} · {formatTime((sourceDuration || 0) * 1000)}
            </span>
            <NumberBox
              label="Root"
              width={84}
              value={settings.rootNote ?? 60}
              min={0} max={127} step={1} quantize={round} defaultValue={60}
              pxPerRange={600}
              format={noteName} parse={parseNote}
              onChange={(x) => actions.setField('rootNote', Math.round(x))}
              onCommit={(x) => actions.commitField('rootNote', Math.round(x))}
              hint="Root note: the key that plays this slot at its own pitch. Type a note (C4) or drag."
              data-field="rootNote"
            />
            <div className={styles.flags}>
              <Toggle
                size="sm" className={styles.flag} on={!!slot.mute}
                onChange={() => actions.toggleSlotFlag(slotIndex, 'mute')}
                aria-label={`Mute slot ${slotIndex + 1}`} hint="Mute this slot. Its tab dims and shows a mute glyph."
              >M</Toggle>
              <Toggle
                size="sm" className={`${styles.flag} ${styles.solo}`} on={!!slot.solo}
                onChange={() => actions.toggleSlotFlag(slotIndex, 'solo')}
                aria-label={`Solo slot ${slotIndex + 1}`} hint="Solo this slot: only soloed slots play"
              >S</Toggle>
              <SlotMenu
                slotIndex={slotIndex} slotCount={slots.length} maxSlots={maxSlots}
                busy={slotBusy} canPaste={canPaste} actions={actions.slot}
              />
            </div>
            <span className={styles.spacer} />
            <div className={styles.wellTools} role="toolbar" aria-label="Waveform view">
              <Toggle
                size="sm" on={snapZero} onChange={onSnapZero}
                hint="Trim and loop handles snap to the nearest zero crossing on release. Hold Alt while dragging to place one exactly."
              >Snap</Toggle>
              <Button
                size="sm" disabled={numSamples === 0}
                onClick={() => waveView.api?.zoomToSelection?.()}
                hint="Zoom the waveform to the trim selection"
              >Zoom to trim</Button>
              <Button
                size="sm" disabled={!waveView.api?.zoomed}
                onClick={() => waveView.api?.zoomToFit?.()}
                hint="Show the whole sample (or double-click the waveform)"
              >Fit</Button>
              <span className={styles.zoomReadout} data-hint="Visible span of the sample">{zoomText}</span>
            </div>
          </div>
          <div className={styles.canvasHost}>
            <SamplerWaveform
              regionId={regionId}
              slotIndex={slotIndex}
              numSamples={numSamples}
              loopEnabled={settings.loopEnabled}
              loopStart={settings.loopStart}
              loopEnd={settings.loopEnd || numSamples}
              onCommitLoopPoints={actions.commitLoopPoints}
              smpStart={settings.smpStart}
              smpLength={settings.smpLength}
              declickMs={settings.declickMs}
              fadeInMs={settings.fadeInMs}
              fadeOutMs={settings.fadeOutMs}
              crossfadeSamples={settings.crossfadeSamples}
              sampleRate={sr}
              onCommitSmpPoints={actions.commitSmpPoints}
              width={800}
              height={160}
              responsive
              snapZero={snapZero}
              onViewChange={onWaveViewChange}
              playPosition={playPosition}
              colorVar={slotColorVarName(slotIndex)}
            />
          </div>
        </div>

        {/* ── Strips, in signal order ───────────────────────────────────── */}
        <div className={styles.strips} ref={stripsRef}>
          <DeviceSection title="Mode" data-section="mode">
            <SegmentedControl
              size="sm"
              label="Note mode"
              value={sustained ? 'sustained' : 'oneshot'}
              options={MODE_OPTIONS}
              onChange={(v) => actions.commitField('crossfadeEnabled', v === 'sustained')}
              hint={MODE_HINT}
              data-field="crossfadeEnabled"
            />
          </DeviceSection>

          <DeviceSection title="Trim" data-section="trim">
            <div className={styles.knobRow}>
              {pos('smpStart', 'Start', settings.smpStart, {
                max: Math.max(0, numSamples - 1),
                hint: 'Where playback starts.',
                onChange: (x) => actions.setField('smpStart', Math.round(x)),
                onCommit: (x) => actions.commit({ smpStart: Math.round(x) }),
              })}
              {pos('smpLength', 'Length', lengthShown, {
                defaultValue: numSamples,
                sentinel: 'full',
                format: (x) => (numSamples === 0 || Math.round(x) >= numSamples ? 'Full' : formatSamplePosition(x, sr)),
                hint: 'How much of the sample plays from Start.',
                onChange: (x) => { const l = Math.round(x); actions.setField('smpLength', l >= numSamples ? 0 : l) },
                onCommit: (x) => { const l = Math.round(x); actions.commit({ smpLength: l >= numSamples ? 0 : l }) },
              })}
              <Knob
                label="Fade in" unit="ms" min={0} max={5000} defaultValue={0} quantize={round}
                value={settings.fadeInMs}
                onChange={(x) => actions.setField('fadeInMs', Math.round(x))}
                onCommit={(x) => actions.commit({ fadeInMs: Math.round(x) })}
                hint="Linear fade-in from Start" data-field="fadeInMs"
              />
              <Knob
                label="Fade out" unit="ms" min={0} max={5000} defaultValue={0} quantize={round}
                value={settings.fadeOutMs}
                onChange={(x) => actions.setField('fadeOutMs', Math.round(x))}
                onCommit={(x) => actions.commit({ fadeOutMs: Math.round(x) })}
                hint="Linear fade-out before the end of the trim" data-field="fadeOutMs"
              />
              <Knob
                label="Declick" unit="ms" min={0} max={10} step={0.1} defaultValue={1.5}
                formatOptions={{ decimals: 1 }}
                quantize={(x) => Math.round(x * 10) / 10}
                value={settings.declickMs}
                onChange={(x) => actions.setField('declickMs', Math.round(x * 10) / 10)}
                onCommit={(x) => actions.commit({ declickMs: Math.round(x * 10) / 10 })}
                hint="Hann-window fade at both trim edges, so the cut never clicks" data-field="declickMs"
              />
            </div>
          </DeviceSection>

          <DeviceSection
            title="Loop"
            data-section="loop"
            actions={(
              <>
                {sustained ? null : <span className={styles.caption}>Needs Sustained</span>}
                <Button
                  size="sm"
                  onClick={actions.runAutoLoop}
                  disabled={autoBusy || numSamples === 0}
                  hint={autoResult?.text
                    ? `Auto loop: find a period-aligned, formant-stable loop inside the trim. Last result: ${autoResult.text}`
                    : 'Auto loop: find a period-aligned, formant-stable loop inside the trim (the whole sample if untrimmed), switch to Sustained and play it'}
                  data-field="autoLoop"
                >{autoBusy ? 'Auto…' : 'Auto'}</Button>
                <Toggle
                  size="sm" on={!!settings.loopEnabled}
                  onChange={(next) => actions.commitField('loopEnabled', next)}
                  aria-label="Loop"
                  hint="Loop the region between Start and End while a note is held (Sustained mode only)"
                  data-field="loopEnabled"
                >On</Toggle>
              </>
            )}
          >
            <div className={styles.loopBody} data-inactive={(!sustained || !settings.loopEnabled) || undefined}>
              <div className={styles.knobRow}>
                {pos('crossfadeSamples', 'Crossfade', settings.crossfadeSamples, {
                  max: 5000,
                  hint: 'Equal-power crossfade into the loop end, so the seam does not click.',
                  onChange: (x) => actions.setField('crossfadeSamples', Math.round(x)),
                  onCommit: (x) => actions.commit({ crossfadeSamples: Math.round(x) }),
                })}
                {pos('loopStart', 'Start', settings.loopStart, {
                  max: Math.max(0, numSamples - 1),
                  hint: 'Loop start.',
                  onChange: (x) => actions.setField('loopStart', Math.round(x)),
                  onCommit: (x) => actions.commit({ loopStart: Math.round(x) }),
                })}
                {pos('loopEnd', 'End', loopEndShown, {
                  defaultValue: numSamples,
                  sentinel: 'end',
                  format: (x) => (numSamples === 0 || Math.round(x) >= numSamples ? 'End' : formatSamplePosition(x, sr)),
                  hint: 'Loop end.',
                  onChange: (x) => { const e = Math.round(x); actions.setField('loopEnd', e >= numSamples ? 0 : e) },
                  onCommit: (x) => { const e = Math.round(x); actions.commit({ loopEnd: e >= numSamples ? 0 : e }) },
                })}
              </div>
              <div className={styles.loopSide}>
                <SegmentedControl
                  size="sm"
                  label="Loop direction"
                  value={settings.loopMode ?? 0}
                  options={LOOP_MODES}
                  onChange={(v) => actions.commitField('loopMode', v)}
                  data-field="loopMode"
                />
                <Toggle
                  size="sm" on={!!settings.exitLoopOnRelease}
                  onChange={(next) => actions.commitField('exitLoopOnRelease', next)}
                  hint="On release, finish the current loop pass and play on to the end of the trim"
                  data-field="exitLoopOnRelease"
                >Exit on release</Toggle>
              </div>
            </div>
          </DeviceSection>

          <AmpEnvelope folded={ampFolded} onFoldChange={setAmpFoldUser} />
        </div>
      </div>

      {/* ── Right column: this slot's pitch, level, prep, process ───────── */}
      <aside className={styles.side} aria-label={`Slot ${slotIndex + 1} settings`}>
        <PitchLevel
          slot={slot} slotIndex={slotIndex} disabled={slotBusy}
          onPreview={actions.previewSlotField} onCommit={actions.commitSlotField}
        />
        <Prep
          settings={settings} busy={prepBusy} bypassed={prepBypassed}
          onLive={actions.setFields} onCommit={actions.commitPrep}
        />
        <Process settings={settings} onToggle={actions.commitField} />
      </aside>
    </div>
  )
}
