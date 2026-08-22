import { useEffect, useRef } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import useSandboxPanelStore from '../../stores/sandboxPanelStore.js'
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
