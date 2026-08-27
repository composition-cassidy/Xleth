import { MousePointer2, Scissors, Spline, Grid2x2, BoxSelect, Square, Lasso } from 'lucide-react'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'

// Vertical tool column at the left edge of the workspace, below the menu bar.
// The tool SET swaps per view (mockup): WAVEFORM = Select/Chop/Envelope,
// SPECTRAL = Select/Paint/Region. Envelope draws over either view in the real
// app (drawEnvelope/handleEnvDown never gate on viewMode) but only appears in
// the WAV set per the mockup, so picking it while in SPC view switches back
// to WAV — the same direction Paint/Region already force a switch TO spc.
// "Region" is this app's real third SPC tool (rect/freehand t×f select →
// Attenuate/Boost/Mute/Copy to New Layer); there is no separate "Erase"
// gesture, so Region fills that slot rather than a fabricated eraser.
const HINTS = {
  select: 'drag = select · space = preview',
  envelope: 'click line = add point · drag = move · right-click = delete',
  paint: 'drag on the spectrogram = paint attenuation · release = commit',
  region: 'drag on the spectrogram = select a region · then Attenuate/Boost/Mute/Copy',
}

export default function SandboxToolColumn() {
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const setEnvelopeEditMode = useSandboxStore((s) => s.setEnvelopeEditMode)
  const paintEditMode = useSandboxStore((s) => s.paintEditMode)
  const setPaintEditMode = useSandboxStore((s) => s.setPaintEditMode)
  const paintBrush = useSandboxStore((s) => s.paintBrush)
  const setPaintBrush = useSandboxStore((s) => s.setPaintBrush)
  const spcSelectMode = useSandboxStore((s) => s.spcSelectMode)
  const setSpcSelectMode = useSandboxStore((s) => s.setSpcSelectMode)
  const spcSelectShape = useSandboxStore((s) => s.spcSelectShape)
  const setSpcSelectShape = useSandboxStore((s) => s.setSpcSelectShape)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const setViewMode = useSandboxStore((s) => s.setViewMode)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const activeTool = paintEditMode ? 'paint' : envelopeEditMode ? 'envelope' : spcSelectMode ? 'region' : 'select'

  const selectTool = () => { setEnvelopeEditMode(false); setPaintEditMode(false); setSpcSelectMode(false) }
  const armEnvelope = () => { setEnvelopeEditMode(true); if (viewMode !== 'wav') setViewMode('wav') }
  const armPaint = () => { setPaintEditMode(true); setViewMode('spc') }
  const armRegionSelect = () => { setSpcSelectMode(true); setViewMode('spc') }

  return (
    <div className="sandbox-toolcol">
      <button
        className={`sandbox-toolcol-tool${activeTool === 'select' ? ' active' : ''}`}
        onClick={selectTool}
        title="Select — drag on the waveform to make a selection"
      >
        <MousePointer2 size={18} />
        <span>Select</span>
      </button>

      {viewMode === 'wav' ? (
        <>
          <button className="sandbox-toolcol-tool ghost" disabled title="Chop / splice tool — coming soon">
            <Scissors size={18} />
            <span>Chop</span>
          </button>
          <button
            className={`sandbox-toolcol-tool${activeTool === 'envelope' ? ' active' : ''}`}
            disabled={!hasLayer}
            onClick={armEnvelope}
            title="Envelope — draw a gain envelope over the waveform (Mode 1/2, see the Gain Envelope op)"
          >
            <Spline size={18} />
            <span>Envelope</span>
          </button>
        </>
      ) : (
        <>
          <button
            className={`sandbox-toolcol-tool${activeTool === 'paint' ? ' active' : ''}`}
            disabled={!hasLayer}
            onClick={armPaint}
            title="Paint — paint out energy directly on the spectrogram (see the Spectral Paint op)"
          >
            <Grid2x2 size={18} />
            <span>Paint</span>
          </button>
          <button
            className={`sandbox-toolcol-tool${activeTool === 'region' ? ' active' : ''}`}
            disabled={!hasLayer}
            onClick={armRegionSelect}
            title="Region — select a rect/freehand time × frequency region, then Attenuate/Boost/Mute/Copy"
          >
            <BoxSelect size={18} />
            <span>Region</span>
          </button>
        </>
      )}

      {activeTool === 'region' && (
        <div className="sandbox-toolcol-params">
          <div className="sandbox-toolstrip-view-toggle">
            <button
              className={spcSelectShape === 'rect' ? 'active' : ''}
              onClick={() => setSpcSelectShape('rect')}
              title="Rectangle selection"
            >
              <Square size={12} />
            </button>
            <button
              className={spcSelectShape === 'freehand' ? 'active' : ''}
              onClick={() => setSpcSelectShape('freehand')}
              title="Freehand selection"
            >
              <Lasso size={12} />
            </button>
          </div>
        </div>
      )}

      {activeTool === 'paint' && (
        <div className="sandbox-toolcol-params">
          <label title="Brush half-width in time">
            Size
            <input
              type="number" step="0.01" min="0.001" className="sandbox-toolbar-number"
              value={paintBrush.halfWidthSec}
              onChange={(e) => setPaintBrush({ halfWidthSec: Math.max(0.001, Number(e.target.value)) })}
            />
            s
          </label>
          <label title="Brush half-height in frequency">
            ×
            <input
              type="number" step="10" min="1" className="sandbox-toolbar-number"
              value={paintBrush.halfHeightHz}
              onChange={(e) => setPaintBrush({ halfHeightHz: Math.max(1, Number(e.target.value)) })}
            />
            Hz
          </label>
          <label title="Attenuation at the brush's core">
            Amount
            <input
              type="number" step="1" min={SPECTRAL_PAINT_AMOUNT_DB_MIN} max={SPECTRAL_PAINT_AMOUNT_DB_MAX}
              className="sandbox-toolbar-number"
              value={paintBrush.amountDb}
              onChange={(e) => setPaintBrush({ amountDb: Number(e.target.value) })}
            />
            dB
          </label>
          <label title="Feather past the brush's core, time × frequency">
            Feather
            <input
              type="number" step="1" min="0" className="sandbox-toolbar-number"
              value={paintBrush.featherTimeMs}
              onChange={(e) => setPaintBrush({ featherTimeMs: Math.max(0, Number(e.target.value)) })}
            />
            ms ×
            <input
              type="number" step="10" min="0" className="sandbox-toolbar-number"
              value={paintBrush.featherFreqHz}
              onChange={(e) => setPaintBrush({ featherFreqHz: Math.max(0, Number(e.target.value)) })}
            />
            Hz
          </label>
        </div>
      )}

      <div className="sandbox-toolcol-hint">{HINTS[activeTool]}</div>
    </div>
  )
}
