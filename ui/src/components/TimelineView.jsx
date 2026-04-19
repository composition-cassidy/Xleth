import { useEffect, useState, useCallback, useRef } from 'react'
import { Layers, Plus } from 'lucide-react'
import TrackHeaderList from './timeline/TrackHeaderList.jsx'
import PatternListPanel from './timeline/PatternListPanel.jsx'
import TimelineCanvas from './timeline/TimelineCanvas.jsx'
import TimelineRuler from './timeline/TimelineRuler.jsx'
import TimelineScrollbar from './timeline/TimelineScrollbar.jsx'
import TimelineToolbar from './timeline/TimelineToolbar.jsx'
import ContextMenu from './ContextMenu.jsx'
import TrackContextMenu from './timeline/TrackContextMenu.jsx'
import FadeBezierEditor from './timeline/FadeBezierEditor.jsx'
import ConfirmConvertDialog from './timeline/ConfirmConvertDialog.jsx'
import QuantizeDialog from './timeline/QuantizeDialog.jsx'
import { buildQuantizeSpecs } from '../utils/quantize.js'
import useTimelineZoom from '../hooks/useTimelineZoom.js'
import useTimelineScroll from '../hooks/useTimelineScroll.js'
import { labelHexColor } from '../constants/labels.js'
import { subscribe } from '../transportStore.js'
import { playheadClock } from '../services/PlayheadClock.js'
import { editCursor } from '../services/EditCursor.js'
import { timelineEvents } from '../timelineEvents.js'
import {
  BEATS_PER_BAR, DEFAULT_LENGTH_BEATS, TRACK_HEIGHT, PPQ,
  pixelToBeat, snapBeatToGrid, beatsToTicks, regionDurationToTicks, findFreePosition,
  GRANULARITY_BEATS,
} from '../constants/timeline.js'
import { getRegime } from '../utils/waveformRenderer.js'
import useSnapStore from '../stores/snapStore.js'

function ClipSliderRow({ label, value, min, max, step, onCommit, formatValue }) {
  const [localVal, setLocalVal] = useState(value)
  const dragging = useRef(false)

  useEffect(() => {
    if (!dragging.current) setLocalVal(value)
  }, [value])

  return (
    <div style={{ padding: '4px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontSize: 11, color: '#aaa', minWidth: 40 }}>{label}</span>
      <input
        type="range" min={min} max={max} step={step}
        value={localVal}
        onChange={(e) => { dragging.current = true; setLocalVal(Number(e.target.value)) }}
        onPointerUp={(e) => {
          const v = Number(e.target.value)
          Promise.resolve(onCommit(v)).finally(() => { dragging.current = false })
        }}
        style={{ flex: 1, accentColor: '#33CED6' }}
      />
      <span style={{ fontSize: 10, color: '#888', minWidth: 40, textAlign: 'right' }}>
        {formatValue(localVal)}
      </span>
    </div>
  )
}

export default function TimelineView({
  activeSampleId,
  currentPatternIdByTrack = {},
  setCurrentPatternIdByTrack = () => {},
  activeCenterTab = 'timeline',
}) {
  // ── Tool state ──────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool] = useState('select')
  const [stickyNoteLength, setStickyNoteLength] = useState(240) // 1/16 = PPQ/4
  const { snapGranularity, setSnapGranularity } = useSnapStore()

  // Keep arranger clip length in sync with snap granularity
  useEffect(() => {
    const beats = GRANULARITY_BEATS[snapGranularity] ?? GRANULARITY_BEATS['1/16']
    setStickyNoteLength(Math.round(beats * PPQ))
  }, [snapGranularity])

  const [patternListCollapsed, setPatternListCollapsed] = useState(false)
  const lastSplitUndoCountRef = useRef(0)
  const timelineFocusedRef = useRef(false)
  const timelineViewRef = useRef(null)

  // ── Track state ────────────────────────────────────────────────────────────
  const [tracks, setTracks] = useState([])
  const [contextMenu, setContextMenu] = useState(null)
  const [trackMenu, setTrackMenu] = useState(null)         // { track, x, y }
  const [confirmDialog, setConfirmDialog] = useState(null)  // { title, message, onConfirm }
  const [quantizeOpen, setQuantizeOpen] = useState(false)
  const nextTrackNum = useRef(1)

  // ── Clip state ─────────────────────────────────────────────────────────────
  const [clips, setClips] = useState([])
  const [regions, setRegions] = useState({})        // { [id]: region }
  const [selectedClipIds, setSelectedClipIds] = useState(new Set())
  const clipsRef = useRef([])
  const clipboardRef = useRef(null)  // stores copied clip properties for paste
  const patternBlockClipboardRef = useRef(null)  // stores copied pattern block data for paste
  const pencilTemplateRef = useRef(null) // middle-click template for pencil tool
  const [pencilTemplate, setPencilTemplate] = useState(null)
  const dropPreviewRef = useRef(null)
  const loadedRegionAudioRef = useRef(new Set()) // track which regions have audio loaded
  const [sources, setSources] = useState({})     // { [id]: source }
  const waveformCacheRef = useRef({})             // { [regionId]: { peaks, stride, peakWidth } }
  const waveformLruRef = useRef([])               // LRU order: most-recent at end
  const WAVEFORM_CACHE_MAX = 128                  // max cached regions before eviction
  const hiResCacheRef = useRef({})                // { [regionId|"c"+clipId]: { peaks?, samples?, startSec, endSec, ... } }
  const hiResFetchTimer = useRef(null)            // debounce timer for hi-res fetches
  const regionSampleRates = useRef({})            // { [regionId]: sampleRate } — learned from getRegionPeaks
  const clipPeakCacheRef = useRef({})             // { [clipId]: { peaks, stride, peakWidth, pitchOffset, pitchOffsetCents, reversed, stretchRatio } }
  const clipPeakRetryRef = useRef({})             // { [clipId]: retryCount } — resets on param change or success

  // ── Pattern state ──────────────────────────────────────────────────────────
  const [patternBlocks, setPatternBlocks] = useState([])
  const [patterns, setPatterns] = useState({})        // { [id]: pattern }
  const [selectedBlockIds, setSelectedBlockIds] = useState(new Set())

  // ── Transport state ────────────────────────────────────────────────────────
  const [isPlaying, setIsPlaying] = useState(false)
  const isPlayingRef = useRef(false)
  const playheadBeatRef = useRef(0)
  const bpmRef = useRef(140)

  // ── User-scroll guard (prevents ensureVisible from fighting manual scroll) ─
  const userScrollingRef = useRef(false)
  const scrollTimeoutRef = useRef(null)
  const markUserScrolling = useCallback(() => {
    userScrollingRef.current = true
    clearTimeout(scrollTimeoutRef.current)
    scrollTimeoutRef.current = setTimeout(() => {
      userScrollingRef.current = false
    }, 2000)
  }, [])

  // ── Zoom / Scroll ──────────────────────────────────────────────────────────
  const { pixelsPerBeat, pixelsPerBeatRef, applyZoom, zoomAtCursor } = useTimelineZoom()
  const { scrollOffset, scrollOffsetRef, applyScroll, scrollBy, scrollTo, ensureVisible, setMaxScroll } = useTimelineScroll()

  // ── Canvas refs ────────────────────────────────────────────────────────────
  const canvasRef = useRef(null)    // TimelineCanvas imperative handle
  const rulerRef = useRef(null)     // TimelineRuler imperative handle
  const [canvasWidth, setCanvasWidth] = useState(800)
  const canvasAreaRef = useRef(null)
  const scrollContainerRef = useRef(null)

  const [declickMs, setDeclickMs] = useState(0.5)
  const [globalStretchMethod, setGlobalStretchMethod] = useState(1) // 1=PSOLA,2=Rubber,3=WSOLA,4=PhaseVocoder
  const declickMountedRef = useRef(true)
  useEffect(() => {
    declickMountedRef.current = true
    window.xleth?.timeline?.getDeclickMs()
      .then(v => { if (declickMountedRef.current && v != null) setDeclickMs(v) })
      .catch(() => {})
    window.xleth?.engine?.getGlobalStretchMethod()
      .then(m => { if (declickMountedRef.current && m != null) setGlobalStretchMethod(m) })
      .catch(() => {})
    return () => { declickMountedRef.current = false }
  }, [])
  const handleDeclick = useCallback((v) => {
    const clamped = Math.max(0, Math.min(5, v))
    setDeclickMs(clamped)
    window.xleth?.timeline?.setDeclickMs(clamped)
  }, [])

  // ── Pencil template (middle-click quick copy) ──────────────────────────────

  const updatePencilTemplate = useCallback((template) => {
    pencilTemplateRef.current = template
    setPencilTemplate(template)
    if (template) setStickyNoteLength(template.durationTicks)
  }, [])

  // ── Select syllable index for pencil drawing ───────────────────────────────
  // Creates/updates a pencil template that carries the syllable index so the
  // pencilTool picks it up when drawing new clips.
  const handleSelectSyllable = useCallback((syllableIndex) => {
    const existing = pencilTemplateRef.current
    if (existing) {
      updatePencilTemplate({ ...existing, syllableIndex })
      return
    }
    // No template yet — build one from the active sample
    if (activeSampleId == null) return
    const region = regions[activeSampleId]
    if (!region) return
    updatePencilTemplate({
      regionId:          region.id,
      regionOffsetTicks: 0,
      durationTicks:     stickyNoteLength,
      velocity:          1.0,
      pitchOffset:       0,
      syllableIndex,
      displayName:       region.name || '?',
      label:             region.label,
    })
  }, [activeSampleId, regions, stickyNoteLength, updatePencilTemplate])

  // Clear pencil template when user selects a different sample in Sample Selector
  useEffect(() => {
    if (activeSampleId != null && pencilTemplateRef.current != null) {
      updatePencilTemplate(null)
    }
  }, [activeSampleId, updatePencilTemplate])

  // ── Fetch tracks from engine ───────────────────────────────────────────────

  const fetchTracks = useCallback(async () => {
    try {
      const t = await window.xleth?.timeline?.getTracks()
      if (t) {
        setTracks(t)
        console.log(`[Timeline] Tracks loaded: ${t.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchClips = useCallback(async () => {
    try {
      const c = await window.xleth?.timeline?.getClips()
      if (c) {
        setClips(c)
        clipsRef.current = c
        console.log(`[TimelineClips] Clips loaded: ${c.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchRegions = useCallback(async () => {
    try {
      const r = await window.xleth?.timeline?.getRegions()
      if (r) {
        const map = {}
        r.forEach((reg) => { map[reg.id] = reg })
        setRegions(map)
        console.log(`[TimelineClips] Regions loaded: ${r.length}`)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatterns = useCallback(async () => {
    try {
      const list = await window.xleth?.timeline?.getAllPatterns()
      if (list) {
        const map = {}
        list.forEach((p) => { map[p.id] = p })
        setPatterns(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  const fetchPatternBlocks = useCallback(async () => {
    try {
      const b = await window.xleth?.timeline?.getPatternBlocks()
      if (b) setPatternBlocks(b)
    } catch { /* engine not ready */ }
  }, [])

  const fetchSources = useCallback(async () => {
    try {
      const s = await window.xleth?.timeline?.getSources()
      if (s) {
        const map = {}
        s.forEach(src => { map[src.id] = src })
        setSources(map)
      }
    } catch { /* engine not ready */ }
  }, [])

  // ── Rebuild audio mappings for regions that don't have samples loaded yet ──
  const rebuildAudioMappings = useCallback(async (regionsMap, cancelled) => {
    const regionList = Object.values(regionsMap)
    const unloaded = regionList.filter(r => r.sourceId != null && !loadedRegionAudioRef.current.has(r.id))
    if (unloaded.length === 0) return

    // Fetch sources to get file paths
    let sources = []
    try {
      sources = await window.xleth?.timeline?.getSources() || []
    } catch { return }
    if (cancelled.current) return

    const sourceById = {}
    sources.forEach(s => { sourceById[s.id] = s })

    for (const region of unloaded) {
      if (cancelled.current) break
      const source = sourceById[region.sourceId]
      if (!source?.filePath || region.startTime == null || region.endTime == null) continue

      try {
        // Swap-aware: bridge loads swappedAudioPath if region.hasSwappedAudio,
        // else the original source range. It also calls mapRegionToSample.
        const sampleId = await window.xleth?.audio?.loadRegionAudio(region.id)
        if (cancelled.current) break
        if (sampleId != null && sampleId >= 0) {
          loadedRegionAudioRef.current.add(region.id)
          console.log(`[Timeline] Audio mapped: region=${region.id} → sample=${sampleId}${region.hasSwappedAudio ? ' (swapped)' : ''}`)
        }
      } catch (e) {
        console.warn(`[Timeline] Audio load failed for region ${region.id}:`, e.message)
      }
    }
  }, [])

  // ── Quantize apply (per-edge batch) ────────────────────────────────────────
  const handleQuantizeApply = useCallback(async ({ startAction, endAction }) => {
    const clipSel  = clipsRef.current.filter(c => selectedClipIds.has(c.id))
    const blockSel = patternBlocks.filter(b => selectedBlockIds.has(b.id))
    if (clipSel.length === 0 && blockSel.length === 0) {
      console.warn('[Quantize] nothing selected, closing dialog')
      setQuantizeOpen(false)
      return
    }
    const { specs, skipped } = buildQuantizeSpecs(
      clipSel, blockSel, startAction, endAction, snapGranularity
    )
    console.log(`[Quantize] start=${startAction} end=${endAction} snap=${snapGranularity} `
      + `→ ${specs.length} specs, ${skipped.length} skipped`)
    if (skipped.length > 0) {
      for (const s of skipped) console.log(`[Quantize] skip ${s.kind} id=${s.id}: ${s.reason}`)
    }
    if (specs.length === 0) {
      setQuantizeOpen(false)
      return
    }
    try {
      await window.xleth?.timeline?.quantizeClipsBatch(specs)
      await fetchClips()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[Quantize] quantizeClipsBatch failed:', err)
    }
    setQuantizeOpen(false)
  }, [selectedClipIds, selectedBlockIds, patternBlocks, snapGranularity, fetchClips])

  useEffect(() => {
    fetchTracks()
    fetchClips()
    fetchRegions()
    fetchSources()
    fetchPatterns()
    fetchPatternBlocks()

    // Refresh regions/clips when samples are added/removed via SamplePicker
    const onRegionsChanged = () => { loadedRegionAudioRef.current.clear(); fetchTracks(); fetchRegions(); fetchSources() }
    const onClipsChanged = () => { fetchTracks(); fetchClips() }
    const onPatternsChanged = () => { fetchPatterns() }
    const onPatternBlocksChanged = () => { fetchPatternBlocks() }
    const onPatternChanged = () => { fetchPatterns() }
    const onRegionAudioLoaded = (e) => {
      if (e.detail?.regionId != null) loadedRegionAudioRef.current.add(e.detail.regionId)
    }
    timelineEvents.addEventListener('timeline-regions-changed', onRegionsChanged)
    timelineEvents.addEventListener('timeline-clips-changed', onClipsChanged)
    timelineEvents.addEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
    timelineEvents.addEventListener('timeline-patterns-changed', onPatternsChanged)
    timelineEvents.addEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
    timelineEvents.addEventListener('timeline-pattern-changed', onPatternChanged)
    return () => {
      timelineEvents.removeEventListener('timeline-regions-changed', onRegionsChanged)
      timelineEvents.removeEventListener('timeline-clips-changed', onClipsChanged)
      timelineEvents.removeEventListener('timeline-region-audio-loaded', onRegionAudioLoaded)
      timelineEvents.removeEventListener('timeline-patterns-changed', onPatternsChanged)
      timelineEvents.removeEventListener('timeline-pattern-blocks-changed', onPatternBlocksChanged)
      timelineEvents.removeEventListener('timeline-pattern-changed', onPatternChanged)
    }
  }, [fetchTracks, fetchClips, fetchRegions, fetchSources, fetchPatterns, fetchPatternBlocks])

  // ── Rebuild audio mappings when regions change (e.g. on project load) ──────
  useEffect(() => {
    const cancelled = { current: false }
    if (Object.keys(regions).length > 0) {
      rebuildAudioMappings(regions, cancelled)
    }
    return () => { cancelled.current = true }
  }, [regions, rebuildAudioMappings])

  // ── Sync track counter from existing track names on mount/re-entry ──────────
  useEffect(() => {
    if (tracks.length > 0) {
      const maxNum = tracks.reduce((max, t) => {
        const match = t.name.match(/^Track (\d+)$/)
        return match ? Math.max(max, parseInt(match[1])) : max
      }, 0)
      nextTrackNum.current = maxNum + 1
    }
  }, [tracks.length])

  // ── Fetch waveform peaks for clip rendering (via WaveformMipmap) ─────────────
  useEffect(() => {
    if (Object.keys(regions).length === 0 || Object.keys(sources).length === 0) return

    let cancelled = false

    // LRU helpers
    function lruTouch(id) {
      const lru = waveformLruRef.current
      const idx = lru.indexOf(id)
      if (idx !== -1) lru.splice(idx, 1)
      lru.push(id)
    }
    function lruEvict() {
      const lru = waveformLruRef.current
      while (lru.length > WAVEFORM_CACHE_MAX) {
        const evictId = lru.shift()
        delete waveformCacheRef.current[evictId]
      }
    }

    async function fetchWaveforms() {
      const PEAKS_PER_SECOND = 200
      const MIN_PEAKS = 800
      const MAX_PEAKS = 16000

      for (const region of Object.values(regions)) {
        if (cancelled) break
        if (waveformCacheRef.current[region.id]) {
          lruTouch(region.id)
          continue
        }

        const source = sources[region.sourceId]
        if (!source?.filePath || region.startTime == null || region.endTime == null) continue

        try {
          const durSec = Math.max(0, (region.endTime ?? 0) - (region.startTime ?? 0))
          const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
            Math.round(durSec * PEAKS_PER_SECOND)))

          // Use mipmap-backed N-API binding (replaces 8kHz FFmpeg pipeline)
          const data = await window.xleth?.waveform?.getRegionPeaks(
            region.id, 0, durSec, peakWidth, -1
          )
          if (cancelled) break

          if (data && data.ready && data.peaks?.length > 0) {
            // Store in cache format compatible with timelineDrawing.js
            // peaks is [min,max,rms, min,max,rms, ...] — 3 values per column
            waveformCacheRef.current[region.id] = { peaks: data.peaks, stride: 3, peakWidth }
            // Remember engine sample rate for spp computation
            if (data.sampleRate) regionSampleRates.current[region.id] = data.sampleRate
            lruTouch(region.id)
            lruEvict()
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Mipmap still generating — retry after a short delay
            setTimeout(() => {
              if (!cancelled) {
                delete waveformCacheRef.current[region.id]
                fetchWaveforms()
              }
            }, 150)
            return  // stop iterating, will retry all pending
          }
        } catch (e) {
          console.warn(`[Timeline] Waveform fetch failed for region ${region.id}:`, e.message)
        }
      }
    }

    fetchWaveforms()
    return () => { cancelled = true }
  }, [regions, sources])

  // ── Fetch waveform peaks for processed clips (stretch/pitch/reverse) ─────────
  // Runs whenever clips change. Fetches from ClipRenderCache via waveform_getClipPeaks.
  // Invalidates stale entries when a clip's processing params have changed.
  useEffect(() => {
    if (clips.length === 0) return
    let cancelled = false

    async function fetchClipPeaks() {
      const PEAKS_PER_SECOND = 200
      const MIN_PEAKS = 800
      const MAX_PEAKS = 16000
      const bpm = bpmRef.current || 120

      for (const clip of clips) {
        if (cancelled) break

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)
        if (!hasProcessing) {
          // Clip no longer processed — evict stale clip-peak entry
          if (clipPeakCacheRef.current[clip.id]) {
            delete clipPeakCacheRef.current[clip.id]
            delete hiResCacheRef.current[`c${clip.id}`]
          }
          continue
        }

        // Invalidate cache if params have changed since last fetch
        const cached = clipPeakCacheRef.current[clip.id]
        if (cached) {
          if (cached.pitchOffset      === (clip.pitchOffset ?? 0) &&
              cached.pitchOffsetCents === (clip.pitchOffsetCents ?? 0) &&
              cached.reversed         === !!clip.reversed &&
              cached.stretchRatio     === (clip.stretchRatio ?? 1.0)) {
            continue  // still valid
          }
          // Params changed — evict and refetch, reset retry counter
          delete clipPeakCacheRef.current[clip.id]
          delete hiResCacheRef.current[`c${clip.id}`]
          clipPeakRetryRef.current[clip.id] = 0
        }

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        if (clipDurSec <= 0) continue

        const peakWidth = Math.max(MIN_PEAKS, Math.min(MAX_PEAKS,
          Math.round(clipDurSec * PEAKS_PER_SECOND)))

        try {
          const data = await window.xleth?.waveform?.getClipPeaks(
            clip.id, 0, clipDurSec, peakWidth)
          if (cancelled) break

          if (data?.ready && data.peaks?.length > 0) {
            clipPeakCacheRef.current[clip.id] = {
              peaks: data.peaks, stride: 3, peakWidth,
              pitchOffset:      clip.pitchOffset ?? 0,
              pitchOffsetCents: clip.pitchOffsetCents ?? 0,
              reversed:         !!clip.reversed,
              stretchRatio:     clip.stretchRatio ?? 1.0,
            }
            canvasRef.current?.redrawContent('waveform')
          } else if (data && !data.ready) {
            // Cache miss — exponential backoff, max 4 retries (150→300→600→1200ms), then fall back
            const RETRY_DELAYS = [150, 300, 600, 1200]
            const retryCount = clipPeakRetryRef.current[clip.id] ?? 0
            if (retryCount < RETRY_DELAYS.length) {
              clipPeakRetryRef.current[clip.id] = retryCount + 1
              setTimeout(() => {
                if (!cancelled) {
                  delete clipPeakCacheRef.current[clip.id]
                  fetchClipPeaks()
                }
              }, RETRY_DELAYS[retryCount])
              return
            } else {
              // Max retries — fall back to raw region waveform and stop requesting
              console.warn(`[Timeline] Clip ${clip.id} cache not ready after ${RETRY_DELAYS.length} retries, falling back to region peaks`)
              clipPeakRetryRef.current[clip.id] = 0
              if (clip.regionId != null) {
                try {
                  const fallback = await window.xleth?.waveform?.getRegionPeaks(
                    clip.regionId, 0, clipDurSec, peakWidth, -1)
                  if (!cancelled && fallback?.ready && fallback.peaks?.length > 0) {
                    clipPeakCacheRef.current[clip.id] = {
                      peaks: fallback.peaks, stride: 3, peakWidth,
                      pitchOffset:      clip.pitchOffset ?? 0,
                      pitchOffsetCents: clip.pitchOffsetCents ?? 0,
                      reversed:         !!clip.reversed,
                      stretchRatio:     clip.stretchRatio ?? 1.0,
                    }
                    canvasRef.current?.redrawContent('waveform')
                  }
                } catch (fe) {
                  console.warn(`[Timeline] Fallback region peaks failed for clip ${clip.id}:`, fe.message)
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[Timeline] Clip peak fetch failed for clip ${clip.id}:`, e.message)
        }
      }
    }

    fetchClipPeaks()
    return () => { cancelled = true }
  }, [clips])

  // ── Waveform cache invalidation (e.g. after swap/revert audio) ─────────────
  useEffect(() => {
    const handler = (e) => {
      const regionId = e.detail?.regionId
      if (regionId == null) return
      delete waveformCacheRef.current[regionId]
      delete hiResCacheRef.current[regionId]
      const lru = waveformLruRef.current
      const lruIdx = lru.indexOf(regionId)
      if (lruIdx !== -1) lru.splice(lruIdx, 1)
      // Drop the JS-side "already loaded" flag so rebuildAudioMappings re-runs
      // for this region and picks up the new swapped/original audio.
      loadedRegionAudioRef.current.delete(regionId)
      // Force waveform + audio remap effects to re-run by refetching regions.
      fetchRegions()
    }
    timelineEvents.addEventListener('timeline-waveform-invalidate', handler)
    return () => timelineEvents.removeEventListener('timeline-waveform-invalidate', handler)
  }, [fetchRegions])

  // ── Viewport-aware hi-res waveform fetch (for waveform-line & sample regimes) ─
  // Runs on scroll/zoom changes. Computes which clips are visible, determines the
  // zoom regime, and fetches viewport-appropriate data.  The visible time window
  // shrinks as zoom increases, keeping data volume bounded by viewport pixel width.
  useEffect(() => {
    // Gate: only relevant at zoom levels beyond envelope mode
    const ppb = pixelsPerBeatRef.current
    const bpm = bpmRef.current || 120
    const DEFAULT_SR = 48000
    const pixelsPerSecond = ppb * (bpm / 60)
    const spp = DEFAULT_SR / pixelsPerSecond
    const regime = getRegime(spp)

    if (regime === 'envelope') {
      // Clear any stale hi-res data when zoomed back out
      if (Object.keys(hiResCacheRef.current).length > 0) {
        hiResCacheRef.current = {}
      }
      return
    }

    // Debounce: only fetch after scroll/zoom settles (80ms)
    if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    hiResFetchTimer.current = setTimeout(async () => {
      const scroll = scrollOffsetRef.current
      const w = canvasWidth || 800

      for (const clip of clips) {
        const region = regions[clip.regionId]
        if (!region) continue
        const regionDurSec = Math.abs((region.endTime ?? 0) - (region.startTime ?? 0))
        if (regionDurSec <= 0) continue

        const beatPos = clip.positionTicks / PPQ
        const beatDur = clip.durationTicks / PPQ
        const x = (beatPos - scroll) * ppb
        const clipW = beatDur * ppb

        // Skip off-screen clips
        if (x + clipW < 0 || x > w) continue

        // Visible pixel range (clip ∩ viewport)
        const visL = Math.max(0, x)
        const visR = Math.min(w, x + clipW)
        if (visR <= visL) continue

        const clipDurSec = (clip.durationTicks / PPQ) / (bpm / 60)
        const regionOffsetSec = ((clip.regionOffsetTicks ?? 0) / PPQ) / (bpm / 60)
        const secPerPx = clipDurSec / clipW
        const visStartSec = regionOffsetSec + (visL - x) * secPerPx
        const visEndSec   = regionOffsetSec + (visR - x) * secPerPx
        const visPxWidth  = Math.ceil(visR - visL)
        const sr = regionSampleRates.current[clip.regionId] || DEFAULT_SR

        const hasProcessing = (clip.pitchOffset ?? 0) !== 0
                           || (clip.pitchOffsetCents ?? 0) !== 0
                           || clip.reversed
                           || ((clip.stretchRatio ?? 1.0) !== 1.0)

        if (hasProcessing && regime !== 'sample') {
          // Processed clip: use clip-local time coords (0 = start of processed buffer).
          // Keyed by "c"+clipId so multiple clips on the same region don't collide.
          const clipLocalStart = (visL - x) * secPerPx   // 0..clipDurSec
          const clipLocalEnd   = (visR - x) * secPerPx
          const hiResKey = `c${clip.id}`
          const cachedClip = hiResCacheRef.current[hiResKey]
          if (cachedClip?.peaks &&
              cachedClip.startSec <= clipLocalStart + 0.001 &&
              cachedClip.endSec   >= clipLocalEnd   - 0.001) continue

          try {
            const data = await window.xleth?.waveform?.getClipPeaks(
              clip.id, clipLocalStart, clipLocalEnd, visPxWidth)
            if (data?.ready && data.peaks?.length > 0) {
              hiResCacheRef.current[hiResKey] = {
                peaks: data.peaks,
                stride: 3,
                startSec: clipLocalStart,
                endSec:   clipLocalEnd,
              }
            }
          } catch (e) {
            console.warn(`[Timeline] Hi-res clip peak fetch failed for clip ${clip.id}:`, e.message)
          }
          continue
        }

        // Unprocessed clip (or sample regime): use existing region-based logic.
        // Check if existing cache entry already covers this window
        const cached = hiResCacheRef.current[clip.regionId]
        if (cached && cached.startSec <= visStartSec + 0.001 && cached.endSec >= visEndSec - 0.001) {
          if (regime === 'sample' && cached.samples) continue
          if ((regime === 'trace' || regime === 'waveform') && cached.peaks) continue
        }

        try {
          if (regime === 'sample') {
            // Request raw samples for the visible window
            const startSample = Math.floor(visStartSec * sr)
            const endSample   = Math.ceil(visEndSec * sr)
            const data = await window.xleth?.waveform?.getRawSamples(
              clip.regionId, startSample, endSample, -1)
            if (data?.samples?.length > 0) {
              hiResCacheRef.current[clip.regionId] = {
                samples: data.samples,
                startSample,
                endSample,
                startSec: visStartSec,
                endSec: visEndSec,
                sampleRate: data.sampleRate || sr,
              }
            }
          } else {
            // Waveform mode: request hi-res peaks for the visible window
            const data = await window.xleth?.waveform?.getRegionPeaks(
              clip.regionId, visStartSec, visEndSec, visPxWidth, -1)
            if (data?.ready && data.peaks?.length > 0) {
              hiResCacheRef.current[clip.regionId] = {
                peaks: data.peaks,
                stride: 3,
                startSec: visStartSec,
                endSec: visEndSec,
                sampleRate: data.sampleRate || sr,
              }
            }
          }
        } catch (e) {
          console.warn(`[Timeline] Hi-res fetch failed for region ${clip.regionId}:`, e.message)
        }
      }
      // Trigger redraw with the new hi-res data
      canvasRef.current?.redrawContent('hires-waveform')
    }, 80)

    return () => {
      if (hiResFetchTimer.current) clearTimeout(hiResFetchTimer.current)
    }
  }, [pixelsPerBeat, scrollOffset, clips, regions, canvasWidth])

  // ── Transport polling (control state only — position comes from PlayheadClock)

  useEffect(() => subscribe((s) => {
    bpmRef.current = s.bpm

    if (s.isPlaying !== isPlayingRef.current) {
      isPlayingRef.current = s.isPlaying
      setIsPlaying(s.isPlaying)
      if (!s.isPlaying) {
        // Final position at engine-reported stopped position
        const stopBeat = s.positionMs * s.bpm / 60000
        playheadBeatRef.current = stopBeat
        editCursor.setPosition(stopBeat)
        canvasRef.current?.positionPlayhead(stopBeat)
        rulerRef.current?.redrawOverlay()
      }
    }
  }), [])

  // ── PlayheadClock 60fps auto-scroll ─────────────────────────────────────────
  // Playhead drawing is handled by TimelineCanvas and TimelineRuler directly.

  // During playback, editCursor follows the playback position (10fps, no re-renders).
  // When stopped, editCursor is authoritative and won't be overwritten.
  useEffect(() => {
    return playheadClock.onDisplayUpdate((posMs, bpm) => {
      if (!isPlayingRef.current) return
      editCursor.setPosition((posMs / 1000) * (bpm / 60))
    })
  }, [])

  useEffect(() => {
    const unsub = playheadClock.onFrame((posMs) => {
      playheadBeatRef.current = posMs * bpmRef.current / 60000

      // Auto-scroll only during playback and only when user isn't manually scrolling
      if (!isPlayingRef.current || userScrollingRef.current) return
      const el = canvasAreaRef.current
      if (el) {
        const w = el.getBoundingClientRect().width
        ensureVisible(playheadBeatRef.current, w, pixelsPerBeatRef.current)
      }
    })
    return unsub
  }, [ensureVisible])

  // ── Redraw grid/ruler when zoom or scroll changes (via state) ──────────────

  useEffect(() => {
    canvasRef.current?.redrawGrid('zoom')
    canvasRef.current?.redrawContent('zoom')
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
    rulerRef.current?.redrawOverlay()

    const barsVisible = (canvasAreaRef.current?.getBoundingClientRect().width || 800) / pixelsPerBeat / BEATS_PER_BAR
    console.log(`[Timeline] Zoom: ${pixelsPerBeat.toFixed(1)}px/beat, ~${barsVisible.toFixed(1)} bars visible`)
  }, [pixelsPerBeat])

  useEffect(() => {
    canvasRef.current?.redrawGrid('scroll')
    canvasRef.current?.redrawContent('scroll')
    rulerRef.current?.redraw()
    canvasRef.current?.positionPlayhead(playheadBeatRef.current)
    rulerRef.current?.redrawOverlay()
  }, [scrollOffset])

  // ── Redraw content layer when clips/regions/selection change ───────────────

  useEffect(() => {
    canvasRef.current?.redrawContent('clips')
  }, [clips, regions, tracks])

  // Grid needs a redraw when tracks/regions change because Pattern-track rows
  // get a tint based on the assigned region's label color.
  useEffect(() => {
    canvasRef.current?.redrawGrid('tracks-or-regions')
  }, [tracks, regions])

  useEffect(() => {
    canvasRef.current?.redrawContent('pattern-blocks')
  }, [patternBlocks, patterns])

  useEffect(() => {
    canvasRef.current?.redrawContent('selection')
  }, [selectedClipIds, selectedBlockIds])

  // ── Max scroll ─────────────────────────────────────────────────────────────

  useEffect(() => {
    setMaxScroll(DEFAULT_LENGTH_BEATS)
  }, [setMaxScroll])

  // ── Track canvas area width for scrollbar ──────────────────────────────────

  useEffect(() => {
    const el = canvasAreaRef.current
    if (!el) return
    const observer = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width)
      if (w > 0) setCanvasWidth(w)
    })
    setCanvasWidth(el.clientWidth || 800)
    observer.observe(el)
    return () => observer.disconnect()
  }, [tracks.length > 0])

  // ── Wheel handler (shared between ruler and canvas) ────────────────────────

  // Wheel on canvas/ruler = always zoom centered on cursor
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    markUserScrolling()
    const rect = canvasAreaRef.current?.getBoundingClientRect()
    if (!rect) return
    const cursorBeat = pixelToBeat(
      e.clientX - rect.left,
      scrollOffsetRef.current,
      pixelsPerBeatRef.current
    )
    zoomAtCursor(e.deltaY, cursorBeat, scrollOffsetRef, applyScroll)
  }, [zoomAtCursor, scrollOffsetRef, applyScroll, markUserScrolling])

  // ── Track mutations ────────────────────────────────────────────────────────

  const handleAddTrack = useCallback(async () => {
    const num = nextTrackNum.current++
    const name = `Track ${num}`
    console.log(`[Timeline] Track added: ${name}`)
    if (window.xleth?.timeline?.addTrack) {
      try {
        await window.xleth.timeline.addTrack({ name })
        await fetchTracks()
        return
      } catch { /* fall through to local */ }
    }
    // Offline / no-engine fallback — add locally
    setTracks((prev) => [
      ...prev,
      { id: Date.now(), name, volume: 1, pan: 0, muted: false, solo: false },
    ])
  }, [fetchTracks])

  const handleMute = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.muted
    if (window.xleth?.timeline?.setTrackMuted) {
      try {
        await window.xleth.timeline.setTrackMuted(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, muted: next } : t))
    )
  }, [tracks, fetchTracks])

  const handleSolo = useCallback(async (id) => {
    const current = tracks.find((t) => t.id === id)
    if (!current) return
    const next = !current.solo
    if (window.xleth?.timeline?.setTrackSolo) {
      try {
        await window.xleth.timeline.setTrackSolo(id, next)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, solo: next } : t))
    )
  }, [tracks, fetchTracks])

  const handleRename = useCallback(async (id, name) => {
    // Persist to engine first so undo/redo and project save see the change.
    if (window.xleth?.timeline?.setTrackName) {
      try {
        await window.xleth.timeline.setTrackName(id, name)
      } catch (e) {
        console.warn('[Timeline] setTrackName failed', e)
      }
    }
    setTracks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, name } : t))
    )
    console.log(`[Timeline] Track ${id} renamed to "${name}"`)
  }, [])

  const handlePatternRename = useCallback(async (id, name) => {
    if (window.xleth?.timeline?.setPatternName) {
      try {
        await window.xleth.timeline.setPatternName(id, name)
      } catch (e) {
        console.warn('[Timeline] setPatternName failed', e)
      }
    }
    setPatterns((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], name } } : prev))
    // Notify other views (App.jsx keeps its own pattern cache for the Piano
    // Roll title/dropdown).
    timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    console.log(`[Timeline] Pattern ${id} renamed to "${name}"`)
  }, [])

  const handleRemove = useCallback(async (id) => {
    console.log(`[Timeline] Track ${id} removed`)
    if (window.xleth?.timeline?.removeTrack) {
      try {
        await window.xleth.timeline.removeTrack(id)
        await fetchTracks()
        return
      } catch { /* fall through */ }
    }
    setTracks((prev) => prev.filter((t) => t.id !== id))
  }, [fetchTracks])

  const handleReorder = useCallback((fromIndex, toIndex) => {
    setTracks((prev) => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  // ── Pattern-track conversion helpers ───────────────────────────────────────

  // Auto-generate the next unique pattern name (flat global numbering —
  // pattern tracks are sample-agnostic, so names are scoped to the project).
  // The regionId argument is retained for call-site symmetry but unused.
  const nextPatternName = useCallback((_regionId) => {
    const used = new Set(Object.values(patterns).map(p => p.name))
    let n = 1
    while (used.has(`Pattern ${n}`)) n++
    return `Pattern ${n}`
  }, [patterns])

  // Core: convert a Clip track → Pattern track (sample-agnostic container).
  // Deletes existing clips, then flips the track type. Caller is responsible
  // for the confirmation UI when the track has clips.
  const performConvertToPatternTrack = useCallback(async (trackId) => {
    try {
      // Delete existing clips on that track
      const existing = clipsRef.current.filter(c => c.trackId === trackId)
      for (const c of existing) {
        await window.xleth?.timeline?.removeClip(c.id)
      }
      // Convert track (no region binding — pattern tracks are sample-agnostic)
      await window.xleth?.timeline?.convertToPatternTrack(trackId)
      console.log(`[Timeline] Converted track ${trackId} → Pattern`)
      // Notify all listeners
      await fetchTracks()
      await fetchClips()
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      return true
    } catch (err) {
      console.error('[Timeline] convertToPatternTrack failed:', err)
      return false
    }
  }, [fetchTracks, fetchClips])

  // Wrap convert with a confirmation dialog when the track has clips
  const confirmAndConvertToPatternTrack = useCallback((track) => {
    return new Promise((resolve) => {
      const clipCount = clipsRef.current.filter(c => c.trackId === track.id).length
      if (clipCount === 0) {
        performConvertToPatternTrack(track.id).then((ok) => resolve(ok))
        return
      }
      setConfirmDialog({
        title: 'Convert to Pattern Track?',
        message: (
          <>
            Convert <strong>"{track.name}"</strong> to a Pattern Track?
            <br />
            This will delete <strong>{clipCount} clip{clipCount !== 1 ? 's' : ''}</strong> on this track.
          </>
        ),
        confirmLabel: 'Convert',
        onConfirm: async () => {
          setConfirmDialog(null)
          const ok = await performConvertToPatternTrack(track.id)
          resolve(ok)
        },
        onCancel: () => { setConfirmDialog(null); resolve(false) },
      })
    })
  }, [performConvertToPatternTrack])

  const handleConvertToClipTrack = useCallback(async (trackId) => {
    try {
      await window.xleth?.timeline?.convertToClipTrack(trackId)
      console.log(`[Timeline] Converted track ${trackId} → Clip`)
      setCurrentPatternIdByTrack(prev => {
        const next = { ...prev }
        delete next[trackId]
        return next
      })
      await fetchTracks()
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
    } catch (err) {
      console.error('[Timeline] convertToClipTrack failed:', err)
    }
  }, [setCurrentPatternIdByTrack, fetchTracks])

  const handleNewPatternForTrack = useCallback(async (trackId) => {
    const track = tracks.find(t => t.id === trackId)
    if (!track || track.type !== 'Pattern') return
    // Seed the new pattern's regionId:
    // 1) the sample highlighted in the Sample Selector, or
    // 2) the track's currently-active pattern, or
    // 3) the first Pitch region.
    let seedRegionId = -1
    if (activeSampleId != null && regions[activeSampleId]) {
      seedRegionId = activeSampleId
    }
    if (seedRegionId < 0) {
      const currentPatId = currentPatternIdByTrack?.[trackId]
      if (currentPatId != null && currentPatId >= 0) {
        seedRegionId = patterns[currentPatId]?.regionId ?? -1
      }
    }
    if (seedRegionId < 0) {
      const firstPitch = Object.values(regions).find(r => r.label === 'Pitch')
      if (firstPitch) seedRegionId = firstPitch.id
    }
    if (seedRegionId < 0) {
      console.warn('[Timeline] No Pitch region available — cannot create new pattern')
      return
    }
    const name = nextPatternName(seedRegionId)
    try {
      const patternId = await window.xleth?.timeline?.addPattern({
        name,
        regionId: seedRegionId,
        lengthTicks: PPQ * 4,
      })
      if (patternId != null && patternId >= 0) {
        setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
      }
      await fetchPatterns()
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
      console.log(`[Timeline] New pattern "${name}" (id=${patternId}) created for track ${trackId}`)
    } catch (err) {
      console.error('[Timeline] addPattern failed:', err)
    }
  }, [tracks, patterns, regions, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack, fetchPatterns, activeSampleId])

  const handleSelectPatternForTrack = useCallback((trackId, patternId) => {
    setCurrentPatternIdByTrack(prev => ({ ...prev, [trackId]: patternId }))
    console.log(`[Timeline] Track ${trackId} current pattern → ${patternId}`)
  }, [setCurrentPatternIdByTrack])

  const handleSetVideoFlipMode = useCallback(async (trackId, mode) => {
    try {
      await window.xleth?.timeline?.setVideoFlipMode(trackId, mode)
      await fetchTracks()
      console.log(`[Timeline] Track ${trackId} videoFlipMode → ${mode}`)
    } catch (err) {
      console.error('[Timeline] setVideoFlipMode failed:', err)
    }
  }, [fetchTracks])

  const handleSetVideoHoldLastFrame = useCallback(async (trackId, hold) => {
    try {
      await window.xleth?.timeline?.setVideoHoldLastFrame(trackId, hold)
      await fetchTracks()
      console.log(`[Timeline] Track ${trackId} videoHoldLastFrame → ${hold}`)
    } catch (err) {
      console.error('[Timeline] setVideoHoldLastFrame failed:', err)
    }
  }, [fetchTracks])

  const handleRequestTrackContextMenu = useCallback((track, x, y) => {
    setTrackMenu({ track, x, y })
  }, [])

  const buildTrackMenuItems = useCallback((track) => {
    if (!track) return []
    const items = []

    if (track.type === 'Pattern') {
      const allPatterns = Object.values(patterns).sort((a, b) => a.id - b.id)
      const currentPatId = currentPatternIdByTrack?.[track.id]
      items.push({
        label: 'New Pattern',
        onClick: () => handleNewPatternForTrack(track.id),
      })
      items.push({
        label: 'Select Pattern',
        disabled: allPatterns.length === 0,
        submenu: allPatterns.map(p => ({
          label: p.name || `Pattern ${p.id}`,
          checked: p.id === currentPatId,
          onClick: () => handleSelectPatternForTrack(track.id, p.id),
        })),
      })
      items.push({ type: 'separator' })
      items.push({
        label: 'Convert to Clip Track',
        onClick: () => handleConvertToClipTrack(track.id),
      })
    } else {
      // Clip track → convert to sample-agnostic Pattern track
      items.push({
        label: 'Convert to Pattern Track',
        onClick: () => confirmAndConvertToPatternTrack(track),
      })
    }

    // Video Flip applies to all track types — pattern-note counter and
    // clip counter both feed ev.globalNoteIndex in the native bridge.
    const currentFlip = track.videoFlipMode || 'None'
    items.push({
      label: 'Video Flip',
      submenu: [
        { label: 'None',              checked: currentFlip === 'None',             onClick: () => handleSetVideoFlipMode(track.id, 'None') },
        { label: 'Horizontal (Even)', checked: currentFlip === 'HorizontalEven',   onClick: () => handleSetVideoFlipMode(track.id, 'HorizontalEven') },
        { label: 'Clockwise',         checked: currentFlip === 'Clockwise',        onClick: () => handleSetVideoFlipMode(track.id, 'Clockwise') },
        { label: 'Counter-Clockwise', checked: currentFlip === 'CounterClockwise', onClick: () => handleSetVideoFlipMode(track.id, 'CounterClockwise') },
      ],
    })

    const currentHold = track.videoHoldLastFrame || false
    items.push({
      label: 'Hold Last Frame',
      checked: currentHold,
      onClick: () => handleSetVideoHoldLastFrame(track.id, !currentHold),
    })

    items.push({ type: 'separator' })
    items.push({
      label: 'Delete Track',
      danger: true,
      onClick: () => handleRemove(track.id),
    })
    return items
  }, [patterns, currentPatternIdByTrack, handleNewPatternForTrack, handleSelectPatternForTrack, handleSetVideoFlipMode, handleSetVideoHoldLastFrame, handleConvertToClipTrack, confirmAndConvertToPatternTrack, handleRemove])

  // ── Seek via ruler ─────────────────────────────────────────────────────────

  const handleSeek = useCallback((beat) => {
    editCursor.setPosition(beat)
    const posMs = beat * 60000 / bpmRef.current
    playheadClock.syncFromEngine(posMs, bpmRef.current, isPlayingRef.current)
    playheadBeatRef.current = beat
    canvasRef.current?.positionPlayhead(beat)
    rulerRef.current?.redrawOverlay()
    window.xleth?.transport?.seek(beat)  // fire-and-forget
  }, [])

  // ── Mutation callbacks (passed to tools via canvas) ────────────────────────

  const handleCreateClip = useCallback(async (trackId, regionId, positionTicks, durationTicks, opts = {}) => {
    const { regionOffsetTicks = 0, velocity = 1.0, pitchOffset = 0, syllableIndex = -1 } = opts
    console.log(`[PencilTool] Creating clip: region=${regionId}, track=${trackId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const clipId = await window.xleth?.timeline?.addClip({
        trackId, regionId, positionTicks, durationTicks,
        regionOffsetTicks, velocity, pitchOffset, syllableIndex,
      })
      console.log(`[PencilTool] Clip created: id=${clipId}`)
      await fetchClips()
    } catch (err) {
      console.error('[PencilTool] addClip failed:', err)
    }
  }, [fetchClips])

  const handleDeleteClip = useCallback(async (clipId) => {
    console.log(`[DeleteTool] Deleting clip ${clipId}`)
    try {
      await window.xleth?.timeline?.removeClip(clipId)
      setSelectedClipIds((prev) => {
        const next = new Set(prev)
        next.delete(clipId)
        return next
      })
      await fetchClips()
    } catch (err) {
      console.error(`[DeleteTool] removeClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleMoveClip = useCallback(async (clipId, newTrackId, newPositionTicks) => {
    console.log(`[SelectTool] Moving clip ${clipId}: track=${newTrackId}, pos=${newPositionTicks}t`)
    try {
      await window.xleth?.timeline?.moveClip(clipId, newTrackId, newPositionTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] moveClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleResizeClip = useCallback(async (clipId, newDurationTicks) => {
    console.log(`[SelectTool] Resizing clip ${clipId}: dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.resizeClip(clipId, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] resizeClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleSplitClip = useCallback(async (clipId, leftDuration, rightDuration) => {
    const clip = clipsRef.current.find((c) => c.id === clipId)
    if (!clip) return
    console.log(`[SplitTool] Splitting clip ${clipId}: left=${leftDuration}t, right=${rightDuration}t`)
    try {
      const originalOffset = clip.regionOffsetTicks ?? 0

      await window.xleth?.timeline?.removeClip(clipId)
      await window.xleth?.timeline?.addClip({
        trackId: clip.trackId, regionId: clip.regionId,
        positionTicks: clip.positionTicks, durationTicks: leftDuration,
        regionOffsetTicks: originalOffset,
        syllableIndex: clip.syllableIndex ?? -1,
        velocity: clip.velocity ?? 1.0,
        pitchOffset: clip.pitchOffset ?? 0,
        pitchOffsetCents: clip.pitchOffsetCents ?? 0,
        reversed: clip.reversed ?? false,
        stretchRatio: clip.stretchRatio ?? 1.0,
        stretchMethod: clip.stretchMethod ?? 0,
        formantPreserve: clip.formantPreserve ?? false,
        fadeInTicks:  clip.fadeInTicks  ?? 0,
        fadeOutTicks: clip.fadeOutTicks ?? 0,
        fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
        fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
        fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
        fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
      })
      await window.xleth?.timeline?.addClip({
        trackId: clip.trackId, regionId: clip.regionId,
        positionTicks: clip.positionTicks + leftDuration, durationTicks: rightDuration,
        regionOffsetTicks: originalOffset + leftDuration,
        syllableIndex: clip.syllableIndex ?? -1,
        velocity: clip.velocity ?? 1.0,
        pitchOffset: clip.pitchOffset ?? 0,
        pitchOffsetCents: clip.pitchOffsetCents ?? 0,
        reversed: clip.reversed ?? false,
        stretchRatio: clip.stretchRatio ?? 1.0,
        stretchMethod: clip.stretchMethod ?? 0,
        formantPreserve: clip.formantPreserve ?? false,
        fadeInTicks:  clip.fadeInTicks  ?? 0,
        fadeOutTicks: clip.fadeOutTicks ?? 0,
        fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
        fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
        fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
        fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
      })
      lastSplitUndoCountRef.current = 3
      setSelectedClipIds(new Set())
      await fetchClips()
      console.log(`[SplitTool] Split complete`)
    } catch (err) {
      console.error(`[SplitTool] split failed:`, err)
    }
  }, [fetchClips])

  // ── Pattern Block mutations (used by tools) ────────────────────────────────

  const handleCreatePatternBlock = useCallback(async (trackId, patternId, positionTicks, durationTicks, offsetTicks = 0) => {
    console.log(`[PencilTool] Creating pattern block: track=${trackId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
    try {
      const blockId = await window.xleth?.timeline?.addPatternBlock({
        trackId, patternId, positionTicks, durationTicks, offsetTicks,
      })
      console.log(`[PencilTool] Pattern block created: id=${blockId}`)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[PencilTool] addPatternBlock failed:', err)
    }
  }, [])

  const handleMovePatternBlock = useCallback(async (blockId, trackId, positionTicks) => {
    console.log(`[SelectTool] Moving pattern block ${blockId}: track=${trackId}, pos=${positionTicks}t`)
    try {
      await window.xleth?.timeline?.movePatternBlock(blockId, trackId, positionTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] movePatternBlock failed:', err)
    }
  }, [])

  const handleResizePatternBlock = useCallback(async (blockId, durationTicks) => {
    console.log(`[SelectTool] Resizing pattern block ${blockId}: dur=${durationTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlock(blockId, durationTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlock failed:', err)
    }
  }, [])

  const handleResizePatternBlockLeft = useCallback(async (blockId, positionTicks, durationTicks, offsetTicks) => {
    console.log(`[SelectTool] Left-resizing pattern block ${blockId}: pos=${positionTicks}t, dur=${durationTicks}t, offset=${offsetTicks}t`)
    try {
      await window.xleth?.timeline?.resizePatternBlockLeft(blockId, positionTicks, durationTicks, offsetTicks)
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SelectTool] resizePatternBlockLeft failed:', err)
    }
  }, [])

  const handleDeletePatternBlock = useCallback(async (blockId) => {
    console.log(`[DeleteTool] Deleting pattern block ${blockId}`)
    try {
      await window.xleth?.timeline?.removePatternBlock(blockId)
      setSelectedBlockIds(prev => {
        const next = new Set(prev)
        next.delete(blockId)
        return next
      })
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[DeleteTool] removePatternBlock failed:', err)
    }
  }, [])

  const handleSplitPatternBlock = useCallback(async (blockId, splitPositionTicks) => {
    const block = patternBlocks.find(b => b.id === blockId)
    if (!block) return
    const pattern = patterns[block.patternId]
    const patLen = pattern?.lengthTicks || (PPQ * 4)
    const leftDur = splitPositionTicks - block.positionTicks
    const rightDur = block.durationTicks - leftDur
    if (leftDur <= 0 || rightDur <= 0) return
    const baseOffset = block.offsetTicks || 0
    const splitOffsetInPattern = (baseOffset + leftDur) % patLen
    console.log(`[SplitTool] Splitting block ${blockId}: leftDur=${leftDur}, rightDur=${rightDur}, secondOffset=${splitOffsetInPattern}`)
    try {
      // Resize first half
      await window.xleth?.timeline?.resizePatternBlock(blockId, leftDur)
      // Create second half
      await window.xleth?.timeline?.addPatternBlock({
        trackId: block.trackId,
        patternId: block.patternId,
        positionTicks: splitPositionTicks,
        durationTicks: rightDur,
        offsetTicks: splitOffsetInPattern,
      })
      timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
    } catch (err) {
      console.error('[SplitTool] splitPatternBlock failed:', err)
    }
  }, [patternBlocks, patterns])

  const handleResizeClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks, newRegionOffset) => {
    console.log(`[SelectTool] Left-resize clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t, offset=${newRegionOffset}t`)
    try {
      await window.xleth?.timeline?.resizeClipLeft(clipId, newPositionTicks, newDurationTicks, newRegionOffset)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] resizeClipLeft(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleStretchClip = useCallback(async (clipId, newDurationTicks) => {
    console.log(`[SelectTool] Stretching clip ${clipId}: dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.stretchClip(clipId, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] stretchClip(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  const handleStretchClipLeft = useCallback(async (clipId, newPositionTicks, newDurationTicks) => {
    console.log(`[SelectTool] Left-stretch clip ${clipId}: pos=${newPositionTicks}t, dur=${newDurationTicks}t`)
    try {
      await window.xleth?.timeline?.stretchClipLeft(clipId, newPositionTicks, newDurationTicks)
      await fetchClips()
    } catch (err) {
      console.error(`[SelectTool] stretchClipLeft(${clipId}) failed:`, err)
    }
  }, [fetchClips])

  // ── Drag-over (preview while dragging sample onto timeline) ────────────────

  const handleCanvasDragOver = useCallback((localX, localY, e) => {
    const types = e.dataTransfer.types
    const isSample  = types.includes('application/xleth-sample')
    const isSource  = types.includes('application/xleth-source')
    const isPattern = types.includes('application/xleth-pattern')
    if (!isSample && !isSource && !isPattern) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'

    const trackIndex = Math.floor(localY / TRACK_HEIGHT)
    if (trackIndex < 0 || trackIndex >= tracks.length) {
      dropPreviewRef.current = null
      canvasRef.current?.redrawOverlay()
      return
    }

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)

    // Read drag payload from global (can't read dataTransfer during dragover)
    const dragData = isPattern
      ? window.__xlethDragPattern
      : isSource
        ? window.__xlethDragSource
        : window.__xlethDragSample
    if (!dragData) return

    let durationBeats
    let color
    let name
    if (isPattern) {
      durationBeats = (dragData.lengthTicks || PPQ * 4) / PPQ
      const region  = regions[dragData.regionId]
      color = region ? labelHexColor(region.label || 'Custom') : '#6aa9ff'
      name  = dragData.name
    } else if (isSource) {
      durationBeats = (dragData.duration || 0) * (bpmRef.current / 60)
      color = labelHexColor('Custom')
      name  = dragData.fileName
    } else {
      durationBeats = Math.abs(dragData.endTime - dragData.startTime) * (bpmRef.current / 60)
      color = labelHexColor(dragData.label)
      name  = dragData.name
    }

    const snapLabel = modifiers.shift ? 'free' : modifiers.alt ? '32nd' : '16th'
    console.log(`[TimelineClips] Drop preview: beat=${snappedBeat.toFixed(2)}, track=${trackIndex}, snap=${snapLabel}`)

    dropPreviewRef.current = {
      beat: snappedBeat,
      trackIndex,
      durationBeats,
      color,
      name,
    }
    canvasRef.current?.redrawOverlay()
  }, [tracks, regions])

  // ── Drop (create clip from dropped sample) ─────────────────────────────────

  const handleCanvasDrop = useCallback(async (localX, localY, e) => {
    e.preventDefault()
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()

    const sourceRaw  = e.dataTransfer.getData('application/xleth-source')
    const sampleRaw  = e.dataTransfer.getData('application/xleth-sample')
    const patternRaw = e.dataTransfer.getData('application/xleth-pattern')
    if (!sourceRaw && !sampleRaw && !patternRaw) return

    const beat = pixelToBeat(localX, scrollOffsetRef.current, pixelsPerBeatRef.current)
    const trackIndex = Math.floor(localY / TRACK_HEIGHT)

    if (trackIndex < 0 || trackIndex >= tracks.length) {
      console.warn('[TimelineClips] WARNING: drop outside track area')
      return
    }

    const modifiers = { alt: e.altKey, shift: e.shiftKey }
    const snappedBeat = snapBeatToGrid(Math.max(0, beat), modifiers, snapGranularity)
    const track = tracks[trackIndex]
    const positionTicks = beatsToTicks(snappedBeat)

    // ── Pattern drop: create PatternBlock on Pattern-type track ─────────────
    // Pattern tracks are sample-agnostic — any pattern is accepted on any
    // pattern track. The block's pattern carries its own regionId.
    if (patternRaw) {
      let pd
      try { pd = JSON.parse(patternRaw) } catch { return }
      if (track.type !== 'Pattern') {
        console.warn(`[TimelineClips] Pattern drop rejected: track "${track.name}" is not a Pattern track`)
        return
      }
      const durationTicks = pd.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: track.id,
          patternId: pd.patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created via drag: id=${blockId}, pattern=${pd.patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock (drag) failed:', err)
      }
      return
    }

    // ── Source drop: create region + clip spanning the full source ──────────
    if (sourceRaw) {
      let src
      try { src = JSON.parse(sourceRaw) } catch { return }
      const durationTicks = regionDurationToTicks(0, src.duration || 0, bpmRef.current)
      console.log(`[TimelineClips] Source drop: "${src.fileName}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)
      try {
        const regionId = await window.xleth?.timeline?.addRegion({
          sourceId:  src.sourceId,
          startTime: 0,
          endTime:   src.duration || 0,
          label:     'Custom',
          name:      src.fileName,
        })
        if (typeof regionId !== 'number' || regionId < 0) {
          console.warn('[TimelineClips] addRegion returned invalid id:', regionId)
          return
        }
        const clipId = await window.xleth?.timeline?.addClip({
          trackId: track.id,
          regionId,
          positionTicks,
          durationTicks,
          velocity: 1.0,
        })
        console.log(`[TimelineClips] Source clip created: region=${regionId} clip=${clipId}`)
        // rebuildAudioMappings() picks up the new region and loads it into SampleBank.
        timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
        await fetchClips()
      } catch (err) {
        console.error('[TimelineClips] source drop failed:', err)
      }
      return
    }

    // ── Sample drop (existing behavior) ─────────────────────────────────────
    let data
    try { data = JSON.parse(sampleRaw) } catch { return }

    // ── Pitch sample → PatternBlock on Pattern track ───────────────────────
    if (data.label === 'Pitch') {
      let currentTrack = track
      // If track is a Clip track, offer to convert it.
      if (currentTrack.type !== 'Pattern') {
        const ok = await confirmAndConvertToPatternTrack(currentTrack)
        if (!ok) return  // user cancelled or failed
        currentTrack = { ...currentTrack, type: 'Pattern' }
      }

      // Find or create a pattern matching the dropped sample's region.
      // Priority: (1) current pattern for this track if regionId matches,
      // (2) any existing pattern with that regionId, (3) create new.
      let patternId = -1
      const currentPatId = currentPatternIdByTrack?.[currentTrack.id]
      if (currentPatId != null && currentPatId >= 0) {
        const p = patterns[currentPatId]
        if (p && p.regionId === data.regionId) patternId = currentPatId
      }
      if (patternId < 0) {
        const match = Object.values(patterns).find(p => p.regionId === data.regionId)
        if (match) patternId = match.id
      }
      if (patternId < 0) {
        const name = nextPatternName(data.regionId)
        try {
          const newId = await window.xleth?.timeline?.addPattern({
            name,
            regionId: data.regionId,
            lengthTicks: PPQ * 4,
          })
          if (newId != null && newId >= 0) {
            patternId = newId
            await fetchPatterns()
            timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'))
          }
        } catch (err) {
          console.error('[TimelineClips] addPattern failed:', err)
          return
        }
      }
      if (patternId < 0) {
        console.warn('[TimelineClips] No pattern available for block creation')
        return
      }
      setCurrentPatternIdByTrack(prev => ({ ...prev, [currentTrack.id]: patternId }))

      // Create a PatternBlock at drop position — duration = one pattern loop
      const pattern = patterns[patternId]
      const durationTicks = pattern?.lengthTicks || (PPQ * 4)
      try {
        const blockId = await window.xleth?.timeline?.addPatternBlock({
          trackId: currentTrack.id,
          patternId,
          positionTicks,
          durationTicks,
          offsetTicks: 0,
        })
        console.log(`[TimelineClips] PatternBlock created: id=${blockId}, pattern=${patternId}, pos=${positionTicks}t, dur=${durationTicks}t`)
        timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
      } catch (err) {
        console.error('[TimelineClips] addPatternBlock failed:', err)
      }
      return
    }

    // ── Non-pitch sample → Clip (existing behavior) ────────────────────────
    const durationTicks = regionDurationToTicks(data.startTime, data.endTime, bpmRef.current)

    console.log(`[TimelineClips] Clip created via drop: "${data.name}" on track "${track.name}" at beat ${snappedBeat.toFixed(2)} (pos=${positionTicks}t, dur=${durationTicks}t)`)

    try {
      const clipId = await window.xleth?.timeline?.addClip({
        trackId: track.id,
        regionId: data.regionId,
        positionTicks,
        durationTicks,
        velocity: 1.0,
      })
      console.log(`[TimelineClips] Clip created: id=${clipId}`)
      await fetchClips()
    } catch (err) {
      console.error('[TimelineClips] addClip failed:', err)
    }
  }, [tracks, fetchClips, fetchPatterns, patterns, currentPatternIdByTrack, nextPatternName, setCurrentPatternIdByTrack, confirmAndConvertToPatternTrack])

  // ── Drag leave (clear preview) ─────────────────────────────────────────────

  const handleCanvasDragLeave = useCallback((e) => {
    // Only clear if leaving the canvas container (not entering a child)
    if (e.currentTarget.contains(e.relatedTarget)) return
    dropPreviewRef.current = null
    canvasRef.current?.redrawOverlay()
    console.log('[TimelineClips] Drop preview cleared')
  }, [])

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────

  useEffect(() => {
    const onKeyDown = async (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      if (activeCenterTab !== 'timeline') return
      const ctrl = e.ctrlKey || e.metaKey

      // ── Undo / Redo (global, no focus gate) ───────────────────────────
      if (e.key === 'z' && ctrl && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        if (lastSplitUndoCountRef.current > 0) {
          const count = lastSplitUndoCountRef.current
          lastSplitUndoCountRef.current = 0
          for (let i = 0; i < count; i++) await window.xleth?.undo?.undo()
          console.log(`[Keyboard] Undo (split batch ×${count})`)
        } else {
          await window.xleth?.undo?.undo()
          console.log('[Keyboard] Undo')
        }
        await fetchClips()
        return
      }
      if ((e.key === 'y' && ctrl) || (e.key === 'z' && ctrl && e.shiftKey)) {
        e.preventDefault()
        e.stopPropagation()
        await window.xleth?.undo?.redo()
        await fetchClips()
        lastSplitUndoCountRef.current = 0
        console.log('[Keyboard] Redo')
        return
      }

      // ── Select all (global) ───────────────────────────────────────────
      if (e.key === 'a' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        setSelectedClipIds(new Set(clipsRef.current.map((c) => c.id)))
        console.log('[Keyboard] Select all')
        return
      }

      // ── Delete selected clips + blocks (parallel) ─────────────────────
      if (e.key === 'Delete' && (selectedClipIds.size > 0 || selectedBlockIds.size > 0)) {
        e.preventDefault()
        e.stopPropagation()
        const clipIdList = [...selectedClipIds]
        const blockIdList = [...selectedBlockIds]
        console.log(`[Keyboard] Deleting ${clipIdList.length} clip(s), ${blockIdList.length} block(s)`)
        setSelectedClipIds(new Set())
        setSelectedBlockIds(new Set())
        await Promise.all([
          ...clipIdList.map(id =>
            window.xleth?.timeline?.removeClip(id).catch(err =>
              console.error(`[Keyboard] removeClip(${id}) failed:`, err)
            )
          ),
          ...blockIdList.map(id =>
            window.xleth?.timeline?.removePatternBlock(id).catch(err =>
              console.error(`[Keyboard] removePatternBlock(${id}) failed:`, err)
            )
          ),
        ])
        if (clipIdList.length > 0) await fetchClips()
        if (blockIdList.length > 0) timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
        return
      }

      // ── Copy clips + pattern blocks (Ctrl+C) — supports multi-selection ──
      if (e.key === 'c' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        if (selectedClipIds.size > 0) {
          const selectedClips = clipsRef.current
            .filter(c => selectedClipIds.has(c.id))
            .sort((a, b) => a.positionTicks - b.positionTicks)
          if (selectedClips.length > 0) {
            const basePosition = selectedClips[0].positionTicks
            const trackOrder = tracks.map(t => t.id)
            const baseTrackIdx = trackOrder.indexOf(selectedClips[0].trackId)
            clipboardRef.current = selectedClips.map(clip => ({
              regionId: clip.regionId,
              trackId: clip.trackId,
              durationTicks: clip.durationTicks,
              regionOffsetTicks: clip.regionOffsetTicks ?? 0,
              velocity: clip.velocity ?? 1.0,
              pitchOffset: clip.pitchOffset ?? 0,
              syllableIndex: clip.syllableIndex ?? -1,
              relativePosition: clip.positionTicks - basePosition,
              relativeTrackIndex: trackOrder.indexOf(clip.trackId) - baseTrackIdx,
              // Non-fade playback modifiers (defaults match engine Clip struct)
              pitchOffsetCents: clip.pitchOffsetCents ?? 0,
              reversed: clip.reversed ?? false,
              stretchRatio: clip.stretchRatio ?? 1.0,
              stretchMethod: clip.stretchMethod ?? 0,   // 0 == StretchMethod::Global
              formantPreserve: clip.formantPreserve ?? false,
              // Fade envelope (duration + cubic-bezier control points)
              fadeInTicks:  clip.fadeInTicks  ?? 0,
              fadeOutTicks: clip.fadeOutTicks ?? 0,
              fadeInX1:  clip.fadeInX1  ?? 0,
              fadeInY1:  clip.fadeInY1  ?? 0,
              fadeInX2:  clip.fadeInX2  ?? 1,
              fadeInY2:  clip.fadeInY2  ?? 1,
              fadeOutX1: clip.fadeOutX1 ?? 0,
              fadeOutY1: clip.fadeOutY1 ?? 0,
              fadeOutX2: clip.fadeOutX2 ?? 1,
              fadeOutY2: clip.fadeOutY2 ?? 1,
            }))
            console.log(`[Keyboard] Copied ${selectedClips.length} clip(s)`)
            console.log('[ClipCopy] source clips (raw React state) =',
              JSON.stringify(selectedClips, null, 2))
            console.log('[ClipCopy] clipboardRef =',
              JSON.stringify(clipboardRef.current, null, 2))
            patternBlockClipboardRef.current = null
          }
        }
        if (selectedBlockIds.size > 0) {
          const selectedBlocks = patternBlocks
            .filter(b => selectedBlockIds.has(b.id))
            .sort((a, b) => a.positionTicks - b.positionTicks)
          if (selectedBlocks.length > 0) {
            const basePosition = selectedBlocks[0].positionTicks
            const trackOrder = tracks.map(t => t.id)
            const baseTrackIdx = trackOrder.indexOf(selectedBlocks[0].trackId)
            patternBlockClipboardRef.current = selectedBlocks.map(block => {
              const pattern = patterns[block.patternId]
              const srcRegionId = pattern?.regionId ?? -1
              const srcRegion = regions[srcRegionId]
              return {
                patternId: block.patternId,
                srcRegionId,
                srcRootNote: srcRegion?.rootNote ?? 60,
                trackId: block.trackId,
                durationTicks: block.durationTicks,
                offsetTicks: block.offsetTicks ?? 0,
                loopEnabled: block.loopEnabled ?? false,
                relativePosition: block.positionTicks - basePosition,
                relativeTrackIndex: trackOrder.indexOf(block.trackId) - baseTrackIdx,
              }
            })
            console.log(`[Keyboard] Copied ${selectedBlocks.length} pattern block(s)`)
            clipboardRef.current = null
          }
        }
        return
      }

      // ── Paste clips at edit cursor (Ctrl+V) — supports multi-clip ─────
      if (e.key === 'v' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        const cb = clipboardRef.current
        if (cb && Array.isArray(cb) && cb.length > 0) {
          // Read & snap edit cursor — instant, no IPC
          const baseBeat = snapBeatToGrid(editCursor.getPosition())
          const baseTicks = beatsToTicks(baseBeat)

          // Predict end position from clipboard geometry (pure math, no I/O)
          let predictedEndTicks = baseTicks
          for (const item of cb) {
            const end = baseTicks + item.relativePosition + item.durationTicks
            if (end > predictedEndTicks) predictedEndTicks = end
          }

          // Advance edit cursor IMMEDIATELY — spamming Ctrl+V reads fresh values
          const predictedEndBeat = predictedEndTicks / PPQ
          editCursor.setPosition(predictedEndBeat)

          // Fire-and-forget transport sync (engine follows editor, not vice versa)
          window.xleth?.transport?.seek(predictedEndBeat)
          playheadClock.syncFromEngine(predictedEndBeat * 60000 / bpmRef.current, bpmRef.current, isPlayingRef.current)
          playheadBeatRef.current = predictedEndBeat
          canvasRef.current?.positionPlayhead(predictedEndBeat)
          rulerRef.current?.redrawOverlay()

          // Now place clips (async, but cursor is already correct for next spam)
          const trackOrder = tracks.map(t => t.id)
          const baseTrackIdx = Math.max(0, trackOrder.indexOf(cb[0].trackId))
          try {
            const newIds = []
            const virtualClips = [...clipsRef.current]  // includes in-batch placements
            let pasteIdx = 0
            for (const item of cb) {
              const targetTrackIdx = Math.min(
                Math.max(0, baseTrackIdx + item.relativeTrackIndex),
                trackOrder.length - 1
              )
              const trackId = trackOrder[targetTrackIdx]
              const proposedTicks = baseTicks + item.relativePosition
              const safeTicks = findFreePosition(trackId, proposedTicks, item.durationTicks, virtualClips)
              const payload = {
                trackId,
                regionId: item.regionId,
                positionTicks: safeTicks,
                durationTicks: item.durationTicks,
                regionOffsetTicks: item.regionOffsetTicks,
                syllableIndex: item.syllableIndex,
                velocity: item.velocity,
                pitchOffset: item.pitchOffset,
                // Carry all playback modifiers from the clipboard snapshot
                pitchOffsetCents: item.pitchOffsetCents,
                reversed: item.reversed,
                stretchRatio: item.stretchRatio,
                stretchMethod: item.stretchMethod,
                formantPreserve: item.formantPreserve,
                fadeInTicks:  item.fadeInTicks,
                fadeOutTicks: item.fadeOutTicks,
                fadeInX1:  item.fadeInX1,  fadeInY1:  item.fadeInY1,
                fadeInX2:  item.fadeInX2,  fadeInY2:  item.fadeInY2,
                fadeOutX1: item.fadeOutX1, fadeOutY1: item.fadeOutY1,
                fadeOutX2: item.fadeOutX2, fadeOutY2: item.fadeOutY2,
              }
              console.log('[ClipPaste] payload for clip', pasteIdx++, '=',
                JSON.stringify(payload, null, 2))
              const newId = await window.xleth?.timeline?.addClip(payload)
              if (newId != null) {
                newIds.push(newId)
                virtualClips.push({ trackId, positionTicks: safeTicks, durationTicks: item.durationTicks })
              }
            }
            await fetchClips()
            setSelectedClipIds(new Set(newIds))
            console.log(`[Keyboard] Pasted ${cb.length} clip(s) at edit cursor (${baseTicks}t), cursor → ${predictedEndTicks}t`)
          } catch (err) {
            console.error('[Keyboard] Paste failed:', err)
          }
        }

        // ── Paste pattern blocks at edit cursor (Ctrl+V) ───────────────
        const pbcb = patternBlockClipboardRef.current
        if (pbcb && Array.isArray(pbcb) && pbcb.length > 0) {
          const baseBeat = snapBeatToGrid(editCursor.getPosition())
          const baseTicks = beatsToTicks(baseBeat)

          // Predict end position & advance cursor immediately (same pattern as clip paste)
          let predictedEndTicks = baseTicks
          for (const item of pbcb) {
            const end = baseTicks + item.relativePosition + item.durationTicks
            if (end > predictedEndTicks) predictedEndTicks = end
          }
          const predictedEndBeat = predictedEndTicks / PPQ
          editCursor.setPosition(predictedEndBeat)
          window.xleth?.transport?.seek(predictedEndBeat)
          playheadClock.syncFromEngine(predictedEndBeat * 60000 / bpmRef.current, bpmRef.current, isPlayingRef.current)
          playheadBeatRef.current = predictedEndBeat
          canvasRef.current?.positionPlayhead(predictedEndBeat)
          rulerRef.current?.redrawOverlay()

          const trackOrder = tracks.map(t => t.id)
          const baseTrackIdx = Math.max(0, trackOrder.indexOf(pbcb[0].trackId))
          try {
            const newIds = []
            for (const item of pbcb) {
              const targetTrackIdx = Math.min(
                Math.max(0, baseTrackIdx + item.relativeTrackIndex),
                trackOrder.length - 1
              )
              const destTrackId = trackOrder[targetTrackIdx]
              const destTrack = tracks.find(t => t.id === destTrackId)
              if (!destTrack) continue
              if (destTrack.type !== 'Pattern') {
                console.warn(`[Keyboard] Pattern block paste rejected: track ${destTrackId} is not a Pattern track`)
                continue
              }

              // Pattern tracks are sample-agnostic — paste the pattern verbatim.
              const blockId = await window.xleth?.timeline?.addPatternBlock({
                trackId: destTrackId,
                patternId: item.patternId,
                positionTicks: baseTicks + item.relativePosition,
                durationTicks: item.durationTicks,
                offsetTicks: item.offsetTicks,
              })
              if (blockId != null && blockId >= 0) newIds.push(blockId)
            }
            await fetchPatternBlocks()
            timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
            setSelectedBlockIds(new Set(newIds))
            console.log(`[Keyboard] Pasted ${newIds.length} pattern block(s) at ${baseTicks}t, cursor → ${predictedEndTicks}t`)
          } catch (err) {
            console.error('[Keyboard] Pattern block paste failed:', err)
          }
        }
        return
      }

      // ── Duplicate clip after source (Ctrl+D) ─────────────────────────
      if (e.key === 'd' && ctrl) {
        e.preventDefault()
        e.stopPropagation()
        if (selectedClipIds.size >= 1) {
          const clipId = [...selectedClipIds][0]
          const clip = clipsRef.current.find(c => c.id === clipId)
          if (clip) {
            const proposedTicks = clip.positionTicks + clip.durationTicks
            const newPositionTicks = findFreePosition(clip.trackId, proposedTicks, clip.durationTicks, clipsRef.current)
            try {
              const payload = {
                trackId: clip.trackId,
                regionId: clip.regionId,
                positionTicks: newPositionTicks,
                durationTicks: clip.durationTicks,
                regionOffsetTicks: clip.regionOffsetTicks ?? 0,
                syllableIndex: clip.syllableIndex ?? -1,
                velocity: clip.velocity ?? 1.0,
                pitchOffset: clip.pitchOffset ?? 0,
                pitchOffsetCents: clip.pitchOffsetCents ?? 0,
                reversed: clip.reversed ?? false,
                stretchRatio: clip.stretchRatio ?? 1.0,
                stretchMethod: clip.stretchMethod ?? 0,
                formantPreserve: clip.formantPreserve ?? false,
                fadeInTicks:  clip.fadeInTicks  ?? 0,
                fadeOutTicks: clip.fadeOutTicks ?? 0,
                fadeInX1:  clip.fadeInX1  ?? 0,  fadeInY1:  clip.fadeInY1  ?? 0,
                fadeInX2:  clip.fadeInX2  ?? 1,  fadeInY2:  clip.fadeInY2  ?? 1,
                fadeOutX1: clip.fadeOutX1 ?? 0,  fadeOutY1: clip.fadeOutY1 ?? 0,
                fadeOutX2: clip.fadeOutX2 ?? 1,  fadeOutY2: clip.fadeOutY2 ?? 1,
              }
              console.log('[ClipDuplicate] source clip (raw React state) =',
                JSON.stringify(clip, null, 2))
              console.log('[ClipDuplicate] payload =',
                JSON.stringify(payload, null, 2))
              const newId = await window.xleth?.timeline?.addClip(payload)
              await fetchClips()
              if (newId != null) setSelectedClipIds(new Set([newId]))
              // Advance playhead + editCursor to end of duplicated clip
              const dupEndBeat = (newPositionTicks + clip.durationTicks) / PPQ
              handleSeek(dupEndBeat)
              console.log(`[Keyboard] Duplicated clip ${clipId} → ${newPositionTicks}t, playhead → ${newPositionTicks + clip.durationTicks}t`)
            } catch (err) {
              console.error('[Keyboard] Duplicate failed:', err)
            }
          }
        }
        return
      }

      // ── Toggle pattern-block loop (L) ─────────────────────────────────
      if (!ctrl && (e.key === 'l' || e.key === 'L') && selectedBlockIds.size > 0) {
        e.preventDefault()
        e.stopPropagation()
        const ids = [...selectedBlockIds]
        // Determine new state from the first selected block's current loopEnabled
        // (treat undefined as true for backward compat) — toggle to the opposite,
        // then apply uniformly to all selected blocks so they stay in sync.
        const first = patternBlocks.find(b => b.id === ids[0])
        const nextEnabled = !((first?.loopEnabled ?? true))
        try {
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.setPatternBlockLoop(id, nextEnabled)
              .catch(err => console.error(`[Keyboard] setPatternBlockLoop(${id}) failed:`, err))
          ))
          await fetchPatternBlocks()
          timelineEvents.dispatchEvent(new Event('timeline-pattern-blocks-changed'))
          console.log(`[Keyboard] Toggled loop → ${nextEnabled} on ${ids.length} block(s)`)
        } catch (err) {
          console.error('[Keyboard] Loop toggle failed:', err)
        }
        return
      }

      // ── Pitch shift selected clips (+/- keys) ────────────────────────
      if ((e.key === '+' || e.key === '=' || e.key === '-' || e.key === '_') && selectedClipIds.size > 0) {
        e.preventDefault()
        e.stopPropagation()
        const direction = (e.key === '+' || e.key === '=') ? 1 : -1
        const ids = [...selectedClipIds]
        if (ctrl) {
          // Ctrl +/- = ±1 cent
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.pitchShiftClip(id, 0, direction)
              .catch(err => console.error(`[Keyboard] pitchShiftClip(${id}) failed:`, err))
          ))
          console.log(`[Keyboard] Pitch ${direction > 0 ? '+' : '-'}1 cent on ${ids.length} clip(s)`)
        } else {
          // +/- = ±1 semitone
          await Promise.all(ids.map(id =>
            window.xleth?.timeline?.pitchShiftClip(id, direction, 0)
              .catch(err => console.error(`[Keyboard] pitchShiftClip(${id}) failed:`, err))
          ))
          console.log(`[Keyboard] Pitch ${direction > 0 ? '+' : '-'}1 semitone on ${ids.length} clip(s)`)
        }
        await fetchClips()
        return
      }

      // ── Tool shortcuts (only when timeline is focused, no Ctrl) ───────
      if (!ctrl && timelineFocusedRef.current) {
        const key = e.key.toLowerCase()
        if (key === 's') { setActiveTool('select');  console.log('[Keyboard] Tool → Select');  return }
        if (key === 'p') { setActiveTool('pencil');  console.log('[Keyboard] Tool → Pencil');  return }
        if (key === 'c') { setActiveTool('split');   console.log('[Keyboard] Tool → Split');   return }
        if (key === 'd') { setActiveTool('delete');  console.log('[Keyboard] Tool → Delete');  return }

        // ── Syllable pick (1-9) when pencil + Quote with syllables is active ─
        if (activeTool === 'pencil' && /^[1-9]$/.test(e.key)) {
          const tmpl = pencilTemplateRef.current
          const regionId = tmpl ? tmpl.regionId : activeSampleId
          const region = regionId != null ? regions[regionId] : null
          if (region?.label === 'Quote' && Array.isArray(region.syllables) && region.syllables.length > 0) {
            const idx = parseInt(e.key, 10) - 1
            if (idx < region.syllables.length) {
              handleSelectSyllable(idx)
              console.log(`[Keyboard] Syllable → ${idx + 1}`)
            }
            return
          }
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectedClipIds, selectedBlockIds, fetchClips, fetchPatternBlocks, fetchPatterns, patternBlocks, patterns, tracks, handleSeek, activeTool, regions, activeSampleId, handleSelectSyllable, activeCenterTab])

  // ── Context menu ───────────────────────────────────────────────────────────

  const handleAutoTrimClip = useCallback(async (clipId) => {
    try {
      const result = await window.xleth.timeline.autoTrimClip(clipId, -54)
      console.log('[Timeline] Auto-Trim result:', result)
      if (!result?.success) {
        console.warn('[Timeline] Auto-Trim failed:', result?.reason)
        return
      }
      await fetchClips()
      window.dispatchEvent(new CustomEvent('timeline-clips-changed'))
    } catch (err) {
      console.error('[Timeline] Auto-Trim error:', err)
    }
  }, [fetchClips])

  const handlePitchShiftClip = useCallback(async (clipId, semiDelta, centsDelta = 0) => {
    try {
      await window.xleth.timeline.pitchShiftClip(clipId, semiDelta, centsDelta)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] pitchShiftClip error:', err)
    }
  }, [fetchClips])

  const handleReverseClip = useCallback(async (clipId) => {
    try {
      await window.xleth.timeline.reverseClip(clipId)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] reverseClip error:', err)
    }
  }, [fetchClips])

  const handleSetClipStretchMethod = useCallback(async (clipId, method) => {
    console.log(`[UIStretch] setClipStretchMethod: clip=${clipId} method=${method}`)
    try {
      await window.xleth.timeline.setClipParams(clipId, { stretchMethod: method })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipStretchMethod error:', err)
    }
  }, [fetchClips])

  const handleSetClipFormantPreserve = useCallback(async (clipId, enabled) => {
    console.log(`[UIStretch] setClipFormantPreserve: clip=${clipId} enabled=${enabled}`)
    try {
      await window.xleth.timeline.setClipParams(clipId, { formantPreserve: enabled })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipFormantPreserve error:', err)
    }
  }, [fetchClips])

  const handleSetClipVelocity = useCallback(async (clipId, velocity) => {
    try {
      await window.xleth.timeline.setClipParams(clipId, { velocity })
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipVelocity error:', err)
    }
  }, [fetchClips])

  const handleSetClipFade = useCallback(async (clipId, fadeParams) => {
    try {
      await window.xleth.timeline.setClipParams(clipId, fadeParams)
      await fetchClips()
    } catch (err) {
      console.error('[Timeline] setClipFade error:', err)
    }
  }, [fetchClips])

  const contextMenuClip = contextMenu?.type === 'clip'
    ? clipsRef.current.find(c => c.id === contextMenu.clipId)
    : null

  function stretchMethodName(m) {
    switch (m) {
      case 1: return 'TD-PSOLA'
      case 2: return 'Rubber Band'
      case 3: return 'WSOLA'
      case 4: return 'Phase Vocoder'
      default: return 'TD-PSOLA'
    }
  }

  const contextMenuItems = contextMenu
    ? (contextMenu.type === 'clip'
        ? [
            { label: 'Auto-Trim Silence (−54 dB)', onClick: () => handleAutoTrimClip(contextMenu.clipId) },
            { type: 'separator' },
            {
              type: 'custom', key: 'volume-slider',
              content: (
                <ClipSliderRow
                  label="Volume"
                  value={Math.round((contextMenuClip?.velocity ?? 1.0) * 100)}
                  min={0} max={200} step={1}
                  onCommit={(v) => handleSetClipVelocity(contextMenu.clipId, v / 100)}
                  formatValue={(v) => `${v}%`}
                />
              ),
            },
            {
              type: 'custom', key: 'fade-in',
              content: (
                <div>
                  <ClipSliderRow
                    label="Fade In"
                    value={contextMenuClip?.fadeInTicks ?? 0}
                    min={0} max={3840} step={60}
                    onCommit={(v) => handleSetClipFade(contextMenu.clipId, { fadeInTicks: v })}
                    formatValue={(v) => `${(v / 960).toFixed(1)}b`}
                  />
                  {(contextMenuClip?.fadeInTicks ?? 0) > 0 && (
                    <div style={{ padding: '0 8px 6px' }}>
                      <FadeBezierEditor
                        x1={contextMenuClip?.fadeInX1 ?? 0} y1={contextMenuClip?.fadeInY1 ?? 0}
                        x2={contextMenuClip?.fadeInX2 ?? 1} y2={contextMenuClip?.fadeInY2 ?? 1}
                        type="fadeIn" width={180} height={100}
                        onChange={(fx1, fy1, fx2, fy2) => handleSetClipFade(contextMenu.clipId, {
                          fadeInX1: fx1, fadeInY1: fy1, fadeInX2: fx2, fadeInY2: fy2,
                        })}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              type: 'custom', key: 'fade-out',
              content: (
                <div>
                  <ClipSliderRow
                    label="Fade Out"
                    value={contextMenuClip?.fadeOutTicks ?? 0}
                    min={0} max={3840} step={60}
                    onCommit={(v) => handleSetClipFade(contextMenu.clipId, { fadeOutTicks: v })}
                    formatValue={(v) => `${(v / 960).toFixed(1)}b`}
                  />
                  {(contextMenuClip?.fadeOutTicks ?? 0) > 0 && (
                    <div style={{ padding: '0 8px 6px' }}>
                      <FadeBezierEditor
                        x1={contextMenuClip?.fadeOutX1 ?? 0} y1={contextMenuClip?.fadeOutY1 ?? 0}
                        x2={contextMenuClip?.fadeOutX2 ?? 1} y2={contextMenuClip?.fadeOutY2 ?? 1}
                        type="fadeOut" width={180} height={100}
                        onChange={(fx1, fy1, fx2, fy2) => handleSetClipFade(contextMenu.clipId, {
                          fadeOutX1: fx1, fadeOutY1: fy1, fadeOutX2: fx2, fadeOutY2: fy2,
                        })}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            { type: 'separator' },
            {
              label: contextMenuClip?.reversed ? '✓ Reverse' : 'Reverse',
              onClick: () => handleReverseClip(contextMenu.clipId),
            },
            { type: 'separator' },
            {
              label: (contextMenuClip?.stretchMethod ?? 0) === 0
                ? `● Method: Global (${stretchMethodName(globalStretchMethod)})`
                : `○ Method: Global (${stretchMethodName(globalStretchMethod)})`,
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 0),
            },
            {
              label: contextMenuClip?.stretchMethod === 1 ? '● Method: TD-PSOLA' : '○ Method: TD-PSOLA',
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 1),
            },
            {
              label: contextMenuClip?.stretchMethod === 2 ? '● Method: Rubber Band' : '○ Method: Rubber Band',
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 2),
            },
            {
              label: contextMenuClip?.stretchMethod === 3 ? '● Method: WSOLA' : '○ Method: WSOLA',
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 3),
            },
            {
              label: contextMenuClip?.stretchMethod === 4 ? '● Method: Phase Vocoder' : '○ Method: Phase Vocoder',
              onClick: () => handleSetClipStretchMethod(contextMenu.clipId, 4),
            },
            {
              label: contextMenuClip?.formantPreserve ? '✓ Formant Preserve' : 'Formant Preserve',
              onClick: () => handleSetClipFormantPreserve(contextMenu.clipId, !contextMenuClip?.formantPreserve),
            },
            { label: 'Delete', danger: true, onClick: () => handleDeleteClip(contextMenu.clipId) },
          ]
        : [
            { label: 'Rename', onClick: () => { /* focus rename */ } },
            { label: 'Duplicate', onClick: () => handleAddTrack() },
            { type: 'separator' },
            { label: 'Delete Track', danger: true, onClick: () => handleRemove(contextMenu.trackId) },
          ])
    : []

  // ── Timeline focus tracking (for keyboard shortcut gating) ─────────────────

  useEffect(() => {
    const onMouseDown = (e) => {
      timelineFocusedRef.current = !!timelineViewRef.current?.contains(e.target)
    }
    window.addEventListener('mousedown', onMouseDown, true)
    return () => window.removeEventListener('mousedown', onMouseDown, true)
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────

  const hasTracks = tracks.length > 0

  return (
    <div className="timeline-view" ref={timelineViewRef}>
      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <TimelineToolbar
        activeTool={activeTool}
        setActiveTool={setActiveTool}
        activeSampleId={activeSampleId}
        regions={regions}
        snapGranularity={snapGranularity}
        onSnapGranularityChange={setSnapGranularity}
        pixelsPerBeat={pixelsPerBeat}
        onAddTrack={handleAddTrack}
        pencilTemplate={pencilTemplate}
        onSelectSyllable={handleSelectSyllable}
        declickMs={declickMs}
        onDeclickChange={handleDeclick}
        onOpenQuantize={() => setQuantizeOpen(true)}
        quantizeSelectionCount={selectedClipIds.size + selectedBlockIds.size}
      />

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      <div className="timeline-body">
        {hasTracks ? (
          <>
            {/* Left-most: pattern list (FL-style strip) */}
            <PatternListPanel
              patterns={patterns}
              collapsed={patternListCollapsed}
              onToggleCollapsed={() => setPatternListCollapsed(v => !v)}
              onOpenPianoRoll={(patternId) => {
                timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId } }))
              }}
              onRename={handlePatternRename}
            />

            {/* Left: track headers */}
            <TrackHeaderList
              tracks={tracks}
              patterns={patterns}
              currentPatternIdByTrack={currentPatternIdByTrack}
              onAddTrack={handleAddTrack}
              onMute={handleMute}
              onSolo={handleSolo}
              onRename={handleRename}
              onRemove={handleRemove}
              onReorder={handleReorder}
              onRequestContextMenu={handleRequestTrackContextMenu}
              scrollContainerRef={scrollContainerRef}
            />

            {/* Right: canvas area */}
            <div className="timeline-canvas-area" ref={canvasAreaRef}>
              <TimelineRuler
                ref={rulerRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                scrollOffsetRef={scrollOffsetRef}
                playheadBeatRef={playheadBeatRef}
                onSeek={handleSeek}
                onWheel={handleWheel}
              />
              <TimelineScrollbar
                scrollOffsetRef={scrollOffsetRef}
                pixelsPerBeatRef={pixelsPerBeatRef}
                totalBeats={DEFAULT_LENGTH_BEATS}
                canvasWidth={canvasWidth}
                onScroll={(delta) => { markUserScrolling(); scrollBy(delta) }}
                onScrollTo={(beat) => { markUserScrolling(); scrollTo(beat) }}
                scrollOffset={scrollOffset}
                pixelsPerBeat={pixelsPerBeat}
              />
              <div className="timeline-canvas-scroll" ref={scrollContainerRef}>
                <TimelineCanvas
                  ref={canvasRef}
                  trackCount={tracks.length}
                  pixelsPerBeatRef={pixelsPerBeatRef}
                  scrollOffsetRef={scrollOffsetRef}
                  playheadBeatRef={playheadBeatRef}
                  onWheel={handleWheel}
                  clips={clips}
                  regions={regions}
                  tracks={tracks}
                  selectedClipIds={selectedClipIds}
                  dropPreviewRef={dropPreviewRef}
                  waveformCacheRef={waveformCacheRef}
                  hiResCacheRef={hiResCacheRef}
                  clipPeakCacheRef={clipPeakCacheRef}
                  bpmRef={bpmRef}
                  activeTool={activeTool}
                  stickyNoteLength={stickyNoteLength}
                  setStickyNoteLength={setStickyNoteLength}
                  activeSampleId={activeSampleId}
                  snapGranularity={snapGranularity}
                  onCreateClip={handleCreateClip}
                  onDeleteClip={handleDeleteClip}
                  onMoveClip={handleMoveClip}
                  onResizeClip={handleResizeClip}
                  onResizeClipLeft={handleResizeClipLeft}
                  onStretchClip={handleStretchClip}
                  onStretchClipLeft={handleStretchClipLeft}
                  onSplitClip={handleSplitClip}
                  onRequestClipContextMenu={(clipId, x, y) => setContextMenu({ type: 'clip', clipId, x, y })}
                  setSelectedClipIds={setSelectedClipIds}
                  pencilTemplateRef={pencilTemplateRef}
                  onSetPencilTemplate={updatePencilTemplate}
                  onCanvasDragOver={handleCanvasDragOver}
                  onCanvasDrop={handleCanvasDrop}
                  onCanvasDragLeave={handleCanvasDragLeave}
                  patternBlocks={patternBlocks}
                  patterns={patterns}
                  selectedBlockIds={selectedBlockIds}
                  setSelectedBlockIds={setSelectedBlockIds}
                  currentPatternIdByTrack={currentPatternIdByTrack}
                  onCreatePatternBlock={handleCreatePatternBlock}
                  onMovePatternBlock={handleMovePatternBlock}
                  onResizePatternBlock={handleResizePatternBlock}
                  onResizePatternBlockLeft={handleResizePatternBlockLeft}
                  onDeletePatternBlock={handleDeletePatternBlock}
                  onSplitPatternBlock={handleSplitPatternBlock}
                  onOpenPianoRoll={(patternId, blockId) => {
                    timelineEvents.dispatchEvent(new CustomEvent('open-piano-roll', { detail: { patternId, blockId } }))
                  }}
                />
              </div>
            </div>
          </>
        ) : (
          /* ── Empty state ──────────────────────────────────────────────── */
          <div className="timeline-empty">
            <Layers size={36} strokeWidth={1} className="tab-placeholder-icon" />
            <p>No tracks yet</p>
            <p className="tab-placeholder-hint">Click + to add tracks to the timeline</p>
            <button className="timeline-empty-add" onClick={handleAddTrack}>
              <Plus size={14} />
              <span>Add Track</span>
            </button>
          </div>
        )}
      </div>

      {/* ── Context menu ─────────────────────────────────────────────────── */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* ── Track context menu (pattern/clip track actions) ──────────────── */}
      {trackMenu && (
        <TrackContextMenu
          x={trackMenu.x}
          y={trackMenu.y}
          items={buildTrackMenuItems(trackMenu.track)}
          onClose={() => setTrackMenu(null)}
        />
      )}

      {/* ── Confirmation dialog ──────────────────────────────────────────── */}
      {confirmDialog && (
        <ConfirmConvertDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          cancelLabel={confirmDialog.cancelLabel}
          onConfirm={confirmDialog.onConfirm}
          onCancel={confirmDialog.onCancel}
        />
      )}

      {/* ── Quantize dialog ──────────────────────────────────────────────── */}
      <QuantizeDialog
        isOpen={quantizeOpen}
        onClose={() => setQuantizeOpen(false)}
        onApply={handleQuantizeApply}
        snapGranularity={snapGranularity}
        selectionCount={selectedClipIds.size + selectedBlockIds.size}
        hasPatternBlock={selectedBlockIds.size > 0}
        hasClip={selectedClipIds.size > 0}
      />
    </div>
  )
}
