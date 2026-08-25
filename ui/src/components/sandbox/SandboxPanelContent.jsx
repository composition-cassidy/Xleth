import { useEffect, useRef } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import useSandboxPanelStore from '../../stores/sandboxPanelStore.js'
import { useKeyboardBinding } from '../../windowing/managers/useKeyboardBinding.ts'
import { stopSandboxPreview } from './sandboxPreviewPlayer.js'
import SandboxSourcesPanel from './SandboxSourcesPanel.jsx'
import SandboxToolstrip from './SandboxToolstrip.jsx'
import SandboxSelectionActionBar from './SandboxSelectionActionBar.jsx'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxStackPanel from './SandboxStackPanel.jsx'
import SandboxStatusBar from './SandboxStatusBar.jsx'
import './sandbox.css'

export default function SandboxPanelContent() {
  const openTarget = useSandboxPanelStore((s) => s.openTarget)
  const clearOpenTarget = useSandboxPanelStore((s) => s.clearOpenTarget)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const selection = useSandboxStore((s) => s.selection)
  const consumedRef = useRef(null)

  // The selection action bar only makes sense once there is a rendered
  // buffer to select INTO — mirrors every selection-gated command in the
  // store, which already no-ops without one.
  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSelection = !!activeLayer && activeLayer.renderState === 'ready'
    && !!selection && selection.endSample > selection.startSample

  // One-shot: a context-menu entry point sets openTarget then opens this
  // panel. Consume it once (by region id) so re-renders / panel refocus
  // don't re-add the same layer.
  useEffect(() => {
    if (!openTarget || consumedRef.current === openTarget.id) return
    consumedRef.current = openTarget.id
    addSourceFromRegion(openTarget)
    clearOpenTarget()
  }, [openTarget, addSourceFromRegion, clearOpenTarget])

  // ── Space: preview/stop the rendered composite ──────────────────────────
  // Scoped to `panel:sampleSandbox` so it only fires while this panel is
  // focused, and only ever wins the dispatch race for that combo then — see
  // resolveFocusedPanel() in KeyboardManager. TransportBar's own Space
  // handler is a raw window-level listener outside that router entirely, so
  // it still gets the event on bubble unless we stop it here explicitly.
  // The toggle itself lives in sandboxStore (toggleCompositePreview) so the
  // composite section's own Play button shares the exact same state — no
  // separate "is it playing" flag to drift out of sync.
  // KeyboardManager's combo strings are built from event.key, and the
  // spacebar's event.key is a literal " " (not the string "Space") — match
  // that, not event.code.
  useKeyboardBinding('panel:sampleSandbox', ' ', (e) => {
    e.preventDefault()
    e.stopPropagation()
    useSandboxStore.getState().toggleCompositePreview()
    return 'handled'
  })
  useEffect(() => () => {
    // Stop on panel unmount/close — also resets the store flag so a reopen
    // doesn't show a stale "Stop" icon for audio that's no longer playing.
    stopSandboxPreview()
    useSandboxStore.setState({ compositePreviewState: 'idle' })
  }, [])

  return (
    <div className="sandbox-panel-content">
      <div className="sandbox-main-row">
        <SandboxSourcesPanel />
        <div className="sandbox-center-column">
          <SandboxToolstrip />
          {hasSelection && <SandboxSelectionActionBar />}
          <SandboxWaveformCanvas />
        </div>
        <SandboxStackPanel />
      </div>
      <SandboxStatusBar />
    </div>
  )
}
