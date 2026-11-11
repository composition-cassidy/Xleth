import { memo, useCallback, useEffect, useRef } from 'react'
import { VolumeX } from 'lucide-react'
import { Button, Fader, Knob, Meter, NumberBox, Select, Toggle, dbTaperScale } from '../../ui-kit'
import useMixerStore, { MASTER_OUTPUT_TARGET_ID, normalizeOutputTargetId } from '../../stores/mixerStore.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'
import useEffectChainStore, { resolveFxMode } from '../../stores/effectChainStore.js'
import useFxChainDragStore from '../../stores/fxChainDragStore.js'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry'
import { subscribeMeter } from './mixerMeterBus.js'
import { dbToGain, formatPan, formatWidth, gainToDb, insertLabel, parsePan, parseWidth } from './mixerMath.js'
import styles from './MixerStrip.module.css'

const EMPTY_CHAIN = []

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

/** Select this strip's chain and open the Devices tab on it. */
export function openDevicesFor(chainKey, trackId) {
  if (trackId != null) useTimelineFocusStore.getState().setFocusedTrackId(trackId)
  useMixerStore.getState().setSelectedChainKey(chainKey)
  usePanelRegistry.getState().openPanel('devices')
}

function MixerStrip({ trackId, index, color, stripW = 84 }) {
  const fxKey = String(trackId)
  const track = useMixerStore(s => s.tracks[trackId])
  const tracks = useMixerStore(s => s.tracks)
  const outputRoutes = useMixerStore(s => s.outputRoutes)
  const routingError = useMixerStore(s => s.routingError)
  const setVolume = useMixerStore(s => s.setVolume)
  const setPan = useMixerStore(s => s.setPan)
  const setSpread = useMixerStore(s => s.setSpread)
  const setOutputRoute = useMixerStore(s => s.setOutputRoute)
  const getEligibleOutputTargets = useMixerStore(s => s.getEligibleOutputTargets)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const toggleMute = useMixerStore(s => s.toggleMute)
  const toggleSolo = useMixerStore(s => s.toggleSolo)
  const toggleVisualOnly = useMixerStore(s => s.toggleVisualOnly)
  const selected = useMixerStore(s => s.selectedChainKey === fxKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const setFocusedTrackId = useTimelineFocusStore(s => s.setFocusedTrackId)
  const chain = useEffectChainStore(s => s.chains[fxKey] ?? EMPTY_CHAIN)
  const fxMode = useEffectChainStore(s => resolveFxMode(s.fxModes, fxKey))
  const openFxChainMenu = useFxChainDragStore(s => s.openMenu)
  const fxDrop = useFxDropState(fxKey)
  const subscribe = useMeterSubscribe(fxKey)
  const stripRef = useRef(null)

  const routeTargetId = normalizeOutputTargetId(outputRoutes[trackId])
  const routeTarget = routeTargetId === MASTER_OUTPUT_TARGET_ID ? null : tracks[routeTargetId]

  useEffect(() => {
    if (selected) stripRef.current?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' })
  }, [selected])

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
  const handleRoute = useCallback((target) => setOutputRoute(trackId, Number(target)), [trackId, setOutputRoute])

  if (!track) return null

  const name = track.name || `Track ${trackId}`
  const outputTargets = getEligibleOutputTargets(trackId)
  const hasSelectedTarget = outputTargets.some(o => o.targetTrackId === routeTargetId)
  const routeOptions = outputTargets.map(o => ({ value: o.targetTrackId, label: o.name }))
  if (routeTargetId !== MASTER_OUTPUT_TARGET_ID && !hasSelectedTarget) {
    routeOptions.unshift({ value: routeTargetId, label: 'Missing track', disabled: true })
  }
  const db = gainToDb(track.volume)
  const knobW = Math.floor((stripW - 4) / 2)

  return (
    <div
      ref={stripRef}
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
      <div className={styles.head} title={name}>
        <span className={styles.num}>{index}</span>
        <span className={styles.name}>{name}</span>
        {track.muted ? <VolumeX className={styles.muteGlyph} size={12} aria-hidden="true" /> : null}
      </div>

      <Button
        size="sm"
        className={styles.inserts}
        aria-label={`${name}: ${insertLabel(chain, fxMode)}. Open in Devices`}
        hint="Inserts on this track. Opens the Devices tab."
        onClick={(e) => { e.stopPropagation(); openDevicesFor(fxKey, trackId) }}
      >
        {insertLabel(chain, fxMode)}
      </Button>

      <div className={styles.toggles}>
        <Toggle
          size="sm" className={styles.toggle} on={!!track.muted} onChange={() => toggleMute(trackId)}
          aria-label={`Mute ${name}`} hint="Mute. Dims the strip and silences this track."
        >M</Toggle>
        <Toggle
          size="sm" className={`${styles.toggle} ${styles.solo}`} on={!!track.solo} onChange={() => toggleSolo(trackId)}
          aria-label={`Solo ${name}`} hint="Solo. Plays only soloed tracks."
        >S</Toggle>
        <Toggle
          size="sm" className={styles.toggle} on={!!track.visualOnly} onChange={() => toggleVisualOnly(trackId)}
          aria-label={`Visual only ${name}`} hint="Visual only. Silences the audio, keeps grid triggers."
        >V</Toggle>
      </div>

      <div className={styles.knobs}>
        <Knob
          className={styles.knob} label="Pan" size={20} width={knobW} bipolar min={-1} max={1} defaultValue={0}
          value={track.pan} format={formatPan} parse={parsePan}
          onChange={handlePan} onCommit={handlePan} hint={`Pan of ${name}`}
        />
        <Knob
          className={styles.knob} label="Width" size={20} width={knobW} min={0} max={2} defaultValue={1}
          value={track.spread} format={formatWidth} parse={parseWidth}
          onChange={handleSpread} onCommit={handleSpread} hint={`Stereo width of ${name}`}
        />
      </div>

      <div className={styles.field}>
        <NumberBox
          label={`${name} volume`} hideLabel width={stripW - 8} scale={dbTaperScale} unit="dB" defaultValue={0}
          value={db} onChange={handleVolume} onCommit={handleVolume} hint={`Volume of ${name}`}
        />
      </div>

      <div className={styles.faderRow}>
        <Fader
          label={`${name} volume`} scale={dbTaperScale} unit="dB" defaultValue={0} width={28}
          value={db} onChange={handleVolume} onCommit={handleVolume} hint={`Volume of ${name}`}
        />
        <Meter label={name} channels={2} well="panel" subscribe={subscribe} hint={`Level of ${name}`} />
      </div>

      <div className={styles.cableSpace} aria-hidden="true" />
      <Select
        size="sm" className={styles.out} ariaLabel={`Output of ${name}`} value={routeTargetId}
        options={routeOptions} onChange={handleRoute} hint={routingError || `Where ${name} sends its output`}
      />
    </div>
  )
}

export default memo(MixerStrip)
