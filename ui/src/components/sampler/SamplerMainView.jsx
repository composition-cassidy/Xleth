import {
  Button, DeviceSection, Knob, Select, Toggle, formatValue,
} from '../../ui-kit'
import FieldSelect from './FieldSelect.jsx'
import SamplerWaveform from './SamplerWaveform.jsx'
import {
  formatOffset, formatSamplePosition, formatTime, parseOffset, parseSamplePosition,
  sampleCountText, samplesToMs, slotColorVar, slotColorVarName,
} from './samplerFormat.js'
import { slotDisplayName } from './SlotTabs.jsx'
import styles from './Sampler.module.css'

// ── Sample view ─────────────────────────────────────────────────────────────
// The waveform is the hero: a recessed g0 well drawn in the selected slot's
// identity colour, under a file row (what is loaded, Replace, snap and zoom). It
// takes every pixel the window has left. Under it, two rows of titled sections:
// Trim and Loop (the two things drawn on the waveform), then Mode, Time stretch
// and Process. The rows wrap in a narrow window and sit beside the waveform when
// the Sampler is docked. Level and pitch are in the slot bar above every view;
// the amp envelope has the Envelope view.

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

const RELEASE_OPTIONS = [
  { value: 'loop', label: 'Keep looping' },
  { value: 'exit', label: 'Exit loop' },
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

const round = (v) => Math.round(v)

// ── Time stretch (the engine's PREP bake) ─────────────────────────────────────
function Prep({ settings, busy, bypassed, onLive, onCommit }) {
  const status = busy ? 'Baking…' : (bypassed ? 'Off' : null)
  return (
      <DeviceSection
        title="Time stretch"
        className={styles.section}
        data-section="prep"
        actions={(
          <>
            {status ? (
              <span
                className={styles.caption} role="status"
                data-hint={bypassed && !busy ? 'Off at 100 % stretch and 0 ct shift: the slot plays its raw sample' : undefined}
              >{status}</span>
            ) : null}
            <Button
              size="sm"
              disabled={bypassed}
              onClick={() => onCommit({ prepStretch: 1, prepShiftCents: 0 })}
              hint="Back to 100 % stretch and 0 ct shift: the slot plays its raw sample again"
            >Reset</Button>
          </>
        )}
      >
        <div className={styles.prepRow} data-bypassed={bypassed || undefined}>
          <Select
            size="sm"
            className={styles.prepAlgo}
            ariaLabel="Stretch algorithm"
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
  )
}

// ── Process ───────────────────────────────────────────────────────────────────
function Process({ settings, onToggle }) {
  return (
      <DeviceSection title="Process" className={styles.section} data-section="process">
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
  )
}

// ── The view ──────────────────────────────────────────────────────────────────
export default function SamplerMainView({
  regionId, slots, slotIndex, settings, numSamples, sampleRate, sourceName, sourcePath,
  sourceDuration, slotBusy, prepBusy, prepBypassed, autoBusy, autoResult, playPosition,
  snapZero, onSnapZero, waveView, onWaveViewChange, sampleDragRange, actions,
}) {
  const slot = slots[slotIndex] || {}
  const sr = sampleRate || 48000

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
      {/* ── Waveform well ───────────────────────────────────────────────── */}
      <div className={styles.well} style={{ '--slot-color': slotColorVar(slotIndex) }}>
        <div className={styles.wellHead}>
          <span className={styles.swatch} aria-hidden="true" />
          <span className={styles.wellName} data-hint={sourcePath || sourceName || slotDisplayName(slot, slotIndex)}>
            {sourceName || slotDisplayName(slot, slotIndex)}
          </span>
          <span className={styles.wellMeta} data-hint={sampleCountText(numSamples)}>
            {formatValue(sr, 'Hz')} · {formatTime((sourceDuration || 0) * 1000)}
          </span>
          <Button
            size="sm" disabled={slotBusy}
            onClick={actions.slot.swap}
            hint={slotIndex === 0
              ? "Load another audio file as the region's sample. Its settings, and every other slot, are kept."
              : 'Load another audio file into this slot. Its settings are kept. Or drop a file on the slot tab.'}
            data-field="replaceAudio"
          >Replace…</Button>
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

      {/* ── Sections: what is drawn on the waveform first, then the rest ───── */}
      <div className={styles.sections}>
        <div className={styles.sectionRow}>
          <DeviceSection title="Trim" data-section="trim" className={styles.section}>
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
            className={styles.section}
            actions={(
              <>
                {sustained
                  ? (settings.loopEnabled ? null : <span className={styles.caption}>Off</span>)
                  : <span className={styles.caption}>Needs Sustained</span>}
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
            <div className={styles.loopBody}>
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
                <FieldSelect
                  label="Direction"
                  value={settings.loopMode ?? 0}
                  options={LOOP_MODES}
                  onChange={(v) => actions.commitField('loopMode', Number(v))}
                  hint="Which way the loop plays"
                  data-field="loopMode"
                />
                <FieldSelect
                  label="On release"
                  value={settings.exitLoopOnRelease ? 'exit' : 'loop'}
                  options={RELEASE_OPTIONS}
                  onChange={(v) => actions.commitField('exitLoopOnRelease', v === 'exit')}
                  hint="What a held note does when its key is released"
                  data-field="exitLoopOnRelease"
                />
              </div>
            </div>
          </DeviceSection>

        </div>

        <div className={styles.sectionRow}>
          <DeviceSection title="Mode" data-section="mode" className={styles.section}>
            <FieldSelect
              label="Notes"
              width={104}
              value={sustained ? 'sustained' : 'oneshot'}
              options={MODE_OPTIONS}
              onChange={(v) => actions.commitField('crossfadeEnabled', v === 'sustained')}
              hint={MODE_HINT}
              data-field="crossfadeEnabled"
            />
          </DeviceSection>
          <Prep
            settings={settings} busy={prepBusy} bypassed={prepBypassed}
            onLive={actions.setFields} onCommit={actions.commitPrep}
          />
          <Process settings={settings} onToggle={actions.commitField} />
        </div>
      </div>
    </div>
  )
}
