import { useState } from 'react'
import {
  Scissors, Crop, Copy, ClipboardPaste, VolumeX, FlipHorizontal2,
  SeparatorHorizontal, TrendingUp, TrendingDown, Volume2, Waves, Spline,
} from 'lucide-react'
import useSandboxStore from '../../stores/sandboxStore.js'

// Every button below applies its op IMMEDIATELY to the current selection —
// there is no persistent "tool mode" the way chop/trim implied in the SB-3
// shell. That matches the rest of this panel: bypass/remove/bake are all
// one-click actions on whatever is selected, never a mode you enter first.

const FADE_SHAPES = [
  { value: 'linear', label: 'Linear' },
  { value: 'equalPower', label: 'Equal Power' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'logarithmic', label: 'Logarithmic' },
  { value: 'sCurve', label: 'S-Curve' },
  { value: 'hann', label: 'Hann' },
]

function ToolButton({ icon: Icon, label, disabled, onClick, title, active }) {
  return (
    <button
      className={`sandbox-tool-btn${active ? ' active' : ''}`}
      disabled={disabled}
      onClick={onClick}
      title={title || label}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  )
}

export default function SandboxToolbar() {
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)

  const addOp = useSandboxStore((s) => s.addOp)
  const cutSelection = useSandboxStore((s) => s.cutSelection)
  const copySelection = useSandboxStore((s) => s.copySelection)
  const pasteClipboard = useSandboxStore((s) => s.pasteClipboard)
  const insertSilence = useSandboxStore((s) => s.insertSilence)
  const spliceAtCursor = useSandboxStore((s) => s.spliceAtCursor)
  const reverseSelection = useSandboxStore((s) => s.reverseSelection)
  const fadeSelection = useSandboxStore((s) => s.fadeSelection)
  const gainSelection = useSandboxStore((s) => s.gainSelection)
  const normalizeSelection = useSandboxStore((s) => s.normalizeSelection)
  const crossfadeAtCursor = useSandboxStore((s) => s.crossfadeAtCursor)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const toggleEnvelopeEditMode = useSandboxStore((s) => s.toggleEnvelopeEditMode)

  const [fadeShape, setFadeShape] = useState('equalPower')
  const [gainDb, setGainDb] = useState(-6)
  const [normTargetDb, setNormTargetDb] = useState(-1)
  const [xfadeShape, setXfadeShape] = useState('hann')
  const [xfadeLength, setXfadeLength] = useState(256)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const hasSelection = hasLayer && !!selection && selection.endSample > selection.startSample
  const cursorSample = selection?.startSample ?? 0

  const handleTrim = () => hasSelection && addOp(activeLayerId, {
    type: 'trim',
    params: { startSample: selection.startSample, endSample: selection.endSample },
  })

  return (
    <div className="sandbox-toolbar">
      <ToolButton icon={Crop} label="Trim" disabled={!hasSelection} onClick={handleTrim}
        title="Keep only the selection" />
      <ToolButton icon={Scissors} label="Cut" disabled={!hasSelection}
        onClick={() => cutSelection(activeLayerId, 'ripple')}
        title="Remove the selection, closing the gap (copies it first)" />
      <ToolButton icon={Copy} label="Copy" disabled={!hasSelection}
        onClick={() => copySelection(activeLayerId)}
        title="Copy the selection to the sandbox clipboard" />
      <ToolButton icon={ClipboardPaste} label="Paste" disabled={!hasLayer || !clipboard}
        onClick={() => pasteClipboard(activeLayerId, cursorSample, true)}
        title="Insert the clipboard at the selection start" />
      <ToolButton icon={VolumeX} label="Silence" disabled={!hasSelection}
        onClick={() => insertSilence(activeLayerId, selection.startSample, selection.endSample - selection.startSample, false)}
        title="Mute the selection in place" />
      <ToolButton icon={VolumeX} label="Ins. Silence" disabled={!hasSelection}
        onClick={() => insertSilence(activeLayerId, selection.startSample, selection.endSample - selection.startSample, true)}
        title="Insert silence the length of the selection" />
      <ToolButton icon={SeparatorHorizontal} label="Splice" disabled={!hasLayer}
        onClick={() => spliceAtCursor(activeLayerId, cursorSample, 'ripple', 0)}
        title="Split at the selection start and swap the two halves" />
      <ToolButton icon={FlipHorizontal2} label="Reverse" disabled={!hasLayer}
        onClick={() => reverseSelection(activeLayerId)}
        title="Reverse the selection (or the whole buffer)" />

      <div className="sandbox-toolbar-divider" />

      <select
        className="sandbox-toolbar-select"
        value={fadeShape}
        onChange={(e) => setFadeShape(e.target.value)}
        title="Fade curve shape"
      >
        {FADE_SHAPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
      <ToolButton icon={TrendingUp} label="Fade In" disabled={!hasSelection}
        onClick={() => fadeSelection(activeLayerId, true, fadeShape)} />
      <ToolButton icon={TrendingDown} label="Fade Out" disabled={!hasSelection}
        onClick={() => fadeSelection(activeLayerId, false, fadeShape)} />

      <div className="sandbox-toolbar-divider" />

      <input
        className="sandbox-toolbar-number"
        type="number" step="0.5" value={gainDb}
        onChange={(e) => setGainDb(Number(e.target.value))}
        title="Gain, dB"
      />
      <ToolButton icon={Volume2} label="Gain" disabled={!hasLayer}
        onClick={() => gainSelection(activeLayerId, gainDb)} />
      <input
        className="sandbox-toolbar-number"
        type="number" step="0.5" value={normTargetDb}
        onChange={(e) => setNormTargetDb(Number(e.target.value))}
        title="Normalize target peak, dBFS"
      />
      <ToolButton icon={Volume2} label="Normalize" disabled={!hasLayer}
        onClick={() => normalizeSelection(activeLayerId, normTargetDb)} />

      <div className="sandbox-toolbar-divider" />

      <select
        className="sandbox-toolbar-select"
        value={xfadeShape}
        onChange={(e) => setXfadeShape(e.target.value)}
        title="Crossfade declick curve"
      >
        {FADE_SHAPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
      <input
        className="sandbox-toolbar-number"
        type="number" step="16" min="2" value={xfadeLength}
        onChange={(e) => setXfadeLength(Number(e.target.value))}
        title="Crossfade window, samples"
      />
      <ToolButton icon={Waves} label="Crossfade" disabled={!hasLayer}
        onClick={() => crossfadeAtCursor(activeLayerId, cursorSample, xfadeLength, xfadeShape)}
        title="Declick a seam at the selection start" />

      <div className="sandbox-toolbar-divider" />

      {/* The one MODE in this toolbar. Every other button applies its op
          immediately; this one arms the waveform canvas so clicks land on the
          gain curve instead of starting a selection. It has to be a mode
          because the two gestures share the left button — see the header
          comment in SandboxWaveformCanvas.jsx. A press that misses the curve
          still falls through to a selection drag, so arming it never takes a
          capability away. */}
      <ToolButton icon={Spline} label="Envelope" disabled={!hasLayer}
        active={envelopeEditMode}
        onClick={toggleEnvelopeEditMode}
        title="Draw a gain envelope: click the line to add a point, drag to move, right-click a point to delete" />
    </div>
  )
}
