import { useState } from 'react'
import ModShapeCanvas from './ModShapeCanvas.jsx'
import { ModKnob, Seg, Chk, NoteSelect, Field } from './ModControls.jsx'
import {
  SEG_STEP, SEG_LINE, SEG_CURVE, BEHAVIORS,
  NOTE_VALUES_NONZERO, modTimeSeconds,
} from './modConstants.js'

// ── LFO editor ───────────────────────────────────────────────────────────────
// Canvas point editor (STEP/LINE/CURVE segments on a snap grid) plus rate,
// depth-shaping and behaviour controls. A drag on the canvas streams through
// preview(); mouseup commits once. Discrete controls commit immediately.

// Shape starters. Each returns a fresh `{t,v,seg,tension}[]`.
const PRESETS = {
  sine: () => {
    const ys = [0, 0.707, 1, 0.707, 0, -0.707, -1, -0.707]
    return ys.map((v, i) => ({ t: Number((i / 8).toFixed(4)), v, seg: SEG_LINE, tension: 0 }))
  },
  triangle: () => ([
    { t: 0, v: 0, seg: SEG_LINE, tension: 0 },
    { t: 0.25, v: 1, seg: SEG_LINE, tension: 0 },
    { t: 0.5, v: 0, seg: SEG_LINE, tension: 0 },
    { t: 0.75, v: -1, seg: SEG_LINE, tension: 0 },
  ]),
  saw: () => ([
    { t: 0, v: -1, seg: SEG_LINE, tension: 0 },
    { t: 0.999, v: 1, seg: SEG_LINE, tension: 0 },
  ]),
  square: () => ([
    { t: 0, v: 1, seg: SEG_STEP, tension: 0 },
    { t: 0.5, v: -1, seg: SEG_STEP, tension: 0 },
  ]),
  randomSteps: () => {
    const out = []
    for (let i = 0; i < 8; i++) {
      out.push({ t: Number((i / 8).toFixed(4)), v: Number((Math.random() * 2 - 1).toFixed(3)), seg: SEG_STEP, tension: 0 })
    }
    return out
  },
}

const PRESET_ICONS = {
  sine: <path d="M1,7 Q4,1 7,7 Q10,13 13,7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />,
  triangle: <path d="M1,9 L5,2 L9,9 L13,2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  saw: <path d="M2,10 L9,2 M9,2 L9,10 M11,10 L13,10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  square: <path d="M1,9 L1,3 L7,3 L7,9 L13,9 L13,3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />,
  randomSteps: <path d="M1,8 L3,8 L3,4 L5,4 L5,10 L7,10 L7,5 L9,5 L9,9 L11,9 L11,3 L13,3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />,
}
const PRESET_TITLES = { sine: 'Sine', triangle: 'Triangle', saw: 'Saw', square: 'Square', randomSteps: 'Random Steps' }

const SEG_TOOLS = [
  { v: SEG_STEP, l: 'Step' },
  { v: SEG_LINE, l: 'Line' },
  { v: SEG_CURVE, l: 'Curve' },
]

const SNAP_X_OPTS = [
  { v: 0, l: 'Off' }, { v: 2, l: '2' }, { v: 3, l: '3' }, { v: 4, l: '4' },
  { v: 6, l: '6' }, { v: 8, l: '8' }, { v: 12, l: '12' }, { v: 16, l: '16' }, { v: 32, l: '32' },
]
const SNAP_Y_OPTS = [
  { v: 0, l: 'Off' }, { v: 2, l: '2' }, { v: 4, l: '4' }, { v: 8, l: '8' }, { v: 12, l: '12' },
]

export default function LfoEditor({ lfo, color, bpm, preview, commit }) {
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const [snapX, setSnapX] = useState(0)
  const [snapY, setSnapY] = useState(0)

  const points = Array.isArray(lfo.points) ? lfo.points : []
  const sync = !!lfo.tempoSync
  const selPoint = selectedIdx >= 0 && selectedIdx < points.length ? points[selectedIdx] : null

  const setPointsLive = (pts) => preview({ points: pts })
  const setPointsFinal = (pts) => { preview({ points: pts }); commit() }

  const applyPreset = (id) => { setPointsFinal(PRESETS[id]()); setSelectedIdx(-1) }

  // Apply a segment type / tension to the selected point.
  const setSelSeg = (seg) => {
    if (!selPoint) return
    const next = points.map((p, i) => (i === selectedIdx ? { ...p, seg } : p))
    setPointsFinal(next)
  }
  const setSelTensionLive = (tension) => {
    if (!selPoint) return
    setPointsLive(points.map((p, i) => (i === selectedIdx ? { ...p, tension } : p)))
  }
  const setSelTensionFinal = (tension) => {
    if (!selPoint) return
    setPointsFinal(points.map((p, i) => (i === selectedIdx ? { ...p, tension } : p)))
  }

  const setTimeLive = (key, patch) => preview({ [key]: { ...lfo[key], ...patch } })
  const setTimeFinal = (key, patch) => { preview({ [key]: { ...lfo[key], ...patch } }); commit() }

  // Read-out: the synced rate as ms at the project tempo.
  const syncedRateMs = sync ? Math.round(modTimeSeconds(lfo.syncRate, true, bpm) * 1000) : null

  return (
    <div className="sampler-mod-editor">
      {/* Behaviour + mono + output */}
      <div className="sampler-mod-editor-head">
        <Seg
          sm
          opts={BEHAVIORS}
          val={lfo.behavior ?? 0}
          set={(v) => { preview({ behavior: v }); commit() }}
        />
        <Chk val={lfo.mono} set={(v) => { preview({ mono: v }); commit() }} label="Mono" title="One shared instance even in Retrig / Env" />
        <div className="sampler-mod-head-spacer" />
        <ModKnob
          label="OUT"
          value={(lfo.outputAmount ?? 1) * 100}
          min={0} max={100} defaultValue={100}
          size={34} color={color}
          formatValue={(v) => `${Math.round(v)}%`}
          onLiveChange={(v) => preview({ outputAmount: Math.round(v) / 100 })}
          onCommit={(v) => { preview({ outputAmount: Math.round(v) / 100 }); commit() }}
        />
      </div>

      {/* Preset starters + segment tools */}
      <div className="sampler-mod-toolbar">
        <div className="sampler-mod-tool-group">
          <span className="sampler-mod-tool-label">Shape</span>
          {Object.keys(PRESETS).map((id) => (
            <button
              type="button" key={id} title={PRESET_TITLES[id]}
              className="sampler-mod-icon-btn"
              onClick={() => applyPreset(id)}
            >
              <svg width={14} height={14} viewBox="0 0 14 14">{PRESET_ICONS[id]}</svg>
            </button>
          ))}
        </div>
        <div className="sampler-mod-tool-group">
          <span className="sampler-mod-tool-label">Segment</span>
          <Seg
            sm
            opts={SEG_TOOLS}
            val={selPoint ? (selPoint.seg ?? SEG_LINE) : -1}
            set={setSelSeg}
            title={selPoint ? 'Segment type for the selected point' : 'Select a point first'}
          />
        </div>
      </div>

      {/* Canvas */}
      <div className="sampler-mod-graph-well">
        <ModShapeCanvas
          points={points}
          selectedIdx={selectedIdx}
          snapX={snapX}
          snapY={snapY}
          color={color}
          width={460}
          height={150}
          onPreview={setPointsLive}
          onCommit={setPointsFinal}
          onSelect={setSelectedIdx}
        />
      </div>
      <div className="sampler-mod-caption-row">
        <span className="sampler-mod-caption">Double-click to add · drag to move · alt/right-click to delete</span>
        <div className="sampler-mod-snap">
          <span className="sampler-mod-tool-label">Snap X</span>
          <select className="sampler-select sampler-select--sm" value={String(snapX)} onChange={(e) => setSnapX(Number(e.target.value))}>
            {SNAP_X_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
          <span className="sampler-mod-tool-label">Y</span>
          <select className="sampler-select sampler-select--sm" value={String(snapY)} onChange={(e) => setSnapY(Number(e.target.value))}>
            {SNAP_Y_OPTS.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
          </select>
        </div>
      </div>

      {/* Rate + depth shaping */}
      <div className="sampler-mod-rate-row">
        <div className="sampler-mod-rate-block">
          <div className="sampler-mod-rate-head">
            <span className="sampler-mod-tool-label">Rate</span>
            <Seg
              sm
              opts={[{ v: false, l: 'Hz' }, { v: true, l: 'BPM' }]}
              val={sync}
              set={(v) => { preview({ tempoSync: v }); commit() }}
            />
          </div>
          {sync ? (
            <div className="sampler-mod-rate-sync">
              <NoteSelect val={lfo.syncRate?.noteValue ?? 8} set={(v) => setTimeFinal('syncRate', { noteValue: v })} opts={NOTE_VALUES_NONZERO} />
              <Chk val={lfo.syncRate?.triplet} set={(v) => setTimeFinal('syncRate', { triplet: v })} label="Trip" />
              <Chk val={lfo.syncRate?.dotted} set={(v) => setTimeFinal('syncRate', { dotted: v })} label="Dot" />
              {syncedRateMs != null && <span className="sampler-mod-readout">{syncedRateMs} ms</span>}
            </div>
          ) : (
            <ModKnob
              label="Hz"
              value={lfo.rateHz ?? 1}
              min={0.01} max={40} defaultValue={1} skew={0.4}
              size={40} color={color}
              formatValue={(v) => v < 1 ? v.toFixed(2) : v.toFixed(1)}
              onLiveChange={(v) => preview({ rateHz: Number(v.toFixed(3)) })}
              onCommit={(v) => { preview({ rateHz: Number(v.toFixed(3)) }); commit() }}
            />
          )}
        </div>

        <div className="sampler-mod-knob-row">
          {sync ? (
            <>
              <Field label="RISE"><NoteSelect val={lfo.rise?.noteValue ?? 0} set={(v) => setTimeFinal('rise', { noteValue: v })} /></Field>
              <Field label="DELAY"><NoteSelect val={lfo.delay?.noteValue ?? 0} set={(v) => setTimeFinal('delay', { noteValue: v })} /></Field>
            </>
          ) : (
            <>
              <ModKnob
                label="RISE" value={lfo.rise?.ms ?? 0} min={0} max={10000} defaultValue={0}
                size={40} color={color}
                formatValue={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}m`}
                onLiveChange={(v) => setTimeLive('rise', { ms: Math.round(v) })}
                onCommit={(v) => setTimeFinal('rise', { ms: Math.round(v) })}
              />
              <ModKnob
                label="DELAY" value={lfo.delay?.ms ?? 0} min={0} max={10000} defaultValue={0}
                size={40} color={color}
                formatValue={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}m`}
                onLiveChange={(v) => setTimeLive('delay', { ms: Math.round(v) })}
                onCommit={(v) => setTimeFinal('delay', { ms: Math.round(v) })}
              />
            </>
          )}
          <ModKnob
            label="SMOOTH" value={lfo.smooth ?? 0} min={0} max={100} defaultValue={0}
            size={40} color={color}
            formatValue={(v) => `${Math.round(v)}`}
            onLiveChange={(v) => preview({ smooth: Math.round(v) })}
            onCommit={(v) => { preview({ smooth: Math.round(v) }); commit() }}
          />
          <ModKnob
            label="PHASE" value={lfo.phase ?? 0} min={0} max={100} defaultValue={0}
            size={40} color={color}
            formatValue={(v) => `${Math.round(v)}%`}
            onLiveChange={(v) => preview({ phase: Math.round(v) })}
            onCommit={(v) => { preview({ phase: Math.round(v) }); commit() }}
          />
          <ModKnob
            label="TENS" value={selPoint?.tension || 0} min={-1} max={1} defaultValue={0}
            size={28} dragRange={120} capStyle="soft-disk" color="var(--theme-accent)"
            formatValue={(v) => selPoint && selPoint.seg === SEG_CURVE ? v.toFixed(2) : '--'}
            onLiveChange={(v) => selPoint && selPoint.seg === SEG_CURVE && setSelTensionLive(Number(v.toFixed(3)))}
            onCommit={(v) => selPoint && selPoint.seg === SEG_CURVE && setSelTensionFinal(Number(v.toFixed(3)))}
          />
        </div>
      </div>
    </div>
  )
}
