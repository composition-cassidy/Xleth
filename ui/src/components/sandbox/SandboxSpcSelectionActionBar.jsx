import { useState } from 'react'
import { Volume1, Volume2, VolumeX, Layers } from 'lucide-react'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'

// SPC selection action bar — mounted ONLY over the spectrogram view once a
// rect/freehand t×f selection exists (see SandboxPanelContent). Every button
// here fires one of the four SPC selection actions (sandboxStore.js):
// ATTENUATE/BOOST/MUTE all commit a SPECTRAL_PAINT op over the selected
// region (the exact op the paint brush tool commits to — see
// spcSelectionToDabs); COPY TO NEW LAYER extracts it into a brand-new layer
// via sandbox_extractSelection + the existing addBakedAssetAsSource path.
// Mirrors SandboxSelectionActionBar's own "one store command per button"
// shape, one level up (a t×f region instead of a time-only range).
export default function SandboxSpcSelectionActionBar() {
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const layers = useSandboxStore((s) => s.layers)
  const spcSelection = useSandboxStore((s) => s.spcSelection)
  const attenuateSpcSelection = useSandboxStore((s) => s.attenuateSpcSelection)
  const boostSpcSelection = useSandboxStore((s) => s.boostSpcSelection)
  const muteSpcSelection = useSandboxStore((s) => s.muteSpcSelection)
  const copySpcSelectionToNewLayer = useSandboxStore((s) => s.copySpcSelectionToNewLayer)

  // Magnitude only — attenuateSpcSelection/boostSpcSelection each apply their
  // own sign (Math.abs both ways), so this field always reads as "how much",
  // never "which direction".
  const [attenuateDb, setAttenuateDb] = useState(24)
  const [boostDb, setBoostDb] = useState(12)

  const layer = layers.find((l) => l.id === activeLayerId) ?? null
  const hasLayer = !!layer && layer.renderState === 'ready'
  const hasSelection = hasLayer && !!spcSelection?.shapes?.length

  // The bar itself is only mounted while hasSelection is true (see
  // SandboxPanelContent), but keep the guard — an action clears the
  // selection on success, which can race this component's unmount.
  if (!hasSelection) return null

  const shapeCount = spcSelection.shapes.length

  return (
    <div className="sandbox-selection-bar sandbox-spc-selection-bar">
      <span className="sandbox-toolstrip-hint">
        {shapeCount === 1 ? '1 region selected' : `${shapeCount} regions selected`}
      </span>

      <div className="sandbox-toolbar-divider" />

      <input
        className="sandbox-toolbar-number"
        type="number" step="1" min="0" max={-SPECTRAL_PAINT_AMOUNT_DB_MIN}
        value={attenuateDb}
        onChange={(e) => setAttenuateDb(Number(e.target.value))}
        title="Attenuation amount, dB"
      />
      <button className="sandbox-tool-btn" onClick={() => attenuateSpcSelection(activeLayerId, attenuateDb)}
        title="Attenuate the selected time × frequency region">
        <Volume1 size={14} /><span>Attenuate</span>
      </button>

      <input
        className="sandbox-toolbar-number"
        type="number" step="1" min="0" max={SPECTRAL_PAINT_AMOUNT_DB_MAX}
        value={boostDb}
        onChange={(e) => setBoostDb(Number(e.target.value))}
        title="Boost amount, dB"
      />
      <button className="sandbox-tool-btn" onClick={() => boostSpcSelection(activeLayerId, boostDb)}
        title="Boost the selected time × frequency region">
        <Volume2 size={14} /><span>Boost</span>
      </button>

      <button className="sandbox-tool-btn" onClick={() => muteSpcSelection(activeLayerId)}
        title="Silence the selected time × frequency region">
        <VolumeX size={14} /><span>Mute</span>
      </button>

      <div className="sandbox-toolbar-divider" />

      <button className="sandbox-tool-btn" onClick={() => copySpcSelectionToNewLayer(activeLayerId)}
        title="Extract the selected region into a new layer, leaving this layer untouched">
        <Layers size={14} /><span>Copy to New Layer</span>
      </button>
    </div>
  )
}
