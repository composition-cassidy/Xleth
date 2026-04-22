import { useEffect, useState, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import { pitchLabel } from '../pianoRoll/PianoRollKeyboard.jsx'
import SamplerWaveform from './SamplerWaveform.jsx'
import EnvelopeEditor from './EnvelopeEditor.jsx'
import MiniKeyboard from './MiniKeyboard.jsx'
import Knob from './Knob.jsx'
import LfoSection from './LfoSection.jsx'
import { tokenValue } from '../../theming/tokenValue.ts'

const WAVE_WIDTH = 520
const WAVE_HEIGHT = 100

const emptySettings = {
  rootNote: 60,
  delayMs: 0, attackMs: 0, holdMs: 0, decayMs: 0, sustain: 1.0, releaseMs: 50,
  attackTension: 0, decayTension: 0, releaseTension: 0,
  pitchEnvEnabled: false, pitchEnvAmount: 0,
  pitchEnvDelayMs: 0, pitchEnvAttackMs: 0, pitchEnvHoldMs: 0,
  pitchEnvDecayMs: 0, pitchEnvSustain: 0, pitchEnvReleaseMs: 0,
  pitchEnvAttackTension: 0, pitchEnvDecayTension: 0, pitchEnvReleaseTension: 0,
  loopEnabled: false, loopStart: 0, loopEnd: 0,
  crossfadeEnabled: false,
  smpStart: 0, smpLength: 0,
  fadeInMs: 0, fadeOutMs: 0,
  crossfadeSamples: 0,
  dcOffsetRemoved: false, normalized: false, polarityReversed: false, reversed: false,
  monoEnabled: false, portamentoEnabled: false, portamentoTimeMs: 100,
  arpEnabled: false, arpTempoSync: true, arpDivision: 8,
  arpFreeTimeMs: 125, arpGate: 0.8, arpRange: 1, arpDirection: 0,
  // LFO — Volume
  lfoVolEnabled: false, lfoVolAmount: 0, lfoVolSpeedHz: 1,
  lfoVolTempoSync: false, lfoVolTempoDivision: 4,
  lfoVolAttackMs: 0, lfoVolDelayMs: 0, lfoVolWaveform: [],
  // LFO — Panning
  lfoPanEnabled: false, lfoPanAmount: 0, lfoPanSpeedHz: 1,
  lfoPanTempoSync: false, lfoPanTempoDivision: 4,
  lfoPanAttackMs: 0, lfoPanDelayMs: 0, lfoPanWaveform: [],
  // LFO — Pitch
  lfoPitchEnabled: false, lfoPitchAmount: 0, lfoPitchSpeedHz: 1,
  lfoPitchTempoSync: false, lfoPitchTempoDivision: 4,
  lfoPitchAttackMs: 0, lfoPitchDelayMs: 0, lfoPitchWaveform: [],
}

export default function SamplerPanel({ regionId, onClose }) {
  const [region, setRegion] = useState(null)
  const [audioInfo, setAudioInfo] = useState(null) // { audioFilePath, numSamples, ... }
  const [settings, setSettings] = useState(emptySettings)
  const [envTab, setEnvTab] = useState('volume')
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Fetch region (sampler settings live on the region) + audio info (by regionId)
  const fetchAll = useCallback(async () => {
    try {
      const [regions, ai] = await Promise.all([
        window.xleth?.timeline?.getRegions?.(),
        window.xleth?.timeline?.getRegionAudioInfo?.(regionId),
      ])
      const r = Array.isArray(regions)
        ? regions.find((x) => x.id === regionId)
        : null
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
          crossfadeEnabled: r.crossfadeEnabled,
          smpStart: r.smpStart ?? 0,
          smpLength: r.smpLength ?? 0,
          fadeInMs: r.fadeInMs ?? 0,
          fadeOutMs: r.fadeOutMs ?? 0,
          crossfadeSamples: r.crossfadeSamples ?? 0,
          dcOffsetRemoved: !!r.dcOffsetRemoved,
          normalized: !!r.normalized,
          polarityReversed: !!r.polarityReversed,
          reversed: !!r.reversed,
          // Playback modes
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
          // LFO — Volume
          lfoVolEnabled: !!r.lfoVolEnabled,
          lfoVolAmount: r.lfoVolAmount ?? 0,
          lfoVolSpeedHz: r.lfoVolSpeedHz ?? 1,
          lfoVolTempoSync: !!r.lfoVolTempoSync,
          lfoVolTempoDivision: r.lfoVolTempoDivision ?? 4,
          lfoVolAttackMs: r.lfoVolAttackMs ?? 0,
          lfoVolDelayMs: r.lfoVolDelayMs ?? 0,
          lfoVolWaveform: Array.isArray(r.lfoVolWaveform) ? r.lfoVolWaveform : [],
          // LFO — Panning
          lfoPanEnabled: !!r.lfoPanEnabled,
          lfoPanAmount: r.lfoPanAmount ?? 0,
          lfoPanSpeedHz: r.lfoPanSpeedHz ?? 1,
          lfoPanTempoSync: !!r.lfoPanTempoSync,
          lfoPanTempoDivision: r.lfoPanTempoDivision ?? 4,
          lfoPanAttackMs: r.lfoPanAttackMs ?? 0,
          lfoPanDelayMs: r.lfoPanDelayMs ?? 0,
          lfoPanWaveform: Array.isArray(r.lfoPanWaveform) ? r.lfoPanWaveform : [],
          // LFO — Pitch
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
      console.warn('[SamplerPanel] fetch failed:', e.message)
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

  // Esc to close
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose?.() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Computer-keyboard → MIDI preview (FL-style).
  //   Z-row naturals / A-row sharps  → octave 4
  //   QWERTY + number-row sharps     → octaves 5–6
  useEffect(() => {
    if (regionId == null) return
    // 'code' → MIDI note. Using e.code so layout stays stable regardless of
    // OS keyboard locale / shift state.
    const KEY_MAP = {
      // Octave 4 (Z row)
      KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64,
      KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69, KeyJ: 70, KeyM: 71,
      // Octave 5 (QWERTY + number row)
      KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76,
      KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81, Digit7: 82, KeyU: 83,
      // Octave 6
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
      // Release anything still held when the panel unmounts / regionId changes.
      for (const note of held) {
        window.xleth?.timeline?.previewNoteOff?.(regionId, note)
      }
    }
  }, [regionId])

  // Commit helper — sends partial settings via bridge.
  // Sampler settings are per-region (per-instrument), so we commit by regionId.
  const commit = useCallback(async (partial) => {
    if (regionId == null) return
    try {
      await window.xleth?.timeline?.updateSamplerSettings(regionId, partial)
      timelineEvents.dispatchEvent(new CustomEvent('timeline-sampler-changed', { detail: { regionId } }))
      // Also fire pattern-changed for any pattern-UI still listening (e.g. piano
      // roll playback follow-up) — sampler changes affect all patterns bound here.
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: {} }))
    } catch (e) { console.warn('[SamplerPanel] updateSamplerSettings failed:', e.message) }
  }, [regionId])

  // Local-state setters (no bridge write)
  const setField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
  }, [])
  const setFields = useCallback((partial) => {
    setSettings((s) => ({ ...s, ...partial }))
  }, [])

  // Commit a single field on blur/mouseup
  const commitField = useCallback((field, val) => {
    setSettings((s) => ({ ...s, [field]: val }))
    commit({ [field]: val })
  }, [commit])

  // Commit whole current envelope (on drag end)
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

  // Loop-point commit from waveform drag
  const commitLoopPoints = useCallback(({ loopStart, loopEnd }) => {
    setFields({ loopStart, loopEnd })
    commit({ loopStart, loopEnd })
  }, [commit, setFields])

  // Trim-point commit from waveform drag
  const commitSmpPoints = useCallback(({ smpStart, smpLength }) => {
    setFields({ smpStart, smpLength })
    commit({ smpStart, smpLength })
  }, [commit, setFields])

  const sourceName = (audioInfo?.audioFilePath || '').split(/[\\/]/).pop() || '—'

  // Filename row display — fall back to region name if no source
  const displayName = region?.name
    ? `${region.name}${sourceName !== '—' ? ` (${sourceName})` : ''}`
    : sourceName

  return (
    <>
      {/* Backdrop */}
      <div
        onMouseDown={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'rgba(0,0,0,0.55)',
          zIndex: 10,
        }}
      />
      {/* Modal card */}
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="sampler-panel"
        style={{
          position: 'absolute',
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 560,
          maxHeight: '90vh',
          background: 'var(--theme-bg-secondary)',
          border: '1px solid var(--theme-sampler-key-border)',
          borderRadius: 8,
          boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
          zIndex: 11,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: 'var(--theme-text)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center',
          padding: '8px 12px',
          borderBottom: '1px solid var(--theme-sampler-key-border)',
          background: 'var(--theme-bg-surface)',
        }}>
          <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>Sampler — {displayName}</span>
          <button
            onClick={onClose}
            title="Close (Esc)"
            style={{
              background: 'transparent', border: 'none', color: 'var(--theme-text-muted)',
              cursor: 'pointer', padding: 4, borderRadius: 4,
              display: 'flex', alignItems: 'center',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Scrollable body */}
        <div style={{ overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Section 1 — Sample */}
          <section className="sampler-panel-section">
            <h4 className="sampler-panel-label">Sample</h4>
            <SamplerWaveform
              regionId={regionId}
              numSamples={audioInfo?.numSamples || 0}
              loopEnabled={settings.loopEnabled}
              loopStart={settings.loopStart}
              loopEnd={settings.loopEnd || (audioInfo?.numSamples || 0)}
              onCommitLoopPoints={commitLoopPoints}
              smpStart={settings.smpStart}
              smpLength={settings.smpLength}
              declickSamples={64}
              fadeInMs={settings.fadeInMs}
              fadeOutMs={settings.fadeOutMs}
              crossfadeSamples={settings.crossfadeSamples}
              sampleRate={audioInfo?.originalSampleRate || 48000}
              onCommitSmpPoints={commitSmpPoints}
              width={WAVE_WIDTH} height={WAVE_HEIGHT}
            />
            {/* SMP START / LENGTH knobs */}
            <div style={{ display: 'flex', gap: 16, marginTop: 8, alignItems: 'flex-start' }}>
              <Knob
                label="SMP Start"
                value={settings.smpStart}
                min={0}
                max={Math.max(0, (audioInfo?.numSamples || 0) - 1)}
                defaultValue={0}
                onLiveChange={(v) => setField('smpStart', Math.round(v))}
                onCommit={(v) => commit({ smpStart: Math.round(v) })}
              />
              <Knob
                label="Length"
                value={settings.smpLength === 0 ? (audioInfo?.numSamples || 0) : settings.smpLength}
                min={0}
                max={audioInfo?.numSamples || 0}
                defaultValue={audioInfo?.numSamples || 0}
                formatValue={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const r = Math.round(v)
                  return (numS === 0 || r >= numS) ? 'FULL' : String(r)
                }}
                onLiveChange={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const len = Math.round(v)
                  setField('smpLength', len >= numS ? 0 : len)
                }}
                onCommit={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const len = Math.round(v)
                  commit({ smpLength: len >= numS ? 0 : len })
                }}
              />
              <Knob
                label="IN"
                value={settings.fadeInMs}
                min={0} max={5000} defaultValue={0}
                formatValue={(v) => `${Math.round(v)}ms`}
                onLiveChange={(v) => setField('fadeInMs', Math.round(v))}
                onCommit={(v) => commit({ fadeInMs: Math.round(v) })}
              />
              <Knob
                label="OUT"
                value={settings.fadeOutMs}
                min={0} max={5000} defaultValue={0}
                formatValue={(v) => `${Math.round(v)}ms`}
                onLiveChange={(v) => setField('fadeOutMs', Math.round(v))}
                onCommit={(v) => commit({ fadeOutMs: Math.round(v) })}
              />
              <Knob
                label="XFADE"
                value={settings.crossfadeSamples}
                min={0} max={5000} defaultValue={0}
                formatValue={(v) => `${Math.round(v)}`}
                onLiveChange={(v) => setField('crossfadeSamples', Math.round(v))}
                onCommit={(v) => commit({ crossfadeSamples: Math.round(v) })}
              />
              <Knob
                label="Loop Start"
                value={settings.loopStart}
                min={0}
                max={Math.max(0, (audioInfo?.numSamples || 0) - 1)}
                defaultValue={0}
                onLiveChange={(v) => setField('loopStart', Math.round(v))}
                onCommit={(v) => commit({ loopStart: Math.round(v) })}
              />
              <Knob
                label="Loop End"
                value={settings.loopEnd === 0 ? (audioInfo?.numSamples || 0) : settings.loopEnd}
                min={0}
                max={audioInfo?.numSamples || 0}
                defaultValue={audioInfo?.numSamples || 0}
                formatValue={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const r = Math.round(v)
                  return (numS === 0 || r >= numS) ? 'END' : String(r)
                }}
                onLiveChange={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const end = Math.round(v)
                  setField('loopEnd', end >= numS ? 0 : end)
                }}
                onCommit={(v) => {
                  const numS = audioInfo?.numSamples || 0
                  const end = Math.round(v)
                  commit({ loopEnd: end >= numS ? 0 : end })
                }}
              />
            </div>
            <div className="sampler-panel-row" style={{ marginTop: 8 }}>
              <label className="sampler-panel-field">
                <span>Root Note</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number" min={0} max={127}
                    value={settings.rootNote}
                    onChange={(e) => setField('rootNote', Math.max(0, Math.min(127, Number(e.target.value) || 0)))}
                    onBlur={() => commit({ rootNote: settings.rootNote })}
                    style={{ width: 56 }}
                  />
                  <span style={{ fontSize: 11, color: 'var(--theme-text-muted)', minWidth: 32 }}>{pitchLabel(settings.rootNote)}</span>
                </div>
              </label>
              <label className="sampler-panel-field" style={{ flex: 1 }}>
                <span>Mode</span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <input
                      type="radio" name="crossfade"
                      checked={!settings.crossfadeEnabled}
                      onChange={() => commitField('crossfadeEnabled', false)}
                    /> One-shot
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                    <input
                      type="radio" name="crossfade"
                      checked={settings.crossfadeEnabled}
                      onChange={() => commitField('crossfadeEnabled', true)}
                    /> Sustained
                  </label>
                </div>
              </label>
            </div>
            <div className="sampler-panel-row" style={{ marginTop: 8 }}>
              <label className="sampler-panel-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={settings.loopEnabled}
                  onChange={(e) => commitField('loopEnabled', e.target.checked)}
                />
                <span>Loop</span>
              </label>
            </div>
          </section>

          {/* Section 1b — Precomputed Effects */}
          <section className="sampler-panel-section">
            <h4 className="sampler-panel-label">Precomputed Effects</h4>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { key: 'dcOffsetRemoved',  label: 'Remove DC Offset' },
                { key: 'normalized',       label: 'Normalize' },
                { key: 'polarityReversed', label: 'Reverse Polarity' },
                { key: 'reversed',         label: 'Reverse' },
              ].map(({ key, label }) => {
                const active = !!settings[key]
                return (
                  <button
                    key={key}
                    onClick={() => commitField(key, !active)}
                    style={{
                      padding: '6px 10px',
                      fontSize: 11,
                      borderRadius: 4,
                      border: '1px solid ' + (active ? '#4AA8C8' : 'var(--theme-sampler-key-border)'),
                      background: active ? '#1E4A5C' : 'var(--theme-bg-surface)',
                      color: active ? '#9BDBF0' : 'var(--theme-text-muted)',
                      cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </section>

          {/* Section 2 — Playback Modes */}
          <section className="sampler-panel-section">
            <h4 className="sampler-panel-label">Playback</h4>

            {/* Mono + Portamento row */}
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--theme-text)' }}>
                <input type="checkbox" checked={settings.monoEnabled}
                  onChange={(e) => commitField('monoEnabled', e.target.checked)} />
                Mono
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--theme-text)' }}>
                <input type="checkbox" checked={settings.portamentoEnabled}
                  onChange={(e) => commitField('portamentoEnabled', e.target.checked)} />
                Portamento
              </label>
              <div style={!settings.portamentoEnabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
                <Knob label="TIME" value={settings.portamentoTimeMs}
                  min={1} max={2000} defaultValue={100} size={40}
                  formatValue={(v) => `${Math.round(v)}ms`}
                  onLiveChange={(v) => setField('portamentoTimeMs', Math.round(v))}
                  onCommit={(v) => commit({ portamentoTimeMs: Math.round(v) })} />
              </div>
            </div>

            {/* Arpeggiator */}
            <div style={{ borderTop: '1px solid var(--theme-sampler-key-border)', marginTop: 8, paddingTop: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--theme-text)', marginBottom: 6 }}>
                <input type="checkbox" checked={settings.arpEnabled}
                  onChange={(e) => commitField('arpEnabled', e.target.checked)} />
                Arpeggiator
              </label>

              <div style={!settings.arpEnabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <Knob label="GATE" value={settings.arpGate * 100}
                    min={1} max={100} defaultValue={80} size={40}
                    formatValue={(v) => `${Math.round(v)}%`}
                    onLiveChange={(v) => setField('arpGate', Math.round(v) / 100)}
                    onCommit={(v) => commit({ arpGate: Math.round(v) / 100 })} />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 9, color: 'var(--theme-text-muted)', textTransform: 'uppercase' }}>Range</span>
                    <select value={settings.arpRange}
                      onChange={(e) => commitField('arpRange', Number(e.target.value))}
                      style={{
                        background: 'var(--theme-bg-surface)', color: 'var(--theme-text)', border: '1px solid var(--theme-sampler-key-border)',
                        borderRadius: 4, padding: '4px 6px', fontSize: 11,
                      }}>
                      <option value={1}>1 oct</option>
                      <option value={2}>2 oct</option>
                      <option value={3}>3 oct</option>
                      <option value={4}>4 oct</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 9, color: 'var(--theme-text-muted)', textTransform: 'uppercase' }}>Direction</span>
                    <select value={settings.arpDirection}
                      onChange={(e) => commitField('arpDirection', Number(e.target.value))}
                      style={{
                        background: 'var(--theme-bg-surface)', color: 'var(--theme-text)', border: '1px solid var(--theme-sampler-key-border)',
                        borderRadius: 4, padding: '4px 6px', fontSize: 11,
                      }}>
                      <option value={0}>Up</option>
                      <option value={1}>Down</option>
                      <option value={2}>Up/Down</option>
                      <option value={3}>Up/Down Sticky</option>
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--theme-text)' }}>
                    <input type="checkbox" checked={settings.arpTempoSync}
                      onChange={(e) => commitField('arpTempoSync', e.target.checked)} />
                    Tempo sync
                  </label>

                  {settings.arpTempoSync ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9, color: 'var(--theme-text-muted)', textTransform: 'uppercase' }}>Division</span>
                      <select value={settings.arpDivision}
                        onChange={(e) => commitField('arpDivision', Number(e.target.value))}
                        style={{
                          background: 'var(--theme-bg-surface)', color: 'var(--theme-text)', border: '1px solid var(--theme-sampler-key-border)',
                          borderRadius: 4, padding: '4px 6px', fontSize: 11,
                        }}>
                        <option value={4}>1/4</option>
                        <option value={8}>1/8</option>
                        <option value={16}>1/16</option>
                        <option value={32}>1/32</option>
                      </select>
                    </div>
                  ) : (
                    <Knob label="TIME" value={settings.arpFreeTimeMs}
                      min={10} max={2000} defaultValue={125} size={40}
                      formatValue={(v) => `${Math.round(v)}ms`}
                      onLiveChange={(v) => setField('arpFreeTimeMs', Math.round(v))}
                      onCommit={(v) => commit({ arpFreeTimeMs: Math.round(v) })} />
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Section 3 — Envelope (Volume | Pitch tabs) */}
          <section className="sampler-panel-section">
            {/* Tab bar */}
            <div style={{ display: 'flex', gap: 0, marginBottom: 4 }}>
              <button onClick={() => setEnvTab('volume')}
                style={{
                  flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: '1px solid var(--theme-sampler-key-border)', borderRadius: '4px 0 0 4px',
                  background: envTab === 'volume' ? 'var(--theme-sampler-lfo-bg-volume)' : 'var(--theme-bg-surface)',
                  color: envTab === 'volume' ? 'var(--theme-sampler-lfo-color-volume)' : 'var(--theme-text-muted)',
                  cursor: 'pointer',
                }}>Volume</button>
              <button onClick={() => setEnvTab('pitch')}
                style={{
                  flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
                  border: '1px solid var(--theme-sampler-key-border)', borderRadius: '0 4px 4px 0',
                  background: envTab === 'pitch' ? 'var(--theme-sampler-lfo-bg-pitch)' : 'var(--theme-bg-surface)',
                  color: envTab === 'pitch' ? 'var(--theme-sampler-lfo-color-pitch)' : 'var(--theme-text-muted)',
                  cursor: 'pointer',
                }}>Pitch</button>
            </div>

            {/* Pitch-only: Enable toggle + Amount knob */}
            {envTab === 'pitch' && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 4 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--theme-text)' }}>
                  <input type="checkbox" checked={settings.pitchEnvEnabled}
                    onChange={(e) => commitField('pitchEnvEnabled', e.target.checked)} />
                  Enable
                </label>
                <Knob label="AMOUNT" value={settings.pitchEnvAmount}
                  min={-48} max={48} defaultValue={0} size={40}
                  formatValue={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}st`}
                  onLiveChange={(v) => setField('pitchEnvAmount', Number(v.toFixed(1)))}
                  onCommit={(v) => commit({ pitchEnvAmount: Number(v.toFixed(1)) })} />
              </div>
            )}

            {/* Envelope canvas + knobs — grayed out when pitch disabled */}
            <div style={envTab === 'pitch' && !settings.pitchEnvEnabled
              ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
              <EnvelopeEditor
                delayMs={envTab === 'volume' ? settings.delayMs : settings.pitchEnvDelayMs}
                attackMs={envTab === 'volume' ? settings.attackMs : settings.pitchEnvAttackMs}
                holdMs={envTab === 'volume' ? settings.holdMs : settings.pitchEnvHoldMs}
                decayMs={envTab === 'volume' ? settings.decayMs : settings.pitchEnvDecayMs}
                sustain={envTab === 'volume' ? settings.sustain : settings.pitchEnvSustain}
                releaseMs={envTab === 'volume' ? settings.releaseMs : settings.pitchEnvReleaseMs}
                attackTension={envTab === 'volume' ? settings.attackTension : settings.pitchEnvAttackTension}
                decayTension={envTab === 'volume' ? settings.decayTension : settings.pitchEnvDecayTension}
                releaseTension={envTab === 'volume' ? settings.releaseTension : settings.pitchEnvReleaseTension}
                color={envTab === 'volume' ? tokenValue('--theme-sampler-lfo-color-volume') : tokenValue('--theme-sampler-lfo-color-pitch')}
                onLiveChange={(partial) => {
                  if (envTab === 'pitch') {
                    const mapped = {}
                    for (const [k, v] of Object.entries(partial))
                      mapped[`pitchEnv${k[0].toUpperCase()}${k.slice(1)}`] = v
                    setFields(mapped)
                  } else {
                    setFields(partial)
                  }
                }}
                onCommit={commitEnvelope}
                width={WAVE_WIDTH} height={120}
              />
              <div style={{ display: 'flex', gap: 10, marginTop: 8, justifyContent: 'center' }}>
                {(() => {
                  const f = (name) => envTab === 'pitch' ? `pitchEnv${name[0].toUpperCase()}${name.slice(1)}` : name
                  const susDefault = envTab === 'pitch' ? 0 : 100
                  return <>
                    <Knob label="DELAY" value={settings[f('delayMs')]} min={0} max={5000} defaultValue={0}
                          size={40} formatValue={(v) => `${Math.round(v)}`}
                          onLiveChange={(v) => setField(f('delayMs'), Math.round(v))}
                          onCommit={(v) => commit({ [f('delayMs')]: Math.round(v) })} />
                    <Knob label="ATT" value={settings[f('attackMs')]} min={0} max={5000} defaultValue={0}
                          size={40} formatValue={(v) => `${Math.round(v)}`}
                          onLiveChange={(v) => setField(f('attackMs'), Math.round(v))}
                          onCommit={(v) => commit({ [f('attackMs')]: Math.round(v) })} />
                    <Knob label="HOLD" value={settings[f('holdMs')]} min={0} max={5000} defaultValue={0}
                          size={40} formatValue={(v) => `${Math.round(v)}`}
                          onLiveChange={(v) => setField(f('holdMs'), Math.round(v))}
                          onCommit={(v) => commit({ [f('holdMs')]: Math.round(v) })} />
                    <Knob label="DEC" value={settings[f('decayMs')]} min={0} max={5000} defaultValue={0}
                          size={40} formatValue={(v) => `${Math.round(v)}`}
                          onLiveChange={(v) => setField(f('decayMs'), Math.round(v))}
                          onCommit={(v) => commit({ [f('decayMs')]: Math.round(v) })} />
                    <Knob label="SUS" value={settings[f('sustain')] * 100} min={0} max={100} defaultValue={susDefault}
                          size={40} formatValue={(v) => `${Math.round(v)}%`}
                          onLiveChange={(v) => setField(f('sustain'), Math.round(v) / 100)}
                          onCommit={(v) => commit({ [f('sustain')]: Math.round(v) / 100 })} />
                    <Knob label="REL" value={settings[f('releaseMs')]} min={0} max={5000}
                          defaultValue={envTab === 'pitch' ? 0 : 50}
                          size={40} formatValue={(v) => `${Math.round(v)}`}
                          onLiveChange={(v) => setField(f('releaseMs'), Math.round(v))}
                          onCommit={(v) => commit({ [f('releaseMs')]: Math.round(v) })} />
                  </>
                })()}
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 4, justifyContent: 'center' }}>
                {(() => {
                  const f = (name) => envTab === 'pitch' ? `pitchEnv${name[0].toUpperCase()}${name.slice(1)}` : name
                  return <>
                    <Knob label="ATK TENS" value={settings[f('attackTension')]} min={-1} max={1} defaultValue={0}
                          size={32} dragRange={120}
                          formatValue={(v) => v.toFixed(2)}
                          onLiveChange={(v) => setField(f('attackTension'), Number(v.toFixed(3)))}
                          onCommit={(v) => commit({ [f('attackTension')]: Number(v.toFixed(3)) })} />
                    <Knob label="DEC TENS" value={settings[f('decayTension')]} min={-1} max={1} defaultValue={0}
                          size={32} dragRange={120}
                          formatValue={(v) => v.toFixed(2)}
                          onLiveChange={(v) => setField(f('decayTension'), Number(v.toFixed(3)))}
                          onCommit={(v) => commit({ [f('decayTension')]: Number(v.toFixed(3)) })} />
                    <Knob label="REL TENS" value={settings[f('releaseTension')]} min={-1} max={1} defaultValue={0}
                          size={32} dragRange={120}
                          formatValue={(v) => v.toFixed(2)}
                          onLiveChange={(v) => setField(f('releaseTension'), Number(v.toFixed(3)))}
                          onCommit={(v) => commit({ [f('releaseTension')]: Number(v.toFixed(3)) })} />
                  </>
                })()}
              </div>
            </div>
          </section>

          {/* Section 2b — LFO */}
          <LfoSection settings={settings} setField={setField} setFields={setFields} commit={commit} />

          {/* Section 3 — Mini keyboard */}
          <section className="sampler-panel-section">
            <h4 className="sampler-panel-label">Preview</h4>
            <MiniKeyboard rootNote={settings.rootNote} regionId={regionId} />
          </section>
        </div>
      </div>
    </>
  )
}
