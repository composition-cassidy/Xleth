import React, { useCallback, useEffect, useState } from 'react'
import { Pipette } from 'lucide-react'
import { DeviceFrame, DeviceSection, IconButton, Knob, Select, Toggle } from '../../../ui-kit'
import { beginPick } from '../../grid/chromaKeyEyedropper.js'
import useDeviceUiStore from '../deviceUiStore.js'
import ColourSwatch from './ColourSwatch.jsx'
import {
  FX, CHAIN_PARAMS, COLOUR_DEFAULTS, ECHO_BLEND_OPTIONS, ECHO_FLIP_OPTIONS, SHADOW_BLEND_OPTIONS,
  chainName, commitValue, isTerminalStage, knobQuantize,
} from './videoFxCatalog.js'
import {
  removeChainEffect, setChainColour, setChainEffectBypassed, setChainParam, setChainPreviewMuted,
} from './videoFxWrites.js'
import useVideoDeviceStore, { isInWindow } from './videoDeviceStore.js'
import styles from './videoDevices.module.css'

export const chainDeviceKey = (trackId, index) => `video:${trackId}:chain:${index}`

/**
 * Local preview of a chain entry's params. A drag shows its value here only; the
 * engine is written once, on commit. The draft clears when the engine's params
 * come back (a new array after every refetch).
 */
function useParamDraft(params) {
  const [draft, setDraft] = useState({})
  useEffect(() => { setDraft({}) }, [params])
  return {
    value: (pi, def) => draft[pi] ?? params?.[pi] ?? def,
    preview: (pi, v) => setDraft((d) => ({ ...d, [pi]: v })),
    cancel: (pi) => setDraft((d) => { const n = { ...d }; delete n[pi]; return n }),
  }
}

function ParamKnob({ row, draft, write, size = 32, width = 60, disabled = false }) {
  return (
    <Knob
      label={row.label}
      value={draft.value(row.pi, row.def)}
      min={row.min}
      max={row.max}
      defaultValue={row.def}
      step={row.step}
      quantize={knobQuantize(row)}
      format={row.fmt.format}
      parse={row.fmt.parse}
      bipolar={!!row.bipolar}
      size={size}
      width={width}
      disabled={disabled}
      hint={row.hint}
      onChange={(v) => draft.preview(row.pi, v)}
      onCancel={() => draft.cancel(row.pi)}
      onCommit={(v) => write(row.pi, commitValue(row, v))}
      data-param={`p${row.pi}`}
    />
  )
}

const rowsOf = (type, ...pis) => pis.map((pi) => CHAIN_PARAMS[type].find((r) => r.pi === pi))

function Knobs({ type, pis, draft, write, size, width }) {
  return rowsOf(type, ...pis).map((row) => (
    <ParamKnob key={row.pi} row={row} draft={draft} write={write} size={size} width={width} />
  ))
}

const colourOf = (fx) => {
  const def = COLOUR_DEFAULTS[fx.type] ?? [0, 0, 0]
  return [0, 1, 2].map((i) => fx.params?.[i] ?? def[i])
}

function TerminalNote() {
  return <p className={styles.note}>Runs after the rest of the chain, so its position does not change the result.</p>
}

// ── Bodies, one per effect type. Sections in signal order. ───────────────────

function DesaturationBody({ fx, draft, write }) {
  return (
    <DeviceSection title="Colour" width={180}>
      <div className={styles.centre}>
        <Knobs type={FX.DESATURATION} pis={[0]} draft={draft} write={write} size={48} width={80} />
      </div>
    </DeviceSection>
  )
}

function TintBody({ fx, draft, write, writeColour }) {
  return (
    <>
      <DeviceSection title="Colour" width={96}>
        <div className={styles.centre}>
          <ColourSwatch label="Tint colour" rgb={colourOf(fx)} onCommit={writeColour} />
        </div>
      </DeviceSection>
      <DeviceSection title="Tint" width={96}>
        <div className={styles.centre}>
          <Knobs type={FX.TINT} pis={[3]} draft={draft} write={write} size={48} width={80} />
        </div>
      </DeviceSection>
      <DeviceSection title="Lightness range" width={136}>
        <div className={styles.knobRow}>
          <Knobs type={FX.TINT} pis={[4, 5]} draft={draft} write={write} />
        </div>
      </DeviceSection>
    </>
  )
}

function BrightnessContrastBody({ draft, write }) {
  return (
    <DeviceSection title="Tone" width={272}>
      <div className={styles.knobRow}>
        <Knobs type={FX.BRIGHTNESS_CONTRAST} pis={[0, 1]} draft={draft} write={write} size={48} width={88} />
      </div>
    </DeviceSection>
  )
}

function TvBody({ draft, write }) {
  return (
    <>
      <DeviceSection title="Picture" width={136}>
        <div className={styles.knobGrid} data-cols="2">
          <Knobs type={FX.TV_SIMULATOR} pis={[0, 2, 4]} draft={draft} write={write} />
        </div>
      </DeviceSection>
      <DeviceSection title="Signal" width={156}>
        <div className={styles.knobGrid} data-cols="2">
          <Knobs type={FX.TV_SIMULATOR} pis={[1, 3, 5, 6]} draft={draft} write={write} width={72} />
        </div>
      </DeviceSection>
    </>
  )
}

function ChainZprBody({ draft, write }) {
  return (
    <DeviceSection title="Framing" width={212}>
      <div className={styles.knobGrid} data-cols="3">
        <Knobs type={FX.ZOOM_PAN_ROT} pis={[1, 4, 5, 7]} draft={draft} write={write} />
      </div>
      <p className={styles.note}>While the track’s Zoom/pan/rot animates, it is applied here in the chain instead.</p>
    </DeviceSection>
  )
}

function ChromaKeyBody({ fx, trackId, draft, write, writeColour }) {
  const [picking, setPicking] = useState(false)

  // The preview frame is the composited output, so with the chain live a pick
  // would read the post-key colour. Mute this track's chain in the preview for
  // the pick (preview-only RPC: no undo, not saved, not exported), as before.
  const pick = async () => {
    if (picking) return
    setPicking(true)
    try {
      await setChainPreviewMuted(trackId, true)
      const rgb = await beginPick(trackId)
      if (rgb) await writeColour([rgb.r, rgb.g, rgb.b])
    } finally {
      try { await setChainPreviewMuted(trackId, false) } catch { /* no-op */ }
      setPicking(false)
    }
  }

  return (
    <>
      <DeviceSection title="Key" width={96}>
        <div className={styles.stack}>
          <ColourSwatch label="Key colour" rgb={colourOf(fx)} onCommit={writeColour} />
          <IconButton
            size="sm"
            label={picking ? 'Picking the key colour' : 'Pick the key colour from the preview'}
            hint={picking ? 'Click the preview to sample the key colour. Escape cancels.' : 'Pick the key colour from the preview'}
            pressed={picking}
            disabled={picking}
            onClick={pick}
          >
            <Pipette aria-hidden="true" />
          </IconButton>
        </div>
      </DeviceSection>
      <DeviceSection title="Matte" width={136}>
        <div className={styles.knobGrid} data-cols="2">
          <Knobs type={FX.CHROMA_KEY} pis={[3, 4, 6, 7]} draft={draft} write={write} />
        </div>
      </DeviceSection>
      <DeviceSection title="Spill" width={76}>
        <div className={styles.centre}>
          <Knobs type={FX.CHROMA_KEY} pis={[5]} draft={draft} write={write} />
        </div>
      </DeviceSection>
    </>
  )
}

function OutlineBody({ fx, draft, write, writeColour }) {
  return (
    <>
      <DeviceSection title="Stroke" width={212}>
        <div className={styles.knobGrid} data-cols="3">
          <ColourSwatch label="Colour" rgb={colourOf(fx)} onCommit={writeColour} />
          <Knobs type={FX.OUTLINE} pis={[3, 4, 5]} draft={draft} write={write} />
        </div>
      </DeviceSection>
      <DeviceSection title="Trace" width={96}>
        <div className={styles.stack}>
          <Knobs type={FX.OUTLINE} pis={[6]} draft={draft} write={write} />
          <TerminalNote />
        </div>
      </DeviceSection>
    </>
  )
}

function DropShadowBody({ fx, draft, write, writeColour }) {
  return (
    <>
      <DeviceSection title="Shadow" width={136}>
        <div className={styles.stack}>
          <ColourSwatch label="Colour" rgb={colourOf(fx)} onCommit={writeColour} />
          <Select
            size="sm"
            ariaLabel="Drop shadow blend"
            hint="How the shadow combines with whatever is behind the cell"
            value={Math.round(fx.params?.[8] ?? 1)}
            options={SHADOW_BLEND_OPTIONS}
            onChange={(v) => write(8, v)}
          />
          <TerminalNote />
        </div>
      </DeviceSection>
      <DeviceSection title="Offset" width={136}>
        <div className={styles.knobRow}>
          <Knobs type={FX.DROP_SHADOW} pis={[3, 4]} draft={draft} write={write} />
        </div>
      </DeviceSection>
      <DeviceSection title="Shape" width={136}>
        <div className={styles.knobGrid} data-cols="2">
          <Knobs type={FX.DROP_SHADOW} pis={[5, 6, 7, 9]} draft={draft} write={write} />
        </div>
      </DeviceSection>
    </>
  )
}

function useDelayNodes(trackId) {
  const [nodes, setNodes] = useState([])
  useEffect(() => {
    let alive = true
    const load = async () => {
      const fn = window.xleth?.audio?.getEffectChain
      if (typeof fn !== 'function') {
        console.warn('[VideoFx] audio.getEffectChain is unavailable; the Visual echo delay list is empty')
        return
      }
      try {
        const raw = await fn(trackId)
        const chain = typeof raw === 'string' ? JSON.parse(raw) : (raw ?? [])
        if (!alive) return
        setNodes((Array.isArray(chain) ? chain : [])
          .filter((e) => e?.pluginId === 'delay')
          .map((e) => ({ value: e.nodeId, label: `Delay, slot ${(e.position ?? 0) + 1}` })))
      } catch (err) {
        console.warn('[VideoFx] could not read the audio chain:', err)
      }
    }
    load()
    return () => { alive = false }
  }, [trackId])
  return nodes
}

function VisualEchoBody({ fx, trackId, draft, write }) {
  const delays = useDelayNodes(trackId)
  const boundId = Math.round(fx.params?.[2] ?? -1)
  const bound = boundId >= 0 && delays.some((d) => d.value === boundId)
  const followFeedback = (fx.params?.[7] ?? 1) >= 0.5
  return (
    <>
      <DeviceSection title="Timing" width={176}>
        <div className={styles.stack}>
          <span className={styles.caption}>Follow delay</span>
          <Select
            size="sm"
            ariaLabel="Delay that sets the echo's repeat interval"
            hint="The picture follows this Delay’s own time and sync, so sound and picture never drift apart"
            value={bound ? boundId : -1}
            options={[{ value: -1, label: delays.length ? 'None' : 'No Delay on this track' }, ...delays]}
            onChange={(v) => write(2, v)}
          />
          <Toggle
            size="sm"
            on={followFeedback}
            onChange={(next) => write(7, next ? 1 : 0)}
            hint="Take the per-repeat dimming from the bound Delay’s Feedback instead of Decay"
          >
            Follow feedback
          </Toggle>
          <p className={styles.note}>
            {bound
              ? 'Repeat length comes from the bound Delay.'
              : 'Inactive: add a Delay to this track’s audio chain and pick it here.'}
          </p>
        </div>
      </DeviceSection>
      <DeviceSection title="Trail" width={136}>
        <div className={styles.knobGrid} data-cols="2">
          <Knobs type={FX.VISUAL_ECHO} pis={[0, 1, 3, 5]} draft={draft} write={write} />
        </div>
      </DeviceSection>
      <DeviceSection title="Look" width={156}>
        <div className={styles.stack}>
          <span className={styles.caption}>Tap flip</span>
          <Select
            size="sm"
            ariaLabel="Visual echo tap flip"
            hint="How each repeat is flipped relative to the live frame"
            value={Math.round(fx.params?.[4] ?? 0)}
            options={ECHO_FLIP_OPTIONS}
            onChange={(v) => write(4, v)}
          />
          <span className={styles.caption}>Trail blend</span>
          <Select
            size="sm"
            ariaLabel="Visual echo trail blend"
            value={Math.round(fx.params?.[6] ?? 0)}
            options={ECHO_BLEND_OPTIONS}
            onChange={(v) => write(6, v)}
          />
          <TerminalNote />
        </div>
      </DeviceSection>
    </>
  )
}

const BODIES = {
  [FX.DESATURATION]: DesaturationBody,
  [FX.TINT]: TintBody,
  [FX.BRIGHTNESS_CONTRAST]: BrightnessContrastBody,
  [FX.TV_SIMULATOR]: TvBody,
  [FX.ZOOM_PAN_ROT]: ChainZprBody,
  [FX.CHROMA_KEY]: ChromaKeyBody,
  [FX.OUTLINE]: OutlineBody,
  [FX.DROP_SHADOW]: DropShadowBody,
  [FX.VISUAL_ECHO]: VisualEchoBody,
}

/**
 * One visual-chain entry as a device: the same DeviceFrame as an audio device.
 * Activator = the entry's bypass, more = move and remove, pop-out = the same
 * device in a window. There are no presets or A/B for chain entries (no preset
 * adapter exists for them).
 */
export default function VideoChainDevice({
  track, fx, index, identityColor, presentation = 'docked', dragHandleProps, moveItems = [], onClose,
}) {
  const trackId = track.id
  const key = chainDeviceKey(trackId, index)
  const folded = useDeviceUiStore((s) => !!s.folded[key])
  const setFolded = useDeviceUiStore((s) => s.setFolded)
  const win = useVideoDeviceStore((s) => s.window)
  const openWindow = useVideoDeviceStore((s) => s.openWindow)
  const closeWindow = useVideoDeviceStore((s) => s.closeWindow)
  const poppedOut = presentation === 'docked' && isInWindow(win, trackId, 'chain', index)

  const draft = useParamDraft(fx.params)
  const write = useCallback((pi, v) => setChainParam(trackId, index, pi, v), [trackId, index])
  const writeColour = useCallback((rgb) => setChainColour(trackId, index, rgb), [trackId, index])

  const name = chainName(fx.type)
  const Body = BODIES[fx.type]

  return (
    <DeviceFrame
      name={name}
      identityColor={identityColor}
      bypassed={!!fx.bypassed}
      onBypassChange={(bypassed) => setChainEffectBypassed(trackId, index, bypassed)}
      folded={folded}
      onFoldChange={(next) => setFolded(key, next)}
      presentation={presentation}
      moreItems={[
        ...moveItems,
        { label: `Remove ${name}`, danger: true, onSelect: () => removeChainEffect(trackId, index) },
      ]}
      onPopOut={() => openWindow({ trackId, kind: 'chain', key: index })}
      onClose={onClose}
      poppedOut={poppedOut}
      onReturn={closeWindow}
      dragHandleProps={dragHandleProps}
      data-video-fx={fx.type}
      data-terminal-stage={isTerminalStage(fx.type) || undefined}
    >
      {Body && !folded && !poppedOut ? (
        <Body fx={fx} trackId={trackId} draft={draft} write={write} writeColour={writeColour} />
      ) : null}
    </DeviceFrame>
  )
}
