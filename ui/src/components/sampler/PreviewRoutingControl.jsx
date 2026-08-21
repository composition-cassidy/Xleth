import { useCallback, useEffect, useState } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import useTimelineFocusStore from '../../stores/timelineFocusStore.js'

// ── Sampler audition routing ─────────────────────────────────────────────────
// Picks which track's effect rack a previewed note is heard through, and shows
// which track that currently resolves to for THIS sample.
//
// The engine owns the setting (it is a monitoring preference, not project
// state, so it is neither undoable nor saved with the project). This component
// mirrors it and re-reads the resolved track whenever the arrangement changes,
// because "dedicated" is derived from where the sample is actually placed.

// Routing applies while the transport is STOPPED. During playback a track's
// effect rack is already busy processing that track, and a rack can only run
// once per audio block — see MixEngine::renderPreviewSamplers. Auditioning
// while the song rolls stays dry.
const PLAYBACK_NOTE = ' Applies while playback is stopped; auditioning during '
  + 'playback stays dry.'

// A routed audition walks the whole arrangement path, not just the track's
// inserts, so its level matches what the sample does in the mix.
const ROUTED_PATH_NOTE = ' The audition also passes through that track’s '
  + 'volume and the Master chain and volume.'

export const PREVIEW_ROUTE_MODES = [
  {
    value: 0,
    label: 'Dedicated track',
    hint: 'Hear the sample through the effect rack of the track it belongs to. '
        + 'If it is spread across several tracks feeding one bus, that bus is used.'
        + ROUTED_PATH_NOTE + PLAYBACK_NOTE,
  },
  {
    value: 1,
    label: 'Selected track',
    hint: 'Always hear the sample through whichever track is selected.'
        + ROUTED_PATH_NOTE + PLAYBACK_NOTE,
  },
  {
    value: 2,
    label: 'Off (raw)',
    hint: 'Hear the sample dry — no track effects, no track or Master volume, '
        + 'no Master chain.',
  },
]

export default function PreviewRoutingControl({ regionId }) {
  const [mode, setMode] = useState(0)
  const [routeTrackId, setRouteTrackId] = useState(-1)
  const [tracks, setTracks] = useState([])
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId)

  const readMode = useCallback(async () => {
    try {
      const r = await window.xleth?.sampler?.getPreviewRouting?.()
      if (r && typeof r.mode === 'number') setMode(r.mode)
    } catch { /* keep the current value */ }
  }, [])

  // The resolved track depends on the arrangement, so it is re-read rather than
  // remembered. -1 means the audition plays dry.
  const readRoute = useCallback(async () => {
    if (regionId == null) return
    try {
      const [id, list] = await Promise.all([
        window.xleth?.sampler?.getPreviewRouteTrack?.(regionId),
        window.xleth?.timeline?.getTracks?.(),
      ])
      if (typeof id === 'number') setRouteTrackId(id)
      if (Array.isArray(list)) setTracks(list)
    } catch { /* leave the last known route on screen */ }
  }, [regionId])

  useEffect(() => { readMode() }, [readMode])

  useEffect(() => {
    readRoute()
    const refresh = () => readRoute()
    // Placing/removing blocks, retargeting a track's output, or reassigning a
    // pattern's region can all change which track a sample belongs to.
    const events = [
      'timeline-pattern-blocks-changed',
      'timeline-patterns-changed',
      'timeline-tracks-changed',
    ]
    for (const name of events) timelineEvents.addEventListener(name, refresh)
    return () => {
      for (const name of events) timelineEvents.removeEventListener(name, refresh)
    }
  }, [readRoute])

  const pushSetting = useCallback(async (nextMode, selectedTrackId) => {
    try {
      await window.xleth?.sampler?.setPreviewRouting?.(nextMode, selectedTrackId ?? -1)
    } catch (e) {
      console.warn('[PreviewRoutingControl] setPreviewRouting failed:', e?.message)
    }
  }, [])

  const handleModeChange = useCallback(async (next) => {
    setMode(next)
    await pushSetting(next, focusedTrackId)
    readRoute()
  }, [focusedTrackId, pushSetting, readRoute])

  // In "Selected track" mode the engine needs to follow the selection as it
  // moves, not only when the mode itself is changed.
  useEffect(() => {
    if (mode !== 1) return
    pushSetting(mode, focusedTrackId)
    readRoute()
  }, [focusedTrackId, mode, pushSetting, readRoute])

  const routeName = routeTrackId >= 0
    ? (tracks.find((t) => t.id === routeTrackId)?.name || `Track ${routeTrackId}`)
    : null

  const activeMode = PREVIEW_ROUTE_MODES.find((m) => m.value === mode)

  return (
    <div className="sampler-preview-routing">
      <label className="sampler-prep-algo">
        <span>Preview through</span>
        <select
          className="sampler-select"
          value={mode}
          onChange={(e) => handleModeChange(Number(e.target.value))}
          title={activeMode?.hint}
        >
          {PREVIEW_ROUTE_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </label>
      <span
        className={`sampler-preview-routing-state${routeName ? '' : ' is-dry'}`}
        title={routeName
          ? `Auditions through ${routeName} → Master.`
          : (mode === 0
              ? 'This sample is not on a single track (or the tracks that play it do not share one bus), so it auditions dry.'
              : undefined)}
      >
        {routeName ? `→ ${routeName} → Master` : '→ dry'}
      </span>
    </div>
  )
}
