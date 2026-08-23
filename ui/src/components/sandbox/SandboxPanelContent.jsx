import { useEffect, useRef, useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import useSandboxPanelStore from '../../stores/sandboxPanelStore.js'
import { useKeyboardBinding } from '../../windowing/managers/useKeyboardBinding.ts'
import { playSandboxPreview, stopSandboxPreview } from './sandboxPreviewPlayer.js'
import SandboxSourcesPanel from './SandboxSourcesPanel.jsx'
import SandboxToolbar from './SandboxToolbar.jsx'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxStackPanel from './SandboxStackPanel.jsx'
import SandboxStatusBar from './SandboxStatusBar.jsx'
import './sandbox.css'

export default function SandboxPanelContent() {
  const openTarget = useSandboxPanelStore((s) => s.openTarget)
  const clearOpenTarget = useSandboxPanelStore((s) => s.clearOpenTarget)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  const consumedRef = useRef(null)

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
  const [previewing, setPreviewing] = useState(false)
  // KeyboardManager's combo strings are built from event.key, and the
  // spacebar's event.key is a literal " " (not the string "Space") — match
  // that, not event.code.
  useKeyboardBinding('panel:sampleSandbox', ' ', (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (previewing) {
      stopSandboxPreview()
      setPreviewing(false)
      return 'handled'
    }
    const { composite, selection } = useSandboxStore.getState()
    const started = playSandboxPreview(
      composite.renderedBuffer,
      selection?.startSample ?? 0,
      () => setPreviewing(false),
    )
    setPreviewing(started)
    return 'handled'
  })
  useEffect(() => stopSandboxPreview, []) // stop on panel unmount

  return (
    <div className="sandbox-panel-content">
      <div className="sandbox-main-row">
        <SandboxSourcesPanel />
        <div className="sandbox-center-column">
          <SandboxToolbar />
          <SandboxWaveformCanvas />
        </div>
        <SandboxStackPanel />
      </div>
      <SandboxStatusBar />
    </div>
  )
}
