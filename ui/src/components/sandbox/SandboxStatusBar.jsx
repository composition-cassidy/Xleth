import { useEffect } from 'react'

import useSandboxStore from '../../stores/sandboxStore.js'

// Bottom readout bar — cursor position, selection start/end/length, undo
// depth, clipboard size. Live: every value here is read straight off the
// store on each render, same source of truth the waveform canvas and op
// stack already use. Render/composite status moved to the toolstrip's render
// chip and the Composite section (Sources & Layers panel) respectively, so
// this bar isn't a second copy of state shown elsewhere.
function formatSec(samples, sampleRate) {
  if (!sampleRate || samples == null) return '0.000'
  return (samples / sampleRate).toFixed(3)
}

function formatHz(hz) {
  if (!Number.isFinite(hz)) return '—'
  return hz >= 1000 ? `${(hz / 1000).toFixed(2)}k` : `${Math.round(hz)}`
}

// Time × Hz span of a committed SPC selection's shapes — min/max across every
// shape, so a multi-shape freehand selection reads as ONE bounding readout
// rather than a list. `sampleRate` is the rendered buffer's own rate, same
// convention every other readout in this file uses.
function spcSelectionSpan(spcSelection, sampleRate) {
  const shapes = spcSelection?.shapes
  if (!shapes?.length || !sampleRate) return null
  let startSample = Infinity, endSample = -Infinity, minHz = Infinity, maxHz = -Infinity
  for (const s of shapes) {
    startSample = Math.min(startSample, s.centerSample - s.halfWidthSamples)
    endSample   = Math.max(endSample, s.centerSample + s.halfWidthSamples)
    minHz = Math.min(minHz, s.centerFreqHz - s.halfHeightHz)
    maxHz = Math.max(maxHz, s.centerFreqHz + s.halfHeightHz)
  }
  return { startSample, endSample, minHz: Math.max(0, minHz), maxHz }
}

// Composite auto-render state, folded into the same idle/rendering/ready/
// error vocabulary the per-layer render chip already uses (sandbox.css's
// `.sandbox-render-chip--*` rules), so this bar's composite chip needs no
// styling of its own. `debouncePending`/`pending` (sandboxStore's
// compositeAutoRender) both mean "a render is scheduled or in flight" —
// see _scheduleCompositeAutoRender / _runCompositeAutoRender.
function compositeChipState(composite, compositeAutoRender) {
  if (composite.renderState === 'error') return 'error'
  if (compositeAutoRender.debouncePending || compositeAutoRender.pending || composite.renderState === 'rendering') return 'rendering'
  if (composite.renderState === 'ready') return 'ready'
  return 'idle'
}

const COMPOSITE_CHIP_LABEL = {
  idle: 'IDLE', rendering: 'COMPOSITING…', ready: 'CACHED', error: 'RENDER FAILED',
}

export default function SandboxStatusBar() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const selection = useSandboxStore((s) => s.selection)
  const clipboard = useSandboxStore((s) => s.clipboard)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const spcSelection = useSandboxStore((s) => s.spcSelection)
  const spcHoverReadout = useSandboxStore((s) => s.spcHoverReadout)
  const history = useSandboxStore((s) => s.history)
  const refreshHistory = useSandboxStore((s) => s.refreshHistory)
  const composite = useSandboxStore((s) => s.composite)
  const compositeAutoRender = useSandboxStore((s) => s.compositeAutoRender)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  const chipState = compositeChipState(composite, compositeAutoRender)

  // The panel can be opened onto a session whose edits it never saw (a project
  // load, or edits made while it was closed), so seed the readout on mount.
  useEffect(() => { refreshHistory() }, [refreshHistory])

  const sampleRate = layer?.renderedBuffer?.sampleRate
  const hasSelection = !!selection && selection.endSample > selection.startSample
  const cursorSample = selection?.startSample ?? 0
  const lengthSamples = hasSelection ? selection.endSample - selection.startSample : 0

  // Time × Hz readout — live under the pointer while hovering the SPC canvas,
  // falling back to the committed region selection's own bounding span so the
  // readout stays informative between drags, then to '—' when neither exists.
  // Only shown in SPC view: WAV has no frequency axis for this to describe.
  const spcSpan = spcSelectionSpan(spcSelection, sampleRate)
  const spcReadout = viewMode !== 'spc'
    ? null
    : spcHoverReadout
      ? `${spcHoverReadout.sec.toFixed(3)}s × ${formatHz(spcHoverReadout.hz)} Hz`
      : spcSpan
        ? `${formatSec(spcSpan.startSample, sampleRate)}–${formatSec(spcSpan.endSample, sampleRate)}s × ${formatHz(spcSpan.minHz)}–${formatHz(spcSpan.maxHz)} Hz`
        : '—'

  return (
    <div className="sandbox-status-bar">
      <div className="sandbox-readout-group">
        <span className="sandbox-status-item">Cursor: {formatSec(cursorSample, sampleRate)}</span>
        <span className="sandbox-status-item">
          Sel: {hasSelection ? `${formatSec(selection.startSample, sampleRate)} – ${formatSec(selection.endSample, sampleRate)}` : '—'}
        </span>
        <span className="sandbox-status-item">Len: {hasSelection ? `${formatSec(lengthSamples, sampleRate)}s` : '—'}</span>
        {viewMode === 'spc' && <span className="sandbox-status-item">t × Hz: {spcReadout}</span>}
      </div>
      <div className="sandbox-readout-group">
        <span className="sandbox-status-item">Layers: {layers.length}</span>
        <span className="sandbox-status-item">Undo depth: {history.sandboxUndoCount}</span>
        <span className="sandbox-status-item">
          Clipboard: {clipboard ? `${clipboard.numSamples} smp` : 'empty'}
        </span>
        <span className={`sandbox-render-chip sandbox-render-chip--${chipState}`}>
          <span className="sandbox-render-chip-dot" />
          Composite: {COMPOSITE_CHIP_LABEL[chipState]}
        </span>
      </div>
    </div>
  )
}
