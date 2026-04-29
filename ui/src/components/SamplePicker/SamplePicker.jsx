import { useState, useEffect, useRef, useCallback } from 'react'
import { ArrowLeft } from 'lucide-react'
import { timelineEvents } from '../../timelineEvents.js'
import PickerVideoPreview from './PickerVideoPreview.jsx'
import WaveformScrubber from './WaveformScrubber.jsx'
import ControlsRow from './ControlsRow.jsx'
import MarkedSamplesList from './MarkedSamplesList.jsx'
import SyllableSplitter from '../SyllableSplitter/SyllableSplitter.jsx'

import {
  DEFAULT_LABELS, loadCustomLabels, saveCustomLabels
} from '../../constants/labels.js'

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
 * Props:
 *   source   – { id, name, filePath, duration, width, height, fps, hasVideo }
 *   onClose  – () => void
 */
export default function SamplePicker({ source, onClose }) {
  // ── Bridge/media state ──────────────────────────────────────────────────────
  const [waveformData,  setWaveformData]  = useState(null)   // { peaks, duration, pixelWidth }
  const [waveformError, setWaveformError] = useState(false)

  // ── Playback state ──────────────────────────────────────────────────────────
  const [currentTime, setCurrentTime] = useState(0)
  const currentTimeRef = useRef(0)   // mirror of currentTime for stable closures
  const [playing,     setPlaying]     = useState(false)
  const playingRef = useRef(false)   // mirror of playing for stable closures
  const [sourceDuration, setSourceDuration] = useState(0) // duration from engine loadSource

  // ── Selection state ─────────────────────────────────────────────────────────
  const [inPoint,  setInPoint]  = useState(null)
  const [outPoint, setOutPoint] = useState(null)

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

  // ── Position polling interval ref ──────────────────────────────────────────
  const pollRef = useRef(null)

  // ── Add-sample concurrency guards ───────────────────────────────────────────
  const isAddingRef     = useRef(false)  // blocks overlapping invocations
  const pendingCountRef = useRef(0)      // offsets names for concurrent calls

  // ── Duration from waveform, engine, or source prop ─────────────────────────
  const duration = waveformData?.duration || sourceDuration || source.duration || 0

  // ── On mount: load source audio + fetch waveform + load regions ─────────────
  useEffect(() => {
    console.log(`[SamplePicker] Opened: ${source.name} (id=${source.id})`)

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
    const waveformWidth = 1400
    window.xleth?.waveform?.getFilePeaks(source.filePath, 0, -1, waveformWidth, -1)
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
      // Stop engine source playback and unload on unmount
      window.xleth?.audio?.stopSource().catch(() => {})
      window.xleth?.audio?.unloadSource().catch(() => {})
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Run only once; source won't change while picker is open

  // ── Position polling during playback ──────────────────────────────────────
  // Only polls SourcePlayer position for the waveform playhead.
  // The <video> element handles its own frame rendering at native framerate.
  useEffect(() => {
    if (playing) {
      pollRef.current = setInterval(async () => {
        try {
          const pos = await window.xleth?.audio?.getSourcePosition()
          if (pos != null) {
            currentTimeRef.current = pos
            setCurrentTime(pos)

            // Check if engine stopped playing (reached end of buffer)
            const stillPlaying = await window.xleth?.audio?.isSourcePlaying()
            if (!stillPlaying && playingRef.current) {
              playingRef.current = false
              setPlaying(false)
              console.log(`[SamplePicker] Playback ended at ${pos.toFixed(3)}s`)
            }
          }
        } catch {}
      }, 60) // ~16fps position updates for waveform playhead
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
  }, [playing])

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

  // ── Seek handler (from waveform click/drag) ────────────────────────────────
  // Sets audio position; the <video> element syncs via currentTime prop.
  const handleSeek = useCallback((time) => {
    const t = duration > 0 ? Math.max(0, Math.min(time, duration)) : Math.max(0, time)
    currentTimeRef.current = t
    setCurrentTime(t)
    // Instant seek via engine (atomic position set on RAM buffer)
    window.xleth?.audio?.seekSource(t).catch(() => {})
  }, [duration])

  // ── In/Out setters ─────────────────────────────────────────────────────────
  const handleSetIn = useCallback(() => {
    setInPoint(currentTime)
    console.log(`[SamplePicker] In point: ${currentTime.toFixed(3)}s`)
  }, [currentTime])

  const handleSetOut = useCallback(() => {
    setOutPoint(currentTime)
    console.log(`[SamplePicker] Out point: ${currentTime.toFixed(3)}s`)
  }, [currentTime])

  // ── Play / Pause ───────────────────────────────────────────────────────────
  const handlePlaySelection = useCallback(() => {
    if (playingRef.current) {
      // Pause — engine remembers position
      window.xleth?.audio?.pauseSource().catch(() => {})
      playingRef.current = false
      setPlaying(false)
      console.log(`[SamplePicker] Pause at ${currentTimeRef.current.toFixed(3)}s`)
      return
    }

    // Play from in-point or current position
    const start = inPoint ?? currentTimeRef.current ?? 0
    console.log(
      `[SamplePicker] Play from ${start.toFixed(3)}s, ` +
      `duration=${duration.toFixed(3)}s`
    )
    window.xleth?.audio?.playSource(start).catch(e =>
      console.error('[SamplePicker] playSource error:', e)
    )
    playingRef.current = true
    setPlaying(true)
  }, [inPoint, duration])

  // Stable ref so the keydown effect doesn't re-register on every inPoint/duration change
  const handlePlaySelectionRef = useRef(handlePlaySelection)
  useEffect(() => { handlePlaySelectionRef.current = handlePlaySelection }, [handlePlaySelection])

  // ── Add sample ─────────────────────────────────────────────────────────────
  const handleAddSample = useCallback(async () => {
    if (isAddingRef.current) return          // block overlapping invocations
    if (inPoint === null || outPoint === null) return
    const start = Math.min(inPoint, outPoint)
    const end   = Math.max(inPoint, outPoint)
    if (end - start < 0.01) return  // degenerate selection

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

      console.log(`[SamplePicker] Sample added: id=${newSample.id}`)
    } finally {
      isAddingRef.current = false
      if (didIncrementPending) {
        pendingCountRef.current = Math.max(0, pendingCountRef.current - 1)
      }
    }
  }, [inPoint, outPoint, label, sampleName, source.id, source.filePath, sampleNameIsUserEdited])

  // ── Delete sample ──────────────────────────────────────────────────────────
  const handleDeleteSample = useCallback(async (id) => {
    console.log(`[SamplePicker] Deleting sample: id=${id}`)
    try {
      await window.xleth?.timeline?.removeRegion(id)
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
    } catch (e) {
      console.warn('[SamplePicker] removeRegion failed:', e.message)
    }
    setSamples(prev => prev.filter(s => s.id !== id))
    if (selectedId === id) setSelectedId(null)
  }, [selectedId])

  // ── Select sample from list ────────────────────────────────────────────────
  const handleSelectSample = useCallback((sample) => {
    setSelectedId(sample.id)
    setInPoint(sample.startTime)
    setOutPoint(sample.endTime)
    handleSeek(sample.startTime)
    console.log(`[SamplePicker] Sample selected: "${sample.name}"`)
  }, [handleSeek])

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

  // ── Syllable editing (inline for selected Quote region) ───────────────────
  const selectedSample = samples.find(s => s.id === selectedId) || null
  const handleSaveSyllables = useCallback(async (syllables) => {
    if (!selectedId) return
    try {
      await window.xleth?.timeline?.setSyllables(selectedId, syllables)
      // Reflect locally so the splitter's initial state stays in sync
      setSamples(prev => prev.map(s => s.id === selectedId ? { ...s, syllables } : s))
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'))
      console.log(`[SamplePicker] Saved ${syllables.length} syllable(s) for region ${selectedId}`)
    } catch (e) {
      console.error('[SamplePicker] setSyllables failed:', e)
    }
  }, [selectedId])

  // ── Keyboard shortcuts (capture phase overrides TransportBar) ──────────────
  // handlePlaySelectionRef used instead of handlePlaySelection directly so this
  // effect re-registers only when handleSetIn/handleSetOut/onClose change (rare),
  // not on every inPoint/duration change that recreates handlePlaySelection.
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      if (e.key === 'i' || e.key === 'I') {
        e.stopImmediatePropagation()
        handleSetIn()
      } else if (e.key === 'o' || e.key === 'O') {
        e.stopImmediatePropagation()
        handleSetOut()
      } else if (e.key === ' ') {
        e.preventDefault()
        e.stopImmediatePropagation()
        handlePlaySelectionRef.current()
      } else if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [handleSetIn, handleSetOut, onClose])

  // ── Render ─────────────────────────────────────────────────────────────────
  const allLabels = [...DEFAULT_LABELS, ...customLabels]

  return (
    <div className="sample-picker">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="sample-picker-header">
        <button className="sample-picker-back" onClick={onClose} title="Back (Esc)">
          <ArrowLeft size={14} />
          <span>Back</span>
        </button>
        <span className="sample-picker-source-name" title={source.filePath}>
          {source.name}
        </span>
        {source.width && (
          <span className="sample-picker-source-meta">
            {source.width}×{source.height} · {Math.round(source.fps || 0)}fps
          </span>
        )}
      </div>

      {/* ── Video preview ──────────────────────────────────────────────── */}
      {source.hasVideo !== false && (
        <PickerVideoPreview
          filePath={source.filePath}
          currentTime={currentTime}
          isPlaying={playing}
        />
      )}

      {/* ── Waveform + scrubber ────────────────────────────────────────── */}
      <WaveformScrubber
        filePath={source.filePath}
        waveformData={waveformData}
        waveformError={waveformError}
        duration={duration}
        currentTime={currentTime}
        inPoint={inPoint}
        outPoint={outPoint}
        onSeek={handleSeek}
        onInChange={setInPoint}
        onOutChange={setOutPoint}
      />

      {/* ── Controls row ───────────────────────────────────────────────── */}
      <ControlsRow
        playing={playing}
        label={label}
        sampleName={sampleName}
        inPoint={inPoint}
        outPoint={outPoint}
        duration={duration}
        allLabels={allLabels}
        onPlaySelection={handlePlaySelection}
        onSetIn={handleSetIn}
        onSetOut={handleSetOut}
        onLabelChange={handleLabelChange}
        onNameChange={handleNameChange}
        onAddSample={handleAddSample}
        onAddCustomLabel={handleAddCustomLabel}
      />

      {/* ── Add-sample error (duplicate name) ─────────────────────────── */}
      {addSampleError && (
        <div
          className="picker-name-error"
          role="alert"
          style={{
            color: 'var(--theme-semantic-danger-text)',
            background: '#3a1e1e',
            padding: '6px 12px',
            margin: '4px 12px',
            borderRadius: '4px',
            fontSize: '12px',
          }}
        >
          {addSampleError}
        </div>
      )}

      {/* ── Syllable splitter (only when a Quote is selected) ──────────── */}
      {selectedSample && selectedSample.label === 'Quote' && (
        <SyllableSplitter
          region={selectedSample}
          sourceFilePath={source.filePath}
          sourceWaveform={waveformData}
          onSave={handleSaveSyllables}
          compact
        />
      )}

      {/* ── Marked samples list ────────────────────────────────────────── */}
      <MarkedSamplesList
        samples={samples}
        selectedId={selectedId}
        onSelect={handleSelectSample}
        onDelete={handleDeleteSample}
      />
    </div>
  )
}
