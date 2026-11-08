import { useState } from 'react'
import { Volume1, Volume2, VolumeX, Layers } from 'lucide-react'
import useSandboxStore, {
  SPECTRAL_PAINT_AMOUNT_DB_MIN, SPECTRAL_PAINT_AMOUNT_DB_MAX,
} from '../../stores/sandboxStore.js'
import { Button, NumberBox } from '../../ui-kit'
import styles from './Sandbox.module.css'

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
    <div className={styles.selbar} role="toolbar" aria-label="Spectral selection actions">
      <span className={styles.selbarCount}>
        {shapeCount === 1 ? '1 region selected' : `${shapeCount} regions selected`}
      </span>

      <div className={styles.divider} />

      <NumberBox
        label="Attenuation" width={72} min={0} max={-SPECTRAL_PAINT_AMOUNT_DB_MIN} step={1} unit="dB"
        quantize={Math.round} defaultValue={24} value={attenuateDb} onChange={setAttenuateDb}
      />
      <Button glyph={<Volume1 />} onClick={() => attenuateSpcSelection(activeLayerId, attenuateDb)}
        hint="Attenuate" hintMods="Attenuate the selected time by frequency region">
        Attenuate
      </Button>

      <NumberBox
        label="Boost" width={72} min={0} max={SPECTRAL_PAINT_AMOUNT_DB_MAX} step={1} unit="dB"
        quantize={Math.round} defaultValue={12} value={boostDb} onChange={setBoostDb}
      />
      <Button glyph={<Volume2 />} onClick={() => boostSpcSelection(activeLayerId, boostDb)}
        hint="Boost" hintMods="Boost the selected time by frequency region">
        Boost
      </Button>

      <Button glyph={<VolumeX />} onClick={() => muteSpcSelection(activeLayerId)}
        hint="Mute" hintMods="Silence the selected time by frequency region">
        Mute
      </Button>

      <div className={styles.divider} />

      <Button glyph={<Layers />} onClick={() => copySpcSelectionToNewLayer(activeLayerId)}
        hint="Copy to new layer" hintMods="Extract the selected region into a new layer, leaving this layer untouched">
        Copy to new layer
      </Button>
    </div>
  )
}
