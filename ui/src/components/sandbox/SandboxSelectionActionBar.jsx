import { useState } from 'react'
import {
  Crop, Scissors, Copy, ClipboardPaste, VolumeX, TrendingUp, TrendingDown, Volume2,
} from 'lucide-react'
import useSandboxStore, { hasMeaningfulSelection } from '../../stores/sandboxStore.js'
import { FADE_SHAPES } from './sandboxToolConstants.js'

// Row 2 — rendered ONLY when a selection exists (hidden otherwise). Every
// button here fires the exact same store command the old SandboxToolbar
// buttons did; only the home changed. gainSelection/normalizeSelection/
// fadeSelection all read the current selection from the store themselves
// (see sandboxStore.js), so relocating the trigger changes nothing about
// what gets applied.
export default function SandboxSelectionActionBar() {
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)

  const addOp = useSandboxStore((s) => s.addOp)
  const cutSelection = useSandboxStore((s) => s.cutSelection)
  const copySelection = useSandboxStore((s) => s.copySelection)
  const pasteClipboard = useSandboxStore((s) => s.pasteClipboard)
  const insertSilence = useSandboxStore((s) => s.insertSilence)
  const fadeSelection = useSandboxStore((s) => s.fadeSelection)
  const gainSelection = useSandboxStore((s) => s.gainSelection)
  const normalizeSelection = useSandboxStore((s) => s.normalizeSelection)

  const [fadeShape, setFadeShape] = useState('equalPower')
  const [gainDb, setGainDb] = useState(-6)
  const [normTargetDb, setNormTargetDb] = useState(-1)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const hasSelection = hasLayer && hasMeaningfulSelection(selection, layer.renderedBuffer?.sampleRate)
  const cursorSample = selection?.startSample ?? 0

  // The bar itself is only mounted while hasSelection is true (see
  // SandboxPanelContent), but keep the guard — a selection can be cleared by
  // an accepted edit mid-render before this component unmounts.
  if (!hasSelection) return null

  const handleTrim = () => addOp(activeLayerId, {
    type: 'trim',
    params: { startSample: selection.startSample, endSample: selection.endSample },
  })

  return (
    <div className="sandbox-selection-bar">
      <button className="sandbox-tool-btn" onClick={handleTrim} title="Keep only the selection">
        <Crop size={14} /><span>Trim</span>
      </button>
      <button className="sandbox-tool-btn" onClick={() => cutSelection(activeLayerId, 'ripple')}
        title="Remove the selection, closing the gap (copies it first)">
        <Scissors size={14} /><span>Cut</span>
      </button>
      <button className="sandbox-tool-btn" onClick={() => copySelection(activeLayerId)}
        title="Copy the selection to the sandbox clipboard">
        <Copy size={14} /><span>Copy</span>
      </button>
      <button className="sandbox-tool-btn" disabled={!clipboard}
        onClick={() => pasteClipboard(activeLayerId, cursorSample, true)}
        title="Insert the clipboard at the selection start">
        <ClipboardPaste size={14} /><span>Paste</span>
      </button>
      <button className="sandbox-tool-btn"
        onClick={() => insertSilence(activeLayerId, selection.startSample, selection.endSample - selection.startSample, false)}
        title="Mute the selection in place">
        <VolumeX size={14} /><span>Silence</span>
      </button>

      <div className="sandbox-toolbar-divider" />

      <select
        className="sandbox-toolbar-select"
        value={fadeShape}
        onChange={(e) => setFadeShape(e.target.value)}
        title="Fade curve shape"
      >
        {FADE_SHAPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
      </select>
      <button className="sandbox-tool-btn" onClick={() => fadeSelection(activeLayerId, true, fadeShape)} title="Fade in">
        <TrendingUp size={14} /><span>Fade In</span>
      </button>
      <button className="sandbox-tool-btn" onClick={() => fadeSelection(activeLayerId, false, fadeShape)} title="Fade out">
        <TrendingDown size={14} /><span>Fade Out</span>
      </button>

      <div className="sandbox-toolbar-divider" />

      <input
        className="sandbox-toolbar-number"
        type="number" step="0.5" value={gainDb}
        onChange={(e) => setGainDb(Number(e.target.value))}
        title="Gain, dB"
      />
      <button className="sandbox-tool-btn" onClick={() => gainSelection(activeLayerId, gainDb)} title="Apply gain">
        <Volume2 size={14} /><span>Gain</span>
      </button>
      <input
        className="sandbox-toolbar-number"
        type="number" step="0.5" value={normTargetDb}
        onChange={(e) => setNormTargetDb(Number(e.target.value))}
        title="Normalize target peak, dBFS"
      />
      <button className="sandbox-tool-btn" onClick={() => normalizeSelection(activeLayerId, normTargetDb)} title="Normalize">
        <Volume2 size={14} /><span>Normalize</span>
      </button>
    </div>
  )
}
