// zprSourceFrame — resolves the backdrop image for the ZPR spatial viewport.
//
// The viewport draws a camera window OVER THE SOURCE, so the backdrop must be
// the UNTRANSFORMED source frame. That rules out the composited preview: the
// shared-memory frame already has this very ZPR baked into it, and overlaying
// the rect on an already-transformed image would double-apply the transform.
//
// window.xleth.video.getFrameAtTime(sourceId, seconds, maxW, maxH) is the right
// tap — a per-source, on-demand JPEG extraction (engine Video_GetFrame ->
// FrameServer::getFrameJPEG) that is completely decoupled from the transport
// playback loop, touches neither the preview shared memory nor the LRU render
// frame cache, and already ships wired end to end (MidiSampleRail uses it).
//
// Everything here is best-effort. A request that fails, races, or finds no clip
// resolves to null and the viewport keeps drawing its checkerboard — the render
// loop is never blocked on a frame (see the DO-NOT list).

import { PPQ } from '../../../constants/timeline.js'
import { sourceTicksForTimelineTicks } from '../../timeline/clipSourceDomain.js'

/** Clip covering `tick`, else the nearest earlier clip, else the first. */
export function pickClipAtTick(clips, tick) {
  if (!Array.isArray(clips) || clips.length === 0) return null
  let covering = null
  let latestBefore = null
  for (const c of clips) {
    const start = c.positionTicks ?? 0
    const end = start + (c.durationTicks ?? 0)
    if (tick >= start && tick < end) {
      if (!covering || start > covering.positionTicks) covering = c
    }
    if (start <= tick && (!latestBefore || start > latestBefore.positionTicks)) latestBefore = c
  }
  return covering || latestBefore || clips.slice().sort((a, b) => a.positionTicks - b.positionTicks)[0]
}

/**
 * Absolute time (seconds) inside the source file for a clip at project `tick`.
 *
 * regionOffsetTicks is SOURCE time — the engine trims raw PCM before the
 * stretcher runs — so the timeline distance into the clip is converted with
 * sourceTicksForTimelineTicks before the two are added. Adding them directly is
 * exactly the domain error clipSourceDomain.js exists to prevent.
 *
 * This only picks which frame to show behind the rect; it does not feed the
 * transform, so clamping to the region is enough precision here.
 */
export function sourceTimeForClip(clip, region, tick, bpm) {
  if (!clip || !region) return 0
  const safeBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120
  const secPerBeat = 60 / safeBpm

  const intoClipTicks = Math.max(0, (tick ?? 0) - (clip.positionTicks ?? 0))
  const intoSourceTicks =
    (clip.regionOffsetTicks ?? 0) + sourceTicksForTimelineTicks(intoClipTicks, clip.stretchRatio)

  const t = (region.startTime ?? 0) + (intoSourceTicks / PPQ) * secPerBeat
  const end = Number.isFinite(region.endTime) && region.endTime > (region.startTime ?? 0)
    ? region.endTime
    : t
  return Math.max(region.startTime ?? 0, Math.min(end, t))
}

/**
 * Aspect ratio of the grid cell this track renders into.
 *
 * The compositor stretches the decoded source across the cell's [0,1]^2 with no
 * letterbox (GridComposite.hlsl samples localUV directly), so the cell aspect —
 * not the source aspect — is the shape the viewport must draw the unit square
 * at for the rect overlay to be faithful. spanX/spanY are fine-grid subunits;
 * 8 subunits is one whole column/row (FrameCollector::CellFrameRequest).
 */
export const GRID_SUBUNITS = 8

export function cellAspectFor(layout, trackId) {
  const cw = layout?.canvasWidth
  const ch = layout?.canvasHeight
  if (!Number.isFinite(cw) || !Number.isFinite(ch) || cw <= 0 || ch <= 0) return 16 / 9

  const cols = Math.max(1, layout?.columns ?? 1)
  const rows = Math.max(1, layout?.rows ?? 1)
  const slot = (layout?.slots || []).find(s => s.trackId === trackId)
  const spanX = Math.max(1, slot?.spanX ?? GRID_SUBUNITS)
  const spanY = Math.max(1, slot?.spanY ?? GRID_SUBUNITS)

  // A track with no grid slot is a fullscreen layer — it fills the canvas.
  if (!slot) return cw / ch

  const cellW = (cw / cols) * (spanX / GRID_SUBUNITS)
  const cellH = (ch / rows) * (spanY / GRID_SUBUNITS)
  return cellH > 0 ? cellW / cellH : cw / ch
}

/**
 * Resolve { dataUrl, sourceAspect } for a track at a project tick.
 *
 * Returns { dataUrl: null } rather than throwing whenever anything is missing,
 * so the caller can render the placeholder without a try/catch at every site.
 */
export async function resolveTrackSourceFrame(trackId, tick, bpm, maxW = 640, maxH = 640) {
  const api = typeof window !== 'undefined' ? window.xleth?.timeline : null
  const video = typeof window !== 'undefined' ? window.xleth?.video : null
  const empty = { dataUrl: null, sourceAspect: null, sourceId: null }
  if (!api || typeof video?.getFrameAtTime !== 'function') return empty

  try {
    const clips = await api.getClipsOnTrack?.(trackId)
    const clip = pickClipAtTick(clips, tick)
    if (!clip) return empty

    const regions = await api.getRegions?.()
    const region = Array.isArray(regions)
      ? regions.find(r => r.id === clip.regionId)
      : null
    if (!region) return empty

    const sources = await api.getSources?.()
    const source = Array.isArray(sources)
      ? sources.find(s => s.id === region.sourceId)
      : null
    if (!source || source.hasVideo === false) return empty

    const seconds = sourceTimeForClip(clip, region, tick, bpm)
    const dataUrl = await video.getFrameAtTime(region.sourceId, seconds, maxW, maxH)
    if (!dataUrl) return { ...empty, sourceId: region.sourceId }

    const sourceAspect = source.width > 0 && source.height > 0
      ? source.width / source.height
      : null
    return { dataUrl, sourceAspect, sourceId: region.sourceId }
  } catch (e) {
    console.warn('[XformView] source frame resolve failed:', e?.message || e)
    return empty
  }
}
