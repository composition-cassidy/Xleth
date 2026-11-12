import useSandboxStore from '../../stores/sandboxStore.js'
import { IconButton, MINUS, NumberBox, PanelHeader, Pearl, isHeard } from '../../ui-kit'
import SandboxRenderChip from './SandboxRenderChip.jsx'
import styles from './Sandbox.module.css'
import { formatSamplesShort } from './sandboxFormat.js'
import { iconComponent } from '../../ui-kit/icons'

const IcCopy = iconComponent('copy')
const IcPlay = iconComponent('play')
const IcStopFill = iconComponent('stop', 'fill')
const IcX = iconComponent('x')

// ── Layers ──────────────────────────────────────────────────────────────────
//
// The top half of the sidebar: every layer in the workspace, one line each,
// with the edit stack of whichever one is active directly underneath
// (SandboxStackPanel). Layer, then what has been done to that layer — the two
// lists read as one hierarchy.
//
// The rows used to be a rail across the top of the editor. There they took
// their height out of the waveform (three layers and the hint line cost 135px
// of a 612px panel), and each row strung five unlabelled value boxes across
// 700px. Here a row is the layer's identity and its state (audition, name,
// length, mute, solo), and the ACTIVE row opens a second line with its mix
// values, labelled — the same "the selected row shows its controls" grammar
// the edit stack below already uses.
//
// The mix boxes are kit NumberBoxes: drag to scrub, double-click to type, Shift
// for fine. Each previews locally during a drag and commits once on release.

const RENDER_STATE_LABEL = {
  idle: 'Idle', rendering: 'Rendering…', ready: 'Ready', error: 'Render failed',
}

const pan2 = (v) => v.toFixed(2).replace('-', MINUS)

function offsetMs(layer) {
  return layer.bufferSampleRate ? (layer.offsetSamples / layer.bufferSampleRate) * 1000 : 0
}

function layerDuration(layer) {
  if (layer.renderedBuffer?.numSamples && layer.renderedBuffer.sampleRate) {
    return formatSamplesShort(layer.renderedBuffer.numSamples, layer.renderedBuffer.sampleRate)
  }
  if (layer.sourceStartTime != null && layer.sourceEndTime != null) {
    return `${(layer.sourceEndTime - layer.sourceStartTime).toFixed(2)}s`
  }
  return '—'
}

function LayerRow({
  layer, active, playing, onSelect, onClose, onDuplicate, onPearl, lit,
  onSetMix, onAudition,
}) {
  const ready = layer.renderState === 'ready'
  const opsLabel = `${layer.ops.length} edit${layer.ops.length === 1 ? '' : 's'}`

  return (
    <div
      className={styles.layer}
      data-active={active || undefined}
      data-muted={layer.muted || undefined}
    >
      <div
        className={styles.layerRow}
        data-layer-row
        onClick={() => onSelect(layer.id)}
        title={layer.renderState === 'error' ? (layer.error || 'Render failed') : `${layer.name} (${opsLabel})`}
      >
        <IconButton
          size="sm"
          label="Audition this layer alone"
          pressed={playing}
          disabled={!ready}
          hint="Audition this layer alone"
          hintMods="Shift+Space plays the active layer's own render, without the mix"
          onClick={(e) => { e.stopPropagation(); onAudition(layer.id) }}
        >
          {playing ? <IcStopFill /> : <IcPlay />}
        </IconButton>

        <SandboxRenderChip state={layer.renderState} title={RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState}>
          {ready ? null : (RENDER_STATE_LABEL[layer.renderState] ?? layer.renderState)}
        </SandboxRenderChip>

        <span className={styles.layerName}>{layer.name}</span>
        <span className={styles.layerMeta}>{layerDuration(layer)}</span>

        <span className={styles.layerButtons} onClick={(e) => e.stopPropagation()}>
          <Pearl lit={lit} label={layer.name} onToggle={() => onPearl(layer.id, 'toggle')} onSolo={() => onPearl(layer.id, 'solo')} />
          <IconButton
            size="sm" variant="ghost" label="Duplicate this layer"
            hint="Duplicate this layer"
            hintMods={`Copy it with its ${opsLabel} and mix settings (Ctrl+D)`}
            onClick={() => onDuplicate(layer.id)}
          >
            <IcCopy />
          </IconButton>
          <IconButton
            size="sm" variant="ghost" label="Close layer" hint="Close layer"
            hintMods="Remove this layer from the workspace"
            onClick={() => onClose(layer.id)}
          >
            <IcX />
          </IconButton>
        </span>
      </div>

      {active && (
        <div className={styles.layerMix} role="group" aria-label={`${layer.name} mix`}>
          <NumberBox
            label="Layer gain" caption="Gain" width={100} min={-60} max={12} step={0.25} unit="dB" defaultValue={0}
            bipolar centre={0}
            value={layer.gainDb ?? 0}
            onCommit={(v) => onSetMix(layer.id, { gainDb: v })}
          />
          <NumberBox
            label="Layer pan" caption="Pan" width={84} min={-1} max={1} step={0.01} bipolar centre={0} defaultValue={0}
            format={pan2}
            value={layer.pan ?? 0}
            onCommit={(v) => onSetMix(layer.id, { pan: v })}
          />
          <NumberBox
            label="Layer offset" caption="Offset" width={104} min={0} max={60000} step={1} unit="ms" defaultValue={0}
            quantize={Math.round}
            hint="Layer offset"
            hintMods="How late this layer starts in the mix"
            value={offsetMs(layer)}
            onCommit={(v) => onSetMix(layer.id, { offsetMs: v })}
          />
        </div>
      )}
    </div>
  )
}

export default function SandboxLayerList() {
  const layers = useSandboxStore((s) => s.layers)
  const activeLayerId = useSandboxStore((s) => s.activeLayerId)
  const setActiveLayer = useSandboxStore((s) => s.setActiveLayer)
  const closeLayer = useSandboxStore((s) => s.closeLayer)
  const duplicateLayer = useSandboxStore((s) => s.duplicateLayer)
  const pearlLayer = useSandboxStore((s) => s.pearlLayer)
  const setLayerMix = useSandboxStore((s) => s.setLayerMix)
  const toggleLayerPreview = useSandboxStore((s) => s.toggleLayerPreview)
  const playback = useSandboxStore((s) => s.playback)

  const auditioning = (id) => playback.state === 'playing'
    && playback.kind === 'layer' && playback.layerId === id

  return (
    <section className={styles.layers} aria-label="Layers">
      <PanelHeader title="Layers" meta={layers.length > 0 ? String(layers.length) : undefined} />
      <div className={styles.layerList}>
        {layers.map((layer) => (
          <LayerRow
            key={layer.id}
            layer={layer}
            active={layer.id === activeLayerId}
            playing={auditioning(layer.id)}
            onSelect={setActiveLayer}
            onClose={closeLayer}
            onDuplicate={duplicateLayer}
            onPearl={pearlLayer}
            lit={isHeard({ id: layer.id, muted: !!layer.muted, soloed: !!layer.soloed }, layers.map((l) => ({ id: l.id, muted: !!l.muted, soloed: !!l.soloed })))}
            onSetMix={setLayerMix}
            onAudition={toggleLayerPreview}
          />
        ))}
        <div className={styles.layerHint}>
          {layers.length === 0
            ? 'No layers. Drop a sample or an audio file here.'
            : 'Drop a sample or an audio file to add a layer.'}
        </div>
      </div>
    </section>
  )
}
