import { memo, useCallback, useEffect, useRef } from 'react'
import { Fader, Icon, Knob, Meter, NumberBox, Pearl, Slider, hintAttrs, isHeard, dbTaperScale, motionScrollBehavior, useMotionEnter } from '../../ui-kit'
import useMixerStore, { MASTER_OUTPUT_TARGET_ID, normalizeOutputTargetId } from '../../stores/mixerStore.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useFxChainDragStore from '../../stores/fxChainDragStore.js'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry'
import { requestDeviceReveal } from '../devices/deviceRevealStore.js'
import InsertList from './InsertList.jsx'
import RouteArrow from './RouteArrow.jsx'
import { subscribeMeter } from './mixerMeterBus.js'
import { GAIN_FORMAT, dbToGain, formatPan, formatWidth, gainToDb, parsePan, parseWidth } from './mixerMath.js'
import styles from './MixerStrip.module.css'

const EMPTY_CHAIN = []
/** The pan slider's drag weight: the pointer covers this many rails to sweep hard left to hard right. */
const PAN_DRAG_WEIGHT = 1.5

/** Stable `subscribe` for a kit Meter: this strip's levels from the mixer's one poll loop. */
export function useMeterSubscribe(key) {
  return useCallback((push) => subscribeMeter(key, push), [key])
}

/** Which way a strip is being treated by the FX-chain library drag, for the drop outline. */
export function useFxDropState(fxKey) {
  const dragActive = useFxChainDragStore(s => s.effects != null)
  const dragSourceKey = useFxChainDragStore(s => s.sourceKey)
  const dragHoverKey = useFxChainDragStore(s => s.hoverKey)
  const isSource = dragActive && dragSourceKey === fxKey
  const isTarget = dragActive && !isSource
  if (isSource) return 'source'
  if (isTarget) return dragHoverKey === fxKey ? 'hover' : 'target'
  return undefined
}

/**
 * Select this strip's chain and open the Devices tab on it. With `deviceIndex`
 * (an insert row), the Devices tab also brings that device into view.
 */
export function openDevicesFor(chainKey, trackId, deviceIndex = null) {
  if (trackId != null) useTimelineFocusStore.getState().setFocusedTrackId(trackId)
  useMixerStore.getState().setSelectedChainKey(chainKey)
  usePanelRegistry.getState().openPanel('devices')
  if (deviceIndex != null) requestDeviceReveal(chainKey, deviceIndex)
}

/**
 * The strip's name, written down the side of the meter (reads top to bottom, starts at the
 * top, an ellipsis takes the bottom of a long one). It is decoration for the eye: the strip's
 * group label already names the track, so it is hidden from assistive tech. The text sits in an
 * absolutely placed child, so a long name never lends the fader row any height.
 */
export function VerticalName({ name }) {
  return (
    <span className={styles.vname} title={name} aria-hidden="true" data-testid="strip-name">
      <span className={styles.vtext}>{name}</span>
    </span>
  )
}

function MixerStrip({ trackId, index, color, stripW = 72, insertRowCount = 5, insertsOpen = false, enter = false }) {
  // Decided once, when the strip mounts: true only for a track added to a mixer already on screen.
  const enterAttrs = useMotionEnter('insert', enter)
  const fxKey = String(trackId)
  const track = useMixerStore(s => s.tracks[trackId])
  const tracks = useMixerStore(s => s.tracks)
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const setVolume = useMixerStore(s => s.setVolume)
  const setPan = useMixerStore(s => s.setPan)
  const setSpread = useMixerStore(s => s.setSpread)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const pearl = useMixerStore(s => s.pearl)
  const toggleVisualOnly = useMixerStore(s => s.toggleVisualOnly)
  const selected = useMixerStore(s => s.selectedChainKey === fxKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const setFocusedTrackId = useTimelineFocusStore(s => s.setFocusedTrackId)
  const chain = useEffectChainStore(s => s.chains[fxKey] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => resolveFxMode(s.fxModes, fxKey))
  const fetchChain = useEffectChainStore(s => s.fetchChain)
  const openFxChainMenu = useFxChainDragStore(s => s.openMenu)
  const fxDrop = useFxDropState(fxKey)
  const subscribe = useMeterSubscribe(fxKey)
  const stripRef = useRef(null)

  const routeTargetId = normalizeOutputTargetId(outputRoutes[trackId])
  const routeTarget = routeTargetId === MASTER_OUTPUT_TARGET_ID ? null : tracks[routeTargetId]

  useEffect(() => {
    if (selected) stripRef.current?.scrollIntoView({ behavior: motionScrollBehavior(), inline: 'nearest', block: 'nearest' })
  }, [selected])

  // The insert list reads the chain cache, which only the Devices and FX Graph
  // panels used to fill (for the selected track). Each strip fills its own entry
  // when it mounts; edits made through the store keep it current after that, and
  // MixerPanel refetches every strip's chain when a project loads.
  useEffect(() => {
    fetchChain(fxKey)
  }, [fxKey, fetchChain])

  useEffect(() => {
    if (routeTargetId !== MASTER_OUTPUT_TARGET_ID && !routeTarget) refreshRouting()
  }, [routeTargetId, routeTarget, refreshRouting])

  const handleSelect = useCallback(() => {
    setFocusedTrackId(trackId)
    setSelectedChainKey(fxKey)
  }, [setFocusedTrackId, setSelectedChainKey, trackId, fxKey])

  const handleContextMenu = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    openFxChainMenu(fxKey, e.clientX, e.clientY)
  }, [openFxChainMenu, fxKey])

  // Volume keeps pushing to the bridge on every live tick, exactly as the
  // legacy fader did (there is no release-only commit for a track fader).
  const handleVolume = useCallback((db) => setVolume(trackId, dbToGain(db)), [trackId, setVolume])
  const handlePan = useCallback((v) => setPan(trackId, v), [trackId, setPan])
  const handleSpread = useCallback((v) => setSpread(trackId, v), [trackId, setSpread])
  const handleOpenInsert = useCallback((deviceIndex) => openDevicesFor(fxKey, trackId, deviceIndex), [fxKey, trackId])

  if (!track) return null

  const name = track.name || `Track ${trackId}`
  const db = gainToDb(track.volume)
  const knobW = Math.floor(stripW / 2) - 1

  return (
    <div
      ref={stripRef}
      {...enterAttrs}
      className={styles.strip}
      style={{ '--strip-id': color, '--strip-w': `${stripW}px` }}
      data-selected={selected}
      data-muted={track.muted || undefined}
      data-visual-only={track.visualOnly || undefined}
      data-fx-drop={fxDrop}
      data-fx-key={fxKey}
      data-testid={`mixer-strip-${trackId}`}
      role="group"
      aria-label={`Track ${index} ${name}${track.muted ? ', muted' : ''}${track.solo ? ', soloed' : ''}`}
      aria-selected={selected}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
    >
      {/* The number alone: the name is written up the side of the meter (below), as on a hardware strip. */}
      <div className={styles.head} title={name}>
        <span className={styles.numRow}>
          <span className={styles.num}>{index}</span>
          {track.muted ? <Icon name="speaker-simple-x" weight="fill" className={styles.muteGlyph} size={14} /> : null}
        </span>
      </div>

      <InsertList name={name} chain={chain} fxMode={fxMode} rows={insertRowCount} expanded={insertsOpen} onOpen={handleOpenInsert} />

      <div className={styles.toggles}>
        <Pearl
          className={styles.pearl}
          lit={isHeard({ id: trackId, muted: !!track.muted, soloed: !!track.solo }, Object.values(tracks).filter(Boolean).map(t => ({ id: t.id, muted: !!t.muted, soloed: !!t.solo })))}
          label={name}
          onToggle={() => pearl(trackId, 'toggle')}
          onSolo={() => pearl(trackId, 'solo')}
        />
        {/* No chip: the eye floats in its cell. On is the filled glyph at full ink, off the outlined one
            dimmed, so state is never colour alone. A real button, so Space and Enter work. */}
        <button
          type="button" className={styles.eye} aria-pressed={!!track.visualOnly} aria-label={`Visual only ${name}`}
          onClick={() => toggleVisualOnly(trackId)}
          {...hintAttrs({ hint: 'Visual only. Silences the audio, keeps grid triggers.' })}
        >
          <Icon name="eye" weight={track.visualOnly ? 'fill' : 'regular'} aria-hidden="true" />
        </button>
      </div>

      {/* Width: one plain dial, no words and no numbers (the pointer is the reading; straight up is
          100 %). Pan sits right under it as a horizontal slider, a touch heavier to pull so it does
          not skate off centre. Each keeps its accessible name, its value text and its hint, and
          double-click still types a value. */}
      <div className={styles.knobs}>
        <Knob
          className={styles.knob} label="Width" hideLabel hideValue minimal size={20} width={knobW} min={0} max={2} defaultValue={1}
          value={track.spread} format={formatWidth} parse={parseWidth}
          onChange={handleSpread} onCommit={handleSpread} hint={`Stereo width of ${name}`}
        />
      </div>

      <div className={styles.pan}>
        <Slider
          label="Pan" bipolar weight={PAN_DRAG_WEIGHT} min={-1} max={1} defaultValue={0}
          value={track.pan} format={formatPan} parse={parsePan}
          onChange={handlePan} onCommit={handlePan} hint={`Pan of ${name}`}
        />
      </div>

      {/* The number; the fader under it is the slider, so the field draws no fill of its own. */}
      <div className={styles.field}>
        <NumberBox
          className={styles.readout} label={`${name} volume`} hideLabel fill={false} width={stripW - 7} scale={dbTaperScale} unit="dB"
          formatOptions={GAIN_FORMAT} defaultValue={0}
          value={db} onChange={handleVolume} onCommit={handleVolume} hint={`Volume of ${name}`}
        />
      </div>

      <div className={styles.faderRow}>
        <Fader
          label={`${name} volume`} scale={dbTaperScale} unit="dB" formatOptions={GAIN_FORMAT} defaultValue={0} width={28}
          value={db} onChange={handleVolume} onCommit={handleVolume} hint={`Volume of ${name}`}
        />
        <Meter
          label={name} channels={2} well="panel" tone="audio" scale="ticks" clipLatch="latched"
          subscribe={subscribe} hint={`Level of ${name}, in dB. The scale is printed once, at the left of the mixer.`}
        />
        <VerticalName name={name} />
      </div>

      <div className={styles.cableSpace} aria-hidden="true" />
      {/* FL-style: the arrow routes the SELECTED strip here (click), here only (Ctrl+click)
          or sidechains it here (right-click). The cables above draw every route. */}
      <RouteArrow targetTrackId={trackId} targetName={name} />
    </div>
  )
}

export default memo(MixerStrip)
