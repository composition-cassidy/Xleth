import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import MidiTrackRow from './MidiTrackRow.jsx'
import { gmDrumName, findMatchingTrack } from './filenameMatch.js'
import { MODE_NEW, MODE_UPDATE } from './MidiReimportModeSelect.jsx'
import { resolveAutoAssignment, rememberAssignments } from './assignmentMemory.js'
import { useToast } from '../Toast.jsx'
import { Button, Checkbox, Dialog, Progress, SegmentedControl, Select } from '../../ui-kit'
import styles from './MidiImport.module.css'
import { PPQ } from '../../constants/timeline.js'
import { getPickerPath, openFilePicker } from '../filePicker/filePickerService.js'

// ── Maximum note length clamp (MIDI import sanitation) ───────────────────────
// FL Studio drum-roll exports often produce hugely long note-offs for sample
// triggers. Each output track (drum slot or melodic track) gets its own clamp
// so a kick/snare can be capped at 1/16 while a lead can be left untouched.
// Note starts are never modified by the clamp. denom = 0 means Off; otherwise
// denom is the note-value denominator (4 = quarter, 16 = sixteenth, etc.).
//
// localStorage stores the *default* applied to each newly-seen output track.
// Changing a row's value affects only the current import; the default is not
// auto-updated, since per-track names differ wildly across MIDI files.
import {
  DEFAULT_MAX_NOTE_LENGTH_DENOM,
  readDefaultMaxNoteLengthDenom,
  denomToTicks,
} from './maxNoteLength.js'
import { DEFAULT_TRANSPOSE_SEMITONES, clampTransposeSemitones } from './transpose.js'
import { playheadClock } from '../../services/PlayheadClock.js'
import { beatsToTicks } from '../../constants/timeline.js'
import { iconComponent } from '../../ui-kit/icons'

const IcCheckCircle = iconComponent('check-circle')
const IcWarning = iconComponent('warning')

// ── Placement (dialog-level, one set per import) ─────────────────────────────
// Position and tile-to-fill apply to CREATE rows only; re-import (update) rows
// always preserve the target track's existing block placements. "At playhead"
// reads the renderer's existing playhead mirror (playheadClock, fed by
// transport IPC via TimelineView) rather than adding a new bridge call, and
// the resolved tick is sent explicitly in commitOptions -- the engine command
// never reads transport state itself.
export const POSITION_START = 'start'
export const POSITION_PLAYHEAD = 'playhead'

export const MIDI_BPM_MATCH_TOLERANCE = 0.05

// ── FL Studio projects ───────────────────────────────────────────────────────
// A .flp is converted to a temp MIDI file in the main process (flp.convert,
// electron-main/flp-import.js) and then runs through the exact same midi.*
// pipeline. One output row per FL channel, named after the channel.
export const IMPORT_FILE_FILTERS = [
  { name: 'MIDI and FL Studio projects', extensions: ['mid', 'midi', 'flp'] },
  { name: 'MIDI Files', extensions: ['mid', 'midi'] },
  { name: 'FL Studio projects', extensions: ['flp'] },
]

export function isFlpPath(fp) {
  return /\.flp$/i.test(String(fp || ''))
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// The detail lines an FLP import adds under the placement options. Pure, so the
// wording is unit-tested without rendering the dialog.
export function buildFlpDetails(info) {
  if (!info) return []
  const lines = []
  if (info.pattern) {
    lines.push(`Playlist is empty: importing pattern “${info.pattern.name}” from the start`)
  }
  if (info.hasTempoAutomation) {
    lines.push(`Tempo automation: first tempo only (${Number(info.startBpm).toFixed(1)} BPM)`)
  }
  if (!info.includeMuted) {
    const parts = []
    if (info.mutedTracks?.length) parts.push(plural(info.mutedTracks.length, 'playlist track'))
    if (info.mutedClips > 0) parts.push(plural(info.mutedClips, 'clip'))
    if (parts.length) lines.push(`Muted, skipped: ${parts.join(', ')}`)
  }
  if (info.audioClipTracks > 0) {
    lines.push('Audio clips: one hit per clip, from the sample start')
  }
  return lines
}

export function hasFlpMutedContent(info) {
  return !!info && ((info.mutedTracks?.length || 0) > 0 || info.mutedClips > 0 || info.mutedNotes > 0)
}

export function flpVersionLabel(version) {
  const [major, minor] = String(version || '').split('.')
  return major ? `FL Studio ${major}${minor ? `.${minor}` : ''}` : 'FL Studio'
}

export function areBpmsEffectivelyEqual(sourceBpm, projectBpm, tolerance = MIDI_BPM_MATCH_TOLERANCE) {
  const source = Number(sourceBpm)
  const project = Number(projectBpm)
  if (!Number.isFinite(source) || !Number.isFinite(project)) return false
  return Math.abs(source - project) <= tolerance
}

export function getEffectiveTempoOverride(tempoOverride, sourceBpm, projectBpm) {
  return areBpmsEffectivelyEqual(sourceBpm, projectBpm) ? false : !!tempoOverride
}

export function getRegionDisplayName(region, source) {
  return region?.name
    || region?.label
    || source?.fileName
    || source?.filePath?.replace(/\\/g, '/').split('/').pop()
    || `Sample ${region?.id ?? ''}`.trim()
}

export function getRegionPreviewTime(region, source) {
  const start = Number(region?.startTime)
  const end = Number(region?.endTime)
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    return start + Math.min(0.1, (end - start) * 0.25)
  }
  if (Number.isFinite(start)) return start
  const duration = Number(source?.duration)
  return Number.isFinite(duration) && duration > 0 ? Math.min(duration * 0.25, 1) : 0
}

export function buildSamplePickerItems(regions = [], sourceMedia = []) {
  const sourceById = new Map((sourceMedia || []).map(source => [String(source.id), source]))
  return (regions || []).map(region => {
    const source = sourceById.get(String(region.sourceId)) || null
    const name = getRegionDisplayName(region, source)
    const duration = Number(region?.endTime) - Number(region?.startTime)
    return {
      id: region.id,
      name,
      subLabel: source?.fileName || region?.label || null,
      title: source?.filePath || name,
      region,
      source,
      previewTime: getRegionPreviewTime(region, source),
      duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    }
  })
}

// ── Module-level helpers ──────────────────────────────────────────────────────

// Returns a flat array of output tracks post-drum-split, in engine-canonical order.
// Disabled source tracks are excluded. Used both to drive the UI and to build
// perTrackOptions for importFull.
export function buildOutputTracks(sourceTracks, trackOptions) {
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

export function buildMidiImportOptions({
  summary,
  trackOptions,
  outputTracks,
  outputTrackOptions,
  projectBpm,
  tempoOverride,
  trimLeadingSilence = false,
}) {
  const enabledTrackIndices = []
  const perTrackOptions = {}
  for (const srcTrack of (summary?.tracks || [])) {
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

  const projectBPM = projectBpm ?? summary?.sourceTempo ?? 120
  const maxNoteLengthByOutputTrack = outputTracks.map(ot => {
    const opts = outputTrackOptions[ot.outputTrackIndex]
    const denom = opts?.maxNoteLengthDenom ?? DEFAULT_MAX_NOTE_LENGTH_DENOM
    return denomToTicks(denom)
  })
  // Drum sub-tracks never show a transpose control (transposing a routed drum
  // note is meaningless), so they always carry the default of 0 (no shift).
  const transposeByOutputTrack = outputTracks.map(ot => {
    const opts = outputTrackOptions[ot.outputTrackIndex]
    return clampTransposeSemitones(opts?.transposeSemitones ?? DEFAULT_TRANSPOSE_SEMITONES)
  })

  return {
    enabledTrackIndices,
    perTrackOptions,
    tempoOverride: getEffectiveTempoOverride(tempoOverride, summary?.sourceTempo, projectBpm),
    projectTPQ: PPQ,
    projectBPM,
    maxNoteLengthByOutputTrack,
    transposeByOutputTrack,
    trimLeadingSilence: !!trimLeadingSilence,
  }
}

// ── Re-import mode ────────────────────────────────────────────────────────────
// A row is either 'new' (create a fresh Pattern track, the original behaviour)
// or 'update' (rewrite the notes of the pattern already on targetTrackId).
// Defined by the control that sets them; re-exported here because the commit
// payload builders below are the other half of the same contract.
export { MODE_NEW, MODE_UPDATE } from './MidiReimportModeSelect.jsx'

// Resolves one row's stored mode into the { mode, targetTrackId } pair the
// engine expects. A row that says 'update' but whose target has disappeared
// from the timeline since the dialog opened falls back to 'new': the engine
// would hard-fail it otherwise, losing the notes entirely.
export function resolveRowMode(opts, targets) {
  if (opts?.mode !== MODE_UPDATE) return { mode: MODE_NEW, targetTrackId: -1 }
  const targetId = Number(opts.targetTrackId)
  const target = (targets || []).find(t => Number(t.trackId) === targetId)
  if (!target || target.eligible === false) {
    return { mode: MODE_NEW, targetTrackId: -1 }
  }
  return { mode: MODE_UPDATE, targetTrackId: targetId }
}

export function buildMidiCommitOptions({
  metadata,
  summary,
  outputTrackOptions,
  tempoOverride,
  projectBpm,
  reimportTargets = [],
  // Placement — resolved by the caller (handleImport) before this is built,
  // since "at playhead" reads live renderer state and this function stays a
  // pure mapper. Both are Create-row-only; the engine ignores them for update
  // rows regardless of what is sent.
  positionTicks = 0,
  tileToFillProject = false,
}) {
  return {
    tempoOverride: getEffectiveTempoOverride(tempoOverride, metadata?.sourceTempo ?? summary?.sourceTempo, projectBpm),
    sourceBPM: metadata?.sourceTempo ?? summary?.sourceTempo,
    projectTPQ: PPQ,
    positionTicks: Math.max(0, Math.round(Number(positionTicks) || 0)),
    tileToFillProject: !!tileToFillProject,
    outputTracks: (metadata?.outputTracks || []).map((ot, i) => {
      const userOpts = outputTrackOptions[i]
      const { mode, targetTrackId } = resolveRowMode(userOpts, reimportTargets)
      return {
        outputTrackIndex: i,
        // In update mode the engine keeps the track's OWN name (the user may
        // have renamed it since the first import); this is still sent because
        // it names a pattern seeded into a previously empty target track.
        name: userOpts?.name ?? ot.name,
        visualOnly: userOpts?.visualOnly ?? false,
        regionId: Number(userOpts?.sampleId ?? -1),
        mode,
        targetTrackId,
      }
    }),
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MidiImportDialog({ isOpen, onClose, initialFilePath }) {
  const { showToast } = useToast()
  const initialFilePathRef = useRef(initialFilePath)
  useEffect(() => { initialFilePathRef.current = initialFilePath }, [initialFilePath])

  const [phase, setPhase] = useState('idle') // idle | parsing | preview | importing | done | error
  // filePath is what the engine reads (the .mid, or the temp .mid made from a
  // .flp); sourcePath is what the user picked and what the dialog shows.
  const [filePath, setFilePath] = useState('')
  const [sourcePath, setSourcePath] = useState('')
  const [flpInfo, setFlpInfo] = useState(null)
  const [summary, setSummary] = useState(null)
  const [errorMsg, setErrorMsg] = useState('')
  const [projectBpm, setProjectBpm] = useState(null)
  const [tempoOverride, setTempoOverride] = useState(true)
  // Placement (dialog-level, one set per import — Create rows only).
  const [positionMode, setPositionMode] = useState(POSITION_START)
  const [trimLeadingSilence, setTrimLeadingSilence] = useState(false)
  const [tileToFillProject, setTileToFillProject] = useState(false)
  // Source-track-level: { [sourceTrackIndex]: { enabled, splitByNote } }
  const [trackOptions, setTrackOptions] = useState({})
  // Output-track-level: { [outputTrackIndex]: { _stableKey, enabled, visualOnly, sampleId, name } }
  const [outputTrackOptions, setOutputTrackOptions] = useState({})
  const [regions, setRegions] = useState([])
  const [sourceMedia, setSourceMedia] = useState([])
  // Existing Pattern tracks that a row can be re-imported INTO, resolved
  // engine-side (midi.getReimportTargets).
  const [reimportTargets, setReimportTargets] = useState([])

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
    setSourcePath('')
    setFlpInfo(null)
    setSummary(null)
    setErrorMsg('')
    setTempoOverride(true)
    setPositionMode(POSITION_START)
    setTrimLeadingSilence(false)
    setTileToFillProject(false)
    setTrackOptions({})
    setOutputTrackOptions({})
    setRegions([])
    setSourceMedia([])
    setReimportTargets([])

    let cancelled = false

    async function run() {
      let fp = initialFilePathRef.current
      if (!fp) {
        const picked = await openFilePicker({
          mode: 'openFile',
          title: 'Import MIDI or FL Studio project',
          subtitle: 'Choose a MIDI file or an FL Studio project (.flp) to map into the project.',
          actionLabel: 'Import',
          filters: IMPORT_FILE_FILTERS,
          legacyPicker: () => window.xleth?.dialog?.openMidiDialog?.(),
        })
        fp = getPickerPath(picked)
      }
      if (!fp || cancelled) {
        if (!cancelled) {
          console.log('[MidiImport] File picker cancelled — closing dialog')
          onClose()
        }
        return
      }

      console.log('[MidiImport] File selected:', fp)
      setSourcePath(fp)
      setPhase('parsing')

      // FLP: convert to a temp MIDI first. A project whose arrangement is all
      // muted retries with muted content included, so there is something to
      // show (the checkbox then reads ticked and can be cleared).
      let enginePath = fp
      if (isFlpPath(fp)) {
        let flp
        try {
          flp = await window.xleth?.flp?.convert?.(fp, {})
          if (flp && !flp.ok && flp.info?.mutedNotes > 0) {
            flp = await window.xleth?.flp?.convert?.(fp, { includeMuted: true })
          }
        } catch (e) {
          flp = { ok: false, reason: e?.message }
        }
        if (cancelled) return
        if (!flp?.ok) {
          console.warn('[MidiImport] FLP convert failure:', flp?.reason)
          setPhase('error')
          setErrorMsg(flp?.reason || "Couldn't read the FL Studio project")
          return
        }
        console.log('[MidiImport] FLP converted:', flp.midiPath, flp.info)
        enginePath = flp.midiPath
        setFlpInfo(flp.info)
      }
      setFilePath(enginePath)

      let raw
      try {
        raw = await window.xleth?.midi?.parseSummary?.(enginePath)
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

      let fetchedRegions = []
      let fetchedSources = []
      let fetchedTargets = []
      try {
        const [regionResult, sourceResult, targetResult] = await Promise.allSettled([
          window.xleth?.timeline?.getRegions?.(),
          window.xleth?.timeline?.getSources?.(),
          window.xleth?.midi?.getReimportTargets?.(),
        ])
        fetchedRegions = regionResult.status === 'fulfilled' && Array.isArray(regionResult.value)
          ? regionResult.value
          : []
        fetchedSources = sourceResult.status === 'fulfilled' && Array.isArray(sourceResult.value)
          ? sourceResult.value
          : []
        fetchedTargets = targetResult.status === 'fulfilled' && Array.isArray(targetResult.value)
          ? targetResult.value
          : []
        if (targetResult.status !== 'fulfilled' || !Array.isArray(targetResult.value)) {
          // Four-layer bridge: an unwired call resolves to undefined rather than
          // throwing, so say so loudly instead of silently offering no targets.
          console.warn('[MidiImport] getReimportTargets unavailable — re-import mode disabled',
                       targetResult.status === 'rejected' ? targetResult.reason : targetResult.value)
        }
      } catch (e) {
        console.warn('[MidiImport] timeline media fetch error:', e)
      }
      if (cancelled) return

      console.log('[MidiImport] Re-import targets:', fetchedTargets)
      setRegions(fetchedRegions)
      setSourceMedia(fetchedSources)
      setReimportTargets(fetchedTargets)
      setSummary(parsed)
      setTrackOptions(initSourceTrackOptions(parsed.tracks || []))
      // outputTrackOptions seeded by reconciliation effect watching outputTracks
      setPhase('preview')
      console.log('[MidiImport] Phase → preview, tracks:', (parsed.tracks || []).filter(t => t.noteCount > 0).length)
    }

    run()
    return () => { cancelled = true }
  }, [isOpen]) // onClose intentionally omitted — stable ref not guaranteed

  // FLP: switching arrangement or the muted filter re-converts and re-reads
  // the summary. Rows reseed (auto-match runs again) because track indices
  // change with the content.
  const reloadFlp = useCallback(async (patch) => {
    if (!flpInfo || !sourcePath) return
    const options = {
      arrangementIndex: flpInfo.arrangementIndex,
      includeMuted: flpInfo.includeMuted,
      patternIid: flpInfo.pattern?.iid ?? null,
      ...patch,
    }
    setPhase('parsing')
    try {
      const res = await window.xleth.flp.convert(sourcePath, options)
      if (!res?.ok) throw new Error(res?.reason || "Couldn't read the FL Studio project")
      const raw = await window.xleth.midi.parseSummary(res.midiPath)
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!parsed?.ok) throw new Error(parsed?.reason || 'Failed to read the converted project')
      setFlpInfo(res.info)
      setFilePath(res.midiPath)
      setSummary(parsed)
      setTrackOptions(initSourceTrackOptions(parsed.tracks || []))
      setOutputTrackOptions({})
      setPhase('preview')
    } catch (e) {
      console.warn('[MidiImport] FLP reload failed:', e)
      setErrorMsg(String(e?.message ?? e))
      setPhase('error')
    }
  }, [flpInfo, sourcePath])

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

  const sampleItems = useMemo(
    () => buildSamplePickerItems(regions, sourceMedia),
    [regions, sourceMedia]
  )

  // ── Reconcile outputTrackOptions whenever outputTracks changes ──────────────
  // Carries forward existing entries by stableKey so user selections survive
  // splitByNote toggles and parent enable/disable. Seeds new entries via auto-match.
  // regions and reimportTargets captured from the render closure — both are set
  // in the same batch that sets summary, so they are populated by the time
  // outputTracks first becomes non-empty.
  // Deliberately excluded from deps — auto-match runs on seed only.
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
          // Precedence: remembered assignment (from a prior import of this
          // track name) first, then scored fuzzy match against the GM alias
          // table and region names.
          const { region: matched, source: matchSource } = resolveAutoAssignment(ot.name, regions)
          if (matched) {
            console.log(`[MidiImport] Auto-match (${matchSource}): "${ot.name}" → "${matched.name}" (regionId=${matched.id})`)
          } else {
            console.log(`[MidiImport] Auto-match: "${ot.name}" → none`)
          }

          // Re-import: an existing Pattern track whose name matches becomes the
          // default target, so the common case (same MIDI, edited in the DAW)
          // needs no clicks. No match → 'new', the original behaviour.
          const matchedTrack = findMatchingTrack(ot.name, reimportTargets)
          if (matchedTrack) {
            console.log(`[MidiImport] Track-match: "${ot.name}" → update trackId=${matchedTrack.trackId} ("${matchedTrack.name}")`)
          }

          // When updating, the track's CURRENT binding is ground truth and wins
          // over the auto-match: it is what is actually playing on the timeline.
          // regionId -1 on the target means "unassigned", in which case the
          // auto-match still gets to suggest something.
          const targetRegionId = Number(matchedTrack?.regionId ?? -1)
          const seededSampleId = (matchedTrack && targetRegionId >= 0)
            ? targetRegionId
            : (matched?.id ?? null)

          next[ot.outputTrackIndex] = {
            _stableKey: key,
            enabled: true,
            visualOnly: false,
            sampleId: seededSampleId,
            name: ot.name,
            maxNoteLengthDenom: readDefaultMaxNoteLengthDenom(),
            transposeSemitones: DEFAULT_TRANSPOSE_SEMITONES,
            mode: matchedTrack ? MODE_UPDATE : MODE_NEW,
            targetTrackId: matchedTrack ? Number(matchedTrack.trackId) : -1,
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
      return opts.enabled !== false
    })
  }, [outputTracks, outputTrackOptions])

  const enabledCount = useMemo(
    () => outputTracks.filter(ot => outputTrackOptions[ot.outputTrackIndex]?.enabled).length,
    [outputTracks, outputTrackOptions]
  )


  // ── Two-step commit flow ────────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (!summary || !filePath) return
    if (!canImport) {
      console.log('[MidiImport] Import blocked: output track options incomplete')
      return
    }

    const effectiveTempoOverride = getEffectiveTempoOverride(tempoOverride, summary.sourceTempo, projectBpm)

    // Resolved now, at click time, from the renderer's existing playhead
    // mirror -- NOT read again later, and never by the engine command itself.
    const resolvedPositionTicks = positionMode === POSITION_PLAYHEAD
      ? Math.max(0, beatsToTicks(playheadClock.positionBeats))
      : 0

    setPhase('importing')
    console.log('[MidiImport] Import begin: tempoOverride=', effectiveTempoOverride, 'output tracks=', outputTracks.length,
                'positionMode=', positionMode, 'positionTicks=', resolvedPositionTicks,
                'trimLeadingSilence=', trimLeadingSilence, 'tileToFillProject=', tileToFillProject)

    // Two RAFs so phase='importing' paints before synchronous bridge calls freeze the renderer.
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))

    const t0 = performance.now()

    try {
      const importOptions = buildMidiImportOptions({
        summary,
        trackOptions,
        outputTracks,
        outputTrackOptions,
        projectBpm,
        tempoOverride,
        trimLeadingSilence,
      })

      console.log('[MidiImport] Import payload:', importOptions)

      const { metadata, noteData } = await window.xleth.midi.importFull(filePath, importOptions)
      const t1 = performance.now()
      console.log('[MidiImport] importFull complete:', (t1 - t0).toFixed(1), 'ms', 'noteData bytes=', noteData?.byteLength ?? 'unknown')

      const meta = typeof metadata === 'string' ? JSON.parse(metadata) : metadata

      if (meta.outputTracks.length !== outputTracks.length) {
        console.warn('[MidiImport] Output track count mismatch — engine:', meta.outputTracks.length,
                     'renderer:', outputTracks.length)
      }

      const commitOptions = buildMidiCommitOptions({
        metadata: meta,
        summary,
        outputTrackOptions,
        tempoOverride,
        projectBpm,
        reimportTargets,
        positionTicks: resolvedPositionTicks,
        tileToFillProject,
      })

      const updateCount = commitOptions.outputTracks.filter(o => o.mode === MODE_UPDATE).length
      console.log('[MidiImport] Commit payload:', updateCount, 'update row(s),',
                  commitOptions.outputTracks.length - updateCount, 'new row(s)')

      await window.xleth.midi.executeImport(noteData, commitOptions)
      const t2 = performance.now()
      console.log('[MidiImport] executeImport complete:', (t2 - t1).toFixed(1), 'ms', 'total=', (t2 - t0).toFixed(1), 'ms')

      // Learn from this import: remember every enabled output track's final
      // name → sample assignment, including manual overrides, so a re-import
      // of the same (or similarly-named) tracks pre-fills next time.
      const assignmentEntries = outputTracks
        .filter(ot => outputTrackOptions[ot.outputTrackIndex]?.enabled !== false)
        .map(ot => {
          const opts = outputTrackOptions[ot.outputTrackIndex]
          const regionId = opts?.sampleId
          if (regionId == null || Number(regionId) < 0) return null
          const region = regions.find(r => String(r.id) === String(regionId))
          return {
            trackName: opts?.name ?? ot.name,
            regionId,
            regionName: region?.name ?? '',
          }
        })
        .filter(Boolean)
      if (assignmentEntries.length) {
        rememberAssignments(assignmentEntries)
      }

      const updatedRows = outputTracks.filter(ot => {
        const opts = outputTrackOptions[ot.outputTrackIndex]
        return opts?.enabled !== false
          && resolveRowMode(opts, reimportTargets).mode === MODE_UPDATE
      }).length
      const createdRows = enabledCount - updatedRows
      const summaryText = updatedRows === 0
        ? `Imported ${createdRows} track${createdRows === 1 ? '' : 's'}`
        : createdRows === 0
          ? `Updated ${updatedRows} track${updatedRows === 1 ? '' : 's'}`
          : `Updated ${updatedRows}, imported ${createdRows}`
      showToast(`${summaryText} — Ctrl+Z to undo`, 'success')
      setPhase('done')
    } catch (err) {
      console.error('[MidiImport] Import failed:', err)
      setErrorMsg(String(err?.message ?? err))
      setPhase('error')
    }
  }, [summary, filePath, canImport, tempoOverride, outputTracks, outputTrackOptions, trackOptions, enabledCount, projectBpm, showToast, regions, reimportTargets, positionMode, trimLeadingSilence, tileToFillProject])

  if (!isOpen) return null

  const shownPath = sourcePath || filePath
  const fileName = shownPath ? shownPath.replace(/\\/g, '/').split('/').pop() : ''
  const isFlp = !!flpInfo
  const flpDetails = buildFlpDetails(flpInfo)
  const filteredSourceTracks = summary ? (summary.tracks || []).filter(t => t.noteCount > 0) : []
  const tempoBpmMatches = areBpmsEffectivelyEqual(summary?.sourceTempo, projectBpm)
  const pitchBendTrackCount = filteredSourceTracks.filter(track => track.hasPitchBend).length
  const unassignedOutputCount = outputTracks.filter(ot => {
    const opts = outputTrackOptions[ot.outputTrackIndex]
    return opts?.enabled !== false && (opts?.sampleId == null || Number(opts.sampleId) < 0)
  }).length

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

  const importing = phase === 'importing'
  const dialogTitle = isFlp ? 'Import FL Studio project' : 'Import MIDI'
  const readingFlp = isFlp || isFlpPath(sourcePath)
  const importLabel = enabledCount === 1 ? 'Import 1 track' : `Import ${enabledCount} tracks`

  return (
    <Dialog
      title={dialogTitle}
      width="xl"
      flush
      fill
      dismissable={!importing}
      onClose={onClose}
      actions={
        phase === 'done' ? (
          <Button size="lg" variant="primary" onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button size="lg" onClick={onClose} disabled={importing}>Cancel</Button>
            {phase === 'preview' && (
              <Button size="lg" variant="primary" onClick={handleImport} disabled={!canImport}>
                {importLabel}
              </Button>
            )}
            {phase === 'error' && (
              <>
                <Button size="lg" onClick={() => setPhase('preview')}>Back</Button>
                <Button size="lg" variant="primary" onClick={onClose}>Close</Button>
              </>
            )}
          </>
        )
      }
    >
      <div className={styles.root}>

        {(phase === 'idle' || phase === 'parsing') && (
          <div className={styles.status}>
            <Progress
              label={readingFlp ? 'Opening FL Studio project' : 'Opening MIDI file'}
              value={null}
              text={phase === 'idle'
                ? 'Opening file picker…'
                : readingFlp ? 'Reading FL Studio project…' : 'Parsing MIDI file…'}
            />
          </div>
        )}

        {importing && (
          <div className={styles.status}>
            <Progress
              label={isFlp ? 'Importing FL Studio project' : 'Importing MIDI'}
              value={null}
              text={isFlp ? 'Importing notes…' : 'Importing MIDI…'}
            />
            <span className={styles.statusSub}>This may take a few seconds for projects with multiple sources.</span>
          </div>
        )}

        {phase === 'error' && (
          <div className={styles.status}>
            <div className={styles.statusLine} data-tone="error" role="alert">
              <IcWarning size={16} aria-hidden="true" />
              <span>{errorMsg || 'An error occurred'}</span>
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className={styles.status}>
            <div className={styles.statusLine} data-tone="done">
              <IcCheckCircle size={16} aria-hidden="true" />
              <span>Import complete</span>
            </div>
          </div>
        )}

        {phase === 'preview' && summary && (
          <>
            {/* File + tempo info */}
            <div className={styles.fileInfo}>
              <span className={styles.fileName} title={shownPath}>{fileName}</span>
              <span className={styles.tempo}>
                {isFlp ? `${flpVersionLabel(flpInfo.version)} · ` : ''}
                Source {summary.sourceTempo?.toFixed(1)} BPM
                {projectBpm != null ? ` · Project ${projectBpm.toFixed(1)} BPM` : ''}
              </span>
            </div>

            <div className={styles.optionGroup}>
              <Checkbox
                checked={tempoBpmMatches ? false : tempoOverride}
                onChange={setTempoOverride}
                disabled={tempoBpmMatches}
              >
                Override project tempo to match source
              </Checkbox>
              {tempoBpmMatches && <span className={styles.note}>Already matches</span>}
            </div>

            {/* Placement — Create rows only; re-import rows always keep their
                existing block placement (see the per-row note below). */}
            <div className={styles.options} role="group" aria-label="Import placement">
              <div className={styles.optionGroup}>
                <span className={styles.label}>Position</span>
                <SegmentedControl
                  label="Import position"
                  options={[
                    { value: POSITION_START, label: 'Start of timeline' },
                    { value: POSITION_PLAYHEAD, label: 'At playhead' },
                  ]}
                  value={positionMode}
                  onChange={setPositionMode}
                />
              </div>
              <Checkbox checked={trimLeadingSilence} onChange={setTrimLeadingSilence}>Trim leading silence</Checkbox>
              <Checkbox checked={tileToFillProject} onChange={setTileToFillProject}>Loop pattern to fill project</Checkbox>
            </div>

            {/* FL Studio source: which arrangement to read, and whether muted
                playlist tracks and clips come along. Both re-read the project. */}
            {isFlp && (flpInfo.arrangements.length > 1 || flpInfo.patterns?.length > 1 || hasFlpMutedContent(flpInfo)) && (
              <div className={styles.options} role="group" aria-label="FL Studio project">
                {flpInfo.arrangements.length > 1 && (
                  <div className={styles.optionGroup}>
                    <span className={styles.label}>Arrangement</span>
                    <Select
                      size="sm"
                      ariaLabel="FL Studio arrangement"
                      value={flpInfo.arrangementIndex}
                      options={flpInfo.arrangements.map(a => ({ value: a.index, label: a.name }))}
                      onChange={(index) => reloadFlp({ arrangementIndex: index })}
                    />
                  </div>
                )}
                {flpInfo.pattern && flpInfo.patterns.length > 1 && (
                  <div className={styles.optionGroup}>
                    <span className={styles.label}>Pattern</span>
                    <Select
                      size="sm"
                      ariaLabel="FL Studio pattern"
                      value={flpInfo.pattern.iid}
                      options={flpInfo.patterns.map(x => ({ value: x.iid, label: x.name }))}
                      onChange={(iid) => reloadFlp({ patternIid: iid })}
                    />
                  </div>
                )}
                {hasFlpMutedContent(flpInfo) && (
                  <Checkbox
                    checked={flpInfo.includeMuted}
                    onChange={(checked) => reloadFlp({ includeMuted: checked })}
                  >
                    Include muted tracks and clips
                  </Checkbox>
                )}
              </div>
            )}

            {(summary.hasMidFileTempoChanges || pitchBendTrackCount > 0 || unassignedOutputCount > 0 || flpDetails.length > 0) && (
              <div className={styles.details} role="group" aria-label="Import details">
                {flpDetails.map(line => <span key={line}>{line}</span>)}
                {summary.hasMidFileTempoChanges && !isFlp && (
                  <span>MIDI tempo changes: first tempo only</span>
                )}
                {pitchBendTrackCount > 0 && (
                  <span>Pitch bend: skipped on {pitchBendTrackCount} track{pitchBendTrackCount === 1 ? '' : 's'}</span>
                )}
                {unassignedOutputCount > 0 && (
                  <span>Unassigned outputs: {unassignedOutputCount}</span>
                )}
              </div>
            )}

            {/* Track list (zero-note tracks already excluded) */}
            <div className={styles.tracks}>
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
                  sampleItems={sampleItems}
                  reimportTargets={reimportTargets}
                />
              ))}
            </div>
          </>
        )}

      </div>
    </Dialog>
  )
}
