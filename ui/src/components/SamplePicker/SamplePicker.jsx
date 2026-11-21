import { useState, useEffect, useRef, useCallback } from 'react'
import { timelineEvents } from '../../timelineEvents.js'
import { SourceAudioIcon, SourceVideoIcon } from '../../ui-kit'
import PickerVideoPreview from './PickerVideoPreview.jsx'
import PickerWaveform from './PickerWaveform.jsx'
import PickerToolbar from './PickerToolbar.jsx'
import MarkedSamplesList from './MarkedSamplesList.jsx'
import { normalizeSelection } from './selection.js'
import { formatFps, formatTimecode } from './pickerFormat.js'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry.ts'
import {
  isInsideSamplePicker, isSamplePickerActive, isSamplePickerKeyTarget, setSamplePickerActive,
  setSamplePickerOpen, setSamplePickerRoot, subscribeSamplePickerActive,
} from '../../stores/samplePickerGate.js'
import styles from './SamplePicker.module.css'

import {
  DEFAULT_LABELS, loadCustomLabels, saveCustomLabels
} from '../../constants/labels.js'
import { iconComponent } from '../../ui-kit/icons'

const IcX = iconComponent('x')

const BASE_WAVEFORM_COLS = 4000   // whole-file peaks; zoomed detail is fetched per view
const POLL_MS = 50                // engine position poll while playing
const LOOP_SLACK_MS = 8           // a loop pass restarts this long after its expected end
const SHOW_MARKS_KEY = 'xleth-picker-show-marks'

// Space belongs to preview everywhere in the editor. The only targets allowed
// to keep it are real text entry (the sample name field, the custom-label
// field, a value being typed), where it has to stay a literal space character.
// Notably a focused <button> is NOT exempt: otherwise Set In / Set Out / Add
// sample swallow Space as their own activation and preview stops responding.
function isTextEntryTarget(target) {
  if (!target || typeof target.closest !== 'function') return false
  return Boolean(target.closest('input, textarea, [contenteditable="true"]'))
}

// Enter belongs to whatever natively activates on it (a button, a marked row,
// a value field that opens its editor). Anywhere else in the editor it adds.
function ownsEnter(target) {
  if (!target || typeof target.closest !== 'function') return false
  return Boolean(target.closest('button, a[href], [role="button"], [role="slider"], [role="option"]'))
}

// Arrow keys, Home and End belong to a focused value field or list.
function ownsArrows(target) {
  if (!target || typeof target.closest !== 'function') return false
  return Boolean(target.closest('[role="slider"], [role="listbox"], [role="radiogroup"], [role="tablist"]'))
}

function isSpaceKey(e) {
  return e.key === ' ' || e.key === 'Spacebar' || e.code === 'Space'
}

function nowMs() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function loadShowMarks() {
  try { return localStorage.getItem(SHOW_MARKS_KEY) === '1' } catch { return false }
}

// Count how many saved samples share the given label
function nextLabelIndex(samples, label) {
  return samples.filter(s => s.label === label).length + 1
}

// Same idea, but for a project-wide region list (used at Add-time so the
// counter is globally correct, not limited to the current source).
function nextLabelIndexGlobal(allRegions, label) {
  return (allRegions || []).filter(r => r.label === label).length + 1
}

// True if `allRegions` contains any region with matching label+name,
// ignoring the optional excludeId (for rename checks).
function nameCollides(allRegions, label, name, excludeId = null) {
  return (allRegions || []).some(r =>
    r.id !== excludeId && r.label === label && r.name === name
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * The sample editor, shown as a sheet over the Preview/Inspector row (see
 * windowing/components/PickerSheet). The arrangement under it stays live.
 *
 * What it does has not changed: load a source, audition it, mark In / Out,
 * label and name the span, add it to the project as a region. What it adds to
 * the project is the same `{ sourceId, startTime, endTime, label, name }`.
 *
 * Props:
 *   source    – { id, name, filePath, duration, width, height, fps, hasVideo }
 *   onClose   – () => void
 *   scopeRef  – optional ref to the element that bounds the editor (the sheet).
 *               Default: the editor's own root.
 *
 * Keyboard (see stores/samplePickerGate.js for who owns a key):
 *   Space          play the selection / pause       L       loop on / off
 *   I / O          set In / Out at the playhead     Shift+I / Shift+O   go to In / Out
 *   Left / Right   nudge the playhead one frame (10 ms for audio); Shift x10
 *   Home / End     start / end of the source        Z / F   zoom to selection / fit
 *   1 to 9         pick the label                   Enter   add the sample
 *   Esc            close
 */
export default function SamplePicker({ source, onClose, scopeRef }) {
  const rootRef = useRef(null)
  const waveRef = useRef(null)
  const scopeElement = useCallback(() => scopeRef?.current || rootRef.current, [scopeRef])

  // ── Bridge/media state ──────────────────────────────────────────────────────
  const [waveformData,  setWaveformData]  = useState(null)   // { peaks, duration, pixelWidth, stride }
  const [waveformError, setWaveformError] = useState(false)

  // ── Playback state ──────────────────────────────────────────────────────────
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeRef = useRef(0)   // mirror of currentTime for stable closures
  const [playing,     setPlaying]     = useState(false)
  const playingRef = useRef(false)   // mirror of playing for stable closures
  const playbackStopTimeRef = useRef(null)
  const boundedRef = useRef(false)   // the engine itself stops this pass at its end (sample accurate)
  const playEpochRef = useRef(0)     // bumps on every start / pause, so a stale poll can be told apart
  const loopTimerRef = useRef(null)
  // Where the playhead was at the last engine report, for drawing it between reports.
  const clockRef = useRef({ pos: 0, wall: 0, stopAt: null })
  const [sourceDuration, setSourceDuration] = useState(0) // duration from engine loadSource

  const [loop, setLoop] = useState(false)
  const loopRef = useRef(false)

  // ── Selection state ─────────────────────────────────────────────────────────
  const [inPoint,  setInPointState]  = useState(null)
  const [outPoint, setOutPointState] = useState(null)
  const inPointRef = useRef(null)
  const outPointRef = useRef(null)
  const setInPoint = useCallback((t) => { inPointRef.current = t; setInPointState(t) }, [])
  const setOutPoint = useCallback((t) => { outPointRef.current = t; setOutPointState(t) }, [])

  // Toggle: draw every already-marked sample on the waveform in its label
  // colour, so existing coverage is visible while auditioning new in/out points.
  const [showMarks, setShowMarks] = useState(loadShowMarks)

  // ── Sample list state ───────────────────────────────────────────────────────
  const [samples,      setSamples]      = useState([])
  const [selectedId,   setSelectedId]   = useState(null)
  const [label,        setLabel]        = useState('Kick')
  const [sampleName,   setSampleName]   = useState('Kick 1')
  const [customLabels, setCustomLabels] = useState(loadCustomLabels)

  // Distinguishes a user-typed name (must be rejected on collision) from an
  // auto-generated one (safely bumped to the next free index on collision).
  const [sampleNameIsUserEdited, setSampleNameIsUserEdited] = useState(false)
  const [addSampleError, setAddSampleError] = useState(null)

  // ── Keyboard ownership + what the waveform is showing ──────────────────────
  const [active, setActive] = useState(true)
  const [viewInfo, setViewInfo] = useState(null)

  // ── Position polling interval ref ──────────────────────────────────────────
  const pollRef = useRef(null)

  // ── Add-sample concurrency guards ───────────────────────────────────────────
  const isAddingRef     = useRef(false)  // blocks overlapping invocations
  const pendingCountRef = useRef(0)      // offsets names for concurrent calls

  // ── Duration from waveform, engine, or source prop ─────────────────────────
  const duration = waveformData?.duration || sourceDuration || source.duration || 0
  const durationRef = useRef(duration)
  durationRef.current = duration

  // ── On mount: load source audio + fetch waveform + load regions ─────────────
  useEffect(() => {
    console.log(`[SamplePicker] Opened: ${source.name} (id=${source.id})`)

    // The editor owns the keyboard from the moment it opens (samplePickerGate):
    // TransportBar's Space / Home / M stand down for as long as it is active.
    setSamplePickerRoot(scopeRef?.current || rootRef.current)
    setSamplePickerOpen(true)
    const unsubscribe = subscribeSamplePickerActive(setActive)

    // Load source audio into the C++ engine (decodes entire file to RAM)
    window.xleth?.audio?.loadSource(source.filePath)
      .then(result => {
        if (result?.success) {
          setSourceDuration(result.duration)
          console.log(`[SamplePicker] Source loaded via engine: ${result.duration.toFixed(1)}s`)
        } else {
          console.error('[SamplePicker] Engine loadSource failed')
        }
      })
      .catch(e => console.error('[SamplePicker] loadSource error:', e))

    // Fetch waveform via mipmap (JUCE for WAV/FLAC/etc, FFmpeg fallback for MP4/MKV/etc)
    window.xleth?.waveform?.getFilePeaks(source.filePath, 0, -1, BASE_WAVEFORM_COLS, -1)
      .then(data => {
        if (data?.error) {
          console.warn('[SamplePicker] Waveform generation failed (unsupported format)')
          setWaveformError(true)
        } else if (data && data.peaks?.length > 0) {
          const cols = Math.floor(data.peaks.length / 3)
          console.log(`[SamplePicker] Waveform ready: ${data.duration?.toFixed(1)}s, ${cols}px`)
          setWaveformData({ peaks: data.peaks, duration: data.duration, pixelWidth: cols, stride: 3 })
        } else {
          console.warn('[SamplePicker] Waveform extraction returned null/empty')
          setWaveformError(true)
        }
      })
      .catch(e => {
        console.error('[SamplePicker] Waveform error:', e)
        setWaveformError(true)
      })

    // Load any existing regions for this source from the timeline
    window.xleth?.timeline?.getRegions()
      .then(regions => {
        if (!Array.isArray(regions)) return
        const ours = regions.filter(r => r.sourceId === source.id)
        if (ours.length) {
          setSamples(ours)
          console.log(`[SamplePicker] Loaded ${ours.length} existing region(s)`)
        }
      })
      .catch(() => {})

    return () => {
      unsubscribe()
      setSamplePickerOpen(false)
      if (loopTimerRef.current) clearTimeout(loopTimerRef.current)
      // Stop engine source playback and unload on unmount
      window.xleth?.audio?.stopSource().catch(() => {})
      window.xleth?.audio?.unloadSource().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Run only once; source won't change while picker is open

  // ── Playhead bookkeeping ───────────────────────────────────────────────────
  const setTime = useCallback((t) => {
    currentTimeRef.current = t
    clockRef.current = { pos: t, wall: nowMs(), stopAt: playbackStopTimeRef.current }
    setCurrentTime(t)
  }, [])

  // The playhead right now: between engine reports it is read off the clock,
  // so I / O tapped during playback land where the sound is, not up to a poll late.
  const nowTime = useCallback(() => {
    if (!playingRef.current) return currentTimeRef.current
    const { pos, wall, stopAt } = clockRef.current
    const limit = stopAt ?? (durationRef.current > 0 ? durationRef.current : Infinity)
    return Math.max(0, Math.min(pos + (nowMs() - wall) / 1000, limit))
  }, [])

  const clearLoopTimer = useCallback(() => {
    if (loopTimerRef.current) clearTimeout(loopTimerRef.current)
    loopTimerRef.current = null
  }, [])

  // ── Start / finish a preview pass ──────────────────────────────────────────
  // `end` null plays to the end of the source. A bounded pass is handed to the
  // engine's region preview, which stops on the exact sample; an addon without
  // it falls back to playSource and the poll below stops it (the old path).
  const startPlaybackRef = useRef(null)
  const startPlayback = useCallback((start, end) => {
    const audio = window.xleth?.audio
    playEpochRef.current += 1
    const epoch = playEpochRef.current
    clearLoopTimer()
    playbackStopTimeRef.current = end
    const bounded = end !== null && typeof audio?.playRegionPreview === 'function'
    boundedRef.current = bounded

    const started = bounded ? audio.playRegionPreview(start, end) : audio?.playSource(start)
    started?.catch?.(e => console.error('[SamplePicker] playSource error:', e))

    setTime(start)
    playingRef.current = true
    setPlaying(true)

    if (loopRef.current && end !== null && end > start) {
      loopTimerRef.current = setTimeout(() => {
        loopTimerRef.current = null
        if (epoch !== playEpochRef.current || !playingRef.current || !loopRef.current) return
        // Read the edges fresh: a pass picks up whatever In / Out are now.
        const sel = normalizeSelection(inPointRef.current, outPointRef.current)
        if (sel) startPlaybackRef.current(sel.start, sel.end)
      }, Math.max(0, (end - start) * 1000 + LOOP_SLACK_MS))
    }
  }, [clearLoopTimer, setTime])
  startPlaybackRef.current = startPlayback

  const finishPlayback = useCallback((at, stopEngine) => {
    playEpochRef.current += 1
    clearLoopTimer()
    playbackStopTimeRef.current = null
    if (stopEngine) {
      window.xleth?.audio?.pauseSource().catch(() => {})
      window.xleth?.audio?.seekSource(at).catch(() => {})
    }
    playingRef.current = false
    setPlaying(false)
    setTime(at)
  }, [clearLoopTimer, setTime])

  // A bounded pass reached its end: loop again, or stop on the Out point.
  const onPassEnded = useCallback((stopTime) => {
    if (loopRef.current) {
      const sel = normalizeSelection(inPointRef.current, outPointRef.current)
      if (sel) { startPlayback(sel.start, sel.end); return }
    }
    finishPlayback(stopTime, true)
    console.log(`[SamplePicker] Selection playback ended at ${stopTime.toFixed(3)}s`)
  }, [finishPlayback, startPlayback])

  // ── Position polling during playback ──────────────────────────────────────
  // Only polls SourcePlayer position; the waveform draws the playhead between
  // polls from clockRef, and the <video> element renders its own frames.
  useEffect(() => {
    if (playing) {
      pollRef.current = setInterval(async () => {
        try {
          const epoch = playEpochRef.current
          const pos = await window.xleth?.audio?.getSourcePosition()
          if (pos == null || epoch !== playEpochRef.current || !playingRef.current) return

          const stopTime = playbackStopTimeRef.current
          if (stopTime !== null && !boundedRef.current && pos >= stopTime - 0.005) {
            onPassEnded(stopTime)
            return
          }

          setTime(pos)

          // Check if engine stopped playing (end of a bounded pass, or end of buffer)
          const stillPlaying = await window.xleth?.audio?.isSourcePlaying()
          if (epoch !== playEpochRef.current || !playingRef.current) return
          if (!stillPlaying) {
            if (stopTime !== null) {
              onPassEnded(stopTime)
            } else {
              finishPlayback(pos, false)
              console.log(`[SamplePicker] Playback ended at ${pos.toFixed(3)}s`)
            }
          }
        } catch {}
      }, POLL_MS)
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [playing, onPassEnded, finishPlayback, setTime])

  // ── Auto-update sample name when label changes ─────────────────────────────
  // Only regenerate the suggestion when the user has NOT manually typed a
  // custom name. Display-only: the committed name in handleAddSample is
  // re-derived from a fresh project-wide fetch.
  useEffect(() => {
    if (!sampleNameIsUserEdited) {
      setSampleName(`${label} ${nextLabelIndex(samples, label)}`)
    }
  }, [label, samples, sampleNameIsUserEdited])

  // ── Name input: flip "user-edited" flag, clear any stale error ──────────────
  const handleNameChange = useCallback((name) => {
    setSampleName(name)
    setSampleNameIsUserEdited(true)
    setAddSampleError(null)
  }, [])

  // ── Label change: reset the flag so the suggestion regenerates cleanly ─────
  const handleLabelChange = useCallback((newLabel) => {
    setLabel(newLabel)
    setSampleNameIsUserEdited(false)
    setAddSampleError(null)
  }, [])

  // ── Seek handler (from waveform click/drag, nudges, go-to) ─────────────────
  // Sets audio position; the <video> element syncs via currentTime prop.
  const handleSeek = useCallback((time) => {
    const d = durationRef.current
    const t = d > 0 ? Math.max(0, Math.min(time, d)) : Math.max(0, time)
    if (playingRef.current) {
      // Keep playing from the new place. The pass stays bounded while the
      // playhead is still short of its end; past it, it runs free.
      const stop = playbackStopTimeRef.current
      startPlayback(t, stop !== null && t < stop - 0.005 ? stop : null)
      return
    }
    setTime(t)
    // Instant seek via engine (atomic position set on RAM buffer)
    window.xleth?.audio?.seekSource(t).catch(() => {})
  }, [setTime, startPlayback])

  // ── In/Out setters ─────────────────────────────────────────────────────────
  const handleSetIn = useCallback(() => {
    const t = nowTime()
    setInPoint(t)
    console.log(`[SamplePicker] In point: ${t.toFixed(3)}s`)
  }, [nowTime, setInPoint])

  const handleSetOut = useCallback(() => {
    const t = nowTime()
    setOutPoint(t)
    console.log(`[SamplePicker] Out point: ${t.toFixed(3)}s`)
  }, [nowTime, setOutPoint])

  // ── Play / Pause ───────────────────────────────────────────────────────────
  const handlePlaySelection = useCallback(() => {
    if (playingRef.current) {
      // Pause — engine remembers position
      const at = nowTime()
      playEpochRef.current += 1
      const epoch = playEpochRef.current
      clearLoopTimer()
      window.xleth?.audio?.pauseSource().catch(() => {})
      playbackStopTimeRef.current = null
      playingRef.current = false
      setPlaying(false)
      setTime(at)
      // The estimate above is replaced by where the engine actually stopped.
      window.xleth?.audio?.getSourcePosition?.()
        ?.then?.(pos => { if (pos != null && epoch === playEpochRef.current) setTime(pos) })
        ?.catch?.(() => {})
      console.log(`[SamplePicker] Pause at ${at.toFixed(3)}s`)
      return
    }

    const selection = normalizeSelection(inPointRef.current, outPointRef.current)
    const start = selection?.start ?? currentTimeRef.current ?? 0
    console.log(
      `[SamplePicker] Play from ${start.toFixed(3)}s` + (selection ? `, stop=${selection.end.toFixed(3)}s` : '')
    )
    startPlayback(start, selection?.end ?? null)
  }, [clearLoopTimer, nowTime, setTime, startPlayback])

  const handleToggleLoop = useCallback(() => {
    const next = !loopRef.current
    loopRef.current = next
    setLoop(next)
    if (!next) clearLoopTimer()
    console.log(`[SamplePicker] Loop ${next ? 'on' : 'off'}`)
  }, [clearLoopTimer])

  // ── Add sample ─────────────────────────────────────────────────────────────
  const handleAddSample = useCallback(async () => {
    if (isAddingRef.current) return          // block overlapping invocations
    const selection = normalizeSelection(inPoint, outPoint)
    if (!selection) return
    const { start, end } = selection

    isAddingRef.current = true
    let didIncrementPending = false

    try {
      // Fresh project-wide fetch: counter must account for regions on OTHER
      // sources too (otherwise each source restarts at "Pitch 1" independently).
      let allRegions = []
      try {
        const regs = await window.xleth?.timeline?.getRegions()
        if (Array.isArray(regs)) allRegions = regs
      } catch { /* empty list fallback */ }

      let name
      if (sampleNameIsUserEdited) {
        // User-typed name: reject on collision, surface inline error.
        const typed = (sampleName || '').trim()
        if (!typed) {
          setAddSampleError('Sample name cannot be empty.')
          return
        }
        if (nameCollides(allRegions, label, typed)) {
          setAddSampleError(`A ${label} sample named "${typed}" already exists.`)
          return
        }
        name = typed
      } else {
        // Auto-generated: compute from fresh global list. Concurrent-add safety
        // net: bump the counter until we find an unused name (capped retries).
        let idx = nextLabelIndexGlobal(allRegions, label) + pendingCountRef.current
        let candidate = `${label} ${idx}`
        let retries = 0
        while (nameCollides(allRegions, label, candidate) && retries < 1000) {
          idx++
          candidate = `${label} ${idx}`
          retries++
        }
        name = candidate
        pendingCountRef.current += 1
        didIncrementPending = true
      }

      setAddSampleError(null)

      const regionDef = {
        sourceId:  source.id,
        startTime: start,
        endTime:   end,
        label,
        name,
      }

      console.log(`[SamplePicker] Adding sample: "${name}" (${label}) ${start.toFixed(3)}–${end.toFixed(3)}s`)

      let regionId = null
      try {
        regionId = await window.xleth?.timeline?.addRegion(regionDef)
        timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      } catch (e) {
        console.warn('[SamplePicker] addRegion failed (addon may not support it yet):', e.message)
      }

      // Load region audio into SampleBank and map it for MixEngine playback
      if (regionId != null && source.filePath) {
        try {
          const sampleId = await window.xleth?.audio?.loadSourceRegion(source.filePath, start, end)
          if (sampleId != null && sampleId >= 0) {
            await window.xleth?.audio?.mapRegionToSample(regionId, sampleId)
            // Notify TimelineView so it doesn't re-load this region's audio
            timelineEvents.dispatchEvent(new CustomEvent('timeline-region-audio-loaded', { detail: { regionId } }))
            console.log(`[SamplePicker] Audio loaded: region=${regionId} → sample=${sampleId}`)
          } else {
            console.warn(`[SamplePicker] loadSourceRegion returned ${sampleId}`)
          }
        } catch (e) {
          console.warn('[SamplePicker] Audio load/map failed:', e.message)
        }
      }

      const newSample = { ...regionDef, id: regionId ?? `local-${Date.now()}` }
      setSamples(prev => [...prev, newSample])
      setSelectedId(newSample.id)
      // Reset flag so the useEffect regenerates a fresh suggested name.
      setSampleNameIsUserEdited(false)

      // Reset in/out
      setInPoint(null)
      setOutPoint(null)

      // Add sample has just disabled itself. Hand focus to the waveform so the
      // next key (Space, I, O) has somewhere to land.
      if (isSamplePickerActive()) waveRef.current?.focus()

      console.log(`[SamplePicker] Sample added: id=${newSample.id}`)
    } finally {
      isAddingRef.current = false
      if (didIncrementPending) {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
      }
    }
  }, [inPoint, outPoint, label, sampleName, source.id, source.filePath, sampleNameIsUserEdited, setInPoint, setOutPoint])

  // ── Delete sample ──────────────────────────────────────────────────────────
  const handleDeleteSample = useCallback(async (id) => {
    console.log(`[SamplePicker] Deleting sample: id=${id}`)
    // The row's own button is about to unmount with the row.
    if (isSamplePickerActive()) waveRef.current?.focus()
    try {
      await window.xleth?.timeline?.removeRegion(id)
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
    } catch (e) {
      console.warn('[SamplePicker] removeRegion failed:', e.message)
    }
    setSamples(prev => prev.filter(s => s.id !== id))
    if (selectedId === id) setSelectedId(null)
  }, [selectedId])

  // ── Select sample from list or from its bar on the waveform ────────────────
  const handleSelectSample = useCallback((sample) => {
    setSelectedId(sample.id)
    setInPoint(sample.startTime)
    setOutPoint(sample.endTime)
    const sel = normalizeSelection(sample.startTime, sample.endTime)
    // Mid-preview, picking a sample auditions that sample (the pass takes its bounds).
    if (playingRef.current && sel) startPlayback(sel.start, sel.end)
    else handleSeek(sample.startTime)
    console.log(`[SamplePicker] Sample selected: "${sample.name}"`)
  }, [handleSeek, setInPoint, setOutPoint, startPlayback])

  // ── A sweep committed a region on the waveform ─────────────────────────────
  // The gesture already left in/out set, so the only thing missing is the
  // label — pop the dropdown open so the next keystroke picks one.
  const [labelPickerSignal, setLabelPickerSignal] = useState(0)
  const [labelSelectKey, setLabelSelectKey] = useState(0)
  const handleRegionDragEnd = useCallback(({ start, end }) => {
    setSelectedId(null)
    setAddSampleError(null)
    setLabelPickerSignal(n => n + 1)
    console.log(`[SamplePicker] Region swept: ${start.toFixed(3)}-${end.toFixed(3)}s`)
  }, [])

  // ── Add custom label ───────────────────────────────────────────────────────
  const handleAddCustomLabel = useCallback((name) => {
    const trimmed = name.trim()
    if (!trimmed) return
    setCustomLabels(prev => {
      if (prev.includes(trimmed)) return prev
      const updated = [...prev, trimmed]
      saveCustomLabels(updated)
      console.log(`[SamplePicker] Custom label added: "${trimmed}"`)
      return updated
    })
    setLabel(trimmed)
  }, [])

  const handleToggleShowMarks = useCallback(() => {
    setShowMarks(v => {
      try { localStorage.setItem(SHOW_MARKS_KEY, v ? '0' : '1') } catch { /* private mode */ }
      return !v
    })
  }, [])

  // ── Open the Split Syllables floating panel for a marked sample ────────────
  // The panel owns its own marker/waveform state (keepAliveWhenHidden), so the
  // picker only hands it the target region + source context and asks the
  // windowing system to surface it.
  const handleOpenSplitter = useCallback((sample) => {
    // Swap-aware (mirrors sandboxStore.addSourceFromRegion / TimelineView audio
    // mapping): once a sample's audio has been SWAP-IN'd, that's what plays —
    // splitting against the original file would mark syllables against audio
    // nobody hears. The stale whole-source waveform doesn't apply to the swap
    // file either, so leave it null and let the panel fetch fresh region peaks.
    const swapped = sample?.hasSwappedAudio && sample?.swappedAudioPath
    usePanelRegistry.getState().openPanel('splitSyllables', {
      region: sample,
      sourceFilePath: swapped ? sample.swappedAudioPath : source.filePath,
      sourceWaveform: swapped ? null : waveformData,
    })
    console.log(`[SamplePicker] Opened Split Syllables for "${sample.name}"${swapped ? ' (swapped audio)' : ''}`)
  }, [source.filePath, waveformData])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  // One window-level capture listener, registered once. It reads everything it
  // needs through `actions`, so it never re-registers as state changes.
  const allLabels = [...DEFAULT_LABELS, ...customLabels]
  const nudgeStep = source.fps > 0 && source.hasVideo !== false ? 1 / source.fps : 0.01
  const actions = useRef({})
  actions.current = {
    togglePlay: handlePlaySelection,
    toggleLoop: handleToggleLoop,
    setIn: handleSetIn,
    setOut: handleSetOut,
    add: handleAddSample,
    close: onClose,
    seek: handleSeek,
    nudge: (direction, coarse) => handleSeek(nowTime() + direction * nudgeStep * (coarse ? 10 : 1)),
    goTo: (where) => {
      const t = where === 'in' ? inPointRef.current
        : where === 'out' ? outPointRef.current
        : where === 'end' ? durationRef.current
        : 0
      if (t !== null && Number.isFinite(t)) handleSeek(t)
    },
    zoomToSelection: () => waveRef.current?.zoomToSelection(),
    fit: () => waveRef.current?.fit(),
    pickLabel: (index, closeList) => {
      const next = allLabels[index]
      if (!next) return false
      handleLabelChange(next)
      if (closeList) {
        // The kit Select has no "close" of its own: a fresh instance is a closed one.
        setLabelSelectKey(n => n + 1)
        waveRef.current?.focus()
      }
      return true
    },
  }

  useEffect(() => {
    let pointerDown = false

    // Ownership follows the pointer and focus: inside the sheet (or a list one
    // of its controls opened) the editor is active; a click or a tab elsewhere
    // hands the keyboard back to the arrangement.
    const onPointerDown = (e) => { pointerDown = true; setSamplePickerActive(isInsideSamplePicker(e.target)) }
    const onPointerUp = () => { pointerDown = false }
    const onFocusIn = (e) => { setSamplePickerActive(isInsideSamplePicker(e.target)) }
    // Focus that simply falls away (its control unmounted or was removed) goes
    // back to the sheet, so Tab carries on from the editor and not from <body>.
    const onFocusOut = (e) => {
      if (e.relatedTarget || !isInsideSamplePicker(e.target)) return
      setTimeout(() => {
        if (!isSamplePickerActive()) return
        if (document.activeElement && document.activeElement !== document.body) return
        scopeElement()?.focus?.({ preventScroll: true })
      }, 0)
    }

    const listOpen = () => !!scopeElement()?.querySelector?.('[aria-haspopup="listbox"][aria-expanded="true"]')
    const claim = (e) => { e.preventDefault(); e.stopImmediatePropagation() }

    const onKeyDown = (e) => {
      // The arrangement is live under the sheet: only keys the editor owns are ours.
      if (!isSamplePickerKeyTarget(e)) return
      const a = actions.current
      const target = e.target
      const typing = isTextEntryTarget(target)
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey
      const open = listOpen()

      // Space first, and gated only on text entry: capture-phase
      // stopImmediatePropagation keeps it from ever reaching the focused
      // button, and preventDefault kills that button's native activation.
      // An open label list does not get it either: right after a sweep the
      // list is open and the next thing wanted is to hear the span (Enter
      // chooses from the list).
      if (isSpaceKey(e) && plain) {
        if (typing) return             // a literal space character
        claim(e)
        if (!e.repeat) a.togglePlay()  // a held key must not machine-gun the toggle
        return
      }

      // Typing, or an app shortcut with a modifier (Ctrl+S, Ctrl+Z): not ours.
      if (typing || !plain) return

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const digit = /^[1-9]$/.test(key) ? Number(key) : 0

      if (open) {
        // The open label list has the keyboard; a digit picks straight from it.
        if (digit && a.pickLabel(digit - 1, true)) claim(e)
        return
      }

      switch (key) {
        case 'i': if (e.shiftKey) a.goTo('in'); else a.setIn(); break
        case 'o': if (e.shiftKey) a.goTo('out'); else a.setOut(); break
        case 'l': a.toggleLoop(); break
        case 'z': a.zoomToSelection(); break
        case 'f': a.fit(); break
        case 'Enter':
          if (ownsEnter(target)) return
          a.add()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
          if (ownsArrows(target)) return
          a.nudge(key === 'ArrowLeft' ? -1 : 1, e.shiftKey)
          break
        case 'Home':
        case 'End':
          if (ownsArrows(target)) return
          a.goTo(key === 'Home' ? 'start' : 'end')
          break
        case 'Escape':
          if (pointerDown) return      // a drag in progress cancels itself on Escape
          a.close()
          break
        default:
          if (digit) {
            if (!a.pickLabel(digit - 1, false)) return
            break
          }
          // Any other plain character key: nothing behind the sheet may act on
          // it (a panel's tool letter, the transport's M) while the editor has
          // the keyboard.
          if (key.length === 1) e.stopImmediatePropagation()
          return
      }
      claim(e)
    }

    // A <button> fires its click on keyUP, so swallow that half too rather
    // than relying on the keydown preventDefault alone.
    const onKeyUp = (e) => {
      if (!isSpaceKey(e)) return
      if (!isSamplePickerKeyTarget(e)) return
      if (isTextEntryTarget(e.target)) return
      claim(e)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('mousedown', onPointerDown, true)
    document.addEventListener('pointerup', onPointerUp, true)
    document.addEventListener('mouseup', onPointerUp, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', onFocusOut, true)
    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keyup', onKeyUp, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('mousedown', onPointerDown, true)
      document.removeEventListener('pointerup', onPointerUp, true)
      document.removeEventListener('mouseup', onPointerUp, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', onFocusOut, true)
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keyup', onKeyUp, { capture: true })
    }
  }, [scopeElement])

  // Plain character keys that reach the sheet stop there: with focus inside the
  // editor nothing behind it (a focused panel's shortcuts) may act on them.
  const containKeys = useCallback((e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key.length === 1) e.stopPropagation()
  }, [])

  // ── Render ─────────────────────────────────────────────────────────────────
  const hasVideo = source.hasVideo !== false
  const resolution = source.width && source.height ? `${source.width}×${source.height}` : null
  const fpsText = source.fps ? formatFps(source.fps) : null

  return (
    <div
      className={styles.picker}
      ref={rootRef}
      data-testid="sample-picker"
      data-active={active ? 'true' : 'false'}
      onKeyDown={containKeys}
    >
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        <span className={styles.sourceGlyph} aria-hidden="true">
          {hasVideo ? <SourceVideoIcon /> : <SourceAudioIcon />}
        </span>
        <span className={styles.title} data-hint={source.filePath}>
          {source.name}
        </span>
        {resolution ? <span className={styles.meta}>{resolution}</span> : null}
        {fpsText ? <span className={styles.meta}>{fpsText}</span> : null}
        {duration > 0 ? (
          <span className={styles.meta} data-hint="Length of the source">{formatTimecode(duration)}</span>
        ) : null}
        <span
          className={styles.keys}
          role="status"
          data-testid="picker-keys"
          data-hint={active
            ? 'The sample editor has the keyboard: Space previews this source'
            : 'The arrangement has the keyboard: Space plays the timeline. Click the editor to take it back'}
        >
          {active ? 'Space previews this source' : 'Space plays the timeline'}
        </span>
        <button
          type="button"
          className={`sample-picker-back ${styles.close}`}
          onClick={onClose}
          aria-label="Close sample picker"
          data-hint="Close the sample editor and return to the Preview"
          data-hint-mods="Esc"
        >
          <IcX size={14} aria-hidden="true" />
          <span>Close</span>
        </button>
      </div>

      <div className={styles.workspace}>
        <div className={styles.videoColumn}>
          {hasVideo ? (
            <PickerVideoPreview
              filePath={source.filePath}
              currentTime={currentTime}
              isPlaying={playing}
              sourceWidth={source.width}
              sourceHeight={source.height}
              fps={source.fps}
            />
          ) : (
            <div className={styles.audioOnly}>
              <span>Audio source</span>
              <span className={styles.timecode}>{formatTimecode(currentTime)}</span>
            </div>
          )}
        </div>

        <div className={styles.center}>
          <PickerWaveform
            ref={waveRef}
            filePath={source.filePath}
            waveformData={waveformData}
            waveformError={waveformError}
            duration={duration}
            currentTime={currentTime}
            playing={playing}
            clockRef={clockRef}
            inPoint={inPoint}
            outPoint={outPoint}
            onSeek={handleSeek}
            onInChange={setInPoint}
            onOutChange={setOutPoint}
            onRegionDragEnd={handleRegionDragEnd}
            samples={samples}
            showMarks={showMarks}
            selectedId={selectedId}
            onSelectSample={handleSelectSample}
            pendingLabel={label}
            pendingName={sampleName}
            onViewChange={setViewInfo}
          />

          <PickerToolbar
            playing={playing}
            loop={loop}
            onTogglePlay={handlePlaySelection}
            onToggleLoop={handleToggleLoop}
            inPoint={inPoint}
            outPoint={outPoint}
            duration={duration}
            onSetIn={handleSetIn}
            onSetOut={handleSetOut}
            onInChange={setInPoint}
            onOutChange={setOutPoint}
            viewInfo={viewInfo}
            onZoomToSelection={() => waveRef.current?.zoomToSelection()}
            onFit={() => waveRef.current?.fit()}
            label={label}
            allLabels={allLabels}
            onLabelChange={handleLabelChange}
            onAddCustomLabel={handleAddCustomLabel}
            labelPickerSignal={labelPickerSignal}
            labelSelectKey={labelSelectKey}
            sampleName={sampleName}
            onNameChange={handleNameChange}
            onAddSample={handleAddSample}
            error={addSampleError}
          />
        </div>

        <aside className={styles.rail} aria-label="Marked samples">
          {/* Splitting syllables opens a dedicated floating panel via the
              scissors button on each Quote row (see onSplit). */}
          <MarkedSamplesList
            samples={samples}
            selectedId={selectedId}
            onSelect={handleSelectSample}
            onDelete={handleDeleteSample}
            onSplit={handleOpenSplitter}
            showMarks={showMarks}
            onToggleShowMarks={handleToggleShowMarks}
          />
        </aside>
      </div>
    </div>
  )
}
