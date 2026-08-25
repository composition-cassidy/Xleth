import { MousePointer2, Scissors, Spline, Grid2x2 } from 'lucide-react'
import useSandboxStore from '../../stores/sandboxStore.js'

// Row 1 — modal tools ONLY. Every other action (Trim/Cut/Copy/..., op
// params) has moved out to SandboxSelectionActionBar and the op-stack module
// rail; this row's job is just "what does a press on the waveform do right
// now" plus a one-line hint for whichever tool is armed.
//
// Select and Envelope are the only two tools with real behavior behind them
// today, and they are mutually exclusive by construction: envelopeEditMode
// is a single boolean already owned by the store (see SandboxWaveformCanvas
// and toolbar's old header comment on why it has to be a mode, not a
// modifier), so "Select" is simply "Envelope is off". Chop and Spectral are
// ghosted placeholders — there is no chop/splice-mode or spectral-paint tool
// in this codebase yet, and this restructuring adds no new DSP.
const RENDER_STATE_LABEL = {
  idle: 'Idle', rendering: 'Rendering…', ready: 'Ready', error: 'Render failed',
}

const HINTS = {
  select: 'drag = select · space = preview',
  envelope: 'click line = add point · drag = move · right-click = delete',
}

export default function SandboxToolstrip() {
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const setEnvelopeEditMode = useSandboxStore((s) => s.setEnvelopeEditMode)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const activeTool = envelopeEditMode ? 'envelope' : 'select'

  const renderState = layer ? (RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState) : '—'
  const bufferRate = layer?.renderedBuffer?.sampleRate ? `${Math.round(layer.renderedBuffer.sampleRate)} Hz` : null

  return (
    <div className="sandbox-toolstrip">
      <button
        className={`sandbox-toolstrip-tool${activeTool === 'select' ? ' active' : ''}`}
        onClick={() => setEnvelopeEditMode(false)}
        title="Select — drag on the waveform to make a selection"
      >
        <MousePointer2 size={14} />
        <span>Select</span>
      </button>
      <button className="sandbox-toolstrip-tool ghost" disabled title="Chop / splice tool — coming soon">
        <Scissors size={14} />
        <span>Chop</span>
      </button>
      <button
        className={`sandbox-toolstrip-tool${activeTool === 'envelope' ? ' active' : ''}`}
        disabled={!hasLayer}
        onClick={() => setEnvelopeEditMode(true)}
        title="Envelope — draw a gain envelope over the waveform (Mode 1/2, see the Gain Envelope op)"
      >
        <Spline size={14} />
        <span>Envelope</span>
      </button>
      <button className="sandbox-toolstrip-tool ghost" disabled title="Spectral paint — coming soon">
        <Grid2x2 size={14} />
        <span>Spectral</span>
      </button>

      <div className="sandbox-toolstrip-divider" />

      <div className="sandbox-toolstrip-view-toggle">
        <button className="active" disabled title="Waveform view">WAV</button>
        <button className="ghost" disabled title="Spectrogram view — coming soon">SPC</button>
      </div>

      <div className="sandbox-toolstrip-divider" />

      <span className="sandbox-toolstrip-hint">{HINTS[activeTool]}</span>

      <div className="sandbox-toolstrip-spacer" />

      <span className={`sandbox-render-chip sandbox-render-chip--${layer?.renderState ?? 'idle'}`}>
        <span className="sandbox-render-chip-dot" />
        {renderState}{bufferRate ? ` · ${bufferRate}` : ''}
      </span>
    </div>
  )
}
