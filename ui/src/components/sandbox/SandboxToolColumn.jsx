import { MousePointer2, Spline, Grid2x2, BoxSelect, Square, Lasso } from 'lucide-react'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'
import { NumberBox, SegmentedControl, Toggle } from '../../ui-kit'
import { activeToolOf } from './sandboxToolConstants.js'
import styles from './Sandbox.module.css'

// Vertical tool column at the left edge of the workspace, below the menu bar.
// The tool SET swaps per view: WAVEFORM = Select/Envelope, SPECTRAL =
// Select/Paint/Region. Envelope draws over either view in the real app
// (drawEnvelope/handleEnvDown never gate on viewMode) but only appears in the
// WAV set, so picking it while in SPC view switches back to WAV — the same
// direction Paint/Region already force a switch TO spc.
// "Region" is this app's real third SPC tool (rect/freehand t×f select →
// Attenuate/Boost/Mute/Copy to New Layer); there is no separate "Erase"
// gesture, so Region fills that slot rather than a fabricated eraser.

const SHAPE_OPTIONS = [
  { value: 'rect', label: <Square size={12} aria-hidden="true" />, ariaLabel: 'Rectangle selection' },
  { value: 'freehand', label: <Lasso size={12} aria-hidden="true" />, ariaLabel: 'Freehand selection' },
]

const KEYS = [
  ['Space', 'Play mix'],
  ['Shift+Space', 'Play layer'],
  ['L', 'Loop'],
  ['Ctrl+wheel', 'Zoom'],
  ['Shift+wheel', 'Scroll'],
  ['Ctrl+E', 'Zoom to selection'],
  ['Ctrl+F', 'Fit layer'],
]

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
    <div className={styles.toolcol} role="toolbar" aria-orientation="vertical" aria-label="Sandbox tools">
      <Toggle
        on={activeTool === 'select'}
        glyph={<MousePointer2 />}
        onChange={selectTool}
        hint="Select"
        hintMods="Drag on the waveform to make a selection"
      >
        Select
      </Toggle>

      {viewMode === 'wav' ? (
        <Toggle
          on={activeTool === 'envelope'}
          glyph={<Spline />}
          disabled={!hasLayer}
          onChange={armEnvelope}
          hint="Envelope"
          hintMods="Draw a gain envelope over the waveform (Mode 1 or 2, see the Gain Envelope op)"
        >
          Envelope
        </Toggle>
      ) : (
        <>
          <Toggle
            on={activeTool === 'paint'}
            glyph={<Grid2x2 />}
            disabled={!hasLayer}
            onChange={armPaint}
            hint="Paint"
            hintMods="Paint out energy directly on the spectrogram (see the Spectral Paint op)"
          >
            Paint
          </Toggle>
          <Toggle
            on={activeTool === 'region'}
            glyph={<BoxSelect />}
            disabled={!hasLayer}
            onChange={armRegionSelect}
            hint="Region"
            hintMods="Select a rectangle or freehand time by frequency region, then Attenuate, Boost, Mute or Copy"
          >
            Region
          </Toggle>
        </>
      )}

      {activeTool === 'region' && (
        <div className={styles.toolParams}>
          <div className={styles.paramsTitle}>Region shape</div>
          <SegmentedControl
            label="Region selection shape"
            options={SHAPE_OPTIONS}
            value={spcSelectShape}
            onChange={setSpcSelectShape}
          />
        </div>
      )}

      {activeTool === 'paint' && (
        <div className={styles.toolParams}>
          <div className={styles.paramsTitle}>Brush</div>
          {/* paintBrush is local session state (no bridge call), so a live preview and the committed value are
              the same write. */}
          <NumberBox
            label="Size" width={64} min={0.001} max={2} step={0.002}
            format={(v) => `${v.toFixed(3)} s`} defaultValue={0.05}
            value={paintBrush.halfWidthSec}
            onChange={(v) => setPaintBrush({ halfWidthSec: v })}
          />
          <NumberBox
            label="Frequency" width={64} min={1} max={10000} step={5} unit="Hz"
            defaultValue={200} quantize={Math.round}
            value={paintBrush.halfHeightHz}
            onChange={(v) => setPaintBrush({ halfHeightHz: v })}
          />
          <NumberBox
            label="Amount" width={64}
            min={SPECTRAL_PAINT_AMOUNT_DB_MIN} max={SPECTRAL_PAINT_AMOUNT_DB_MAX} step={0.5} unit="dB"
            defaultValue={-12}
            value={paintBrush.amountDb}
            onChange={(v) => setPaintBrush({ amountDb: v })}
          />
          <NumberBox
            label="Feather time" width={64} min={0} max={500} step={0.5} unit="ms" defaultValue={0}
            value={paintBrush.featherTimeMs}
            onChange={(v) => setPaintBrush({ featherTimeMs: v })}
          />
          <NumberBox
            label="Feather freq" width={64} min={0} max={5000} step={5} unit="Hz" defaultValue={0}
            quantize={Math.round}
            value={paintBrush.featherFreqHz}
            onChange={(v) => setPaintBrush({ featherFreqHz: v })}
          />
        </div>
      )}

      {/* Always-true navigation keys, at the foot of the column. Not per-tool:
          these work in every mode, which is exactly why they belong somewhere
          permanent rather than inside one tool's hint. */}
      <div className={styles.keys}>
        <div className={styles.keysTitle}>Keys</div>
        {KEYS.map(([key, what]) => (
          <span key={key} className={styles.keyRow}>
            <kbd className={styles.kbd}>{key}</kbd>
            <span>{what}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
