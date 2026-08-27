import { useEffect, useRef, useState } from 'react'
import useSandboxStore from '../../stores/sandboxStore.js'
import useSandboxPanelStore from '../../stores/sandboxPanelStore.js'
import useSeparationStore, { SEPARATION_TERMINAL_STATES } from '../../stores/separationStore.js'
import { useKeyboardBinding } from '../../windowing/managers/useKeyboardBinding.ts'
import { stopSandboxPreview } from './sandboxPreviewPlayer.js'
import SandboxMenuBar from './SandboxMenuBar.jsx'
import SandboxToolColumn from './SandboxToolColumn.jsx'
import SandboxLayerWorkspace from './SandboxLayerWorkspace.jsx'
import SandboxStackPanel from './SandboxStackPanel.jsx'
import SandboxSeparationStrip from './SandboxSeparationStrip.jsx'
import SandboxTransport from './SandboxTransport.jsx'
import SandboxStatusBar from './SandboxStatusBar.jsx'
import './sandbox.css'

export default function SandboxPanelContent() {
  const openTarget = useSandboxPanelStore((s) => s.openTarget)
  const clearOpenTarget = useSandboxPanelStore((s) => s.clearOpenTarget)
  const addSourceFromRegion = useSandboxStore((s) => s.addSourceFromRegion)
  const consumedRef = useRef(null)

  // Controls whether SandboxSeparationStrip mounts at all — see that
  // component's own header comment. Lifted here (rather than the strip's own
  // local state) because the control that OPENS the advanced panel now lives
  // in SandboxMenuBar, which is always mounted, while the strip itself is
  // not.
  const [separationAdvancedOpen, setSeparationAdvancedOpen] = useState(false)
  const job = useSeparationStore((s) => s.job)
  const jobError = useSeparationStore((s) => s.jobError)
  const licensePrompt = useSeparationStore((s) => s.licensePrompt)
  const running = !!job && !SEPARATION_TERMINAL_STATES.has(job.state)
  const showSeparationStrip = running || !!licensePrompt || !!jobError || separationAdvancedOpen

  // One-shot: a context-menu entry point sets openTarget then opens this
  // panel. Consume it once (by region id) so re-renders / panel refocus
  // don't re-add the same layer.
  useEffect(() => {
    if (!openTarget || consumedRef.current === openTarget.id) return
    consumedRef.current = openTarget.id
    addSourceFromRegion(openTarget)
    clearOpenTarget()
  }, [openTarget, addSourceFromRegion, clearOpenTarget])

  // Resync with the engine if this mount finds NO local layers. Covers a
  // renderer reload (Ctrl+Shift+R, a crash-recovery reload, etc.): the engine
  // lives outside this renderer's JS context and keeps its sandbox workspace
  // untouched across a reload, but this store's in-memory `layers` resets to
  // empty along with everything else. `onProjectLoaded` (the store's other
  // resync trigger — see its call at the bottom of sandboxStore.js) only
  // fires on an actual project LOAD event, never a plain reload, so nothing
  // else re-seeds this store afterward. Left unfixed, every layer that
  // existed before the reload becomes invisible to the UI forever: it never
  // gets sandbox_render called again, yet the engine still requires it to
  // publish a render before ANY composite mix can succeed — permanently
  // blocking composite rendering for the rest of the session.
  //
  // Skipped when a fresh openTarget is pending: that effect (above) is about
  // to add exactly one layer itself, and racing it against a wholesale
  // workspace replace could drop the layer it's adding if the fetched
  // snapshot was taken a moment before that add committed on the engine side.
  useEffect(() => {
    if (useSandboxStore.getState().layers.length === 0 && !openTarget) {
      useSandboxStore.getState().reloadFromEngine()
    }
    // Mount-only (empty deps, deliberately) — see comment above for why this
    // must not re-fire on every transition to an empty layer list (e.g. the
    // user closing every layer deliberately should not trigger a redundant
    // re-fetch). Reads openTarget/state via getState() rather than closing
    // over the render-time values specifically so this can stay mount-only.
  }, [])

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
      <SandboxMenuBar onOpenAdvancedSeparation={() => setSeparationAdvancedOpen(true)} />
      <div className="sandbox-edbody">
        <SandboxToolColumn />
        <SandboxLayerWorkspace />
        <SandboxStackPanel />
      </div>
      {showSeparationStrip && (
        <SandboxSeparationStrip
          advancedOpen={separationAdvancedOpen}
          onToggleAdvanced={() => setSeparationAdvancedOpen((v) => !v)}
        />
      )}
      <SandboxTransport />
      <SandboxStatusBar />
    </div>
  )
}
