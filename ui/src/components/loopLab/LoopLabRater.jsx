import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { tokenValue } from '../../theming/tokenValue.ts'
import { useThemeEpoch } from '../../theming/useThemeEpoch.js'
import {
  FAILURE_TAGS, RATINGS_FILENAME,
  parseCandidatesDoc, buildTrials,
  indexSamplesForCandidates, resolveLoopLabSample, armEngineLoop,
  parseRatingsJsonl, completedTrialIds, firstPendingIndex,
  makeRatingRecord, serializeRatingLine,
} from './loopLabRater.js'

// ─── Loop Lab — blind A/B rater ──────────────────────────────────────────────
// Auditions the arm set written by `python -m loop_optimizer export` against the
// human gold loop, blind, through the SAME engine sampler path the authoring
// panel previews with (timeline_previewNote -> Sampler::processVoice via
// updateSamplerSettings). Both arms differ only in the loop points pushed to the
// region — no crossfade math is re-implemented anywhere on this side, so a
// verdict is a verdict about the engine's own render.
//
// Switching arms is NOT phase-continuous, by necessity: updateSamplerSettings
// rebuilds the preview sampler and drops any held voice (the authoring panel
// documents the same behaviour at LoopLab.jsx pushSettings). So a switch
// re-arms the note, i.e. playback restarts from the sample's attack. That is
// the honest trade — the alternative would be a second sampler voice
// crossfaded in the renderer, which is exactly the re-implemented preview path
// this panel exists to avoid. The debounce below keeps A/B/A mashing from
// queueing a rebuild per keystroke.
const PREVIEW_VELOCITY = 0.8
const SWITCH_DEBOUNCE_MS = 60

// Remembers the candidates file across restarts so a session resumes without
// hunting for it again. The verdicts themselves live in ratings.jsonl on disk.
const CANDIDATES_PATH_KEY = 'xleth.loopLab.rater.candidatesPath.v1'

function bridgeFn(pathStr) {
  const parts = pathStr.split('.')
  let o = window.xleth
  for (const p of parts) o = o?.[p]
  if (typeof o !== 'function') throw new Error(`window.xleth.${pathStr} unavailable`)
  return o
}

export default function LoopLabRater({ samples, onStatus }) {
  const [doc, setDoc] = useState(null)
  const [candidatesPath, setCandidatesPath] = useState('')
  const [ratingsPath, setRatingsPath] = useState('')
  const [trials, setTrials] = useState([])
  const [completed, setCompleted] = useState(() => new Set())
  const [index, setIndex] = useState(0)
  const [arm, setArm] = useState('A')
  const [playing, setPlaying] = useState(false)
  const [verdict, setVerdict] = useState(null)
  const [tags, setTags] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const switchTimer = useRef(null)
  const openedRef = useRef(false)      // one-shot auto-reopen guard (StrictMode)
  const touchedRef = useRef(new Map()) // regionId -> Loop Lab sample, for restore

  // Line the candidate samples up with the imported working set: the engine
  // region an audition plays through belongs to the authoring panel.
  const sampleIndex = useMemo(() => indexSamplesForCandidates(samples), [samples])

  const resolved = useMemo(() => trials.map((t) => ({
    ...t,
    llSample: resolveLoopLabSample(sampleIndex, t.sample),
  })), [trials, sampleIndex])

  const trial = resolved[index] || null
  const pendingCount = resolved.filter((t) => !completed.has(t.trial_id)).length

  const trialRef = useRef(null); trialRef.current = trial
  const playingRef = useRef(false); playingRef.current = playing
  const armRef = useRef('A'); armRef.current = arm

  // The staged verdict and its failure tags are held in refs and mirrored into
  // state for rendering — NOT the other way round. Committing reads the refs.
  // A rater who tags the losing arm and hits Enter inside the same frame (fast
  // hands, or key repeat) would otherwise commit a record built from the state
  // as it was BEFORE the tag click, silently dropping the tag: state updates
  // are batched, so the keydown listener still closes over the previous value.
  // Refs assigned during render have the same problem, so these are assigned in
  // the event handlers themselves.
  const verdictRef = useRef(null)
  const tagsRef = useRef([])

  const stageVerdict = useCallback((v) => {
    verdictRef.current = v
    setVerdict(v)
    // A tie has no worse arm, so it can carry no failure tags.
    if (v === 'tie') { tagsRef.current = []; setTags([]) }
  }, [])

  const resetStaging = useCallback(() => {
    verdictRef.current = null
    tagsRef.current = []
    setVerdict(null)
    setTags([])
  }, [])

  const status = useCallback((msg) => { if (onStatus) onStatus(msg) }, [onStatus])

  // ── Engine: push one arm's loop, re-arm the held note ──────────────────────
  const applyArm = useCallback((which) => {
    const t = trialRef.current
    const ll = t?.llSample
    if (!ll || ll.regionId == null) return
    const armObj = which === 'B' ? t.arms[1] : t.arms[0]
    // The ONLY domain conversion on this path, and it goes through the shared
    // helper: candidates.json is file-domain, the sampler is engine-domain.
    const loop = armEngineLoop(armObj, t.sample, ll)
    touchedRef.current.set(ll.regionId, ll)

    clearTimeout(switchTimer.current)
    switchTimer.current = setTimeout(async () => {
      try {
        await bridgeFn('timeline.updateSamplerSettings')(ll.regionId, {
          loopEnabled: true,
          crossfadeEnabled: true,
          loopStart: loop.loopStart,
          loopEnd: loop.loopEnd,
          // The REQUESTED crossfade, unclamped: the offline analysis measured
          // this width against the engine's own clamp, so pre-clamping here
          // would audition a different loop than the one that was scored.
          crossfadeSamples: loop.xfade,
          rootNote: ll.rootNote ?? 60,
        })
        if (playingRef.current) {
          bridgeFn('timeline.previewAllNotesOff')(ll.regionId)
          bridgeFn('timeline.previewNote')(ll.regionId, ll.rootNote ?? 60, PREVIEW_VELOCITY)
        }
      } catch (e) { setError(`Arm switch failed: ${e.message}`) }
    }, SWITCH_DEBOUNCE_MS)
  }, [])

  const stop = useCallback(() => {
    const ll = trialRef.current?.llSample
    if (ll?.regionId != null) {
      try { bridgeFn('timeline.previewAllNotesOff')(ll.regionId) } catch { /* best effort */ }
    }
    setPlaying(false)
  }, [])

  const togglePlay = useCallback(() => {
    const t = trialRef.current
    const ll = t?.llSample
    if (!ll || ll.regionId == null) return
    if (playingRef.current) { stop(); return }
    try {
      bridgeFn('timeline.previewNote')(ll.regionId, ll.rootNote ?? 60, PREVIEW_VELOCITY)
      setPlaying(true)
    } catch (e) { setError(`Preview failed: ${e.message}`) }
  }, [stop])

  const selectArm = useCallback((which) => {
    if (which === armRef.current) return
    setArm(which)
    applyArm(which)
  }, [applyArm])

  // Arm A is primed whenever the trial changes; playback always starts stopped
  // so a trial is never judged from a tail the previous one left running.
  useEffect(() => {
    if (!trial?.llSample) return undefined
    setArm('A')
    applyArm('A')
    return () => { clearTimeout(switchTimer.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trial?.trial_id, trial?.llSample?.regionId])

  // ── Load / resume ─────────────────────────────────────────────────────────
  const adoptCandidates = useCallback(async (res) => {
    if (!res || res.cancelled) return
    if (!res.ok) { setError(res.error || 'could not read candidates.json'); return }
    let parsed
    try {
      parsed = parseCandidatesDoc(res.text)
    } catch (e) { setError(e.message); return }

    const built = buildTrials(parsed)
    setDoc(parsed)
    setCandidatesPath(res.path)
    setTrials(built)
    try { localStorage.setItem(CANDIDATES_PATH_KEY, res.path) } catch { /* non-fatal */ }

    // Resume: every trial already in ratings.jsonl is skipped.
    let done = new Set()
    let malformed = 0
    try {
      const r = await bridgeFn('loopLab.loadRatings')(res.path)
      if (r?.ok) {
        const parsedRatings = parseRatingsJsonl(r.text)
        done = completedTrialIds(parsedRatings.records)
        malformed = parsedRatings.malformed
        setRatingsPath(r.path)
      } else if (r) setError(r.error || 'could not read ratings.jsonl')
    } catch (e) { setError(`loadRatings failed: ${e.message}`) }

    setCompleted(done)
    const next = firstPendingIndex(built, done)
    setIndex(next < 0 ? Math.max(0, built.length - 1) : next)
    resetStaging()
    status(
      `Loaded ${built.length} trial(s) from ${res.path}` +
      (done.size ? ` — resuming, ${done.size} already rated` : '') +
      (malformed ? ` (${malformed} unreadable line(s) in ${RATINGS_FILENAME}, ignored)` : '')
    )
  }, [status, resetStaging])

  const openCandidates = useCallback(async () => {
    setBusy(true); setError('')
    try { await adoptCandidates(await bridgeFn('loopLab.pickCandidates')()) }
    catch (e) { setError(`Open failed: ${e.message}`) }
    finally { setBusy(false) }
  }, [adoptCandidates])

  // Re-open the last candidates file on mount.
  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    let saved = ''
    try { saved = localStorage.getItem(CANDIDATES_PATH_KEY) || '' } catch { /* ignore */ }
    if (!saved) return
    ;(async () => {
      try {
        const res = await bridgeFn('loopLab.readCandidates')(saved)
        if (res?.ok) await adoptCandidates(res)
      } catch { /* the file moved; the user can re-open it */ }
    })()
  }, [adoptCandidates])

  // ── Commit a verdict ──────────────────────────────────────────────────────
  const commit = useCallback(async () => {
    const t = trialRef.current
    const winner = verdictRef.current
    if (!t || !winner || busy) return
    setBusy(true)
    try {
      const record = makeRatingRecord(t, { winner, failureTags: tagsRef.current })
      const res = await bridgeFn('loopLab.appendRating')(candidatesPath, serializeRatingLine(record))
      if (!res?.ok) { setError(`Could not save verdict: ${res?.error || 'unknown error'}`); return }
      setRatingsPath(res.path)
      stop()
      const nextCompleted = new Set(completed).add(t.trial_id)
      setCompleted(nextCompleted)
      resetStaging()
      const next = firstPendingIndex(resolved, nextCompleted)
      setIndex(next < 0 ? index : next)
      status(next < 0 ? `Session complete — ${nextCompleted.size} verdict(s) in ${res.path}` : '')
    } catch (e) {
      setError(`Save failed: ${e.message}`)
    } finally { setBusy(false) }
  }, [busy, candidatesPath, completed, resolved, index, stop, status, resetStaging])

  const skip = useCallback(() => {
    stop()
    const next = resolved.findIndex((t, i) => i > index && !completed.has(t.trial_id))
    resetStaging()
    setIndex(next < 0 ? index : next)
  }, [resolved, index, completed, stop, resetStaging])

  const toggleTag = useCallback((tag) => {
    const cur = tagsRef.current
    const next = cur.includes(tag) ? cur.filter((t) => t !== tag) : [...cur, tag]
    tagsRef.current = next
    setTags(next)
  }, [])

  // ── Keyboard ──────────────────────────────────────────────────────────────
  // A/B switch arms while the loop runs, space starts and stops, 1/2/3 stage a
  // verdict and Enter commits it. Staging rather than committing on the verdict
  // key is what makes the failure tags reachable: they describe the arm that
  // lost, so they can only be picked once a loser exists.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'a' || e.key === 'ArrowLeft') { e.preventDefault(); selectArm('A') }
      else if (key === 'b' || e.key === 'ArrowRight') { e.preventDefault(); selectArm('B') }
      else if (e.code === 'Space') { e.preventDefault(); togglePlay() }
      else if (key === '1') { e.preventDefault(); stageVerdict('A') }
      else if (key === '2') { e.preventDefault(); stageVerdict('tie') }
      else if (key === '3') { e.preventDefault(); stageVerdict('B') }
      else if (e.key === 'Enter') { e.preventDefault(); commit() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectArm, togglePlay, commit, stageVerdict])

  // ── Teardown: hand the regions back the way the authoring panel left them ──
  // The rater overwrites each region's sampler settings to audition an arm. If
  // those were left in place, reopening the authoring tab would show the user's
  // own gold loop while the engine quietly played the last arm heard.
  useEffect(() => () => {
    clearTimeout(switchTimer.current)
    for (const [regionId, ll] of touchedRef.current) {
      try { window.xleth?.timeline?.previewAllNotesOff?.(regionId) } catch { /* best effort */ }
      try {
        window.xleth?.timeline?.updateSamplerSettings?.(regionId, {
          loopEnabled: true,
          crossfadeEnabled: true,
          loopStart: ll.loopStart,
          loopEnd: ll.loopEnd,
          crossfadeSamples: ll.xfade,
          rootNote: ll.rootNote ?? 60,
        })
      } catch { /* best effort */ }
    }
    touchedRef.current.clear()
  }, [])

  // ── Render ────────────────────────────────────────────────────────────────
  if (!doc) {
    return (
      <div className="ll-rate">
        <div className="ll-empty">
          No candidate set loaded. Generate one with
          {' '}<code>python -m loop_optimizer export --corpus &lt;dir&gt; --top-k 3</code>{' '}
          then open the candidates.json it writes.
        </div>
        <div className="ll-rate-actions">
          <button className="ll-btn ll-btn--accent" onClick={openCandidates} disabled={busy}>
            {busy ? 'Opening…' : 'Open candidates.json'}
          </button>
        </div>
        {error && <div className="ll-rate-error">{error}</div>}
      </div>
    )
  }

  const doneCount = completed.size
  const isDone = pendingCount === 0

  return (
    <div className="ll-rate">
      <div className="ll-rate-head">
        <div className="ll-rate-progress">
          <strong>{Math.min(doneCount + 1, resolved.length)}</strong> / {resolved.length}
          <span className="ll-rate-sub"> · {doneCount} rated · {pendingCount} left</span>
        </div>
        <TrialProgressCanvas trials={resolved} completed={completed} current={index} width={420} height={12} />
        <button className="ll-btn ll-btn--sm" onClick={openCandidates} disabled={busy}>Change set…</button>
      </div>

      {isDone && (
        <div className="ll-rate-done">
          Session complete — {doneCount} verdict(s) written to {ratingsPath || RATINGS_FILENAME}.
        </div>
      )}

      {!isDone && trial && (
        <>
          {/* Blinded: the sample is named, the arms never are. Which of A/B is
              the optimizer, gold or the naive anchor is only in ratings.jsonl. */}
          <div className="ll-rate-sample">
            <span className="ll-rate-sampleid">{trial.sample_id}</span>
            <span className="ll-rate-sub">{trial.sample.class} · {trial.sample.behavior_family}</span>
          </div>

          {!trial.llSample && (
            <div className="ll-rate-error">
              This sample is not in the working set — import {trial.sample.file || trial.sample_id} on the
              Author tab, or skip the trial.
            </div>
          )}

          <div className="ll-rate-arms">
            {['A', 'B'].map((which) => (
              <button
                key={which}
                className={`ll-arm${arm === which ? ' is-active' : ''}`}
                onClick={() => selectArm(which)}
                disabled={!trial.llSample}
              >
                {which}
              </button>
            ))}
            <button
              className={`ll-btn ${playing ? 'll-btn--danger' : 'll-btn--accent'}`}
              onClick={togglePlay}
              disabled={!trial.llSample}
            >
              {playing ? '■ Stop' : '▶ Play'}
            </button>
            <span className="ll-rate-sub">A / B to switch · space to play</span>
          </div>

          <div className="ll-rate-verdict">
            <span className="ll-rate-label">Verdict</span>
            {[['A', 'A better', '1'], ['tie', 'Tie', '2'], ['B', 'B better', '3']].map(([v, label, key]) => (
              <button
                key={v}
                className={`ll-btn${verdict === v ? ' ll-btn--accent is-chosen' : ''}`}
                onClick={() => stageVerdict(v)}
              >
                {label} <span className="ll-rate-key">{key}</span>
              </button>
            ))}
          </div>

          <div className="ll-rate-tags">
            <span className="ll-rate-label">
              What was wrong with {verdict === 'A' ? 'B' : verdict === 'B' ? 'A' : 'the worse arm'}?
              <span className="ll-rate-sub"> optional</span>
            </span>
            <div className="ll-tag-row">
              {FAILURE_TAGS.map((tag) => (
                <button
                  key={tag}
                  className={`ll-tag${tags.includes(tag) ? ' is-on' : ''}`}
                  onClick={() => toggleTag(tag)}
                  disabled={!verdict || verdict === 'tie'}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          <div className="ll-rate-actions">
            <button className="ll-btn ll-btn--accent" onClick={commit} disabled={!verdict || busy}>
              Save &amp; next <span className="ll-rate-key">↵</span>
            </button>
            <button className="ll-btn ll-btn--ghost" onClick={skip} disabled={busy}>Skip</button>
          </div>
        </>
      )}

      {error && <div className="ll-rate-error">{error}</div>}
    </div>
  )
}

// Session progress: one tick per trial, rated / current / pending. Canvas draw
// calls only, colours read from the theme tokens (never hardcoded), redrawn on
// a theme change like every other canvas in the app. Deliberately carries no
// per-arm information — a visualisation of the two loops would leak which arm
// is which far more reliably than the ear does.
function TrialProgressCanvas({ trials, completed, current, width, height }) {
  const canvasRef = useRef(null)
  const themeEpoch = useThemeEpoch()

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    c.style.width = `${width}px`
    c.style.height = `${height}px`
    const ctx = c.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const bg = tokenValue('--theme-bg-surface') || '#12121a'
    const pending = tokenValue('--theme-border-strong') || '#3a3a44'
    const done = tokenValue('--theme-accent') || '#2ec4b6'
    const cur = tokenValue('--theme-text') || '#e8e8ef'

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, width, height)

    const n = Math.max(1, trials.length)
    const gap = n > 60 ? 1 : 2
    const w = Math.max(1, (width - gap * (n - 1)) / n)
    for (let i = 0; i < trials.length; i++) {
      const x = i * (w + gap)
      const isCurrent = i === current
      ctx.fillStyle = isCurrent ? cur : completed.has(trials[i].trial_id) ? done : pending
      const h = isCurrent ? height : height - 4
      ctx.fillRect(x, (height - h) / 2, w, h)
    }
  }, [trials, completed, current, width, height, themeEpoch])

  return <canvas ref={canvasRef} className="ll-rate-canvas" aria-hidden="true" />
}
