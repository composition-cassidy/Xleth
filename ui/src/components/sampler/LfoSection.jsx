import { useState, useCallback, useMemo } from 'react'
import Knob from './Knob.jsx'
import LfoWaveformCanvas, { backendToY, yToBackend } from './LfoWaveformCanvas.jsx'
import { tokenValue } from '../../theming/tokenValue.ts'

const LFO_COLOR_TOKENS = {
  vol: '--theme-sampler-mod-color-volume',
  pan: '--theme-sampler-mod-color-pan',
  pitch: '--theme-sampler-mod-color-pitch',
}

const PREFIX = { vol: 'lfoVol', pan: 'lfoPan', pitch: 'lfoPitch' }

const LFO_PRESETS_Y = {
  sine:     [ 0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707 ],
  triangle: [ 0, 0.5, 1, 0.5, 0, -0.5, -1, -0.5 ],
  square:   [ 1, 1, 1, 1, -1, -1, -1, -1 ],
  rampUp:   [ -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75 ],
  rampDown: [ 1, 0.75, 0.5, 0.25, 0, -0.25, -0.5, -0.75 ],
}

const PRESET_ICONS = {
  sine:     <path d="M1,7 Q4,1 7,7 Q10,13 13,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>,
  triangle: <path d="M1,9 L5,2 L9,9 L13,2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  square:   <path d="M1,9 L1,3 L7,3 L7,9 L13,9 L13,3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  rampUp:   <path d="M2,10 L9,2 M9,2 L9,10 M11,10 L13,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
  rampDown: <path d="M2,2 L2,10 L9,2 M11,10 L13,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>,
}

const PRESET_TITLES = { sine: 'Sine', triangle: 'Triangle', square: 'Square', rampUp: 'Ramp Up', rampDown: 'Ramp Down' }

const TDIVS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32', '1/64']
const TDIV_VALUES = { '1/1': 1, '1/2': 2, '1/4': 4, '1/8': 8, '1/16': 16, '1/32': 32, '1/64': 64 }
const TDIV_LABELS = { 1: '1/1', 2: '1/2', 4: '1/4', 8: '1/8', 16: '1/16', 32: '1/32', 64: '1/64' }

function presetMatch(Y, presetY) {
  for (let i = 0; i < 8; i++) {
    if (Math.abs(Y[i] - presetY[i]) > 0.02) return false
  }
  return true
}

function detectPreset(waveform) {
  const Y = backendToY(waveform)
  for (const id of Object.keys(LFO_PRESETS_Y)) {
    if (presetMatch(Y, LFO_PRESETS_Y[id])) return id
  }
  return null
}

const TAB_LABELS = { vol: 'Vol LFO', pan: 'Pan LFO', pitch: 'Pitch LFO' }

const SAMPLER_KNOB_APPEARANCE = {
  tickStyle: 'none',
  glyph: 'rotary-arrow',
  accentGlow: true,
}

function SamplerKnob(props) {
  return <Knob {...SAMPLER_KNOB_APPEARANCE} {...props} />
}

export default function LfoSection({ settings, setField, setFields, commit }) {
  const [lfoTab, setLfoTab] = useState('vol')
  const p = PREFIX[lfoTab]
  const color = tokenValue(LFO_COLOR_TOKENS[lfoTab])

  const f = useCallback((name) => `${p}${name[0].toUpperCase()}${name.slice(1)}`, [p])

  const enabled = !!settings[f('enabled')]
  const waveform = settings[f('waveform')]
  const detectedPreset = useMemo(() => detectPreset(waveform), [waveform])

  const applyPreset = useCallback((id) => {
    const wf = yToBackend(LFO_PRESETS_Y[id])
    const key = f('waveform')
    setField(key, wf)
    commit({ [key]: wf })
  }, [f, setField, commit])

  const accentMuted = tokenValue('--theme-text-muted')
  const cardBg = 'var(--theme-bg-elevated)'
  const surface = 'var(--theme-bg-surface)'
  const text = 'var(--theme-text)'
  const muted = 'var(--theme-text-muted)'
  const border = 'var(--theme-border-subtle)'
  const borderStrong = 'var(--theme-border-strong)'
  const accentToken = `var(${LFO_COLOR_TOKENS[lfoTab]})`

  const lblStyle = { fontSize: 9, color: muted, textTransform: 'uppercase', letterSpacing: '0.06em' }

  return (
    <div style={{
      background: surface,
      border: `1px solid ${borderStrong}`,
      borderRadius: 4,
      padding: 12,
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
    }}>
      {/* LFO sub-tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${border}` }}>
        {['vol', 'pan', 'pitch'].map((tab) => (
          <div key={tab} onClick={() => setLfoTab(tab)} style={{
            padding: '4px 10px',
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: lfoTab === tab ? text : muted,
            borderBottom: lfoTab === tab ? `2px solid ${accentToken}` : '2px solid transparent',
            marginBottom: -1,
            cursor: 'pointer',
            userSelect: 'none',
          }}>{TAB_LABELS[tab]}</div>
        ))}
      </div>

      {/* Enable toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setField(f('enabled'), e.target.checked)
            commit({ [f('enabled')]: e.target.checked })
          }}
          style={{ accentColor: accentToken, cursor: 'pointer' }}
        />
        <span style={lblStyle}>Enable</span>
      </label>

      <div style={enabled ? undefined : { opacity: 0.4, pointerEvents: 'none' }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Preset row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ ...lblStyle, marginRight: 2 }}>Preset</span>
              {Object.keys(PRESET_ICONS).map((id) => {
                const active = detectedPreset === id
                return (
                  <div key={id} onClick={() => applyPreset(id)} title={PRESET_TITLES[id]} style={{
                    width: 28, height: 24,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: active ? accentToken : cardBg,
                    color: active ? 'var(--theme-text-on-accent)' : muted,
                    border: `1px solid ${active ? accentToken : border}`,
                    borderRadius: 3, cursor: 'pointer', userSelect: 'none',
                  }}>
                    <svg width={14} height={14} viewBox="0 0 14 14">{PRESET_ICONS[id]}</svg>
                  </div>
                )
              })}
              {detectedPreset === null && (
                <span style={{ ...lblStyle, color: accentToken, marginLeft: 4 }}>Custom</span>
              )}
            </div>

            {/* Editable canvas */}
            <div style={{ border: `1px solid ${border}`, borderRadius: 3, overflow: 'hidden' }}>
              <LfoWaveformCanvas
                waveform={waveform}
                color={color}
                width={400}
                height={80}
                onLiveChange={(wf) => setField(f('waveform'), wf)}
                onCommit={(wf) => commit({ [f('waveform')]: wf })}
              />
            </div>
            <div style={{ fontSize: 9, color: muted }}>Drag points to edit · Click preset to reset</div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <SamplerKnob
                label="DEL"
                value={settings[f('delayMs')]}
                min={0} max={5000} defaultValue={0}
                size={36}
                color={color}
                formatValue={(v) => `${Math.round(v)}`}
                onLiveChange={(v) => setField(f('delayMs'), Math.round(v))}
                onCommit={(v) => commit({ [f('delayMs')]: Math.round(v) })}
              />
              <SamplerKnob
                label="ATT"
                value={settings[f('attackMs')]}
                min={0} max={5000} defaultValue={0}
                size={36}
                color={color}
                formatValue={(v) => `${Math.round(v)}`}
                onLiveChange={(v) => setField(f('attackMs'), Math.round(v))}
                onCommit={(v) => commit({ [f('attackMs')]: Math.round(v) })}
              />
              <SamplerKnob
                label="AMT"
                value={settings[f('amount')]}
                min={lfoTab === 'pitch' ? -48 : 0}
                max={lfoTab === 'pitch' ? 48 : 1}
                defaultValue={0}
                size={36}
                color={color}
                formatValue={(v) => lfoTab === 'pitch' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}st` : `${(v * 100).toFixed(0)}%`}
                onLiveChange={(v) => setField(f('amount'), lfoTab === 'pitch' ? Number(v.toFixed(1)) : Number(v.toFixed(3)))}
                onCommit={(v) => commit({ [f('amount')]: lfoTab === 'pitch' ? Number(v.toFixed(1)) : Number(v.toFixed(3)) })}
              />
              <SamplerKnob
                label="SPEED"
                value={settings[f('speedHz')]}
                min={0.01} max={20} defaultValue={1}
                size={36}
                color={color}
                formatValue={(v) => settings[f('tempoSync')] ? '--' : `${v.toFixed(2)}`}
                onLiveChange={(v) => setField(f('speedHz'), Number(v.toFixed(2)))}
                onCommit={(v) => commit({ [f('speedHz')]: Number(v.toFixed(2)) })}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                <input
                  type="checkbox"
                  checked={!!settings[f('tempoSync')]}
                  onChange={(e) => {
                    setField(f('tempoSync'), e.target.checked)
                    commit({ [f('tempoSync')]: e.target.checked })
                  }}
                  style={{ accentColor: accentToken, cursor: 'pointer' }}
                />
                <span style={lblStyle}>Tempo Sync</span>
              </label>
              {settings[f('tempoSync')] && (
                <select
                  value={TDIV_LABELS[settings[f('tempoDivision')]] || '1/4'}
                  onChange={(e) => {
                    const v = TDIV_VALUES[e.target.value]
                    setField(f('tempoDivision'), v)
                    commit({ [f('tempoDivision')]: v })
                  }}
                  style={{
                    background: cardBg,
                    border: `1px solid ${borderStrong}`,
                    color: text,
                    fontSize: 10,
                    padding: '3px 6px',
                    borderRadius: 3,
                    outline: 'none',
                    cursor: 'pointer',
                  }}
                >
                  {TDIVS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
