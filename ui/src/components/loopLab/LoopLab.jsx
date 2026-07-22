import { useState, useEffect, useRef, useCallback } from 'react'
import LoopLabWaveform from './LoopLabWaveform.jsx'
import LoopLabRater from './LoopLabRater.jsx'
import Knob from '../sampler/Knob.jsx'
import {
  LOOP_LAB_CLASSES, BEHAVIOR_FAMILIES, deriveBehaviorFamily,
  autoName, loadStickyMeta, saveStickyMeta, metaIsComplete, clampCrossfade,
} from './loopLabMeta.js'
import './loopLab.css'

// ─── Loop Lab (DEV) ──────────────────────────────────────────────────────────
// A dev-mode overlay for authoring gold-standard sample loops and exporting a
// labelled corpus for the auto-loop optimizer. Its audible preview runs through
// the exact engine sampler codepath (timeline_previewNote → Sampler::processVoice),
// so what you hear here is what the real sampler produces. See
// docs/loop-lab-codepath-report.md for the full data-flow rationale.

const PREVIEW_VELOCITY = 0.8
const PUSH_DEBOUNCE_MS = 140

// Resolve a window.xleth bridge method, throwing if it is missing. The 4-layer
// bridge silently swallows undefined calls via optional chaining; asserting here
// turns a missing wrapper into a visible error instead of a no-op.
function bridgeFn(pathStr) {
  const parts = pathStr.split('.')
  let o = window.xleth
  for (const p of parts) o = o?.[p]
  if (typeof o !== 'function') throw new Error(`window.xleth.${pathStr} unavailable`)
  return o
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
// MIDI note number → scientific pitch name (60 → "C4"), for the Root Note knob.
function midiToNoteName(v) {
  const m = Math.round(v)
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`
}

let uidCounter = 1

export default function LoopLab({ onClose }) {
  const [sticky, setSticky] = useState(loadStickyMeta)
  // 'author' = label gold loops and export the corpus; 'rate' = blind A/B the
  // optimizer's candidates against those gold loops. Both drive the same engine
  // regions, so only one may hold the preview at a time.
  const [mode, setMode] = useState('author')
  const [samples, setSamples] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [status, setStatus] = useState('')
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [previewingId, setPreviewingId] = useState(null)

  const importCounter = useRef(1)         // zero-padded index for auto-naming
  const pushTimers = useRef({})           // regionId → debounce timer
  const samplesRef = useRef(samples)
  samplesRef.current = samples
  const previewingRef = useRef(null)
  previewingRef.current = previewingId
  const stickyRef = useRef(sticky)
  stickyRef.current = sticky
  const readyRef = useRef(false)          // true once initial restore finishes
  const saveTimer = useRef(null)          // debounced persistent-save timer
  const restoreStartedRef = useRef(false) // one-shot guard (survives StrictMode remount)

  const selected = samples.find((s) => s.id === selectedId) || null

  // Persist sticky metadata whenever it changes (survives app restarts).
  useEffect(() => { saveStickyMeta(sticky) }, [sticky])

  // Snapshot of the whole working set for the ONE permanent disk save. Reads
  // refs so it is safe to call from unmount. Engine-session ids (regionId/
  // sampleId) are intentionally NOT saved — they are re-created on restore.
  const buildState = useCallback(() => ({
    version: 1,
    sticky: stickyRef.current,
    importCounter: importCounter.current,
    samples: samplesRef.current.map((s) => ({
      filePath: s.filePath, name: s.name,
      className: s.className, instrumentName: s.instrumentName, source: s.source,
      rootNote: s.rootNote, behaviorFamily: s.behaviorFamily,
      loopStart: s.loopStart, loopEnd: s.loopEnd, xfade: s.xfade,
    })),
  }), [])

  // ── Engine settings push (debounced) + preview re-arm ───────────────────────
  const pushSettings = useCallback((sample, { reArm = true } = {}) => {
    const regionId = sample.regionId
    if (regionId == null) return
    clearTimeout(pushTimers.current[regionId])
    pushTimers.current[regionId] = setTimeout(async () => {
      try {
        await bridgeFn('timeline.updateSamplerSettings')(regionId, {
          loopEnabled: true,
          crossfadeEnabled: true,
          loopStart: sample.loopStart,
          loopEnd: sample.loopEnd,
          crossfadeSamples: sample.xfade,
          rootNote: sample.rootNote ?? 60,
        })
        // updateSamplerSettings rebuilds the preview sampler, dropping any held
        // voice — re-arm the loop so preview stays continuous with new params.
        if (reArm && previewingRef.current === sample.id) {
          const note = sample.rootNote ?? 60
          bridgeFn('timeline.previewAllNotesOff')(regionId)
          bridgeFn('timeline.previewNote')(regionId, note, PREVIEW_VELOCITY)
        }
      } catch (e) { setStatus(`Settings push failed: ${e.message}`) }
    }, PUSH_DEBOUNCE_MS)
  }, [])

  // ── Import one WAV through the engine ────────────────────────────────────────
  // Decodes the file into a scratch region and builds the panel sample. `saved`
  // (from the persisted state) supplies authoring fields to restore; when absent,
  // fresh defaults are used (quarter/three-quarter loop, C4). Loop points are
  // clamped to the region's actual length so a rate/length change across sessions
  // can't push them out of bounds. Returns the sample; caller appends it.
  const importOne = useCallback(async (filePath, authoring, saved) => {
    const hdr = await bridgeFn('loopLab.probeWav')(filePath)
    if (!hdr) throw new Error('not a readable WAV')
    const sampleId = await bridgeFn('audio.loadSourceRegion')(filePath, 0, hdr.durationSec)
    if (typeof sampleId !== 'number' || sampleId < 0) throw new Error('decode failed')
    const regionId = await bridgeFn('timeline.addRegion')({ name: authoring.name, audioFilePath: filePath })
    if (typeof regionId !== 'number' || regionId < 0) throw new Error('addRegion failed')
    await bridgeFn('audio.mapRegionToSample')(regionId, sampleId)
    const info = await bridgeFn('timeline.getRegionAudioInfo')(regionId)
    const numSamples = Number(info?.numSamples) || 0
    const sampleRate = Number(info?.engineSampleRate) || hdr.sampleRate
    if (numSamples <= 0) throw new Error('region has no audio')

    const clampN = (v) => Math.max(0, Math.min(Math.round(v), numSamples))
    let loopStart = saved && saved.loopStart != null ? clampN(saved.loopStart) : Math.round(numSamples * 0.25)
    let loopEnd = saved && saved.loopEnd != null ? clampN(saved.loopEnd) : Math.round(numSamples * 0.75)
    if (loopEnd <= loopStart) loopEnd = Math.min(numSamples, loopStart + 1)
    const rawXfade = saved && saved.xfade != null
      ? Math.max(0, Math.round(saved.xfade))
      : Math.min(2048, Math.floor((loopEnd - loopStart) / 4))
    const xfade = clampCrossfade(loopStart, loopEnd, rawXfade, numSamples)

    const sample = {
      id: uidCounter++,
      filePath, name: authoring.name,
      className: authoring.className,
      instrumentName: authoring.className === 'Instrument' ? (authoring.instrumentName || '') : '',
      source: authoring.source || '',
      rootNote: authoring.rootNote != null ? authoring.rootNote : 60,
      behaviorFamily: authoring.behaviorFamily
        || deriveBehaviorFamily(authoring.className, authoring.instrumentName),
      regionId, sampleId, sampleRate,
      originalSampleRate: Number(info?.originalSampleRate) || hdr.sampleRate,
      channels: hdr.channels,
      numSamples,
      durationSec: Number(info?.duration) || hdr.durationSec,
      loopStart, loopEnd, xfade,
      view: { start: 0, end: numSamples },
    }
    // Prime the engine preview sampler with this loop.
    pushSettings(sample, { reArm: false })
    return sample
  }, [pushSettings])

  const baseName = (p) => String(p).split(/[\\/]/).pop()

  // ── Import a batch of WAVs ───────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    if (importing) return
    setImporting(true)
    setStatus('Choosing files…')
    try {
      const paths = await bridgeFn('loopLab.pickWavs')()
      if (!paths || paths.length === 0) { setStatus('Import cancelled.'); return }
      const capturedMeta = { ...sticky }        // sticky snapshot applied to this batch
      let firstNewId = null
      for (const filePath of paths) {
        try {
          setStatus(`Importing ${baseName(filePath)}…`)
          const authoring = {
            name: autoName(capturedMeta, importCounter.current++),
            className: capturedMeta.className,
            instrumentName: capturedMeta.instrumentName,
            source: capturedMeta.source,
            rootNote: 60,
            behaviorFamily: deriveBehaviorFamily(capturedMeta.className, capturedMeta.instrumentName),
          }
          const sample = await importOne(filePath, authoring, null)
          setSamples((prev) => [...prev, sample])
          if (firstNewId == null) firstNewId = sample.id
        } catch (e) {
          setStatus(`Failed on ${baseName(filePath)}: ${e.message}`)
        }
      }
      if (firstNewId != null) setSelectedId(firstNewId)
      setStatus(`Imported ${paths.length} file(s).`)
    } catch (e) {
      setStatus(`Import error: ${e.message}`)
    } finally {
      setImporting(false)
    }
  }, [importing, sticky, importOne])

  // ── Mutate a sample field + push to engine ──────────────────────────────────
  const updateSample = useCallback((id, patch, { push = true } = {}) => {
    setSamples((prev) => prev.map((s) => {
      if (s.id !== id) return s
      const next = { ...s, ...patch }
      // Re-clamp the canonical xfade whenever it or the loop bounds change, so
      // it can never drift past what the engine will actually play (e.g. a
      // stale xfade left over from before the loop was shortened).
      if ('loopStart' in patch || 'loopEnd' in patch || 'xfade' in patch) {
        next.xfade = clampCrossfade(next.loopStart, next.loopEnd, next.xfade, next.numSamples)
      }
      if (push && ('loopStart' in patch || 'loopEnd' in patch || 'xfade' in patch || 'rootNote' in patch)) {
        pushSettings(next)
      }
      return next
    }))
  }, [pushSettings])

  // ── Preview (spacebar) ───────────────────────────────────────────────────────
  const stopPreview = useCallback(() => {
    const cur = previewingRef.current
    if (cur == null) return
    const s = samplesRef.current.find((x) => x.id === cur)
    if (s?.regionId != null) {
      try { bridgeFn('timeline.previewAllNotesOff')(s.regionId) } catch { /* best effort */ }
    }
    setPreviewingId(null)
  }, [])

  const startPreview = useCallback((sample) => {
    if (!sample?.regionId) return
    // Stop any other preview first.
    const cur = previewingRef.current
    if (cur != null && cur !== sample.id) {
      const prev = samplesRef.current.find((x) => x.id === cur)
      if (prev?.regionId != null) { try { bridgeFn('timeline.previewAllNotesOff')(prev.regionId) } catch {} }
    }
    try {
      bridgeFn('timeline.previewNote')(sample.regionId, sample.rootNote ?? 60, PREVIEW_VELOCITY)
      setPreviewingId(sample.id)
    } catch (e) { setStatus(`Preview failed: ${e.message}`) }
  }, [])

  const togglePreview = useCallback(() => {
    if (!selected) return
    if (previewingRef.current === selected.id) stopPreview()
    else startPreview(selected)
  }, [selected, startPreview, stopPreview])

  // Spacebar toggles preview (ignored while typing in an input). Rate mode owns
  // the keyboard and the preview voice while it is up, so this stands down.
  useEffect(() => {
    if (mode !== 'author') return undefined
    const onKey = (e) => {
      if (e.code !== 'Space') return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      e.preventDefault()
      togglePreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePreview, mode])

  // Entering rate mode drops the authoring preview: the rater re-points the
  // same region's sampler at an arm, and a note held from here would keep
  // playing whichever loop the author was last editing.
  const switchMode = useCallback((next) => {
    if (next === 'rate') stopPreview()
    setStatus('')
    setMode(next)
  }, [stopPreview])

  // ── Restore the permanent working set on mount ──────────────────────────────
  // Re-imports every saved WAV (from its path) through the engine and reapplies
  // the saved loop edits + metadata. Runs once. Files that have since moved or
  // been deleted are skipped with a note.
  useEffect(() => {
    // One-shot guard: the ref persists across StrictMode's dev remount (same
    // fiber), so the async restore body never runs twice (which would double-
    // import and orphan regions).
    if (restoreStartedRef.current) return
    restoreStartedRef.current = true
    ;(async () => {
      try {
        const saved = await window.xleth?.loopLab?.loadState?.()
        if (!saved) return
        if (saved.sticky) setSticky((m) => ({ ...m, ...saved.sticky }))
        if (Number.isFinite(saved.importCounter)) importCounter.current = saved.importCounter
        const list = Array.isArray(saved.samples) ? saved.samples : []
        if (list.length) setStatus(`Restoring ${list.length} sample(s)…`)
        let firstId = null
        let restored = 0
        let skipped = 0
        for (const sv of list) {
          try {
            const sample = await importOne(sv.filePath, sv, sv)
            setSamples((prev) => [...prev, sample])
            if (firstId == null) firstId = sample.id
            restored++
          } catch (e) {
            skipped++
            setStatus(`Skipped ${baseName(sv.filePath)}: ${e.message}`)
          }
        }
        if (firstId != null) setSelectedId(firstId)
        if (list.length) setStatus(`Restored ${restored} sample(s)${skipped ? `, skipped ${skipped}` : ''}.`)
      } catch (e) {
        setStatus(`Restore error: ${e.message}`)
      } finally {
        readyRef.current = true   // gate autosave until restore is done
      }
    })()
  }, [importOne])

  // ── Autosave the permanent state on every change (debounced) ────────────────
  useEffect(() => {
    if (!readyRef.current) return   // don't clobber the file during initial restore
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.xleth?.loopLab?.saveState?.(buildState())
    }, 500)
    return () => clearTimeout(saveTimer.current)
  }, [samples, sticky, buildState])

  // Cleanup: flush a final save, stop preview notes, delete scratch regions.
  useEffect(() => () => {
    if (readyRef.current) {
      clearTimeout(saveTimer.current)
      try { window.xleth?.loopLab?.saveState?.(buildState()) } catch {}
    }
    for (const s of samplesRef.current) {
      if (s.regionId == null) continue
      try { bridgeFn('timeline.previewAllNotesOff')(s.regionId) } catch {}
      try { window.xleth?.timeline?.removeRegion?.(s.regionId) } catch {}
    }
  }, [buildState])

  const handleRemoveSample = useCallback((id) => {
    const s = samplesRef.current.find((x) => x.id === id)
    if (s?.regionId != null) {
      if (previewingRef.current === id) stopPreview()
      try { bridgeFn('timeline.previewAllNotesOff')(s.regionId) } catch {}
      try { window.xleth?.timeline?.removeRegion?.(s.regionId) } catch {}
    }
    setSamples((prev) => prev.filter((x) => x.id !== id))
    setSelectedId((cur) => (cur === id ? null : cur))
  }, [stopPreview])

  // ── Export ───────────────────────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    if (exporting || samples.length === 0) return
    setExporting(true)
    setStatus('Exporting…')
    try {
      const payload = {
        samples: samples.map((s) => ({
          filePath: s.filePath,
          name: s.name,
          className: s.className,
          instrumentName: s.className === 'Instrument' ? s.instrumentName : null,
          source: s.source,
          rootNote: s.rootNote,
          behaviorFamily: s.behaviorFamily,
          engineSampleRate: s.sampleRate,
          numSamples: s.numSamples,
          gold: { start: s.loopStart, end: s.loopEnd, xfade: s.xfade },
        })),
      }
      const res = await bridgeFn('loopLab.exportDataset')(payload)
      if (res?.ok) setStatus(`Exported ${res.count} sample(s) → ${res.path}`)
      else if (res?.cancelled) setStatus('Export cancelled.')
      else setStatus(`Export failed: ${res?.error || 'unknown error'}`)
    } catch (e) {
      setStatus(`Export error: ${e.message}`)
    } finally {
      setExporting(false)
    }
  }, [exporting, samples])

  const instrumentRequired = sticky.className === 'Instrument' && !metaIsComplete(sticky)

  return (
    <div className="ll-overlay" role="dialog" aria-label="Loop Lab">
      <div className="ll-header">
        <div className="ll-title">
          Loop Lab <span className="ll-badge">DEV</span>
          <span className="ll-tabs" role="tablist">
            {[['author', 'Author'], ['rate', 'Rate A/B']].map(([id, label]) => (
              <button key={id} role="tab" aria-selected={mode === id}
                className={`ll-tab${mode === id ? ' is-active' : ''}`}
                onClick={() => switchMode(id)}>{label}</button>
            ))}
          </span>
        </div>
        <div className="ll-header-actions">
          {mode === 'author' && (
            <>
              <button className="ll-btn" onClick={handleImport} disabled={importing || instrumentRequired}>
                {importing ? 'Importing…' : 'Import WAVs'}
              </button>
              <button className="ll-btn ll-btn--accent" onClick={handleExport}
                disabled={exporting || samples.length === 0}>
                {exporting ? 'Exporting…' : `Export ZIP (${samples.length})`}
              </button>
            </>
          )}
          <button className="ll-btn ll-btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>

      {/* Sticky metadata bar — applied to every new import until changed. */}
      {mode === 'author' && <div className="ll-sticky">
        <label className="ll-field">
          <span>Class</span>
          <select value={sticky.className}
            onChange={(e) => setSticky((m) => ({ ...m, className: e.target.value }))}>
            {LOOP_LAB_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label className="ll-field">
          <span>Instrument{sticky.className === 'Instrument' ? ' *' : ''}</span>
          <input type="text" value={sticky.instrumentName}
            placeholder={sticky.className === 'Instrument' ? 'e.g. flute (required)' : 'n/a'}
            disabled={sticky.className !== 'Instrument'}
            className={instrumentRequired ? 'll-invalid' : ''}
            onChange={(e) => setSticky((m) => ({ ...m, instrumentName: e.target.value }))} />
        </label>
        <label className="ll-field ll-field--grow">
          <span>Source</span>
          <input type="text" value={sticky.source} placeholder="e.g. ep12"
            onChange={(e) => setSticky((m) => ({ ...m, source: e.target.value }))} />
        </label>
        {instrumentRequired && <span className="ll-hint">Instrument name required to import.</span>}
      </div>}

      {mode === 'rate' && (
        <div className="ll-body">
          <LoopLabRater samples={samples} onStatus={setStatus} />
        </div>
      )}

      {mode === 'author' && <div className="ll-body">
        {/* Sample list */}
        <div className="ll-list">
          {samples.length === 0 && <div className="ll-empty">No samples. Import WAVs to begin.</div>}
          {samples.map((s) => (
            <div key={s.id}
              className={`ll-row${s.id === selectedId ? ' is-selected' : ''}${s.id === previewingId ? ' is-playing' : ''}`}
              onClick={() => setSelectedId(s.id)}>
              <div className="ll-row-main">
                <span className="ll-row-name">{s.name}</span>
                <span className={`ll-classbadge ll-class-${s.className.replace(/\s+/g, '-').toLowerCase()}`}>
                  {s.className}
                </span>
              </div>
              <div className="ll-row-meta">
                {(s.durationSec).toFixed(2)}s · {Math.round(s.originalSampleRate)}Hz · {s.behaviorFamily}
              </div>
              <button className="ll-row-x" onClick={(e) => { e.stopPropagation(); handleRemoveSample(s.id) }}
                aria-label="Remove">✕</button>
            </div>
          ))}
        </div>

        {/* Editor */}
        <div className="ll-editor">
          {!selected && <div className="ll-empty">Select a sample to edit its loop.</div>}
          {selected && (
            <SampleEditor
              key={selected.id}
              sample={selected}
              previewing={previewingId === selected.id}
              onTogglePreview={togglePreview}
              onUpdate={updateSample}
            />
          )}
        </div>
      </div>}

      <div className="ll-statusbar">
        {status || (mode === 'rate'
          ? 'A / B = switch arm · space = play · 1 / 2 / 3 = verdict · enter = save & next'
          : 'Space = preview · wheel = zoom · drag empty = pan')}
      </div>
    </div>
  )
}

// ── Per-sample editor: waveform + numeric fields + naming + behavior family ────
function SampleEditor({ sample, previewing, onTogglePreview, onUpdate }) {
  const { id, numSamples, sampleRate } = sample
  const setView = useCallback((view) => onUpdate(id, { view }, { push: false }), [id, onUpdate])

  const clampLoop = (start, end) => ({
    loopStart: Math.max(0, Math.min(start, numSamples - 1)),
    loopEnd: Math.max(1, Math.min(end, numSamples)),
  })

  const commitLoop = useCallback(({ loopStart, loopEnd }) => {
    const c = clampLoop(loopStart, loopEnd)
    if (c.loopEnd <= c.loopStart) c.loopEnd = c.loopStart + 1
    onUpdate(id, c)
  }, [id, numSamples, onUpdate])

  // ── Knob handlers (Sampler-style; sample-count / note-name readouts) ────────
  // Knobs emit continuous floats during drag; we round to whole samples and keep
  // loop-start < loop-end. onUpdate's debounced push rebakes the engine loop.
  const setStart = (v) => onUpdate(id, { loopStart: Math.max(0, Math.min(Math.round(v), sample.loopEnd - 1)) })
  const setEnd = (v) => onUpdate(id, { loopEnd: Math.min(numSamples, Math.max(Math.round(v), sample.loopStart + 1)) })
  const setXfade = (v) => onUpdate(id, { xfade: Math.max(0, Math.round(v)) })
  const setRoot = (v) => onUpdate(id, { rootNote: Math.max(0, Math.min(127, Math.round(v))) })
  // Crossfade is clamped by the engine to half the loop length — cap the knob to
  // the usable range so it maps intuitively.
  const xfadeMax = Math.max(1, Math.floor((sample.loopEnd - sample.loopStart) / 2))

  return (
    <>
      <div className="ll-editor-head">
        <input className="ll-name-input" type="text" value={sample.name}
          onChange={(e) => onUpdate(id, { name: e.target.value }, { push: false })} />
        <button className={`ll-btn ${previewing ? 'll-btn--danger' : 'll-btn--accent'}`} onClick={onTogglePreview}>
          {previewing ? '■ Stop' : '▶ Preview'}
        </button>
      </div>

      <LoopLabWaveform
        regionId={sample.regionId}
        numSamples={numSamples}
        sampleRate={sampleRate}
        loopStart={sample.loopStart}
        loopEnd={sample.loopEnd}
        crossfadeSamples={sample.xfade}
        view={sample.view}
        onView={setView}
        onCommitLoop={commitLoop}
        width={760}
        height={150}
      />

      <div className="ll-zoom-row">
        <button className="ll-btn ll-btn--sm" onClick={() => setView({ start: 0, end: numSamples })}>Fit</button>
        <span className="ll-zoom-info">
          view {sample.view.start}–{sample.view.end} / {numSamples} samples
        </span>
      </div>

      <div className="ll-knobs">
        <Knob
          size={52} label="Loop Start" min={0} max={Math.max(1, numSamples - 1)}
          value={sample.loopStart} defaultValue={Math.round(numSamples * 0.25)}
          formatValue={(v) => String(Math.round(v))}
          onLiveChange={setStart} onCommit={setStart}
        />
        <Knob
          size={52} label="Loop End" min={1} max={numSamples}
          value={sample.loopEnd} defaultValue={Math.round(numSamples * 0.75)}
          formatValue={(v) => String(Math.round(v))}
          onLiveChange={setEnd} onCommit={setEnd}
        />
        <Knob
          size={52} label="Crossfade" min={0} max={xfadeMax}
          value={Math.min(sample.xfade, xfadeMax)} defaultValue={0}
          formatValue={(v) => String(Math.round(v))}
          onLiveChange={setXfade} onCommit={setXfade}
        />
        <Knob
          size={52} label="Root Note" min={0} max={127}
          value={sample.rootNote ?? 60} defaultValue={60}
          formatValue={midiToNoteName}
          onLiveChange={setRoot} onCommit={setRoot}
        />
      </div>

      <div className="ll-controls">
        <label className="ll-num ll-num--wide">
          <span>Behavior family</span>
          <select value={sample.behaviorFamily}
            onChange={(e) => onUpdate(id, { behaviorFamily: e.target.value }, { push: false })}>
            {BEHAVIOR_FAMILIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
        <div className="ll-loopinfo">
          loop len {sample.loopEnd - sample.loopStart} · {sample.channels}ch · engine {Math.round(sampleRate)}Hz
        </div>
      </div>
    </>
  )
}
