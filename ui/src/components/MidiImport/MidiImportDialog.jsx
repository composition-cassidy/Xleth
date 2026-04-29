import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import MidiTrackRow from './MidiTrackRow.jsx'
import { findMatchingSample, gmDrumName } from './filenameMatch.js'
import { useToast } from '../Toast.jsx'
import { PPQ } from '../../constants/timeline.js'

// ── Module-level helpers ──────────────────────────────────────────────────────

// Returns a flat array of output tracks post-drum-split, in engine-canonical order.
// Disabled source tracks are excluded. Used both to drive the UI and to build
// perTrackOptions for importFull.
function buildOutputTracks(sourceTracks, trackOptions) {
  const out = []
  for (const track of sourceTracks) {
    const opts = trackOptions[track.index]
    if (!opts || !opts.enabled) continue
    const splitDrums = !!track.isDrum && !!opts.splitByNote
    if (!splitDrums) {
      out.push({
        outputTrackIndex: out.length,
        sourceTrackIndex: track.index,
        isDrumSubTrack: false,
        drumPitch: null,
        name: track.name || `Track ${track.index + 1}`,
        noteCount: track.noteCount,
      })
    } else {
      for (const pitch of (track.uniqueNoteNumbers || [])) {
        out.push({
          outputTrackIndex: out.length,
          sourceTrackIndex: track.index,
          isDrumSubTrack: true,
          drumPitch: pitch,
          name: gmDrumName(pitch) ?? `Note ${pitch}`,
          noteCount: 0,
        })
      }
    }
  }
  return out
}

// Stable identity key for an output-track entry — survives outputTrackIndex reassignments.
function stableKey(entry) {
  return `${entry.sourceTrackIndex}:${entry.drumPitch ?? '_'}`
}

// Seed source-track-level options (enabled/splitByNote only — no sampleId here).
function initSourceTrackOptions(tracks) {
  const opts = {}
  for (const track of tracks) {
    if (track.noteCount === 0) continue
    opts[track.index] = {
      enabled: true,
      splitByNote: !!track.isDrum,
    }
  }
  return opts
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MidiImportDialog({ isOpen, onClose, initialFilePath }) {
  const { showToast } = useToast()
  const initialFilePathRef = useRef(initialFilePath)
  useEffect(() => { initialFilePathRef.current = initialFilePath }, [initialFilePath])

  const [phase, setPhase] = useState('idle') // idle | parsing | preview | importing | done | error
  const [filePath, setFilePath] = useState('')
  const [summary, setSummary] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [projectBpm, setProjectBpm] = useState(null)
  const [tempoOverride, setTempoOverride] = useState(true)
  // Source-track-level: { [sourceTrackIndex]: { enabled, splitByNote } }
  const [trackOptions, setTrackOptions] = useState({})
  // Output-track-level: { [outputTrackIndex]: { _stableKey, enabled, visualOnly, sampleId, name } }
  const [outputTrackOptions, setOutputTrackOptions] = useState({})
  const [sources, setSources] = useState([])

  // Fetch project BPM whenever the dialog opens.
  useEffect(() => {
    if (!isOpen) return
    window.xleth?.timeline?.getBPM?.()
      .then(bpm => { if (bpm != null) setProjectBpm(Number(bpm)) })
      .catch(() => {})
  }, [isOpen])

  // Drive the full open → file-pick → parse sequence.
  useEffect(() => {
    if (!isOpen) return

    setPhase('idle')
    setFilePath('')
    setSummary(null)
    setErrorMsg('')
    setTempoOverride(true)
    setTrackOptions({})
    setOutputTrackOptions({})
    setSources([])

    let cancelled = false

    async function run() {
      const fp = initialFilePathRef.current || await window.xleth?.dialog?.openMidiDialog?.()
      if (!fp || cancelled) {
        if (!cancelled) {
          console.log('[MidiImport] File picker cancelled — closing dialog')
          onClose()
        }
        return
      }

      console.log('[MidiImport] File selected:', fp)
      setFilePath(fp)
      setPhase('parsing')

      let raw
      try {
        raw = await window.xleth?.midi?.parseSummary?.(fp)
      } catch (e) {
        if (cancelled) return
        console.error('[MidiImport] parseSummary error:', e)
        setPhase('error')
        setErrorMsg(e?.message || 'parseSummary call failed')
        return
      }

      if (cancelled) return

      let parsed
      try {
        parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      } catch (e) {
        console.error('[MidiImport] JSON.parse failed:', e)
        setPhase('error')
        setErrorMsg('Failed to parse MIDI summary response')
        return
      }

      console.log('[MidiImport] Summary received:', parsed)

      if (!parsed?.ok) {
        console.warn('[MidiImport] Parse failure:', parsed?.reason)
        setPhase('error')
        setErrorMsg(parsed?.reason || 'Failed to read MIDI file')
        return
      }

      let srcs = []
      try {
        const fetched = await window.xleth?.timeline?.getRegions?.()
        srcs = Array.isArray(fetched) ? fetched : []
      } catch (e) {
        console.warn('[MidiImport] getRegions error:', e)
      }
      if (cancelled) return

      setSources(srcs)
      setSummary(parsed)
      setTrackOptions(initSourceTrackOptions(parsed.tracks || []))
      // outputTrackOptions seeded by reconciliation effect watching outputTracks
      setPhase('preview')
      console.log('[MidiImport] Phase → preview, tracks:', (parsed.tracks || []).filter(t => t.noteCount > 0).length)
    }

    run()
    return () => { cancelled = true }
  }, [isOpen]) // onClose intentionally omitted — stable ref not guaranteed

  // Auto-close 2 s after done phase.
  useEffect(() => {
    if (phase !== 'done') return
    const t = setTimeout(() => onClose(), 2000)
    return () => clearTimeout(t)
  }, [phase, onClose])

  // ── Flat output-track list ──────────────────────────────────────────────────
  const outputTracks = useMemo(
    () => summary ? buildOutputTracks(summary.tracks || [], trackOptions) : [],
    [summary, trackOptions]
  )

  // ── Reconcile outputTrackOptions whenever outputTracks changes ──────────────
  // Carries forward existing entries by stableKey so user selections survive
  // splitByNote toggles and parent enable/disable. Seeds new entries via auto-match.
  // sources captured from render closure — correct at the time outputTracks changes.
  // sources intentionally excluded from deps — auto-match runs on seed only.
  useEffect(() => {
    setOutputTrackOptions(prev => {
      const prevByStableKey = {}
      for (const opts of Object.values(prev)) {
        if (opts._stableKey) prevByStableKey[opts._stableKey] = opts
      }
      const next = {}
      for (const ot of outputTracks) {
        const key = stableKey(ot)
        if (prevByStableKey[key]) {
          next[ot.outputTrackIndex] = prevByStableKey[key]
        } else {
          const matched = findMatchingSample(ot.name, sources)
          if (matched) {
            console.log(`[MidiImport] Auto-match: "${ot.name}" → "${matched.name}" (regionId=${matched.id})`)
          } else {
            console.log(`[MidiImport] Auto-match: "${ot.name}" → none`)
          }
          next[ot.outputTrackIndex] = {
            _stableKey: key,
            enabled: true,
            visualOnly: false,
            sampleId: matched?.id ?? null,
            name: ot.name,
          }
        }
      }
      return next
    })
  }, [outputTracks]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Strict validation gate ──────────────────────────────────────────────────
  const canImport = useMemo(() => {
    if (!outputTracks.length) return false
    return outputTracks.every(ot => {
      const opts = outputTrackOptions[ot.outputTrackIndex]
      if (!opts) return false
      if (!opts.enabled) return true  // disabled rows skip validation
      return opts.sampleId != null && Number(opts.sampleId) >= 0
    })
  }, [outputTracks, outputTrackOptions])

  const enabledCount = useMemo(
    () => outputTracks.filter(ot => outputTrackOptions[ot.outputTrackIndex]?.enabled).length,
    [outputTracks, outputTrackOptions]
  )

  const missingSampleCount = useMemo(
    () => outputTracks.filter(ot => {
      const o = outputTrackOptions[ot.outputTrackIndex]
      return o?.enabled && (o.sampleId == null || Number(o.sampleId) < 0)
    }).length,
    [outputTracks, outputTrackOptions]
  )

  // ── Two-step commit flow ────────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!summary || !filePath) return
    if (!canImport) {
      console.log('[MidiImport] Import blocked:', missingSampleCount, 'tracks missing sample assignment')
      return
    }

    setPhase('importing')
    console.log('[MidiImport] Import begin: tempoOverride=', tempoOverride, 'output tracks=', outputTracks.length)

    // Two RAFs so phase='importing' paints before synchronous bridge calls freeze the renderer.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    const t0 = performance.now()

    try {
      const enabledTrackIndices = []
      const perTrackOptions = {}
      for (const srcTrack of (summary.tracks || [])) {
        const opts = trackOptions[srcTrack.index]
        if (!opts || !opts.enabled) continue
        enabledTrackIndices.push(srcTrack.index)
        const splitDrums = !!srcTrack.isDrum && !!opts.splitByNote
        const enabledSubNotes = splitDrums
          ? (srcTrack.uniqueNoteNumbers || []).filter(pitch => {
              const ot = outputTracks.find(o => o.sourceTrackIndex === srcTrack.index && o.drumPitch === pitch)
              return ot ? (outputTrackOptions[ot.outputTrackIndex]?.enabled !== false) : false
            })
          : []
        perTrackOptions[String(srcTrack.index)] = { splitDrums, enabledSubNotes }
      }

      const projectBPM = projectBpm ?? summary.sourceTempo ?? 120

      const importOptions = {
        enabledTrackIndices,
        perTrackOptions,
        tempoOverride,
        projectTPQ: PPQ,
        projectBPM,
      }

      console.log('[MidiImport] Import payload:', importOptions)

      const { metadata, noteData } = await window.xleth.midi.importFull(filePath, importOptions)
      const t1 = performance.now()
      console.log('[MidiImport] importFull complete:', (t1 - t0).toFixed(1), 'ms', 'noteData bytes=', noteData?.byteLength ?? 'unknown')

      const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata

      if (meta.outputTracks.length !== outputTracks.length) {
        console.warn('[MidiImport] Output track count mismatch — engine:', meta.outputTracks.length,
                     'renderer:', outputTracks.length)
      }

      const commitOptions = {
        tempoOverride,
        sourceBPM: meta.sourceTempo ?? summary.sourceTempo,
        projectTPQ: PPQ,
        outputTracks: meta.outputTracks.map((ot, i) => {
          const userOpts = outputTrackOptions[i]
          return {
            outputTrackIndex: i,
            name: userOpts?.name ?? ot.name,
            visualOnly: userOpts?.visualOnly ?? false,
            regionId: Number(userOpts?.sampleId ?? -1),
          }
        }),
      }

      await window.xleth.midi.executeImport(noteData, commitOptions)
      const t2 = performance.now()
      console.log('[MidiImport] executeImport complete:', (t2 - t1).toFixed(1), 'ms', 'total=', (t2 - t0).toFixed(1), 'ms')

      showToast(`Imported ${enabledCount} track${enabledCount === 1 ? '' : 's'} — Ctrl+Z to undo`, 'success')
      setPhase('done')
    } catch (err) {
      console.error('[MidiImport] Import failed:', err)
      setErrorMsg(String(err?.message ?? err))
      setPhase('error')
    }
  }, [summary, filePath, canImport, missingSampleCount, tempoOverride, outputTracks, outputTrackOptions, trackOptions, enabledCount, projectBpm, showToast])

  if (!isOpen) return null

  const fileName = filePath ? filePath.replace(/\\/g, '/').split('/').pop() : ''
  const filteredSourceTracks = summary ? (summary.tracks || []).filter(t => t.noteCount > 0) : []

  // Builds the outputOptions prop for a given source track. For non-split tracks,
  // returns a single options object (or null if disabled). For split-drum tracks,
  // returns an array of { pitch, outputTrackIndex, ...options } per sub-track.
  function resolveOutputOptionsForSourceTrack(sourceTrack) {
    const opts = trackOptions[sourceTrack.index]
    if (!opts?.enabled) return null
    const splitDrums = !!sourceTrack.isDrum && !!opts.splitByNote
    if (!splitDrums) {
      const ot = outputTracks.find(o => o.sourceTrackIndex === sourceTrack.index && !o.isDrumSubTrack)
      if (!ot) return null
      return { outputTrackIndex: ot.outputTrackIndex, ...(outputTrackOptions[ot.outputTrackIndex] ?? {}) }
    } else {
      return (sourceTrack.uniqueNoteNumbers || []).map(pitch => {
        const ot = outputTracks.find(o => o.sourceTrackIndex === sourceTrack.index && o.drumPitch === pitch)
        if (!ot) return null
        return { pitch, outputTrackIndex: ot.outputTrackIndex, ...(outputTrackOptions[ot.outputTrackIndex] ?? {}) }
      }).filter(Boolean)
    }
  }

  return (
    <div className="midi-dialog-backdrop" onClick={() => onClose()}>
      <div className="midi-dialog" onClick={e => e.stopPropagation()}>

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="midi-dialog-header">
          <span>Import MIDI</span>
          <button className="midi-dialog-close" onClick={onClose} title="Close">×</button>
        </div>

        {/* ── Body ───────────────────────────────────────────────────────── */}
        <div className="midi-dialog-body">

          {(phase === 'idle' || phase === 'parsing') && (
            <div className="midi-spinner-wrap">
              <div className="midi-spinner" />
              <span className="midi-spinner-label">
                {phase === 'idle' ? 'Opening file picker…' : 'Parsing MIDI file…'}
              </span>
            </div>
          )}

          {phase === 'importing' && (
            <div className="midi-spinner-wrap">
              <div className="midi-spinner" />
              <span className="midi-spinner-label">Importing MIDI…</span>
              <span className="midi-spinner-sub">This may take a few seconds for projects with multiple sources.</span>
            </div>
          )}

          {phase === 'error' && (
            <div className="midi-status-wrap midi-status-wrap--error">
              <span className="midi-status-icon">⚠</span>
              <span className="midi-status-msg">{errorMsg || 'An error occurred'}</span>
            </div>
          )}

          {phase === 'done' && (
            <div className="midi-status-wrap midi-status-wrap--done">
              <span className="midi-status-icon">✓</span>
              <span className="midi-status-msg">Import complete</span>
            </div>
          )}

          {phase === 'preview' && summary && (
            <>
              {/* File + tempo info */}
              <div className="midi-file-info">
                <span className="midi-file-name" title={filePath}>{fileName}</span>
                <span className="midi-bpm-line">
                  Source: {summary.sourceTempo?.toFixed(1)} BPM
                  {projectBpm != null ? ` | Project: ${projectBpm.toFixed(1)} BPM` : ''}
                </span>
              </div>

              <label className="midi-checkbox-row">
                <input
                  type="checkbox"
                  checked={tempoOverride}
                  onChange={e => setTempoOverride(e.target.checked)}
                />
                Override project tempo to match source
              </label>

              {summary.hasMidFileTempoChanges && (
                <div className="midi-warning-banner">
                  ⚠ MIDI contains tempo changes — only first tempo will be used
                </div>
              )}

              {/* Track list (zero-note tracks already excluded) */}
              <div className="midi-track-list">
                {filteredSourceTracks.map(track => (
                  <MidiTrackRow
                    key={track.index}
                    track={track}
                    parentOptions={trackOptions[track.index] ?? { enabled: true, splitByNote: !!track.isDrum }}
                    outputOptions={resolveOutputOptionsForSourceTrack(track)}
                    onParentChange={patch => setTrackOptions(prev => ({
                      ...prev,
                      [track.index]: { ...prev[track.index], ...patch },
                    }))}
                    onOutputChange={(outputTrackIndex, patch) => setOutputTrackOptions(prev => ({
                      ...prev,
                      [outputTrackIndex]: { ...prev[outputTrackIndex], ...patch },
                    }))}
                    sources={sources}
                  />
                ))}
              </div>
            </>
          )}

        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="midi-dialog-footer">
          {phase === 'done' ? (
            <button className="midi-btn-primary" onClick={onClose}>Close</button>
          ) : (
            <>
              <button onClick={onClose}>Cancel</button>
              {phase === 'preview' && (
                <button
                  className="midi-btn-primary"
                  onClick={handleImport}
                  disabled={!canImport}
                >
                  Import
                </button>
              )}
              {phase === 'error' && (
                <>
                  <button onClick={() => setPhase('preview')}>Back</button>
                  <button className="midi-btn-primary" onClick={onClose}>Close</button>
                </>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  )
}
