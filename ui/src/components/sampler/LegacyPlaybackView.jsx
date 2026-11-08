import { tokenValue } from '../../theming/tokenValue.ts'
import Knob from './Knob.jsx'
import PreviewRoutingControl from './PreviewRoutingControl.jsx'
import { useModTarget } from './modulation/useModTarget.js'
import { TARGET_SLOT_MANGLE_AMOUNT, TARGET_SLOT_MANGLE_MIX } from './modulation/modTargets.js'
import {
  MANGLE_OFF, MANGLE_MAX, MANGLE_GROUPS, mangleAmountIsBipolar, mangleInstanceActive,
  displayChain, mangleChainHint,
} from './mangleModes.js'

// TEMPORARY (round 2, step 11b): the Playback view and the Mangle chain as they
// were, moved out of SamplerPanelContent while the Main view is rebuilt. Step 11c
// replaces this whole file with kit section strips and deletes it.

const ARP_DIRS = ['up', 'down', 'updown', 'sticky']
const ARP_DIR_TITLES = { up: 'Up', down: 'Down', updown: 'Up + Down', sticky: 'Sticky' }
const ARP_DIR_ICONS = {
  up:     <path d="M7,11 L7,4 M4,7 L7,4 L10,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  down:   <path d="M7,4 L7,11 M4,8 L7,11 L10,8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  updown: <path d="M7,2 L7,13 M4,5 L7,2 L10,5 M4,10 L7,13 L10,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  sticky: <path d="M4,3 L7,1 L10,3 M7,1 L7,7 M4,12 L7,14 L10,12 M7,14 L7,8 M5,7.5 L9,7.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
}

const TDIVS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64']
const TDIV_VALUES = { '1/1': 1, '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32, '1/64': 64 }
const TDIV_LABELS = { 1: '1/1', 2: '1/2', 4: '1/4', 8: '1/8', 16: '1/16', 32: '1/32', 64: '1/64' }

// Voice count is clamped to the engine's [1, 32] polyphony window.
const clampVoiceCount = (v) => {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return 32
  return Math.max(1, Math.min(32, n))
}

// The amp/pitch envelopes and three drawable LFOs are gone — ENV 1 is the amp

const SAMPLER_KNOB_APPEARANCE = {
  tickStyle: 'none',
  glyph: 'rotary-arrow',
  accentGlow: false,
}

// `modTarget` is the OPT-IN modulation registration. Every sampler knob routes
// through here, but only the ones that pass a registration become drop targets;
// the rest get `mod = null` and are the plain Knob they have always been.
function SamplerKnob({ modTarget, ...props }) {
  const mod = useModTarget(modTarget, { value: props.value, min: props.min, max: props.max })
  return <Knob {...SAMPLER_KNOB_APPEARANCE} {...props} mod={mod} />
}

function Seg({ opts, val, set, sm }) {
  return (
    <div className={`sampler-seg${sm ? ' sampler-seg--sm' : ''}`}>
      {opts.map((o) => (
        <button
          type="button"
          key={o.v}
          onClick={() => set(o.v)}
          className={`sampler-seg-option${val === o.v ? ' is-active' : ''}`}
        >
          {o.l}
        </button>
      ))}
    </div>
  )
}

function Chk({ val, set, label }) {
  return (
    <label className="sampler-check">
      <input
        type="checkbox"
        checked={!!val}
        onChange={(e) => set(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  )
}

function Sel({ val, set, opts }) {
  return (
    <select
      value={val}
      onChange={(e) => set(e.target.value)}
      className="sampler-select"
    >
      {opts.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  )
}

// Select over {v, l} pairs (Sel above is string-only, and PREP's options carry
// numeric engine ids that must survive the round trip).
function SelKV({ val, set, opts }) {
  return (
    <select
      value={String(val)}
      onChange={(e) => set(Number(e.target.value))}
      className="sampler-select"
    >
      {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
    </select>
  )
}

// Select over grouped {label, modes:[{v,l}]} — MANGLE's four families are what
// make a 36-entry list navigable, so the grouping is structural, not decor.
function SelGrouped({ val, set, groups, offLabel, className }) {
  return (
    <select
      value={String(val)}
      onChange={(e) => set(Number(e.target.value))}
      className={className || 'sampler-select'}
    >
      <option value={MANGLE_OFF}>{offLabel}</option>
      {groups.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.modes.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

function SectionLabel({ children }) {
  return (
    <div className="sampler-section-label">{children}</div>
  )
}

export default function LegacyPlaybackView({
  regionId, settings, selectedSlot, setField, setFields, commit, commitField,
  commitChainField, previewChainField, addMangleInstance, moveMangleInstance, removeMangleInstance,
}) {
  const accentPanel = tokenValue('--xleth-flat-accent') || tokenValue('--theme-panel-mixer')
  const muted = 'var(--theme-text-muted)'
  const text = 'var(--theme-text)'
  const card = 'var(--theme-bg-elevated)'
  const border = 'var(--theme-border-subtle)'
  const lblStyle = { fontSize: 9, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }
  const mangleChain = displayChain(settings.mangleChain)
  const mangleOn = mangleChain.some(mangleInstanceActive)
    const arpDirIdx = Math.max(0, Math.min(3, settings.arpDirection ?? 0))
    const arpDirId = ARP_DIRS[arpDirIdx]
    return (
      <div className="sampler-page sampler-page--playback">
        <div className="sampler-playback-grid sampler-voice-panel">
          {/* Voice — poly count / mono / legato / portamento */}
          <div className="sampler-module sampler-voice-module">
            <SectionLabel>Voice</SectionLabel>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', rowGap: 6 }}>
              <Seg
                opts={[{ v: 'mono', l: 'Mono' }, { v: 'poly', l: 'Poly' }]}
                val={settings.monoEnabled ? 'mono' : 'poly'}
                set={(v) => commitField('monoEnabled', v === 'mono')}
              />
              {/* POLY carries an editable voice count; MONO is a single voice. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, ...lblStyle,
                opacity: settings.monoEnabled ? 0.35 : 1,
                pointerEvents: settings.monoEnabled ? 'none' : undefined }}>
                Voices
                <input
                  type="number" min={1} max={32}
                  className="sampler-voice-count"
                  value={settings.voiceCount}
                  onChange={(e) => setField('voiceCount', clampVoiceCount(e.target.value))}
                  onBlur={(e) => commit({ voiceCount: clampVoiceCount(e.target.value) })}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                />
              </label>
            </div>
            <div style={{ marginTop: 8 }}>
              <Chk val={settings.legatoEnabled} set={(v) => commitField('legatoEnabled', v)} label="Legato" />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: 8, flexWrap: 'wrap', rowGap: 8 }}>
              <SamplerKnob
                value={settings.portamentoTimeMs}
                min={0} max={2000} defaultValue={0}
                size={44}
                color={settings.portamentoTimeMs > 0 ? accentPanel : 'var(--theme-text-muted)'}
                label="Porta"
                formatValue={(v) => `${Math.round(v)}ms`}
                onLiveChange={(v) => {
                  const ms = Math.round(v)
                  setFields({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 })
                }}
                onCommit={(v) => {
                  const ms = Math.round(v)
                  commit({ portamentoTimeMs: ms, portamentoEnabled: ms > 0 })
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={lblStyle}>Glide</span>
                <Seg
                  sm
                  opts={[{ v: 0, l: 'Always' }, { v: 1, l: 'Scaled' }]}
                  val={settings.portamentoMode ?? 0}
                  set={(v) => commitField('portamentoMode', v)}
                />
              </div>
              <SamplerKnob
                label="Curve"
                value={settings.portamentoCurve ?? 0}
                min={-1} max={1} defaultValue={0}
                size={28} dragRange={120} capStyle="soft-disk"
                color="var(--theme-accent)"
                formatValue={(v) => v.toFixed(2)}
                onLiveChange={(v) => setField('portamentoCurve', Number(v.toFixed(3)))}
                onCommit={(v) => commit({ portamentoCurve: Number(v.toFixed(3)) })}
              />
            </div>
          </div>

          {/* Arpeggiator */}
          <div className="sampler-module sampler-arp-module">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: text, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                Arpeggiator
              </span>
              <input
                type="checkbox"
                checked={settings.arpEnabled}
                onChange={(e) => commitField('arpEnabled', e.target.checked)}
                style={{ accentColor: 'var(--theme-accent)', cursor: 'pointer' }}
              />
            </div>
            <div className={settings.arpEnabled ? 'sampler-arp-controls' : 'sampler-arp-controls sampler-dimmed'}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...lblStyle, width: 62 }}>Range</span>
                <Seg
                  sm
                  opts={[1, 2, 3, 4].map((n) => ({ v: n, l: `${n} Oct` }))}
                  val={settings.arpRange}
                  set={(v) => commitField('arpRange', v)}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...lblStyle, width: 62 }}>Direction</span>
                <div style={{ display: 'flex', gap: 2 }}>
                  {ARP_DIRS.map((id, idx) => {
                    const active = arpDirId === id
                    return (
                      <div
                        key={id}
                        onClick={() => commitField('arpDirection', idx)}
                        title={ARP_DIR_TITLES[id]}
                        style={{
                          width: 28, height: 26,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: active ? 'var(--theme-accent)' : card,
                          color: active ? 'var(--theme-text-on-accent)' : muted,
                          border: `1px solid ${active ? 'var(--theme-accent)' : border}`,
                          borderRadius: 3,
                          cursor: 'pointer',
                        }}
                      >
                        <svg width={14} height={15} viewBox="0 0 14 15">{ARP_DIR_ICONS[id]}</svg>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...lblStyle, width: 62 }}>Time</span>
                {settings.arpTempoSync ? (
                  <Sel
                    val={TDIV_LABELS[settings.arpDivision] || '1/8'}
                    set={(v) => commitField('arpDivision', TDIV_VALUES[v])}
                    opts={TDIVS}
                  />
                ) : (
                  <SamplerKnob
                    value={settings.arpFreeTimeMs}
                    min={10} max={2000} defaultValue={125}
                    size={28}
                    capStyle='soft-disk'
                    color={accentPanel}
                    formatValue={(v) => `${Math.round(v)}ms`}
                    onLiveChange={(v) => setField('arpFreeTimeMs', Math.round(v))}
                    onCommit={(v) => commit({ arpFreeTimeMs: Math.round(v) })}
                  />
                )}
                <Chk val={settings.arpTempoSync} set={(v) => commitField('arpTempoSync', v)} label="Tempo Sync" />
                <SamplerKnob
                  label="Gate"
                  value={settings.arpGate * 100}
                  min={1} max={100} defaultValue={80}
                  size={28}
                  capStyle='soft-disk'
                  color={accentPanel}
                  formatValue={(v) => `${Math.round(v)}%`}
                  onLiveChange={(v) => setField('arpGate', Math.round(v) / 100)}
                  onCommit={(v) => commit({ arpGate: Math.round(v) / 100 })}
                />
              </div>
            </div>
          </div>
        </div>
        <section className={`sampler-range-card sampler-range-card--mangle${mangleOn ? '' : ' is-bypassed'}`}>
          <header>
            <i /><span>Mangle</span>
            {mangleOn && <span className="sampler-mangle-tag">per note</span>}
            {mangleChain.length < MANGLE_MAX && (
              <button
                type="button" className="sampler-mangle-add"
                aria-label="Add another MANGLE to the chain"
                title="Add another MANGLE to the chain"
                onClick={addMangleInstance}
              >+</button>
            )}
          </header>
          <div className="sampler-mangle-body">
            {/* One row per instance. The chain is an ordered stack — the output of
                instance N feeds N+1 — so reorder is audible. Each row: reorder /
                MODE / AMOUNT / MIX / bypass / remove; a "+" appends another. */}
            {mangleChain.map((inst, i) => {
              const instMode = inst.mode ?? 0
              const instActive = mangleInstanceActive(inst)
              const knobColor = instActive ? accentPanel : muted
              return (
                <div
                  key={i}
                  className={`sampler-mangle-inst${inst.bypass ? ' is-bypassed' : ''}${instActive ? ' is-active' : ''}`}
                >
                  <div className="sampler-mangle-order">
                    <button
                      type="button" className="sampler-mangle-move"
                      disabled={i === 0} aria-label="Move earlier in the chain"
                      title="Move earlier in the chain"
                      onClick={() => moveMangleInstance(i, -1)}
                    >&uarr;</button>
                    <button
                      type="button" className="sampler-mangle-move"
                      disabled={i === mangleChain.length - 1} aria-label="Move later in the chain"
                      title="Move later in the chain"
                      onClick={() => moveMangleInstance(i, 1)}
                    >&darr;</button>
                  </div>
                  <label className="sampler-prep-algo sampler-mangle-mode">
                    <span>Mode</span>
                    <SelGrouped
                      val={instMode}
                      set={(v) => commitChainField(i, 'mode', v)}
                      groups={MANGLE_GROUPS}
                      offLabel="Off"
                    />
                  </label>
                  <SamplerKnob
                    label="Amount"
                    modTarget={{ target: TARGET_SLOT_MANGLE_AMOUNT, index: selectedSlot, stage: i, scale: 0.01 }}
                    value={(inst.amount ?? 0) * 100}
                    min={0} max={100}
                    defaultValue={mangleAmountIsBipolar(instMode) ? 50 : 0}
                    size={42}
                    color={knobColor}
                    formatValue={(v) => `${Math.round(v)}%`}
                    onLiveChange={(v) => previewChainField(i, 'amount', Math.round(v) / 100)}
                    onCommit={(v) => commitChainField(i, 'amount', Math.round(v) / 100)}
                  />
                  <SamplerKnob
                    label="Mix"
                    modTarget={{ target: TARGET_SLOT_MANGLE_MIX, index: selectedSlot, stage: i, scale: 0.01 }}
                    value={(inst.mix ?? 1) * 100}
                    min={0} max={100} defaultValue={100}
                    size={42}
                    color={knobColor}
                    formatValue={(v) => `${Math.round(v)}%`}
                    onLiveChange={(v) => previewChainField(i, 'mix', Math.round(v) / 100)}
                    onCommit={(v) => commitChainField(i, 'mix', Math.round(v) / 100)}
                  />
                  <div className="sampler-mangle-inst-actions">
                    <button
                      type="button"
                      className={`sampler-mangle-bypass${inst.bypass ? '' : ' is-on'}`}
                      aria-pressed={!inst.bypass}
                      title={inst.bypass ? 'Bypassed — click to enable this instance'
                                         : 'Bypass this instance (skipped, at no cost)'}
                      onClick={() => commitChainField(i, 'bypass', !inst.bypass)}
                    >
                      {inst.bypass ? 'byp' : 'on'}
                    </button>
                    <button
                      type="button" className="sampler-mangle-remove"
                      aria-label="Remove this instance" title="Remove this instance"
                      onClick={() => removeMangleInstance(i)}
                    >&times;</button>
                  </div>
                </div>
              )
            })}
            <span className="sampler-prep-note sampler-mangle-note">{mangleChainHint(settings.mangleChain)}</span>
          </div>
        </section>
        {/* Auditioning routes through a track's effect rack so the keyboard
            preview sounds like the sample does in the arrangement. Moved here
            off the main tab: it is a per-session monitoring choice, not part of
            editing a sample, and on the main tab it was a full-width card
            sitting between the waveform and the controls that actually get
            used. */}
        <section className="sampler-card sampler-preview-routing-card">
          <SectionLabel>Preview monitoring</SectionLabel>
          <PreviewRoutingControl regionId={regionId} />
        </section>

        {/* The legacy Envelope / Pitch-Envelope / Vol-Pan-Pitch LFO cards used to
            live here. They are gone — ENV 1 is the amp envelope and every other
            envelope/LFO is a modulation source in the pull-out tray. */}
      </div>
    )
  }
