import React, { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react'
import {
  DeviceFrame, DeviceSection, DisplayWell, Knob, NumberBox, SegmentedControl, Select, formatValue,
} from '../../../ui-kit'
import { subscribe as subscribeTransport, getTransportState } from '../../../transportStore.js'
import useEffectPresets from '../../../fx-presets/useEffectPresets.js'
import ZprTimelineCard from '../../grid/zprTimeline/ZprTimelineCard.jsx'
import DevicePresetMenu, { presetMoreItems } from '../DevicePresetMenu.jsx'
import useDeviceUiStore from '../deviceUiStore.js'
import { fractionPercent, plainFormat } from '../deviceFormat.js'
import { BounceCurveCanvas, NoteFadeCanvas } from './noteDisplays.jsx'
import {
  CHAIN_PARAMS, FX, NOTE_FADE_DEFAULT_SIDE, commitValue, knobQuantize, noteDeviceActive, noteDeviceName,
} from './videoFxCatalog.js'
import {
  notifyTracksChanged, setBounce, setNoteDeviceEnabled, setNoteFade, setPingPong, setSlideNoteEffect,
  setZoomPanRot, setZprTracks,
} from './videoFxWrites.js'
import useVideoDeviceStore, { isInWindow } from './videoDeviceStore.js'
import styles from './videoDevices.module.css'

export const noteDeviceKey = (trackId, id) => `video:${trackId}:note:${id}`

const snapOne = (v) => (Math.abs(v - 1) < 0.025 ? 1 : v)
const times = {
  format: (v) => `${formatValue(v, 'dB', { unitless: true, decimals: 2 })} ×`,
  parse: (t) => { const n = Number(String(t).replace(/[×x\s]/gi, '')); return Number.isFinite(n) ? n : null },
}
const intFmt = { format: plainFormat(0) }

/** Local preview of a config's fields: a drag shows its value here, the engine is written once on commit. */
function useDraft(source) {
  const [draft, setDraft] = useState({})
  useEffect(() => { setDraft({}) }, [source])
  return {
    get: (k, v) => (k in draft ? draft[k] : v),
    set: (k, v) => setDraft((d) => ({ ...d, [k]: v })),
    drop: (k) => setDraft((d) => { const n = { ...d }; delete n[k]; return n }),
  }
}

function useBpm() {
  const [bpm, setBpm] = useState(() => getTransportState()?.bpm ?? 120)
  useEffect(() => subscribeTransport((s) => { if (Number.isFinite(s?.bpm)) setBpm(s.bpm) }), [])
  return bpm
}

// ── Ping-pong loop ───────────────────────────────────────────────────────────

function PingPongBody({ track }) {
  const p = track.pingPong ?? {}
  const draft = useDraft(track.pingPong)
  const write = (patch) => setPingPong(track.id, track.pingPong, patch)
  const knob = (key, label, def, { snap, ...extra }) => (
    <Knob
      label={label}
      value={draft.get(key, p[key] ?? def)}
      defaultValue={def}
      onChange={(v) => draft.set(key, v)}
      onCancel={() => draft.drop(key)}
      {...extra}
      onCommit={(v) => write({ [key]: snap ? snap(v) : v })}
    />
  )
  return (
    <>
      <DeviceSection title="Region" width={136}>
        <div className={styles.knobRow}>
          {knob('regionStartPct', 'Start', 0.8, {
            min: 0, max: 1, step: 0.01, quantize: (v) => Math.round(v * 100) / 100, ...fractionPercent,
            hint: 'Where the looped region starts, as a share of the source',
          })}
          {knob('regionEndPct', 'End', 1, {
            min: 0, max: 1, step: 0.01, quantize: (v) => Math.round(v * 100) / 100, ...fractionPercent, snap: snapOne,
            hint: 'Where the looped region ends',
          })}
        </div>
      </DeviceSection>
      <DeviceSection title="Loop" width={176}>
        <div className={styles.knobGrid} data-cols="2">
          {knob('reverseSpeed', 'Reverse speed', 1, {
            min: 0.25, max: 4, step: 0.01, quantize: (v) => Math.round(v * 100) / 100, ...times, snap: snapOne, width: 72,
            hint: 'Speed of the backwards half of each loop',
          })}
          <div className={styles.stack}>
            <NumberBox
              label="Crossfade" width={80} value={p.crossfadeFrames ?? 3} min={0} max={30} step={1} defaultValue={3}
              format={(v) => `${Math.round(v)} fr`} parse={(t) => { const n = parseInt(t, 10); return Number.isFinite(n) ? n : null }}
              quantize={(v) => Math.round(v)}
              onCommit={(v) => write({ crossfadeFrames: Math.round(v) || 0 })}
              hint="Frames blended at each turn of the loop"
            />
            <NumberBox
              label="Max loops" width={80} value={p.maxLoops ?? 0} min={0} max={99} step={1} defaultValue={0}
              format={(v) => (Math.round(v) === 0 ? '∞' : intFmt.format(v))}
              parse={(t) => (/^\s*(∞|inf)/i.test(t) ? 0 : (Number.isFinite(parseInt(t, 10)) ? parseInt(t, 10) : null))}
              quantize={(v) => Math.round(v)}
              onCommit={(v) => write({ maxLoops: Math.round(v) || 0 })}
              hint="How many times the region loops; ∞ (0) loops until the note ends"
            />
          </div>
        </div>
      </DeviceSection>
    </>
  )
}

// ── Bounce ───────────────────────────────────────────────────────────────────

const DIRECTIONS = [
  { value: 90, label: 'Up', glyph: <ArrowUp aria-hidden="true" />, ariaLabel: 'Up' },
  { value: 270, label: 'Down', glyph: <ArrowDown aria-hidden="true" />, ariaLabel: 'Down' },
  { value: 180, label: 'Left', glyph: <ArrowLeft aria-hidden="true" />, ariaLabel: 'Left' },
  { value: 0, label: 'Right', glyph: <ArrowRight aria-hidden="true" />, ariaLabel: 'Right' },
]

/** Direction, distance and repeat: shared by the Bounce device and the Slide note effect's bounce. */
function BounceControls({ bounce, write, withDuration = true }) {
  const b = bounce ?? {}
  const draft = useDraft(bounce)
  const distance = draft.get('distance', b.distance ?? 0.15)
  return (
    <>
      <DeviceSection title="Direction" width={176}>
        <SegmentedControl
          size="sm"
          label="Bounce direction"
          value={b.directionDeg ?? 270}
          options={DIRECTIONS}
          onChange={(v) => write({ directionDeg: v })}
        />
      </DeviceSection>
      <DeviceSection title="Motion" width={196}>
        <div className={styles.knobRow}>
          <Knob
            label="Distance" value={distance} min={0} max={1} step={0.01} defaultValue={0.15}
            quantize={(v) => Math.round(v * 100) / 100} {...fractionPercent}
            hint="How far the cell moves, as a share of the cell"
            onChange={(v) => draft.set('distance', v)}
            onCancel={() => draft.drop('distance')}
            onCommit={(v) => write({ distance: v })}
          />
          <div className={styles.stack}>
            {withDuration ? (
              <NumberBox
                label="Duration" width={104} value={b.durationMs ?? 200} min={20} max={2000} step={10} defaultValue={200} unit="ms"
                quantize={(v) => Math.round(v)}
                onCommit={(v) => write({ durationMs: v || 200 })}
                hint="Length of one bounce"
              />
            ) : null}
            <NumberBox
              label="Repeat" width={104} value={b.repeatCount ?? 1} min={1} max={8} step={1} defaultValue={1}
              format={intFmt.format} parse={(t) => { const n = parseInt(t, 10); return Number.isFinite(n) ? n : null }}
              quantize={(v) => Math.round(v)}
              onCommit={(v) => write({ repeatCount: Math.round(v) || 1 })}
              hint="Bounces per note; each repeat is half as far as the one before"
            />
          </div>
        </div>
      </DeviceSection>
    </>
  )
}

function BounceBody({ track }) {
  return (
    <>
      <DisplayWell label="Bounce motion" width={220}>
        <div className={styles.display}>
          <BounceCurveCanvas bounce={track.bounce ?? {}} />
        </div>
      </DisplayWell>
      <BounceControls bounce={track.bounce} write={(patch) => setBounce(track.id, track.bounce, patch)} />
    </>
  )
}

// ── Zoom/pan/rot ─────────────────────────────────────────────────────────────

function ZprBody({ track, layout }) {
  const z = track.zoomPanRot ?? {}
  return (
    <ZprTimelineCard
      key={track.id}
      layout={layout}
      trackId={track.id}
      zpr={z}
      onApplyScalar={(patch) => setZoomPanRot(track.id, track.zoomPanRot, patch)}
      onApplyTracks={(tracks) => setZprTracks(track.id, tracks)}
    />
  )
}

// ── Note fade ────────────────────────────────────────────────────────────────

const FADE_MODE_OPTIONS = [
  { value: 0, label: 'Follow note length', hint: 'A share of each note’s own length' },
  { value: 1, label: 'Note division', hint: 'A fixed musical length, up to one beat' },
  { value: 2, label: 'Milliseconds', hint: 'A fixed time, independent of tempo' },
]
const FADE_DIVISION_OPTIONS = [
  { value: 64, label: '1/64' },
  { value: 32, label: '1/32' },
  { value: 16, label: '1/16' },
  { value: 8, label: '1/8' },
  { value: 4, label: '1/4 (1 beat)' },
]
const FADE_CURVE_OPTIONS = [
  { value: 0, label: 'Linear' },
  { value: 1, label: 'Smooth' },
  { value: 2, label: 'Snappy' },
  { value: 3, label: 'Gentle' },
]

function FadeSide({ title, side, onChange }) {
  const mode = side.mode ?? NOTE_FADE_DEFAULT_SIDE.mode
  const draft = useDraft(side)
  return (
    <DeviceSection title={title} width={156}>
      <div className={styles.stack}>
        <Select size="sm" ariaLabel={`${title} length mode`} value={mode} options={FADE_MODE_OPTIONS} onChange={(v) => onChange({ mode: v })} />
        {mode === 0 && (
          <NumberBox
            label="Amount" value={draft.get('percent', side.percent ?? NOTE_FADE_DEFAULT_SIDE.percent)} min={0} max={100} step={1}
            defaultValue={NOTE_FADE_DEFAULT_SIDE.percent} unit="%" quantize={(v) => Math.round(v)}
            onChange={(v) => draft.set('percent', v)} onCancel={() => draft.drop('percent')}
            onCommit={(v) => onChange({ percent: v })}
            hint={`${title} length as a share of the note`}
          />
        )}
        {mode === 1 && (
          <Select
            size="sm" ariaLabel={`${title} note division`}
            value={side.divisionDenominator ?? NOTE_FADE_DEFAULT_SIDE.divisionDenominator}
            options={FADE_DIVISION_OPTIONS}
            onChange={(v) => onChange({ divisionDenominator: v })}
          />
        )}
        {mode === 2 && (
          <NumberBox
            label="Time" value={side.ms ?? NOTE_FADE_DEFAULT_SIDE.ms} min={0} max={5000} step={10}
            defaultValue={NOTE_FADE_DEFAULT_SIDE.ms} unit="ms" quantize={(v) => Math.round(v)}
            onCommit={(v) => onChange({ ms: v || 0 })}
            hint={`${title} length in milliseconds`}
          />
        )}
        <Select size="sm" ariaLabel={`${title} curve`} value={side.curve ?? 0} options={FADE_CURVE_OPTIONS} onChange={(v) => onChange({ curve: v })} />
      </div>
    </DeviceSection>
  )
}

function NoteFadeBody({ track }) {
  const bpm = useBpm()
  const nf = track.noteFade ?? {}
  const enabled = nf.enabled ?? false
  const fadeIn = nf.fadeIn ?? NOTE_FADE_DEFAULT_SIDE
  const fadeOut = nf.fadeOut ?? NOTE_FADE_DEFAULT_SIDE
  // The whole object, as the legacy panel sent it, so both sides stay consistent.
  const set = (patch) => setNoteFade(track.id, { enabled, fadeIn, fadeOut, ...patch })
  return (
    <>
      <DisplayWell label="Note fade envelope" width={200}>
        <div className={styles.display}>
          <NoteFadeCanvas noteFade={{ enabled: true, fadeIn, fadeOut }} bpm={bpm} />
        </div>
      </DisplayWell>
      <FadeSide title="Fade in" side={fadeIn} onChange={(patch) => set({ fadeIn: { ...fadeIn, ...patch } })} />
      <FadeSide title="Fade out" side={fadeOut} onChange={(patch) => set({ fadeOut: { ...fadeOut, ...patch } })} />
      <DeviceSection title="About" width={140}>
        <p className={styles.note}>
          Shown on a one-beat note. Fixed lengths are clamped to each note; a note shorter than the fade gets a shorter one.
        </p>
      </DeviceSection>
    </>
  )
}

// ── Slide note effect ────────────────────────────────────────────────────────

const SLIDE_TYPES = [
  { value: 0, label: 'None', hint: 'Slide notes trigger no effect' },
  { value: 1, label: 'Zoom/pan/rot', hint: 'A keyframed zoom, pan and rotation over the slide' },
  { value: 2, label: 'Bounce', hint: 'A bounce shaped by the slide note’s own curve' },
  { value: 3, label: 'TV', hint: 'The TV simulator ramps in over the slide' },
]
const SLIDE_DURATION = [
  { value: 0, label: 'Follow slide' },
  { value: 1, label: 'Fixed' },
]
const RETURN_STYLE = [
  { value: 0, label: 'Instant' },
  { value: 1, label: 'Smooth reverse' },
]
const RETURN_TRIGGER = [
  { value: 0, label: 'Next normal note' },
  { value: 1, label: 'Next slide note' },
]
// Slide TV keys, by the chain TV simulator's param index (same ranges and defaults).
const SLIDE_TV_KEYS = { 0: 'intensity', 1: 'rollSpeed', 2: 'scanlines', 3: 'chroma', 4: 'noise', 5: 'jitter', 6: 'colorBleed' }

function SlideTvKnobs({ tv, write }) {
  const draft = useDraft(tv)
  return (
    <DeviceSection title="TV simulator" width={292}>
      <div className={styles.knobGrid} data-cols="4">
        {CHAIN_PARAMS[FX.TV_SIMULATOR].map((row) => {
          const key = SLIDE_TV_KEYS[row.pi]
          return (
            <Knob
              key={key}
              label={row.label}
              value={draft.get(key, tv?.[key] ?? row.def)}
              min={row.min} max={row.max} defaultValue={row.def} step={row.step}
              quantize={knobQuantize(row)} format={row.fmt.format} parse={row.fmt.parse}
              width={68}
              onChange={(v) => draft.set(key, v)}
              onCancel={() => draft.drop(key)}
              onCommit={(v) => write({ [key]: commitValue(row, v) })}
            />
          )
        })}
      </div>
    </DeviceSection>
  )
}

function SlideNoteBody({ track, layout }) {
  const sl = track.slideNoteEffect ?? {}
  const type = sl.type ?? 0
  const durationMode = sl.durationMode ?? 0
  const fixedMs = sl.fixedDurationMs ?? 300
  const returnStyle = sl.returnStyle ?? 1
  const set = (patch) => setSlideNoteEffect(track.id, track.slideNoteEffect, patch)
  return (
    <>
      <DeviceSection title="Effect" width={156}>
        <div className={styles.stack}>
          <Select size="sm" ariaLabel="Slide note effect" value={type} options={SLIDE_TYPES} onChange={(v) => set({ type: v })} />
          <span className={styles.caption}>Length</span>
          <Select size="sm" ariaLabel="Slide note effect length" value={durationMode} options={SLIDE_DURATION} onChange={(v) => set({ durationMode: v })} />
          {durationMode === 1 && (
            <NumberBox
              label="Fixed length" hideLabel value={fixedMs} min={10} max={5000} step={10} defaultValue={300} unit="ms"
              quantize={(v) => Math.round(v)} onCommit={(v) => set({ fixedDurationMs: v || 300 })}
            />
          )}
        </div>
      </DeviceSection>
      <DeviceSection title="Return" width={156}>
        <div className={styles.stack}>
          <Select size="sm" ariaLabel="Return style" value={returnStyle} options={RETURN_STYLE} onChange={(v) => set({ returnStyle: v })} />
          <span className={styles.caption}>Returns on</span>
          <Select size="sm" ariaLabel="Return trigger" value={sl.returnTrigger ?? 0} options={RETURN_TRIGGER} onChange={(v) => set({ returnTrigger: v })} />
          {returnStyle === 1 && (
            <NumberBox
              label="Return time" hideLabel value={sl.returnDurationMs ?? 200} min={10} max={5000} step={10} defaultValue={200} unit="ms"
              quantize={(v) => Math.round(v)} onCommit={(v) => set({ returnDurationMs: v || 200 })}
            />
          )}
        </div>
      </DeviceSection>
      {type === 1 && (
        <ZprTimelineCard
          key={track.id}
          layout={layout}
          variant="slide"
          slideLengthMs={durationMode === 1 ? fixedMs : null}
          trackId={track.id}
          zpr={sl.zoomPanRot ?? {}}
          onApplyScalar={(patch) => set({ zoomPanRot: { ...(sl.zoomPanRot ?? {}), ...patch } })}
          onApplyTracks={(tracks) => set({ zoomPanRot: { ...(sl.zoomPanRot ?? {}), tracks } })}
        />
      )}
      {type === 2 && (
        <BounceControls bounce={sl.bounce} withDuration={false} write={(patch) => set({ bounce: { ...(sl.bounce ?? {}), ...patch } })} />
      )}
      {type === 3 && <SlideTvKnobs tv={sl.tv} write={(patch) => set({ tv: { ...(sl.tv ?? {}), ...patch } })} />}
    </>
  )
}

const BODIES = {
  pingPong: PingPongBody,
  zoomPanRot: ZprBody,
  bounce: BounceBody,
  noteFade: NoteFadeBody,
  slideNote: SlideNoteBody,
}

const WINDOW_WIDTH = 860

/**
 * A per-note config as a device. These are track settings the engine evaluates
 * per triggered note, not chain entries, so they have no reorder. Activator =
 * the config's `enabled` (the Slide note effect has none: its type, None
 * included, is the switch). Remove turns it off and hides it.
 */
export default function NoteDevice({ track, id, identityColor, presentation = 'docked', dragHandleProps, onClose }) {
  const key = noteDeviceKey(track.id, id)
  const folded = useDeviceUiStore((s) => !!s.folded[key])
  const setFolded = useDeviceUiStore((s) => s.setFolded)
  const win = useVideoDeviceStore((s) => s.window)
  const openWindow = useVideoDeviceStore((s) => s.openWindow)
  const closeWindow = useVideoDeviceStore((s) => s.closeWindow)
  const showNoteDevice = useVideoDeviceStore((s) => s.showNoteDevice)
  const hideNoteDevice = useVideoDeviceStore((s) => s.hideNoteDevice)
  const poppedOut = presentation === 'docked' && isInWindow(win, track.id, 'note', id)
  const floating = presentation === 'floating'

  const name = noteDeviceName(id)
  const active = noteDeviceActive(track, id)
  const isSlide = id === 'slideNote'

  // Zoom/pan/rot presets: the 'xform' adapter reads target.zpr directly.
  const presetTarget = useMemo(
    () => (id === 'zoomPanRot' ? { trackId: track.id, zpr: track.zoomPanRot ?? {}, nodeId: track.id, storeKey: 'xform' } : null),
    [id, track.id, track.zoomPanRot],
  )
  const presets = useEffectPresets({ effectType: 'xform', target: presetTarget, onApplied: notifyTracksChanged })

  const remove = async () => {
    hideNoteDevice(track.id, id)
    if (isSlide) await setSlideNoteEffect(track.id, track.slideNoteEffect, { type: 0 })
    else await setNoteDeviceEnabled(track, id, false)
  }

  const Body = BODIES[id]
  const layout = floating ? 'window' : 'device'
  // The keyframe editor's window is the one device that is not --device-h tall.
  const tall = floating && (id === 'zoomPanRot' || (isSlide && (track.slideNoteEffect?.type ?? 0) === 1))
  return (
    <DeviceFrame
      name={name}
      identityColor={identityColor}
      bypassed={!active}
      onBypassChange={isSlide ? undefined : (bypassed) => {
        showNoteDevice(track.id, id) // stays in the chain while off, this session
        setNoteDeviceEnabled(track, id, !bypassed)
      }}
      bypassHint={isSlide ? 'The effect type switches the Slide note effect: None turns it off.' : undefined}
      folded={folded}
      onFoldChange={(next) => setFolded(key, next)}
      presentation={presentation}
      width={tall ? WINDOW_WIDTH : undefined}
      style={tall ? { '--device-h': 'auto' } : undefined}
      presetSlot={id === 'zoomPanRot' ? <DevicePresetMenu presets={presets} deviceName={name} /> : undefined}
      moreItems={[
        ...(id === 'zoomPanRot' ? presetMoreItems(presets) : []),
        { label: `Remove ${name}`, danger: true, onSelect: remove },
      ]}
      onPopOut={() => openWindow({ trackId: track.id, kind: 'note', key: id })}
      onClose={onClose}
      poppedOut={poppedOut}
      onReturn={closeWindow}
      dragHandleProps={dragHandleProps}
      data-video-note={id}
    >
      {Body && !folded && !poppedOut ? <Body track={track} layout={layout} /> : null}
    </DeviceFrame>
  )
}
