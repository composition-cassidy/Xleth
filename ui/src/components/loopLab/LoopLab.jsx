import { useState, useEffect, useRef, useCallback } from 'react'
import LoopLabWaveform from './LoopLabWaveform.jsx'
import {
  LOOP_LAB_CLASSES, BEHAVIOR_FAMILIES, deriveBehaviorFamily,
  autoName, loadStickyMeta, saveStickyMeta, metaIsComplete,
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

let uidCounter = 1

export default function LoopLab({ onClose }) {
  const [sticky, setSticky] = useState(loadStickyMeta)
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

  const selected = samples.find((s) => s.id === selectedId) || null

  // Persist sticky metadata whenever it changes (survives app restarts).
  useEffect(() => { saveStickyMeta(sticky) }, [sticky])

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
          setStatus(`Importing ${filePath.split(/[\\/]/).pop()}…`)
          const hdr = await bridgeFn('loopLab.probeWav')(filePath)
          if (!hdr) throw new Error('not a readable WAV')
          const sampleId = await bridgeFn('audio.loadSourceRegion')(filePath, 0, hdr.durationSec)
          if (typeof sampleId !== 'number' || sampleId < 0) throw new Error('decode failed')
          const name = autoName(capturedMeta, importCounter.current++)
          const regionId = await bridgeFn('timeline.addRegion')({ name, audioFilePath: filePath })
          if (typeof regionId !== 'number' || regionId < 0) throw new Error('addRegion failed')
          await bridgeFn('audio.mapRegionToSample')(regionId, sampleId)
          const info = await bridgeFn('timeline.getRegionAudioInfo')(regionId)
          const numSamples = Number(info?.numSamples) || 0
          const sampleRate = Number(info?.engineSampleRate) || hdr.sampleRate
          if (numSamples <= 0) throw new Error('region has no audio')

          const loopStart = Math.round(numSamples * 0.25)
          const loopEnd = Math.round(numSamples * 0.75)
          const xfade = Math.min(2048, Math.floor((loopEnd - loopStart) / 4))
          const behaviorFamily = deriveBehaviorFamily(capturedMeta.className, capturedMeta.instrumentName)

          const sample = {
            id: uidCounter++,
            filePath, name,
            className: capturedMeta.className,
            instrumentName: capturedMeta.className === 'Instrument' ? capturedMeta.instrumentName : '',
            source: capturedMeta.source,
            rootNote: null,
            behaviorFamily,
            regionId, sampleId,
            sampleRate,
            originalSampleRate: Number(info?.originalSampleRate) || hdr.sampleRate,
            channels: hdr.channels,
            numSamples,
            durationSec: Number(info?.duration) || hdr.durationSec,
            loopStart, loopEnd, xfade,
            view: { start: 0, end: numSamples },
          }
          setSamples((prev) => [...prev, sample])
          if (firstNewId == null) firstNewId = sample.id
          // Prime the engine preview sampler with the initial loop.
          pushSettings(sample, { reArm: false })
        } catch (e) {
          setStatus(`Failed on ${filePath.split(/[\\/]/).pop()}: ${e.message}`)
        }
      }
      if (firstNewId != null) setSelectedId(firstNewId)
      setStatus(`Imported ${paths.length} file(s).`)
    } catch (e) {
      setStatus(`Import error: ${e.message}`)
    } finally {
      setImporting(false)
    }
  }, [importing, sticky, pushSettings])

  // ── Mutate a sample field + push to engine ──────────────────────────────────
  const updateSample = useCallback((id, patch, { push = true } = {}) => {
    setSamples((prev) => prev.map((s) => {
      if (s.id !== id) return s
      const next = { ...s, ...patch }
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

  // Spacebar toggles preview (ignored while typing in an input).
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      e.preventDefault()
      togglePreview()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePreview])

  // Cleanup: stop all preview notes + delete scratch regions on unmount.
  useEffect(() => () => {
    for (const s of samplesRef.current) {
      if (s.regionId == null) continue
      try { bridgeFn('timeline.previewAllNotesOff')(s.regionId) } catch {}
      try { window.xleth?.timeline?.removeRegion?.(s.regionId) } catch {}
    }
  }, [])

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
        <div className="ll-title">Loop Lab <span className="ll-badge">DEV</span></div>
        <div className="ll-header-actions">
          <button className="ll-btn" onClick={handleImport} disabled={importing || instrumentRequired}>
            {importing ? 'Importing…' : 'Import WAVs'}
          </button>
          <button className="ll-btn ll-btn--accent" onClick={handleExport}
            disabled={exporting || samples.length === 0}>
            {exporting ? 'Exporting…' : `Export ZIP (${samples.length})`}
          </button>
          <button className="ll-btn ll-btn--ghost" onClick={onClose} aria-label="Close">✕</button>
        </div>
      </div>

      {/* Sticky metadata bar — applied to every new import until changed. */}
      <div className="ll-sticky">
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
      </div>

      <div className="ll-body">
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
      </div>

      <div className="ll-statusbar">{status || 'Space = preview · wheel = zoom · drag empty = pan'}</div>
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

  const num = (v, fallback) => {
    const n = parseInt(v, 10)
    return Number.isFinite(n) ? n : fallback
  }

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

      <div className="ll-controls">
        <label className="ll-num">
          <span>Loop start</span>
          <input type="number" min={0} max={numSamples - 1} value={sample.loopStart}
            onChange={(e) => onUpdate(id, clampLoop(num(e.target.value, sample.loopStart), sample.loopEnd))} />
        </label>
        <label className="ll-num">
          <span>Loop end</span>
          <input type="number" min={1} max={numSamples} value={sample.loopEnd}
            onChange={(e) => onUpdate(id, clampLoop(sample.loopStart, num(e.target.value, sample.loopEnd)))} />
        </label>
        <label className="ll-num">
          <span>Crossfade</span>
          <input type="number" min={0} value={sample.xfade}
            onChange={(e) => onUpdate(id, { xfade: Math.max(0, num(e.target.value, sample.xfade)) })} />
        </label>
        <label className="ll-num">
          <span>Root note</span>
          <input type="number" min={0} max={127} value={sample.rootNote ?? ''} placeholder="—"
            onChange={(e) => {
              const v = e.target.value === '' ? null : Math.max(0, Math.min(127, num(e.target.value, 60)))
              onUpdate(id, { rootNote: v })
            }} />
        </label>
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
