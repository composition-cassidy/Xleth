import { useEffect, useState, useCallback, useRef } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import RootNotePicker from './RootNotePicker.jsx'
import SamplerWaveform from './SamplerWaveform.jsx'
import EnvelopeEditor from './EnvelopeEditor.jsx'
import Knob from './Knob.jsx'
import LfoSection from './LfoSection.jsx'
import { tokenValue } from '../../theming/tokenValue.ts'

const WAVE_WIDTH = 800
const WAVE_HEIGHT = 158

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

const emptySettings = {
  rootNote: 60,
  delayMs: 0, attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1.0, releaseMs: 50,
  attackTension: 0, decayTension: 0, releaseTension: 0,
  pitchEnvEnabled: false, pitchEnvAmount: 0,
  pitchEnvDelayMs: 0, pitchEnvAttackMs: 0, pitchEnvHoldMs: 0,
  pitchEnvDecayMs: 0, pitchEnvSustain: 0, pitchEnvReleaseMs: 0,
  pitchEnvAttackTension: 0, pitchEnvDecayTension: 0, pitchEnvReleaseTension: 0,
  loopEnabled: false, loopStart: 0, loopEnd: 0,
  crossfadeEnabled: true,
  smpStart: 0, smpLength: 0, declickMs: 1.5,
  fadeInMs: 0, fadeOutMs: 0,
  crossfadeSamples: 5000,
  dcOffsetRemoved: false, normalized: false, polarityReversed: false, reversed: false,
  monoEnabled: false, portamentoEnabled: false, portamentoTimeMs: 100,
  arpEnabled: false, arpTempoSync: true, arpDivision: 8,
  arpFreeTimeMs: 125, arpGate: 0.8, arpRange: 1, arpDirection: 0,
  lfoVolEnabled: false, lfoVolAmount: 0, lfoVolSpeedHz: 1,
  lfoVolTempoSync: false, lfoVolTempoDivision: 4,
  lfoVolAttackMs: 0, lfoVolDelayMs: 0, lfoVolWaveform: [],
  lfoPanEnabled: false, lfoPanAmount: 0, lfoPanSpeedHz: 1,
  lfoPanTempoSync: false, lfoPanTempoDivision: 4,
  lfoPanAttackMs: 0, lfoPanDelayMs: 0, lfoPanWaveform: [],
  lfoPitchEnabled: false, lfoPitchAmount: 0, lfoPitchSpeedHz: 1,
  lfoPitchTempoSync: false, lfoPitchTempoDivision: 4,
  lfoPitchAttackMs: 0, lfoPitchDelayMs: 0, lfoPitchWaveform: [],
}

// ── Layout primitives styled per mock ─────────────────────────────────────
const SAMPLER_KNOB_APPEARANCE = {
  tickStyle: 'none',
  glyph: 'rotary-arrow',
  accentGlow: false,
}

function SamplerKnob(props) {
  return <Knob {...SAMPLER_KNOB_APPEARANCE} {...props} />
}

function Tabs({ tabs, active, onSelect, sm }) {
  return (
    <div className={`sampler-tabs${sm ? ' sampler-tabs--sm' : ''}`}>
      {tabs.map((t) => (
        <button
          type="button"
          key={t.id}
          onClick={() => onSelect(t.id)}
          className={`sampler-tab${active === t.id ? ' is-active' : ''}`}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
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

function SectionLabel({ children }) {
  return (
    <div className="sampler-section-label">{children}</div>
  )
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00.000'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${(seconds - minutes * 60).toFixed(3).padStart(6, '0')}`
}

function ProcessButton({ label, active, onClick, children }) {
  return (
    <button type="button" className={`sampler-process-button${active ? ' is-active' : ''}`} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function SamplerPanelContent({ regionId, onClose }) {
  const [tab, setTab] = useState('sample')
  const [envTab, setEnvTab] = useState('env')
  const [region, setRegion] = useState(null)
  const [audioInfo, setAudioInfo] = useState(null)
  const [settings, setSettings] = useState(emptySettings)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const fetchAll = useCallback(async () => {
    try {
      const [regions, ai] = await Promise.all([
        window.xleth?.timeline?.getRegions?.(),
        window.xleth?.timeline?.getRegionAudioInfo?.(regionId),
      ])
      const r = Array.isArray(regions) ? regions.find((x) => x.id === regionId) : null
      if (r) {
        setRegion(r)
        setSettings({
          rootNote: r.rootNote,
          delayMs: r.delayMs ?? 0,
          attackMs: r.attackMs,
          holdMs: r.holdMs ?? 0,
          decayMs: r.decayMs,
          sustain: r.sustain,
          releaseMs: r.releaseMs,
          attackTension: r.attackTension ?? 0,
          decayTension: r.decayTension ?? 0,
          releaseTension: r.releaseTension ?? 0,
          pitchEnvEnabled: !!r.pitchEnvEnabled,
          pitchEnvAmount: r.pitchEnvAmount ?? 0,
          pitchEnvDelayMs: r.pitchEnvDelayMs ?? 0,
          pitchEnvAttackMs: r.pitchEnvAttackMs ?? 0,
          pitchEnvHoldMs: r.pitchEnvHoldMs ?? 0,
          pitchEnvDecayMs: r.pitchEnvDecayMs ?? 0,
          pitchEnvSustain: r.pitchEnvSustain ?? 0,
          pitchEnvReleaseMs: r.pitchEnvReleaseMs ?? 0,
          pitchEnvAttackTension: r.pitchEnvAttackTension ?? 0,
          pitchEnvDecayTension: r.pitchEnvDecayTension ?? 0,
          pitchEnvReleaseTension: r.pitchEnvReleaseTension ?? 0,
          loopEnabled: r.loopEnabled,
          loopStart: r.loopStart,
          loopEnd: r.loopEnd,
          crossfadeEnabled: r.crossfadeEnabled ?? true,
          smpStart: r.smpStart ?? 0,
          smpLength: r.smpLength ?? 0,
          declickMs: r.declickMs ?? 1.5,
          fadeInMs: r.fadeInMs ?? 0,
          fadeOutMs: r.fadeOutMs ?? 0,
          crossfadeSamples: r.crossfadeSamples ?? 5000,
          dcOffsetRemoved: !!r.dcOffsetRemoved,
          normalized: !!r.normalized,
          polarityReversed: !!r.polarityReversed,
          reversed: !!r.reversed,
          monoEnabled: !!r.monoEnabled,
          portamentoEnabled: !!r.portamentoEnabled,
          portamentoTimeMs: r.portamentoTimeMs ?? 100,
          arpEnabled: !!r.arpEnabled,
          arpTempoSync: r.arpTempoSync !== false,
          arpDivision: r.arpDivision ?? 8,
          arpFreeTimeMs: r.arpFreeTimeMs ?? 125,
          arpGate: r.arpGate ?? 0.8,
          arpRange: r.arpRange ?? 1,
          arpDirection: r.arpDirection ?? 0,
          lfoVolEnabled: !!r.lfoVolEnabled,
          lfoVolAmount: r.lfoVolAmount ?? 0,
          lfoVolSpeedHz: r.lfoVolSpeedHz ?? 1,
          lfoVolTempoSync: !!r.lfoVolTempoSync,
          lfoVolTempoDivision: r.lfoVolTempoDivision ?? 4,
          lfoVolAttackMs: r.lfoVolAttackMs ?? 0,
          lfoVolDelayMs: r.lfoVolDelayMs ?? 0,
          lfoVolWaveform: Array.isArray(r.lfoVolWaveform) ? r.lfoVolWaveform : [],
          lfoPanEnabled: !!r.lfoPanEnabled,
          lfoPanAmount: r.lfoPanAmount ?? 0,
          lfoPanSpeedHz: r.lfoPanSpeedHz ?? 1,
          lfoPanTempoSync: !!r.lfoPanTempoSync,
          lfoPanTempoDivision: r.lfoPanTempoDivision ?? 4,
          lfoPanAttackMs: r.lfoPanAttackMs ?? 0,
          lfoPanDelayMs: r.lfoPanDelayMs ?? 0,
          lfoPanWaveform: Array.isArray(r.lfoPanWaveform) ? r.lfoPanWaveform : [],
          lfoPitchEnabled: !!r.lfoPitchEnabled,
          lfoPitchAmount: r.lfoPitchAmount ?? 0,
          lfoPitchSpeedHz: r.lfoPitchSpeedHz ?? 1,
          lfoPitchTempoSync: !!r.lfoPitchTempoSync,
          lfoPitchTempoDivision: r.lfoPitchTempoDivision ?? 4,
          lfoPitchAttackMs: r.lfoPitchAttackMs ?? 0,
          lfoPitchDelayMs: r.lfoPitchDelayMs ?? 0,
          lfoPitchWaveform: Array.isArray(r.lfoPitchWaveform) ? r.lfoPitchWaveform : [],
        })
      }
      if (ai) setAudioInfo(ai)
    } catch (e) {
      console.warn('[SamplerPanelContent] fetch failed:', e.message)
    }
  }, [regionId])

  useEffect(() => {
    fetchAll()
    const onChanged = (e) => {
      if (e.detail?.regionId && e.detail.regionId !== regionId) return
      fetchAll()
    }
    timelineEvents.addEventListener('timeline-sampler-changed', onChanged)
    return () => timelineEvents.removeEventListener('timeline-sampler-changed', onChanged)
  }, [fetchAll, regionId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (regionId == null) return
    const KEY_MAP = {
      KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64,
      KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69, KeyJ: 70, KeyM: 71,
      KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76,
      KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81, Digit7: 82, KeyU: 83,
      KeyI: 84, Digit9: 85, KeyO: 86, Digit0: 87, KeyP: 88,
    }
    const held = new Set()
    const isTyping = () => {
      const el = document.activeElement
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
    }
    const onDown = (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return
      if (isTyping()) return
      const note = KEY_MAP[e.code]
      if (note == null || held.has(note)) return
      held.add(note)
      e.preventDefault()
      window.xleth?.timeline?.previewNote?.(regionId, note, 0.8)
    }
    const onUp = (e) => {
      const note = KEY_MAP[e.code]
      if (note == null || !held.has(note)) return
      held.delete(note)
      window.xleth?.timeline?.previewNoteOff?.(regionId, note)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      for (const note of held) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, note)
      }
    }
  }, [regionId])

  const commit = useCallback(async (partial) => {
    if (regionId == null) return
    try {
      await window.xleth?.timeline?.updateSamplerSettings(regionId, partial)
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: {} }))
    } catch (e) { console.warn('[SamplerPanelContent] updateSamplerSettings failed:', e.message) }
  }, [regionId])

  const setField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
  }, [])
  const setFields = useCallback((partial) => {
    setSettings((s) => ({ ...s, ...partial }))
  }, [])

  const commitField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
    commit({ [field]: val })
  }, [commit])

  const commitEnvelope = useCallback(() => {
    const s = settingsRef.current
    if (envTab === 'pitch') {
      commit({
        pitchEnvDelayMs: s.pitchEnvDelayMs, pitchEnvAttackMs: s.pitchEnvAttackMs,
        pitchEnvHoldMs: s.pitchEnvHoldMs, pitchEnvDecayMs: s.pitchEnvDecayMs,
        pitchEnvSustain: s.pitchEnvSustain, pitchEnvReleaseMs: s.pitchEnvReleaseMs,
        pitchEnvAttackTension: s.pitchEnvAttackTension,
        pitchEnvDecayTension: s.pitchEnvDecayTension,
        pitchEnvReleaseTension: s.pitchEnvReleaseTension,
      })
    } else {
      commit({
        delayMs: s.delayMs, attackMs: s.attackMs, holdMs: s.holdMs,
        decayMs: s.decayMs, sustain: s.sustain, releaseMs: s.releaseMs,
        attackTension: s.attackTension, decayTension: s.decayTension,
        releaseTension: s.releaseTension,
      })
    }
  }, [commit, envTab])

  const commitLoopPoints = useCallback(({ loopStart, loopEnd }) => {
    setFields({ loopStart, loopEnd })
    commit({ loopStart, loopEnd })
  }, [commit, setFields])

  const commitSmpPoints = useCallback(({ smpStart, smpLength }) => {
    setFields({ smpStart, smpLength })
    commit({ smpStart, smpLength })
  }, [commit, setFields])

  const numSamples = audioInfo?.numSamples || 0
  const sampleRate = audioInfo?.originalSampleRate || 48000
  // Flat parity: generic (non-modulation) knobs follow the app's flat teal
  // accent, matching the rest of the flat chrome. Per-modulation env/LFO knobs
  // keep their distinct color-coding via envColor below.
  const accentPanel = tokenValue('--xleth-flat-accent') || tokenValue('--theme-panel-mixer')
  const muted = 'var(--theme-text-muted)'
  const text = 'var(--theme-text)'
  const card = 'var(--theme-bg-elevated)'
  const border = 'var(--theme-border-subtle)'
  const lblStyle = { fontSize: 9, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }
  const sourceName = (audioInfo?.audioFilePath || '').split(/[\\/]/).pop() || ''
  const sourceDuration = audioInfo?.duration ?? (sampleRate > 0 ? numSamples / sampleRate : 0)

  const renderSample = () => (
    <div className="sampler-page sampler-page--sample">
      <section className="sampler-waveform-block">
        <div className="sampler-waveform-meta">
          <span className="sampler-waveform-name" title={sourceName}>{sourceName}</span>
          <span>{(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)}kHz &middot; {formatDuration(sourceDuration)}</span>
        </div>
        <div className="sampler-waveform-well">
          <SamplerWaveform
          regionId={regionId}
          numSamples={numSamples}
          loopEnabled={settings.loopEnabled}
          loopStart={settings.loopStart}
          loopEnd={settings.loopEnd || numSamples}
          onCommitLoopPoints={commitLoopPoints}
          smpStart={settings.smpStart}
          smpLength={settings.smpLength}
          declickMs={settings.declickMs}
          fadeInMs={settings.fadeInMs}
          fadeOutMs={settings.fadeOutMs}
          crossfadeSamples={settings.crossfadeSamples}
          sampleRate={sampleRate}
          onCommitSmpPoints={commitSmpPoints}
            width={WAVE_WIDTH}
            height={WAVE_HEIGHT}
            responsive
          />
        </div>
      </section>

      <div className="sampler-identity-row">
        <section className="sampler-card sampler-root-card">
          <SectionLabel>Root Note</SectionLabel>
          <RootNotePicker value={settings.rootNote} onChange={(midi) => commitField('rootNote', midi)} />
        </section>

        <section className="sampler-card sampler-mode-card">
          <SectionLabel>Mode</SectionLabel>
          <Seg
            opts={[{ v: false, l: 'One-shot' }, { v: true, l: 'Sustained' }]}
            val={!!settings.crossfadeEnabled}
            set={(value) => commitField('crossfadeEnabled', value)}
          />
        </section>

        <section className="sampler-range-card sampler-range-card--trim">
          <header><i /><span>Trim</span></header>
          <div className="sampler-range-knobs sampler-range-knobs--trim">
        <SamplerKnob
          label="SMP Start"
          value={settings.smpStart}
          min={0}
          max={Math.max(0, numSamples - 1)}
          defaultValue={0}
          size={42}
          color={accentPanel}
          onLiveChange={(v) => setField('smpStart', Math.round(v))}
          onCommit={(v) => commit({ smpStart: Math.round(v) })}
        />
        <SamplerKnob
          label="Length"
          value={settings.smpLength === 0 ? numSamples : settings.smpLength}
          min={0}
          max={numSamples}
          defaultValue={numSamples}
          size={42}
          color={accentPanel}
          formatValue={(v) => {
            const r = Math.round(v)
            return (numSamples === 0 || r >= numSamples) ? 'FULL' : String(r)
          }}
          onLiveChange={(v) => {
            const len = Math.round(v)
            setField('smpLength', len >= numSamples ? 0 : len)
          }}
          onCommit={(v) => {
            const len = Math.round(v)
            commit({ smpLength: len >= numSamples ? 0 : len })
          }}
        />
        <SamplerKnob
          label="In"
          value={settings.fadeInMs}
          min={0} max={5000} defaultValue={0}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${Math.round(v)}ms`}
          onLiveChange={(v) => setField('fadeInMs', Math.round(v))}
          onCommit={(v) => commit({ fadeInMs: Math.round(v) })}
        />
        <SamplerKnob
          label="Out"
          value={settings.fadeOutMs}
          min={0} max={5000} defaultValue={0}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${Math.round(v)}ms`}
          onLiveChange={(v) => setField('fadeOutMs', Math.round(v))}
          onCommit={(v) => commit({ fadeOutMs: Math.round(v) })}
        />
        <SamplerKnob
          label="Declick"
          value={settings.declickMs}
          min={0} max={10} step={0.1} defaultValue={1.5}
          size={42}
          color={accentPanel}
          formatValue={(v) => `${v.toFixed(1)}ms`}
          onLiveChange={(v) => setField('declickMs', Math.round(v * 10) / 10)}
          onCommit={(v) => commit({ declickMs: Math.round(v * 10) / 10 })}
        />
          </div>
        </section>

        <section className={`sampler-range-card sampler-range-card--loop${settings.loopEnabled ? '' : ' is-disabled'}`}>
          <header>
            <i /><span>Loop</span>
            <button type="button" className={settings.loopEnabled ? 'is-active' : ''} onClick={() => commitField('loopEnabled', !settings.loopEnabled)}>
              {settings.loopEnabled ? 'On' : 'Off'}
            </button>
          </header>
          <div className="sampler-range-knobs sampler-range-knobs--loop">
        <SamplerKnob
          label="XFade"
          value={settings.crossfadeSamples}
          min={0} max={5000} defaultValue={0}
          size={36}
          color="var(--sampler-loop)"
          formatValue={(v) => `${Math.round(v)}`}
          onLiveChange={(v) => setField('crossfadeSamples', Math.round(v))}
          onCommit={(v) => commit({ crossfadeSamples: Math.round(v) })}
        />
        <SamplerKnob
          label="Loop Start"
          value={settings.loopStart}
          min={0}
          max={Math.max(0, numSamples - 1)}
          defaultValue={0}
          size={36}
          color="var(--sampler-loop)"
          onLiveChange={(v) => setField('loopStart', Math.round(v))}
          onCommit={(v) => commit({ loopStart: Math.round(v) })}
        />
        <SamplerKnob
          label="Loop End"
          value={settings.loopEnd === 0 ? numSamples : settings.loopEnd}
          min={0}
          max={numSamples}
          defaultValue={numSamples}
          size={36}
          color="var(--sampler-loop)"
          formatValue={(v) => {
            const r = Math.round(v)
            return (numSamples === 0 || r >= numSamples) ? 'END' : String(r)
          }}
          onLiveChange={(v) => {
            const end = Math.round(v)
            setField('loopEnd', end >= numSamples ? 0 : end)
          }}
          onCommit={(v) => {
            const end = Math.round(v)
            commit({ loopEnd: end >= numSamples ? 0 : end })
          }}
        />
          </div>
        </section>
      </div>

      <section className="sampler-card sampler-process-card">
        <SectionLabel>Process (applies immediately)</SectionLabel>
        <div className="sampler-process-row">
          <ProcessButton label="Remove DC Offset" active={!!settings.dcOffsetRemoved} onClick={() => commitField('dcOffsetRemoved', !settings.dcOffsetRemoved)}><span aria-hidden>-</span></ProcessButton>
          <ProcessButton label="Normalize" active={!!settings.normalized} onClick={() => commitField('normalized', !settings.normalized)}><span aria-hidden>~</span></ProcessButton>
          <ProcessButton label="Reverse Polarity" active={!!settings.polarityReversed} onClick={() => commitField('polarityReversed', !settings.polarityReversed)}><span aria-hidden>+/-</span></ProcessButton>
          <ProcessButton label="Reverse" active={!!settings.reversed} onClick={() => commitField('reversed', !settings.reversed)}><span aria-hidden>&lt;&gt;</span></ProcessButton>
        </div>
      </section>
    </div>
  )

  const renderEnv = () => {
    const isPitch = envTab === 'pitch'
    const f = (name) => isPitch ? `pitchEnv${name[0].toUpperCase()}${name.slice(1)}` : name
    const envColor = isPitch
      ? tokenValue('--theme-sampler-mod-color-pitch')
      : tokenValue('--theme-sampler-mod-color-volume')
    const dimmed = isPitch && !settings.pitchEnvEnabled

    return (
      <div className="sampler-env-body">
        {isPitch && (
          <div className="sampler-control-rail sampler-control-rail--compact">
            <Chk val={settings.pitchEnvEnabled} set={(v) => commitField('pitchEnvEnabled', v)} label="Enable" />
            <SamplerKnob
              label="Amount"
              value={settings.pitchEnvAmount}
              min={-48} max={48} defaultValue={0}
              size={42}
              color={envColor}
              formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}st`}
              onLiveChange={(v) => setField('pitchEnvAmount', Number(v.toFixed(1)))}
              onCommit={(v) => commit({ pitchEnvAmount: Number(v.toFixed(1)) })}
            />
            <span style={{ fontSize: 9, color: muted }}>±48 semitones</span>
          </div>
        )}

        <div className={dimmed ? 'sampler-dimmed' : undefined}>
          <div className="sampler-env-grid">
            <div className="sampler-graph-well">
              <EnvelopeEditor
                delayMs={settings[f('delayMs')]}
                attackMs={settings[f('attackMs')]}
                holdMs={settings[f('holdMs')]}
                decayMs={settings[f('decayMs')]}
                sustain={settings[f('sustain')]}
                releaseMs={settings[f('releaseMs')]}
                attackTension={settings[f('attackTension')]}
                decayTension={settings[f('decayTension')]}
                releaseTension={settings[f('releaseTension')]}
                color={envColor}
                onLiveChange={(partial) => {
                  if (isPitch) {
                    const mapped = {}
                    for (const [k, v] of Object.entries(partial))
                      mapped[`pitchEnv${k[0].toUpperCase()}${k.slice(1)}`] = v
                    setFields(mapped)
                  } else {
                    setFields(partial)
                  }
                }}
                onCommit={commitEnvelope}
                width={520}
                height={120}
              />
            </div>

            <div className="sampler-knob-bank">
              <div className="sampler-knob-row">
                <SamplerKnob label="DEL" value={settings[f('delayMs')]} min={0} max={5000} defaultValue={0}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}`}
                  onLiveChange={(v) => setField(f('delayMs'), Math.round(v))}
                  onCommit={(v) => commit({ [f('delayMs')]: Math.round(v) })} />
                <SamplerKnob label="ATK" value={settings[f('attackMs')]} min={0} max={5000} defaultValue={0}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}`}
                  onLiveChange={(v) => setField(f('attackMs'), Math.round(v))}
                  onCommit={(v) => commit({ [f('attackMs')]: Math.round(v) })} />
                <SamplerKnob label="HLD" value={settings[f('holdMs')]} min={0} max={5000} defaultValue={0}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}`}
                  onLiveChange={(v) => setField(f('holdMs'), Math.round(v))}
                  onCommit={(v) => commit({ [f('holdMs')]: Math.round(v) })} />
                <SamplerKnob label="DEC" value={settings[f('decayMs')]} min={0} max={5000} defaultValue={0}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}`}
                  onLiveChange={(v) => setField(f('decayMs'), Math.round(v))}
                  onCommit={(v) => commit({ [f('decayMs')]: Math.round(v) })} />
                <SamplerKnob label="SUS" value={settings[f('sustain')] * 100} min={0} max={100}
                  defaultValue={isPitch ? 0 : 100}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}%`}
                  onLiveChange={(v) => setField(f('sustain'), Math.round(v) / 100)}
                  onCommit={(v) => commit({ [f('sustain')]: Math.round(v) / 100 })} />
                <SamplerKnob label="REL" value={settings[f('releaseMs')]} min={0} max={5000}
                  defaultValue={isPitch ? 0 : 50}
                  size={36} color={envColor} formatValue={(v) => `${Math.round(v)}`}
                  onLiveChange={(v) => setField(f('releaseMs'), Math.round(v))}
                  onCommit={(v) => commit({ [f('releaseMs')]: Math.round(v) })} />
              </div>

              <div className="sampler-knob-row sampler-knob-row--tension">
                <SamplerKnob label="ATK T" value={settings[f('attackTension')]} min={-1} max={1} defaultValue={0}
                  size={28} dragRange={120} color={'var(--theme-accent)'} capStyle='soft-disk'
                  formatValue={(v) => v.toFixed(2)}
                  onLiveChange={(v) => setField(f('attackTension'), Number(v.toFixed(3)))}
                  onCommit={(v) => commit({ [f('attackTension')]: Number(v.toFixed(3)) })} />
                <SamplerKnob label="DEC T" value={settings[f('decayTension')]} min={-1} max={1} defaultValue={0}
                  size={28} dragRange={120} color={'var(--theme-accent)'} capStyle='soft-disk'
                  formatValue={(v) => v.toFixed(2)}
                  onLiveChange={(v) => setField(f('decayTension'), Number(v.toFixed(3)))}
                  onCommit={(v) => commit({ [f('decayTension')]: Number(v.toFixed(3)) })} />
                <SamplerKnob label="REL T" value={settings[f('releaseTension')]} min={-1} max={1} defaultValue={0}
                  size={28} dragRange={120} color={'var(--theme-accent)'} capStyle='soft-disk'
                  formatValue={(v) => v.toFixed(2)}
                  onLiveChange={(v) => setField(f('releaseTension'), Number(v.toFixed(3)))}
                  onCommit={(v) => commit({ [f('releaseTension')]: Number(v.toFixed(3)) })} />
                <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', paddingBottom: 10 }}>
                  <span style={{ ...lblStyle, fontSize: 8 }}>Tension</span>
                </div>
              </div>
            </div>
          </div>

          {/* Embedded LFO sub-section — only relevant under Env tab */}
        </div>
      </div>
    )
  }

  const renderPlayback = () => {
    const arpDirIdx = Math.max(0, Math.min(3, settings.arpDirection ?? 0))
    const arpDirId = ARP_DIRS[arpDirIdx]
    return (
      <div className="sampler-page sampler-page--playback">
        <div className="sampler-playback-grid sampler-voice-panel">
          {/* Voice + Portamento */}
          <div className="sampler-module sampler-voice-module" style={{ minWidth: 148 }}>
            <SectionLabel>Voice</SectionLabel>
            <Seg
              opts={[{ v: 'mono', l: 'Mono' }, { v: 'poly', l: 'Poly' }]}
              val={settings.monoEnabled ? 'mono' : 'poly'}
              set={(v) => commitField('monoEnabled', v === 'mono')}
            />
            <SamplerKnob
              value={settings.portamentoTimeMs}
              min={0} max={2000} defaultValue={0}
              size={48}
              color={settings.portamentoTimeMs > 0 ? accentPanel : 'var(--theme-text-muted)'}
              label="Porta Time"
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

        {/* Envelope + LFO card */}
        <div className="sampler-module sampler-env-module">
          <Tabs
            tabs={[{ id: 'env', label: 'Envelope' }, { id: 'pitch', label: 'Pitch Envelope' }]}
            active={envTab}
            onSelect={setEnvTab}
            sm
          />
          <div style={{ marginTop: 10 }}>
            {renderEnv()}
          </div>
        </div>
        <div className="sampler-module sampler-lfo-module">
          <LfoSection settings={settings} setField={setField} setFields={setFields} commit={commit} />
        </div>
      </div>
    )
  }

  return (
    <div className="sampler-panel-body">
      <div className="sampler-panel-tabbar">
        <div className="sampler-panel-tabs">
          <Tabs
            tabs={[{ id: 'sample', label: 'Sample' }, { id: 'playback', label: 'Playback' }]}
            active={tab}
            onSelect={setTab}
          />
        </div>
      </div>
      <div className="sampler-panel-scroll">
        <div className="sampler-panel-content">
          {tab === 'sample' ? renderSample() : renderPlayback()}
        </div>
      </div>
    </div>
  )
}
