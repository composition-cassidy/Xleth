import { MousePointer2, Spline, Grid2x2, BoxSelect, Square, Lasso } from 'lucide-react'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'
import DragNumberField from '../grid/zprTimeline/DragNumberField.jsx'
import { activeToolOf } from './sandboxToolConstants.js'

// Vertical tool column at the left edge of the workspace, below the menu bar.
// The tool SET swaps per view: WAVEFORM = Select/Envelope, SPECTRAL =
// Select/Paint/Region. Envelope draws over either view in the real app
// (drawEnvelope/handleEnvDown never gate on viewMode) but only appears in the
// WAV set, so picking it while in SPC view switches back to WAV — the same
// direction Paint/Region already force a switch TO spc.
// "Region" is this app's real third SPC tool (rect/freehand t×f select →
// Attenuate/Boost/Mute/Copy to New Layer); there is no separate "Erase"
// gesture, so Region fills that slot rather than a fabricated eraser.

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
  // The hint for this tool is rendered by the status bar, which has the width
  // for a sentence — see TOOL_HINTS in sandboxToolConstants.js.
  const activeTool = activeToolOf({ paintEditMode, envelopeEditMode, spcSelectMode })

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
          {/* The CHOP ghost that used to sit here was a permanently disabled
              button for a tool that does not exist. A control that can never
              be pressed teaches nothing except that the panel is unfinished —
              Splice/Crossfade already live in EFFECT ▾, which is where the
              capability actually is. */}
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
          {/* Drag-scrub rather than typed number boxes — a brush size is a
              feel, not a figure, and typing 0.05 into a spinner to widen a
              stroke is the interaction that made this panel read as a test
              harness. Click still types, for when the exact number matters.
              paintBrush is local session state (no bridge call), so live and
              committed updates are the same write. */}
          <DragNumberField
            className="sandbox-drag-field" label="Size" suffix="s" precision={3} step={0.002}
            min={0.001} max={2} value={paintBrush.halfWidthSec}
            onLiveChange={(v) => setPaintBrush({ halfWidthSec: v })}
            onCommit={(v) => setPaintBrush({ halfWidthSec: v })}
          />
          <DragNumberField
            className="sandbox-drag-field" label="Freq" suffix="Hz" precision={0} step={5}
            min={1} max={10000} value={paintBrush.halfHeightHz}
            onLiveChange={(v) => setPaintBrush({ halfHeightHz: v })}
            onCommit={(v) => setPaintBrush({ halfHeightHz: v })}
          />
          <DragNumberField
            className="sandbox-drag-field" label="Amt" suffix="dB" precision={0} step={0.5}
            min={SPECTRAL_PAINT_AMOUNT_DB_MIN} max={SPECTRAL_PAINT_AMOUNT_DB_MAX}
            value={paintBrush.amountDb}
            onLiveChange={(v) => setPaintBrush({ amountDb: v })}
            onCommit={(v) => setPaintBrush({ amountDb: v })}
          />
          <DragNumberField
            className="sandbox-drag-field" label="Fth t" suffix="ms" precision={0} step={0.5}
            min={0} max={500} value={paintBrush.featherTimeMs}
            onLiveChange={(v) => setPaintBrush({ featherTimeMs: v })}
            onCommit={(v) => setPaintBrush({ featherTimeMs: v })}
          />
          <DragNumberField
            className="sandbox-drag-field" label="Fth f" suffix="Hz" precision={0} step={5}
            min={0} max={5000} value={paintBrush.featherFreqHz}
            onLiveChange={(v) => setPaintBrush({ featherFreqHz: v })}
            onCommit={(v) => setPaintBrush({ featherFreqHz: v })}
          />
        </div>
      )}

      {/* Always-true navigation keys, at the foot of the column. Not per-tool:
          these work in every mode, which is exactly why they belong somewhere
          permanent rather than inside one tool's hint. */}
      <div className="sandbox-toolcol-keys">
        <div className="sandbox-toolcol-keys-title">KEYS</div>
        <div><kbd>Space</kbd> mix</div>
        <div><kbd>⇧Spc</kbd> layer</div>
        <div><kbd>L</kbd> loop</div>
        <div><kbd>^whl</kbd> zoom</div>
        <div><kbd>⇧whl</kbd> scroll</div>
        <div><kbd>^E</kbd> to sel</div>
        <div><kbd>^F</kbd> fit</div>
      </div>
    </div>
  )
}
