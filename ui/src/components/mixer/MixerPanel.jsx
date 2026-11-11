import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Columns3 } from 'lucide-react'
import useMixerStore, { peaksSnapshot } from '../../stores/mixerStore.js'
import useEffectChainStore from '../../stores/effectChainStore.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'
import { timelineEvents } from '../../timelineEvents.js'
import { EmptyState, IconButton, MeterScale } from '../../ui-kit'
import { clearAllMeterTelemetry, mergeMeterTelemetry } from './meterTelemetry.js'
import { publishMeters } from './mixerMeterBus.js'
import MixerStrip from './MixerStrip.jsx'
import MasterStrip from './MasterStrip.jsx'
import FxChainMenuLayer from './FxChainMenuLayer.jsx'
import MasterLoudnessMeter, { pollMasterLoudness } from '../MasterLoudnessMeter.jsx'
import { buildMixerFolderLayout } from './mixerFolderLayout.js'
import RoutingBand from './RoutingBand.jsx'
import useMixerIdentity from './useMixerIdentity.js'
import useMixerUiStore, { STRIP_WIDTHS } from './mixerUiStore.js'
import styles from './MixerPanel.module.css'
import strip from './MixerStrip.module.css'

const ADD_TRACK_HINT = 'Adds an empty clip track to the project'

/**
 * A strip's fixed rows with five insert rows and a 64px fader come to 316px. Under that (the
 * height left for strips: the panel minus the scroller's bar) a strip shows three insert
 * rows and lets its fader go down to 48px, which fits the 320px dock of a 1366x768 window.
 */
export const FULL_STRIP_H = 316
export const insertRowsForHeight = (stripAreaH) => (stripAreaH > 0 && stripAreaH < FULL_STRIP_H ? 3 : 5)

/**
 * What every strip shares, printed once at the left of the scroller: the dB numerals of the
 * meters (same rows as a strip, so each numeral sits at the strips' tick), the words Pan
 * and Width for the two knobs, and the strip-width switch.
 */
export function MixerGutter({ stripMode, onStripMode }) {
  const compact = stripMode === 'compact'
  return (
    <div className={strip.gutter} data-testid="mixer-gutter" role="group" aria-label="Mixer legend">
      <div className={strip.gutterHead} />
      <div className={strip.gutterCell} aria-hidden="true">FX</div>
      <div className={strip.gutterCell} />
      {/* The legend for the row of knobs beside it: the left knob is pan, the right one width. */}
      <div className={`${strip.gutterCell} ${strip.gutterKnobs}`} aria-hidden="true">
        <span>Pan</span>
        <span>Width</span>
      </div>
      <div className={strip.gutterCell} />
      <div className={`${strip.gutterCell} ${strip.gutterScale}`}>
        <span className={strip.gutterUnit} aria-hidden="true">dB</span>
        <MeterScale />
      </div>
      <div className={strip.gutterCell} />
      <div className={strip.gutterCell}>
        <IconButton
          size="sm"
          label={compact ? 'Strip width: compact. Switch to normal' : 'Strip width: normal. Switch to compact'}
          hint={compact ? 'Strips are compact (72 px). Click for normal (84 px).' : 'Strips are normal (84 px). Click for compact (72 px), which fits more across.'}
          onClick={() => onStripMode(compact ? 'normal' : 'compact')}
        >
          {compact ? <Columns3 aria-hidden="true" /> : <Columns2 aria-hidden="true" />}
        </IconButton>
      </div>
    </div>
  )
}

/** The timeline's own add-track call, with the same default name; the mixer follows the change event. */
export async function addTrackFromMixer(trackCount) {
  const timeline = window.xleth?.timeline
  if (!timeline?.addTrack) return null
  try {
    const id = await timeline.addTrack({ name: `Track ${trackCount + 1}`, order: trackCount })
    timelineEvents.dispatchEvent(new Event('timeline-tracks-changed'))
    return id
  } catch (e) {
    console.warn('[Mixer] addTrack failed:', e?.message ?? e)
    return null
  }
}

export default function MixerPanel() {
  const visible = useMixerStore(s => s.visible)
  const trackOrder = useMixerStore(s => s.trackOrder)
  const trackLayout = useMixerStore(s => s.trackLayout)
  const tracks = useMixerStore(s => s.tracks)
  const selectedChainKey = useMixerStore(s => s.selectedChainKey)
  const setSelectedChainKey = useMixerStore(s => s.setSelectedChainKey)
  const routingError = useMixerStore(s => s.routingError)
  const init = useMixerStore(s => s.init)
  const syncFromTimeline = useMixerStore(s => s.syncFromTimeline)
  const refreshRouting = useMixerStore(s => s.refreshRouting)
  const refreshMasterVolume = useMixerStore(s => s.refreshMasterVolume)
  const focusedTrackId = useTimelineFocusStore(s => s.focusedTrackId)
  const stripMode = useMixerUiStore(s => s.stripWidthMode)
  const setStripMode = useMixerUiStore(s => s.setStripWidthMode)
  const stripW = STRIP_WIDTHS[stripMode]
  const panelRef = useRef(null)
  const scrollRef = useRef(null)
  const [insertRowCount, setInsertRowCount] = useState(5)
  // Height of the strip scroller's horizontal bar, measured: the fixed columns (gutter,
  // master) leave exactly this much at the bottom so their rows line up with the strips'.
  const [barH, setBarH] = useState(0)
  const identity = useMixerIdentity()
  const previousFocusedTrackIdRef = useRef(null)

  useEffect(() => {
    if (!visible) return
    init()
    const onTracksChanged = async () => {
      try {
        const [list, layout] = await Promise.all([
          window.xleth?.timeline?.getTracks(),
          window.xleth?.timeline?.getTrackLayout?.(),
        ])
        if (Array.isArray(list)) syncFromTimeline(list, layout)
        await refreshRouting()
      } catch {}
    }
    timelineEvents.addEventListener('timeline-tracks-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-track-layout-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-routing-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onTracksChanged)
    timelineEvents.addEventListener('timeline-patterns-changed', onTracksChanged)
    const onProjectLoaded = async () => {
      await onTracksChanged()
      // Master volume is not part of the track list, so the tracks-changed
      // path never picks it up — refresh it explicitly on project load.
      await refreshMasterVolume()
      // The strips name their inserts from the chain cache, and each strip only fills its
      // entry when it mounts. A project loaded into a mixer that stays mounted keeps the
      // same strips (same track ids), so refetch every chain here.
      const { fetchChain } = useEffectChainStore.getState()
      fetchChain('master')
      for (const id of useMixerStore.getState().trackOrder) fetchChain(String(id))
    }
    const offProjectLoaded = window.xleth?.onProjectLoaded?.(onProjectLoaded)
    return () => {
      timelineEvents.removeEventListener('timeline-tracks-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-track-layout-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-routing-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onTracksChanged)
      timelineEvents.removeEventListener('timeline-patterns-changed', onTracksChanged)
      offProjectLoaded?.()
    }
  }, [visible, init, syncFromTimeline, refreshRouting, refreshMasterVolume])

  useEffect(() => {
    if (!visible) return
    const previousFocusedTrackId = previousFocusedTrackIdRef.current
    previousFocusedTrackIdRef.current = focusedTrackId
    if (focusedTrackId == null || !tracks[focusedTrackId]) return
    if (focusedTrackId !== previousFocusedTrackId) setSelectedChainKey(String(focusedTrackId))
  }, [visible, focusedTrackId, tracks, setSelectedChainKey])

  useEffect(() => {
    if (!visible || selectedChainKey === 'master') return
    if (selectedChainKey != null && tracks[Number(selectedChainKey)]) return
    const fallbackTrackId = focusedTrackId != null && tracks[focusedTrackId]
      ? focusedTrackId
      : trackOrder[0]
    setSelectedChainKey(fallbackTrackId == null ? null : String(fallbackTrackId))
  }, [visible, selectedChainKey, focusedTrackId, tracks, trackOrder, setSelectedChainKey])

  // The one existing peak poll (125 ms). It feeds peaksSnapshot as before and now
  // also fans the levels out to the kit meters; no timer was added.
  useEffect(() => {
    if (!visible) return
    let polling = true
    ;(async function loop() {
      while (polling) {
        try {
          const data = await window.xleth?.audio?.getAllPeaks()
          if (data) mergeMeterTelemetry(peaksSnapshot, data, performance.now())
          else clearAllMeterTelemetry(peaksSnapshot)
        } catch {
          clearAllMeterTelemetry(peaksSnapshot)
        }
        publishMeters(peaksSnapshot)
        // Same tick as the peak meters — the loudness panel deliberately has no
        // timer of its own. Self-gating: no-ops unless it is mounted and on.
        await pollMasterLoudness()
        await new Promise(resolve => setTimeout(resolve, 125))
      }
    })()
    return () => {
      polling = false
      clearAllMeterTelemetry(peaksSnapshot)
      publishMeters(peaksSnapshot)
    }
  }, [visible])

  const mixerLayout = useMemo(() => buildMixerFolderLayout(trackLayout, tracks), [trackLayout, tracks])
  // Strip order is the layout's order (folders keep their members together).
  const orderedIds = useMemo(() => (
    mixerLayout.hasFolderHeaders
      ? mixerLayout.items.flatMap(item => (item.kind === 'folder' ? item.trackIds : [item.id]))
      : trackOrder
  ), [mixerLayout, trackOrder])
  const indexOf = useMemo(() => {
    const map = {}
    trackOrder.forEach((id, i) => { map[id] = i + 1 })
    return map
  }, [trackOrder])

  const handleAddTrack = useCallback(() => addTrackFromMixer(trackOrder.length), [trackOrder.length])

  // One observer on the panel: a short dock shows three insert rows instead of five.
  useEffect(() => {
    const el = panelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const scroller = scrollRef.current
      const bar = scroller ? Math.max(0, scroller.offsetHeight - scroller.clientHeight) : 0
      setBarH(bar)
      setInsertRowCount(insertRowsForHeight(el.clientHeight - bar))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [visible])

  if (!visible) return null

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      data-testid="mixer-panel"
      data-strip-width={stripMode}
      data-short={insertRowCount < 5 ? 'true' : undefined}
      style={{ '--mx-ins-rows': insertRowCount, '--mx-bar-h': `${barH}px` }}
    >
      {orderedIds.length > 0 ? (
        <div className={styles.gutterDock} data-folders={mixerLayout.hasFolderHeaders || undefined}>
          <MixerGutter stripMode={stripMode} onStripMode={setStripMode} />
        </div>
      ) : null}
      <div className={styles.scroll} ref={scrollRef}>
        {mixerLayout.hasFolderHeaders && orderedIds.length > 0 ? (
          <div className={styles.folderRow} aria-hidden="true">
            {mixerLayout.items.map(item => item.kind === 'folder' ? (
              <div
                key={`folder-${item.folder.id}`}
                className={styles.folder}
                style={{ width: item.trackIds.length * stripW }}
                title={item.folder.name}
              >
                <span className={styles.folderName}>{item.folder.name}</span>
                <span>{item.trackIds.length}</span>
              </div>
            ) : (
              <div key={`track-${item.id}`} className={styles.folderSpacer} style={{ width: stripW }} />
            ))}
          </div>
        ) : null}
        <div className={styles.lane}>
          {routingError ? <span className={styles.routingError} role="status">{routingError}</span> : null}
          {orderedIds.length === 0 ? (
            <EmptyState
              className={styles.empty}
              message="No tracks. Add one to start mixing."
              actionLabel="Add track"
              onAction={handleAddTrack}
              hint={ADD_TRACK_HINT}
            />
          ) : orderedIds.map(id => (
            <MixerStrip key={id} trackId={id} index={indexOf[id]} color={identity[id]} stripW={stripW} insertRowCount={insertRowCount} />
          ))}
          {orderedIds.length > 0 ? <RoutingBand orderedIds={orderedIds} stripW={stripW} idColors={identity} /> : null}
        </div>
      </div>

      <div className={styles.dock} data-folders={mixerLayout.hasFolderHeaders && orderedIds.length > 0 ? true : undefined}>
        <MasterStrip stripW={stripW} insertRowCount={insertRowCount} />
        <MasterLoudnessMeter />
      </div>

      {/* FX Chain Library — one instance for the whole mixer. Owns the strip
          context menu, the save dialog, the sticky drag ghost and the toasts;
          the strips themselves only report the right-click. */}
      <FxChainMenuLayer />
    </div>
  )
}
