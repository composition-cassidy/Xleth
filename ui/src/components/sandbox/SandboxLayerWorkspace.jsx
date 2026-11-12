import useSandboxStore from '../../stores/sandboxStore.js'
import SandboxWaveformCanvas from './SandboxWaveformCanvas.jsx'
import SandboxSpcSelectionActionBar from './SandboxSpcSelectionActionBar.jsx'
import styles from './Sandbox.module.css'

// ── The editor ──────────────────────────────────────────────────────────────
//
// One canvas for the active layer, filling everything the bars and the sidebar
// leave. The layer rows that used to sit above it are the sidebar's Layers
// list now (SandboxLayerList.jsx), so the display is the full height between
// the tool bar and the transport.
//
// The selection, the view, and the envelope and paint modes have always been
// global-to-the-active-layer rather than per-layer, so there is exactly one
// editor and it shows whichever layer is active.
//
// Dropping audio is handled one level up (SandboxPanelContent, through
// useSandboxSourceDrop) so the layer list is a drop target as well; `dragOver`
// arrives from there.
export default function SandboxLayerWorkspace({ dragOver = false }) {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const viewMode = useSandboxStore((s) => s.viewMode)
  const spcSelection = useSandboxStore((s) => s.spcSelection)

  const activeLayer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasSpcSelection = !!activeLayer && activeLayer.renderState === 'ready'
    && viewMode === 'spc' && !!spcSelection?.shapes?.length

  return (
    <div className={styles.editorPane}>
      {activeLayer ? (
        <>
          <SandboxWaveformCanvas />
          {hasSpcSelection && <SandboxSpcSelectionActionBar />}
        </>
      ) : (
        <div className={styles.dropZone} data-over={dragOver || undefined}>
          <span className={styles.dropTitle}>Drop a sample or an audio file here to begin</span>
          <span className={styles.dropHint}>
            Or right-click a marked region in the timeline and choose “Open in Sample Sandbox”.
          </span>
        </div>
      )}
      {dragOver && activeLayer && <div className={styles.dropOverlay}>Drop to add a layer</div>}
    </div>
  )
}
