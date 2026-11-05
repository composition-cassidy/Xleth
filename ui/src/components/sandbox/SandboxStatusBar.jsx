import { useEffect } from 'react'

import useSandboxStore from '../../stores/sandboxStore.js'
import { formatSamples, formatSamplesShort, formatHz } from './sandboxFormat.js'
import { resolveView, viewSpan, isFitted } from './sandboxView.js'
import { activeToolOf, TOOL_HINTS } from './sandboxToolConstants.js'

// Bottom readout bar — cursor position, selection start/end/length, undo
// depth, clipboard size. Live: every value here is read straight off the
// store on each render, same source of truth the waveform canvas and op
// stack already use. Render/composite status moved to the toolstrip's render
// chip and the Composite section (Sources & Layers panel) respectively, so
// this bar isn't a second copy of state shown elsewhere.
//
// Time formatting is shared with the ruler and the op rail (sandboxFormat.js)
// — this bar used to carry its own three-decimal helper, which is how the
// panel ended up reading seconds here, beats on the ruler and sample indices
// in the op stack.

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
  const view = useSandboxStore((s) => s.view)
  const envelopeEditMode = useSandboxStore((s) => s.envelopeEditMode)
  const paintEditMode = useSandboxStore((s) => s.paintEditMode)
  const spcSelectMode = useSandboxStore((s) => s.spcSelectMode)
  const layer = layers.find((l) => l.id === activeLayerId) ?? null

  // What the pointer currently does, in the middle of the bar. This lived in
  // the 64px tool column, where a sentence wrapped to five lines and read as
  // decoration.
  const toolHint = TOOL_HINTS[activeToolOf({ paintEditMode, envelopeEditMode, spcSelectMode })]

  const numSamples = layer?.renderedBuffer?.numSamples ?? 0
  const fitted = isFitted(view, numSamples)
  const visibleSamples = viewSpan(resolveView(view, numSamples))

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
        ? `${formatSamples(spcSpan.startSample, sampleRate)}–${formatSamples(spcSpan.endSample, sampleRate)} × ${formatHz(spcSpan.minHz)}–${formatHz(spcSpan.maxHz)} Hz`
        : '—'

  return (
    <div className="sandbox-status-bar">
      <div className="sandbox-readout-group">
        <span className="sandbox-status-item">Cursor: {formatSamples(cursorSample, sampleRate)}</span>
        <span className="sandbox-status-item">
          Sel: {hasSelection ? `${formatSamples(selection.startSample, sampleRate)} – ${formatSamples(selection.endSample, sampleRate)}` : '—'}
        </span>
        <span className="sandbox-status-item">Len: {hasSelection ? formatSamplesShort(lengthSamples, sampleRate) : '—'}</span>
        {/* Zoom, stated as a span rather than a percentage: "0.42s visible" is
            the number you can act on when deciding whether to zoom further,
            and "1400%" is not. Hidden while fitted, where the waveform's own
            extent already says it. */}
        {!fitted && (
          <span className="sandbox-status-item sandbox-status-item--zoom" title="Visible range — Ctrl+F fits the whole layer">
            View: {formatSamplesShort(visibleSamples, sampleRate)}
          </span>
        )}
        {viewMode === 'spc' && <span className="sandbox-status-item">t × Hz: {spcReadout}</span>}
      </div>
      <span className="sandbox-status-hint">{toolHint}</span>

      <div className="sandbox-readout-group">
        <span className="sandbox-status-item">Layers: {layers.length}</span>
        <span className="sandbox-status-item">Undo depth: {history.sandboxUndoCount}</span>
        <span className="sandbox-status-item">
          Clipboard: {clipboard ? formatSamplesShort(clipboard.numSamples, sampleRate) : 'empty'}
        </span>
        <span className={`sandbox-render-chip sandbox-render-chip--${chipState}`}>
          <span className="sandbox-render-chip-dot" />
          Composite: {COMPOSITE_CHIP_LABEL[chipState]}
        </span>
      </div>
    </div>
  )
}
