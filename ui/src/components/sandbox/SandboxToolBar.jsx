import useSandboxPanelStore from '../../stores/sandboxPanelStore.js'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'
import { IconButton, NumberBox, SegmentedControl, Toggle, Toolbar, ToolbarSeparator } from '../../ui-kit'
import { activeToolOf } from './sandboxToolConstants.js'
import styles from './Sandbox.module.css'
import { iconComponent } from '../../ui-kit/icons'

const IcArrowsOutLineHorizontal = iconComponent('arrows-out-line-horizontal')
const IcBezierCurve = iconComponent('bezier-curve')
const IcCursor = iconComponent('cursor')
const IcFrameCorners = iconComponent('frame-corners')
const IcLasso = iconComponent('lasso')
const IcMagnifyingGlassMinus = iconComponent('magnifying-glass-minus')
const IcMagnifyingGlassPlus = iconComponent('magnifying-glass-plus')
const IcPaintBrush = iconComponent('paint-brush')
const IcRectangleDashed = iconComponent('rectangle-dashed')
const IcSelection = iconComponent('selection')
const IcSidebarSimple = iconComponent('sidebar-simple')

// ── The tool and view bar ───────────────────────────────────────────────────
//
// The row of MODES, directly above the display they change: which tool owns
// the pointer, that tool's own settings, how far in the view is zoomed, and
// whether it shows the waveform or the spectrogram. Commands live in the row
// above (SandboxMenuBar); nothing here edits audio by being clicked.
//
// This replaces a 148px tool COLUMN that held two buttons and a key legend.
// Three things changed with the move:
//
//  - All four tools are always offered. The column swapped its set with the
//    view (Envelope in waveform view, Paint and Region in spectral view), so a
//    tool could only be found by first switching to the view it lived in. A
//    tool that needs the other view switches to it, as it always did — and the
//    view switch sits in this same row, so the change is seen happening.
//  - A tool's settings appear beside the tool, not in a block under the column.
//  - The view switch is two visible segments instead of a View menu with two
//    entries.
//
// "Region" is this app's third spectral tool (rect/freehand time by frequency
// select, then Attenuate/Boost/Mute/Copy to new layer); there is no separate
// erase gesture.

const SHAPE_OPTIONS = [
  { value: 'rect', label: <IcRectangleDashed size={14} aria-hidden="true" />, ariaLabel: 'Rectangle selection' },
  { value: 'freehand', label: <IcLasso size={14} aria-hidden="true" />, ariaLabel: 'Freehand selection' },
]

// The brush is stored as HALF extents (seconds, Hz) because that is what a dab is on the wire, but a brush is
// thought of by its full size: "100 ms wide, 400 Hz tall". The boxes show and accept the full size.
const parseScaled = (perUnit) => (text) => {
  const n = Number.parseFloat(String(text).replace(',', '.'))
  return Number.isFinite(n) ? n / perUnit : null
}

const VIEW_OPTIONS = [
  { value: 'wav', label: 'Waveform', hint: 'Waveform', hintMods: 'Amplitude over time' },
  { value: 'spc', label: 'Spectral', hint: 'Spectral', hintMods: 'Frequency over time. The Paint and Region tools work here' },
]

export default function SandboxToolBar() {
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
  const selectTool = useSandboxStore((s) => s.selectTool)
  const zoomBy = useSandboxStore((s) => s.zoomBy)
  const zoomToFit = useSandboxStore((s) => s.zoomToFit)
  const zoomToSelection = useSandboxStore((s) => s.zoomToSelection)
  const sidebarOpen = useSandboxPanelStore((s) => s.sidebarOpen)
  const toggleSidebar = useSandboxPanelStore((s) => s.toggleSidebar)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const activeTool = activeToolOf({ paintEditMode, envelopeEditMode, spcSelectMode })

  // Leaving spectral view with a spectral tool armed would leave the pointer in
  // a mode with nothing to act on, so the view switch hands it back to Select.
  const changeView = (mode) => {
    if (mode === 'wav' && (paintEditMode || spcSelectMode)) { setPaintEditMode(false); setSpcSelectMode(false) }
    setViewMode(mode)
  }

  return (
    <div className={styles.toolbar}>
      <Toolbar label="Tools" className={styles.toolGroup}>
        <Toggle
          size="sm" on={activeTool === 'select'} glyph={<IcCursor />}
          onChange={() => selectTool('select')}
          hint="Select tool (S)"
          hintMods="Drag: select · Drag an edge: adjust · Click: place the cursor · Double-click: select all · Alt: no zero-crossing snap"
        >
          Select
        </Toggle>
        <Toggle
          size="sm" on={activeTool === 'envelope'} glyph={<IcBezierCurve />} disabled={!hasLayer}
          onChange={() => selectTool('envelope')}
          hint="Envelope tool (E)"
          hintMods="Draw a gain curve over the waveform. Click the line: add a point · Drag: move · Right-click: delete"
        >
          Envelope
        </Toggle>
        <Toggle
          size="sm" on={activeTool === 'paint'} glyph={<IcPaintBrush />} disabled={!hasLayer}
          onChange={() => selectTool('paint')}
          hint="Paint tool (B)"
          hintMods="Paint energy out of (or into) the spectrogram. Switches to spectral view"
        >
          Paint
        </Toggle>
        <Toggle
          size="sm" on={activeTool === 'region'} glyph={<IcSelection />} disabled={!hasLayer}
          onChange={() => selectTool('region')}
          hint="Region tool (R)"
          hintMods="Select a time by frequency region, then attenuate, boost, mute or copy it. Switches to spectral view"
        >
          Region
        </Toggle>
      </Toolbar>

      {activeTool === 'region' && (
        <div className={styles.toolOptions} role="group" aria-label="Region tool settings">
          <span className={styles.optionLabel}>Shape</span>
          <SegmentedControl
            size="sm"
            label="Region selection shape"
            options={SHAPE_OPTIONS}
            value={spcSelectShape}
            onChange={setSpcSelectShape}
          />
        </div>
      )}

      {activeTool === 'paint' && (
        <div className={styles.toolOptions} role="group" aria-label="Brush settings">
          {/* paintBrush is local session state (no bridge call), so a live preview and the committed value are
              the same write. */}
          <NumberBox
            label="Brush width" caption="Width" width={104} min={0.001} max={2} step={0.002}
            format={(v) => `${Math.round(v * 2000)} ms`} parse={parseScaled(2000)} defaultValue={0.05}
            value={paintBrush.halfWidthSec}
            onChange={(v) => setPaintBrush({ halfWidthSec: v })}
          />
          <NumberBox
            label="Brush height" caption="Height" width={112} min={1} max={10000} step={5}
            format={(v) => `${Math.round(v * 2)} Hz`} parse={parseScaled(2)} defaultValue={200} quantize={Math.round}
            value={paintBrush.halfHeightHz}
            onChange={(v) => setPaintBrush({ halfHeightHz: v })}
          />
          <NumberBox
            label="Brush amount" caption="Amount" width={112}
            min={SPECTRAL_PAINT_AMOUNT_DB_MIN} max={SPECTRAL_PAINT_AMOUNT_DB_MAX} step={0.5} unit="dB"
            defaultValue={-12}
            value={paintBrush.amountDb}
            onChange={(v) => setPaintBrush({ amountDb: v })}
          />
          <NumberBox
            label="Feather in time" caption="Feather W" width={124} min={0} max={500} step={0.5} unit="ms" defaultValue={0}
            hint="Feather in time" hintMods="How far the brush fades out past its width"
            value={paintBrush.featherTimeMs}
            onChange={(v) => setPaintBrush({ featherTimeMs: v })}
          />
          <NumberBox
            label="Feather in frequency" caption="Feather H" width={124} min={0} max={5000} step={5} unit="Hz" defaultValue={0}
            quantize={Math.round}
            hint="Feather in frequency" hintMods="How far the brush fades out past its height"
            value={paintBrush.featherFreqHz}
            onChange={(v) => setPaintBrush({ featherFreqHz: v })}
          />
        </div>
      )}

      <span className={styles.spacer} />

      <Toolbar label="Zoom" className={styles.toolGroup}>
        <IconButton size="sm" label="Zoom out" disabled={!hasLayer} onClick={() => zoomBy(1.6)} hint="Zoom out" hintMods="Minus key · Ctrl+wheel zooms at the pointer · Shift+wheel scrolls">
          <IcMagnifyingGlassMinus />
        </IconButton>
        <IconButton size="sm" label="Zoom in" disabled={!hasLayer} onClick={() => zoomBy(1 / 1.6)} hint="Zoom in" hintMods="Plus key · Ctrl+wheel zooms at the pointer · Shift+wheel scrolls">
          <IcMagnifyingGlassPlus />
        </IconButton>
        <IconButton size="sm" label="Zoom to selection" disabled={!hasLayer} onClick={() => zoomToSelection()} hint="Zoom to selection" hintMods="Ctrl+E">
          <IcFrameCorners />
        </IconButton>
        <IconButton size="sm" label="Fit whole layer" disabled={!hasLayer} onClick={() => zoomToFit()} hint="Fit whole layer" hintMods="Ctrl+F">
          <IcArrowsOutLineHorizontal />
        </IconButton>
      </Toolbar>
      <ToolbarSeparator />
      <SegmentedControl size="sm" label="View" options={VIEW_OPTIONS} value={viewMode} onChange={changeView} />
      <IconButton
        size="sm"
        label={sidebarOpen ? 'Hide layers and edit stack' : 'Show layers and edit stack'}
        pressed={sidebarOpen}
        tone="quiet"
        onClick={() => toggleSidebar()}
        hint={sidebarOpen ? 'Hide layers and edit stack' : 'Show layers and edit stack'}
        hintMods="Hidden, the display takes the full width of the panel"
      >
        {/* Phosphor's sidebar has its bar on the left; this panel opens on the right. */}
        <IcSidebarSimple style={{ transform: 'scaleX(-1)' }} />
      </IconButton>
    </div>
  )
}
