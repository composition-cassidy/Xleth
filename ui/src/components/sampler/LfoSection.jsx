import { useState, useCallback } from 'react'
import Knob from './Knob.jsx'
import LfoWaveformCanvas from './LfoWaveformCanvas.jsx'

const LFO_COLORS = { vol: '#33CED6', pan: '#9B59B6', pitch: '#E8A020' }
const LFO_BG     = { vol: '#1E3A3C', pan: '#2A1E3A', pitch: '#3C2E1A' }

// Field prefix per tab
const PREFIX = { vol: 'lfoVol', pan: 'lfoPan', pitch: 'lfoPitch' }

// Preset waveform generators
function sineWaveform(n = 33) {
  return Array.from({ length: n }, (_, i) => ({
    t: i / (n - 1),
    v: Math.sin((i / (n - 1)) * Math.PI * 2),
  }))
}
function triangleWaveform() {
  return [
    { t: 0, v: 0 }, { t: 0.25, v: 1 }, { t: 0.5, v: 0 },
    { t: 0.75, v: -1 }, { t: 1, v: 0 },
  ]
}
function squareWaveform() {
  return [
    { t: 0, v: 1 }, { t: 0.499, v: 1 },
    { t: 0.5, v: -1 }, { t: 0.999, v: -1 }, { t: 1, v: 1 },
  ]
}
function sawUpWaveform() {
  return [{ t: 0, v: -1 }, { t: 0.999, v: 1 }, { t: 1, v: -1 }]
}
function sawDownWaveform() {
  return [{ t: 0, v: 1 }, { t: 0.999, v: -1 }, { t: 1, v: 1 }]
}

const DIVISIONS = [
  { value: 1, label: '1/1' },
  { value: 2, label: '1/2' },
  { value: 4, label: '1/4' },
  { value: 8, label: '1/8' },
  { value: 16, label: '1/16' },
]

export default function LfoSection({ settings, setField, setFields, commit }) {
  const [lfoTab, setLfoTab] = useState('vol')
  const p = PREFIX[lfoTab]
  const color = LFO_COLORS[lfoTab]

  const f = useCallback((name) => `${p}${name[0].toUpperCase()}${name.slice(1)}`, [p])

  const applyPreset = useCallback((generator) => {
    const wf = generator()
    const key = f('waveform')
    setField(key, wf)
    commit({ [key]: wf })
  }, [f, setField, commit])

  const enabled = settings[f('enabled')]

  return (
    <section className="sampler-panel-section">
      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 4 }}>
        {['vol', 'pan', 'pitch'].map((tab, i) => (
          <button key={tab} onClick={() => setLfoTab(tab)}
            style={{
              flex: 1, padding: '5px 0', fontSize: 11, fontWeight: 600,
              border: '1px solid #2A2A38',
              borderRadius: i === 0 ? '4px 0 0 4px' : i === 2 ? '0 4px 4px 0' : '0',
              background: lfoTab === tab ? LFO_BG[tab] : '#1A1A24',
              color: lfoTab === tab ? LFO_COLORS[tab] : '#8888A0',
              cursor: 'pointer',
            }}>
            {tab === 'vol' ? 'Vol LFO' : tab === 'pan' ? 'Pan LFO' : 'Pitch LFO'}
          </button>
        ))}
      </div>

      {/* Enable toggle */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 4 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#E8E8ED' }}>
          <input type="checkbox" checked={enabled}
            onChange={(e) => {
              setField(f('enabled'), e.target.checked)
              commit({ [f('enabled')]: e.target.checked })
            }} />
          Enable
        </label>
      </div>

      {/* Content (grayed out when disabled) */}
      <div style={!enabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}>
        {/* Waveform canvas */}
        <LfoWaveformCanvas
          waveform={settings[f('waveform')]}
          color={color}
          width={520}
          height={80}
          onLiveChange={(wf) => setField(f('waveform'), wf)}
          onCommit={(wf) => commit({ [f('waveform')]: wf })}
        />

        {/* Preset buttons */}
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          {[
            { label: '~', gen: sineWaveform, title: 'Sine' },
            { label: '/\\', gen: triangleWaveform, title: 'Triangle' },
            { label: '\u25A1', gen: squareWaveform, title: 'Square' },
            { label: '/', gen: sawUpWaveform, title: 'Saw Up' },
            { label: '\\', gen: sawDownWaveform, title: 'Saw Down' },
          ].map(({ label, gen, title }) => (
            <button key={title} onClick={() => applyPreset(gen)} title={title}
              style={{
                padding: '3px 8px', fontSize: 11, borderRadius: 3,
                border: '1px solid #2A2A38', background: '#1A1A24',
                color: '#8888A0', cursor: 'pointer', minWidth: 28,
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* Knobs row */}
        <div style={{ display: 'flex', gap: 10, marginTop: 8, justifyContent: 'center' }}>
          <Knob label="DELAY" value={settings[f('delayMs')]} min={0} max={5000} defaultValue={0}
            size={40} formatValue={(v) => `${Math.round(v)}`}
            onLiveChange={(v) => setField(f('delayMs'), Math.round(v))}
            onCommit={(v) => commit({ [f('delayMs')]: Math.round(v) })} />
          <Knob label="ATT" value={settings[f('attackMs')]} min={0} max={5000} defaultValue={0}
            size={40} formatValue={(v) => `${Math.round(v)}`}
            onLiveChange={(v) => setField(f('attackMs'), Math.round(v))}
            onCommit={(v) => commit({ [f('attackMs')]: Math.round(v) })} />
          <Knob label="AMT" value={settings[f('amount')]}
            min={lfoTab === 'pitch' ? -48 : 0}
            max={lfoTab === 'pitch' ? 48 : 1}
            defaultValue={0} size={40}
            formatValue={(v) => lfoTab === 'pitch' ? `${v > 0 ? '+' : ''}${v.toFixed(1)}st` : `${(v * 100).toFixed(0)}%`}
            onLiveChange={(v) => setField(f('amount'), lfoTab === 'pitch' ? Number(v.toFixed(1)) : Number(v.toFixed(3)))}
            onCommit={(v) => commit({ [f('amount')]: lfoTab === 'pitch' ? Number(v.toFixed(1)) : Number(v.toFixed(3)) })} />
          <Knob label="SPEED" value={settings[f('speedHz')]}
            min={0.01} max={20} defaultValue={1} size={40}
            formatValue={(v) => settings[f('tempoSync')] ? '--' : `${v.toFixed(2)}`}
            onLiveChange={(v) => setField(f('speedHz'), Number(v.toFixed(2)))}
            onCommit={(v) => commit({ [f('speedHz')]: Number(v.toFixed(2)) })} />
        </div>

        {/* Tempo sync row */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8, justifyContent: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#E8E8ED' }}>
            <input type="checkbox" checked={settings[f('tempoSync')]}
              onChange={(e) => {
                setField(f('tempoSync'), e.target.checked)
                commit({ [f('tempoSync')]: e.target.checked })
              }} />
            Tempo sync
          </label>
          <select
            value={settings[f('tempoDivision')]}
            onChange={(e) => {
              const v = Number(e.target.value)
              setField(f('tempoDivision'), v)
              commit({ [f('tempoDivision')]: v })
            }}
            style={{
              background: '#0a0a10', border: '1px solid #2A2A38', color: '#E8E8ED',
              fontSize: 11, padding: '2px 6px', borderRadius: 3,
            }}>
            {DIVISIONS.map(({ value, label }) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
      </div>
    </section>
  )
}
