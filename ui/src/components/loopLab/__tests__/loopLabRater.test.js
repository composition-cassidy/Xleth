// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  ANCHOR_TRIAL_COUNT, FAILURE_TAGS, VERDICTS,
  parseCandidatesDoc, buildTrials, documentSeed,
  seedFromString, mulberry32, seededShuffle,
  indexSamplesForCandidates, resolveLoopLabSample, armEngineLoop,
  parseRatingsJsonl, completedTrialIds, firstPendingIndex,
  makeRatingRecord, serializeRatingLine,
  armContentHash, reconcileTrialsWithRatings,
} from '../loopLabRater.js'
import { fileToEngineLoop, sampleIdFromName } from '../loopLabMeta.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────

const arm = (armId, provenance, rank, loop, metrics = {}) => ({
  arm_id: armId, provenance, rank, loop, metrics,
})

function makeSample(i, { withNaive = true } = {}) {
  const id = `tone_${String(i).padStart(4, '0')}`
  return {
    sample_id: id,
    file: `corpus/Test/${id}.wav`,
    class: 'Test',
    behavior_family: 'stable_periodic',
    root_note: 60,
    file_sample_rate: 44100,
    file_num_samples: 44100,
    arms: [
      arm('optimizer_1', 'optimizer', 1, { start: 1000, end: 5000, xfade: 400 }),
      arm('optimizer_2', 'optimizer', 2, { start: 1100, end: 5100, xfade: 400 }),
      arm('gold', 'gold', null, { start: 8000, end: 34000, xfade: 1000 }),
      ...(withNaive ? [arm('naive', 'naive', null, { start: 9000, end: 30000, xfade: 2625 })] : []),
    ],
  }
}

function makeDoc(n = 26, opts) {
  return {
    schema: 'xleth.loop-optimizer.candidates/1',
    dataset: 'C:/corpus/dataset.json',
    selection: 'auto',
    rank_by: 'seam_step',
    top_k: 3,
    metric_names: ['seam_step', 'seam_ncc', 'zero_lag_corr', 'cents_err_per_loop', 'rms_ripple_db', 'spectral_dist'],
    samples: Array.from({ length: n }, (_, i) => makeSample(i + 1, opts)),
  }
}

// ── candidates.json parsing ──────────────────────────────────────────────────

describe('parseCandidatesDoc', () => {
  it('parses a well-formed document', () => {
    const doc = parseCandidatesDoc(JSON.stringify(makeDoc(2)))
    expect(doc.samples).toHaveLength(2)
    expect(doc.metric_names).toHaveLength(6)
    expect(doc.samples[0].arms.map((a) => a.provenance))
      .toEqual(['optimizer', 'optimizer', 'gold', 'naive'])
    expect(doc.samples[0].arms[0].loop).toEqual({ start: 1000, end: 5000, xfade: 400 })
  })

  it('rejects a document that is not JSON at all', () => {
    expect(() => parseCandidatesDoc('{not json')).toThrow(/not valid JSON/)
  })

  it('rejects an unknown schema rather than guessing at the shape', () => {
    const raw = { ...makeDoc(1), schema: 'something.else/9' }
    expect(() => parseCandidatesDoc(JSON.stringify(raw))).toThrow(/unsupported schema/)
  })

  it('rejects an unknown provenance', () => {
    const raw = makeDoc(1)
    raw.samples[0].arms[0].provenance = 'handmade'
    expect(() => parseCandidatesDoc(JSON.stringify(raw))).toThrow(/unknown provenance/)
  })

  it('rejects a degenerate loop instead of auditioning silence', () => {
    const raw = makeDoc(1)
    raw.samples[0].arms[0].loop = { start: 5000, end: 5000, xfade: 0 }
    expect(() => parseCandidatesDoc(JSON.stringify(raw))).toThrow(/end <= start/)
  })

  it('rejects a null loop point', () => {
    const raw = makeDoc(1)
    raw.samples[0].arms[1].loop = { start: null, end: 5000, xfade: 0 }
    expect(() => parseCandidatesDoc(JSON.stringify(raw))).toThrow(/non-numeric loop point/)
  })

  it('rejects a sample with no usable file_sample_rate — the conversion needs it', () => {
    const raw = makeDoc(1)
    raw.samples[0].file_sample_rate = 0
    expect(() => parseCandidatesDoc(JSON.stringify(raw))).toThrow(/file_sample_rate/)
  })

  it('rounds fractional loop points to whole samples', () => {
    const raw = makeDoc(1)
    raw.samples[0].arms[0].loop = { start: 1000.4, end: 5000.6, xfade: 400.5 }
    const doc = parseCandidatesDoc(JSON.stringify(raw))
    expect(doc.samples[0].arms[0].loop).toEqual({ start: 1000, end: 5001, xfade: 401 })
  })
})

// ── Trial construction + randomisation reproducibility ───────────────────────

describe('buildTrials', () => {
  const doc = makeDoc(26)

  it('builds one optimizer trial per sample plus the anchor trials', () => {
    const trials = buildTrials(doc)
    expect(trials).toHaveLength(26 + ANCHOR_TRIAL_COUNT)
    expect(trials.filter((t) => t.kind === 'optimizer')).toHaveLength(26)
    expect(trials.filter((t) => t.kind === 'naive')).toHaveLength(ANCHOR_TRIAL_COUNT)
  })

  it('pairs the top-ranked optimizer candidate against gold, never a lower rank', () => {
    for (const t of buildTrials(doc).filter((x) => x.kind === 'optimizer')) {
      expect(t.arm_order.slice().sort()).toEqual(['gold', 'optimizer_1'])
    }
  })

  it('pairs the naive anchor against gold', () => {
    for (const t of buildTrials(doc).filter((x) => x.kind === 'naive')) {
      expect(t.arm_order.slice().sort()).toEqual(['gold', 'naive'])
    }
  })

  it('is reproducible: same document in, same trials, order and blinding out', () => {
    const a = buildTrials(doc)
    const b = buildTrials(doc)
    expect(a.map((t) => t.trial_id)).toEqual(b.map((t) => t.trial_id))
    expect(a.map((t) => t.seed)).toEqual(b.map((t) => t.seed))
    expect(a.map((t) => t.arm_order.join('|'))).toEqual(b.map((t) => t.arm_order.join('|')))
  })

  it('does not depend on the order samples appear in the file', () => {
    const shuffled = { ...doc, samples: doc.samples.slice().reverse() }
    const a = buildTrials(doc)
    const b = buildTrials(shuffled)
    expect(a.map((t) => t.trial_id)).toEqual(b.map((t) => t.trial_id))
    expect(a.map((t) => t.arm_order.join('|'))).toEqual(b.map((t) => t.arm_order.join('|')))
  })

  it('re-blinds when an explicit session seed is supplied', () => {
    const a = buildTrials(doc)
    const b = buildTrials(doc, { sessionSeed: 12345 })
    // Every sample still gets its optimizer trial — that set is not up to the
    // seed. Which samples get an ANCHOR is, as are order and arm assignment.
    const optIds = (ts) => ts.filter((t) => t.kind === 'optimizer').map((t) => t.trial_id).sort()
    expect(optIds(a)).toEqual(optIds(b))
    expect(a).toHaveLength(b.length)
    const sameOrder = a.map((t) => t.trial_id).join() === b.map((t) => t.trial_id).join()
    const sameArms = a.map((t) => t.arm_order.join()).join() === b.map((t) => t.arm_order.join()).join()
    expect(sameOrder && sameArms).toBe(false)
  })

  it('randomises arm order both ways rather than always putting gold second', () => {
    const trials = buildTrials(doc)
    const goldFirst = trials.filter((t) => t.arm_order[0] === 'gold').length
    expect(goldFirst).toBeGreaterThan(0)
    expect(goldFirst).toBeLessThan(trials.length)
  })

  it("interleaves the anchors so they aren't a giveaway block at the end", () => {
    const trials = buildTrials(doc)
    const anchorAt = trials.map((t, i) => (t.kind === 'naive' ? i : -1)).filter((i) => i >= 0)
    // Not the last ANCHOR_TRIAL_COUNT positions.
    expect(Math.min(...anchorAt)).toBeLessThan(trials.length - ANCHOR_TRIAL_COUNT)
  })

  it('emits a stable, human-readable trial id', () => {
    const t = buildTrials(makeDoc(1)).find((x) => x.kind === 'optimizer')
    expect(t.trial_id).toBe('tone_0001::optimizer_1_vs_gold')
  })

  it('skips a sample that has no gold arm to compare against', () => {
    const raw = makeDoc(2)
    raw.samples[0].arms = raw.samples[0].arms.filter((a) => a.provenance !== 'gold')
    const trials = buildTrials(parseCandidatesDoc(JSON.stringify(raw)))
    expect(trials.every((t) => t.sample_id !== 'tone_0001')).toBe(true)
  })

  it('emits fewer anchors when fewer samples have a naive arm', () => {
    const trials = buildTrials(makeDoc(26, { withNaive: false }))
    expect(trials).toHaveLength(26)
    expect(trials.every((t) => t.kind === 'optimizer')).toBe(true)
  })

  it('produces the 36 trials the corpus calls for', () => {
    expect(buildTrials(makeDoc(26))).toHaveLength(36)
  })
})

describe('seeded randomness', () => {
  it('mulberry32 is deterministic and stays in [0, 1)', () => {
    const a = Array.from({ length: 8 }, mulberry32(42))
    const b = Array.from({ length: 8 }, mulberry32(42))
    expect(a).toEqual(b)
    for (const v of a) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1) }
  })

  it('seedFromString is stable and distinguishes similar strings', () => {
    expect(seedFromString('trial::a')).toBe(seedFromString('trial::a'))
    expect(seedFromString('trial::a')).not.toBe(seedFromString('trial::b'))
  })

  it('seededShuffle permutes without losing or duplicating items', () => {
    const src = Array.from({ length: 20 }, (_, i) => i)
    const out = seededShuffle(src, mulberry32(7))
    expect(out.slice().sort((a, b) => a - b)).toEqual(src)
    expect(out).not.toEqual(src)
    expect(src).toEqual(Array.from({ length: 20 }, (_, i) => i)) // input untouched
  })

  it('documentSeed changes when the sample set does', () => {
    expect(documentSeed(makeDoc(26))).toBe(documentSeed(makeDoc(26)))
    expect(documentSeed(makeDoc(26))).not.toBe(documentSeed(makeDoc(25)))
  })
})

// ── Blinding is resolvable after the fact ────────────────────────────────────

describe('blinding', () => {
  it("a record's arm_order is reproducible from the stored seed", () => {
    const doc = makeDoc(26)
    const trials = buildTrials(doc)
    // Re-deriving from candidates.json alone must reproduce every assignment;
    // this is what makes a months-old ratings.jsonl auditable.
    const rebuilt = new Map(buildTrials(doc).map((t) => [t.trial_id, t]))
    for (const t of trials) {
      const again = rebuilt.get(t.trial_id)
      expect(again.seed).toBe(t.seed)
      expect(again.arm_order).toEqual(t.arm_order)
    }
  })
})

// ── Sample <-> candidate matching, domain conversion ─────────────────────────

describe('matching candidates to the imported working set', () => {
  const llSamples = [
    { id: 1, name: 'tone_0001', filePath: 'C:/x/whatever.wav', regionId: 10, sampleRate: 48000, numSamples: 48000 },
    { id: 2, name: 'Renamed Later', filePath: 'C:/x/tone_0002.wav', regionId: 11, sampleRate: 48000, numSamples: 48000 },
  ]
  const doc = makeDoc(3)

  it('matches on the exported sample_id', () => {
    const idx = indexSamplesForCandidates(llSamples)
    expect(resolveLoopLabSample(idx, doc.samples[0]).regionId).toBe(10)
  })

  it('falls back to the WAV file name when the panel name has drifted', () => {
    const idx = indexSamplesForCandidates(llSamples)
    expect(resolveLoopLabSample(idx, doc.samples[1]).regionId).toBe(11)
  })

  it('returns null for a sample that was never imported', () => {
    const idx = indexSamplesForCandidates(llSamples)
    expect(resolveLoopLabSample(idx, doc.samples[2])).toBeNull()
  })

  it('sampleIdFromName mirrors the export id derivation', () => {
    expect(sampleIdFromName('hard_tuned_vocal_0001')).toBe('hard_tuned_vocal_0001')
    expect(sampleIdFromName('Hard-tuned vocal 12')).toBe('hard_tuned_vocal_12')
  })
})

describe('armEngineLoop', () => {
  const doc = makeDoc(1)
  const ll = { regionId: 10, sampleRate: 48000, numSamples: 39510, rootNote: 60 }

  it('converts a file-domain arm into engine-buffer samples', () => {
    const gold = doc.samples[0].arms.find((a) => a.arm_id === 'gold')
    const loop = armEngineLoop(gold, doc.samples[0], ll)
    const r = 48000 / 44100
    expect(loop.loopStart).toBe(Math.round(8000 * r))
    expect(loop.loopEnd).toBe(Math.round(34000 * r))
    expect(loop.xfade).toBe(Math.round(1000 * r))
  })

  it('is the exact inverse of the export path conversion, to within its rounding', () => {
    // convertGold (electron-main/loopLabExport.js) multiplies by fileRate/engRate.
    const engine = { start: 12974, end: 23482, xfade: 2051 }
    const toFile = (v) => Math.round(v * (44100 / 48000))
    const back = fileToEngineLoop(
      { start: toFile(engine.start), end: toFile(engine.end), xfade: toFile(engine.xfade) },
      44100, 48000, 96000
    )
    expect(Math.abs(back.loopStart - engine.start)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.loopEnd - engine.end)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.xfade - engine.xfade)).toBeLessThanOrEqual(1)
  })

  it('is identity when the file is already at the engine rate', () => {
    expect(fileToEngineLoop({ start: 100, end: 900, xfade: 50 }, 48000, 48000, 96000))
      .toEqual({ loopStart: 100, loopEnd: 900, xfade: 50 })
  })

  it('clamps loop points into the buffer but leaves the crossfade request alone', () => {
    // The engine applies its own crossfade clamp; the offline analysis measured
    // the REQUESTED width against it, so the request must survive unchanged.
    const loop = fileToEngineLoop({ start: 0, end: 999999, xfade: 40000 }, 48000, 48000, 1000)
    expect(loop.loopEnd).toBe(1000)
    expect(loop.xfade).toBe(40000)
  })
})

// ── ratings.jsonl: append + resume ───────────────────────────────────────────

describe('ratings.jsonl', () => {
  const trial = buildTrials(makeDoc(2))[0]

  it('serialises one record per line, newline-terminated', () => {
    const line = serializeRatingLine(makeRatingRecord(trial, { winner: 'A', timestamp: 'T' }))
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd()).not.toContain('\n')
    expect(JSON.parse(line)).toMatchObject({ trial_id: trial.trial_id, winner: 'A' })
  })

  it('records the fields the analysis needs, including the reveal', () => {
    const rec = makeRatingRecord(trial, { winner: 'B', failureTags: ['hollow'], timestamp: 'T' })
    expect(rec).toEqual({
      trial_id: trial.trial_id,
      sample_id: trial.sample_id,
      kind: trial.kind,
      seed: trial.seed,
      arm_order: trial.arm_order,
      arm_hashes: trial.arm_hashes,
      winner: 'B',
      winner_arm_id: trial.arm_order[1],
      loser_arm_id: trial.arm_order[0],
      failure_tags: ['hollow'],
      timestamp: 'T',
    })
  })

  it('leaves a tie with no arm to hang failure tags on', () => {
    const rec = makeRatingRecord(trial, { winner: 'tie', timestamp: 'T' })
    expect(rec.winner_arm_id).toBeNull()
    expect(rec.loser_arm_id).toBeNull()
  })

  it('drops unknown failure tags and keeps the canonical order', () => {
    const rec = makeRatingRecord(trial, { winner: 'A', failureTags: ['bogus', 'flam', 'click'], timestamp: 'T' })
    expect(rec.failure_tags).toEqual(['click', 'flam'])
  })

  it('rejects an unknown verdict', () => {
    expect(() => makeRatingRecord(trial, { winner: 'maybe' })).toThrow(/unknown verdict/)
    for (const v of VERDICTS) expect(() => makeRatingRecord(trial, { winner: v })).not.toThrow()
  })

  it('stamps an ISO timestamp when none is supplied', () => {
    expect(makeRatingRecord(trial, { winner: 'A' }).timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('parses an appended file back into records', () => {
    const lines = [
      makeRatingRecord(trial, { winner: 'A', timestamp: 'T1' }),
      makeRatingRecord(trial, { winner: 'B', timestamp: 'T2' }),
    ].map(serializeRatingLine).join('')
    const { records, malformed } = parseRatingsJsonl(lines)
    expect(records).toHaveLength(2)
    expect(malformed).toBe(0)
  })

  it('survives a torn final line — the crash case the append-per-verdict exists for', () => {
    const good = serializeRatingLine(makeRatingRecord(trial, { winner: 'A', timestamp: 'T' }))
    const { records, malformed } = parseRatingsJsonl(`${good}{"trial_id":"half-writ`)
    expect(records).toHaveLength(1)
    expect(malformed).toBe(1)
  })

  it('ignores blank lines and an empty file', () => {
    expect(parseRatingsJsonl('').records).toEqual([])
    expect(parseRatingsJsonl('\n\n  \n').records).toEqual([])
    expect(parseRatingsJsonl('').malformed).toBe(0)
  })

  it('counts a JSON line that is not a rating as malformed', () => {
    expect(parseRatingsJsonl('{"note":"hello"}\n').malformed).toBe(1)
  })
})

describe('resume', () => {
  const doc = makeDoc(26)
  const trials = buildTrials(doc)

  it('starts at the first trial on a fresh session', () => {
    expect(firstPendingIndex(trials, new Set())).toBe(0)
  })

  it('skips completed trials wherever they sit in the list', () => {
    const rated = [trials[0], trials[1], trials[5]]
    const text = rated.map((t) => serializeRatingLine(makeRatingRecord(t, { winner: 'A', timestamp: 'T' }))).join('')
    const { records } = parseRatingsJsonl(text)
    const done = completedTrialIds(records)
    expect(done.size).toBe(3)
    expect(firstPendingIndex(trials, done)).toBe(2)
  })

  it('reports -1 when every trial has a verdict', () => {
    const all = completedTrialIds(trials.map((t) => makeRatingRecord(t, { winner: 'tie', timestamp: 'T' })))
    expect(firstPendingIndex(trials, all)).toBe(-1)
  })

  it('counts a re-rated trial once', () => {
    const text = [
      makeRatingRecord(trials[0], { winner: 'A', timestamp: 'T1' }),
      makeRatingRecord(trials[0], { winner: 'B', timestamp: 'T2' }),
    ].map(serializeRatingLine).join('')
    const { records } = parseRatingsJsonl(text)
    expect(records).toHaveLength(2)
    expect(completedTrialIds(records).size).toBe(1)
    expect(firstPendingIndex(trials, completedTrialIds(records))).toBe(1)
  })

  it('resumes correctly from a file whose last line was torn by a crash', () => {
    const good = [trials[0], trials[1]]
      .map((t) => serializeRatingLine(makeRatingRecord(t, { winner: 'A', timestamp: 'T' }))).join('')
    const { records } = parseRatingsJsonl(`${good}{"trial_id":"${trials[2].trial_id}","win`)
    // The torn trial is NOT counted as done — it gets rated again, which is the
    // safe direction to fail in.
    expect(firstPendingIndex(trials, completedTrialIds(records))).toBe(2)
  })

  it('ignores a stale trial_id left over from a different candidate set', () => {
    const done = completedTrialIds([{ trial_id: 'some_other_sample::optimizer_1_vs_gold' }])
    expect(firstPendingIndex(trials, done)).toBe(0)
  })
})

// ── Content-addressed resume (arm content, not trial_id alone) ──────────────
// Regression coverage for the real incident: candidates.json got regenerated
// with a new ranking, sample_id + pairing (and so trial_id) stayed the same,
// and every optimizer trial was silently marked "already rated" against loops
// nobody had heard. A whole session produced zero valid verdicts, no warning.

describe('armContentHash', () => {
  const a = (loop, provenance = 'optimizer') => ({ arm_id: 'x', provenance, loop, metrics: {} })

  it('is stable for identical content', () => {
    const loop = { start: 100, end: 500, xfade: 40 }
    expect(armContentHash(a(loop))).toBe(armContentHash(a({ ...loop })))
  })

  it('changes when any loop point changes', () => {
    const base = armContentHash(a({ start: 100, end: 500, xfade: 40 }))
    expect(armContentHash(a({ start: 101, end: 500, xfade: 40 }))).not.toBe(base)
    expect(armContentHash(a({ start: 100, end: 501, xfade: 40 }))).not.toBe(base)
    expect(armContentHash(a({ start: 100, end: 500, xfade: 41 }))).not.toBe(base)
  })

  it('changes with provenance even for identical loop points', () => {
    const loop = { start: 100, end: 500, xfade: 40 }
    expect(armContentHash(a(loop, 'optimizer'))).not.toBe(armContentHash(a(loop, 'gold')))
  })
})

describe('reconcileTrialsWithRatings', () => {
  const doc = makeDoc(26)
  const trials = buildTrials(doc)
  const optTrial = trials.find((t) => t.kind === 'optimizer')

  // A record indistinguishable from a genuine pre-fix verdict: everything
  // makeRatingRecord writes today, MINUS arm_hashes.
  function legacyRecordFor(trial, overrides = {}) {
    const rec = makeRatingRecord(trial, { winner: 'A', timestamp: 'T0' })
    delete rec.arm_hashes
    return { ...rec, ...overrides }
  }

  it('round-1 back-compat: a legacy verdict with matching content resumes as completed', () => {
    const legacy = legacyRecordFor(optTrial)
    const { trials: resolved, completed, archived, toBackfill } =
      reconcileTrialsWithRatings(trials, [legacy])

    expect(completed.has(optTrial.trial_id)).toBe(true)
    expect(resolved.find((t) => t.sample_id === optTrial.sample_id && t.kind === 'optimizer').trial_id)
      .toBe(optTrial.trial_id) // unsuffixed — this IS the trial, not a new variant
    expect(archived).toBe(0)

    // ...and it schedules an upgrade so a FUTURE regeneration can be caught.
    expect(toBackfill).toHaveLength(1)
    expect(toBackfill[0].trial_id).toBe(optTrial.trial_id)
    expect(toBackfill[0].arm_hashes).toEqual(optTrial.arm_hashes)
    expect(toBackfill[0].winner).toBe('A') // original verdict preserved
    expect(toBackfill[0].migrated_from_legacy).toBe(true)
  })

  it('a full round-1 ratings.jsonl + matching candidates.json validates as a completed session', () => {
    // Every trial gets its own legacy verdict — the real shape of an existing
    // production ratings.jsonl predating this fix.
    const legacyFile = trials.map((t) => legacyRecordFor(t))
    const { completed, archived } = reconcileTrialsWithRatings(trials, legacyFile)
    expect(completed.size).toBe(trials.length)
    expect(archived).toBe(0)
  })

  it('REGRESSION: a legacy-only verdict is never adopted by a document with a different rank_by, even on the FIRST load', () => {
    // This is the actual incident, reproduced exactly. A legacy (never
    // migrated) ratings.jsonl exists. The user opens a REGENERATED
    // candidates.json (rank_by changed, real optimizer content changed) for
    // the very first time — there is no prior hash-bearing record to compare
    // against, only the original legacy verdict. Trusting "whatever's
    // currently open" here silently stamped round-2's loop points onto a
    // verdict that was actually rated against round-1's, and every optimizer
    // trial showed complete without ever being freshly judged.
    const legacyFile = trials.map((t) => legacyRecordFor(t)) // NEVER reconciled/migrated before
    const doc2 = JSON.parse(JSON.stringify(doc))
    doc2.rank_by = 'perceptual' // round-1 used 'seam_step' — this is the real diff
    const targetSample = doc2.samples.find((s) => s.sample_id === optTrial.sample_id)
    targetSample.arms.find((a) => a.arm_id === 'optimizer_1').loop.start += 500
    const trials2 = buildTrials(parseCandidatesDoc(JSON.stringify(doc2)))

    const { trials: resolved, completed, toBackfill } = reconcileTrialsWithRatings(trials2, legacyFile)

    const changedTrial = resolved.find((t) => t.sample_id === optTrial.sample_id && t.kind === 'optimizer')
    expect(completed.has(changedTrial.trial_id)).toBe(false) // NOT silently completed
    expect(changedTrial.trial_id).toBe(optTrial.trial_id) // offered under the base id — nothing to disambiguate a suffix from yet
    expect(toBackfill).toHaveLength(0) // round-1's verdict must NOT be stamped with round-2's content
  })

  it('DOES migrate a legacy verdict when the currently-open document truly is the one it was rated against', () => {
    // The positive case the guard must not break: opening round-1's OWN file
    // (same rank_by, same everything) still upgrades its legacy verdicts.
    const legacyFile = trials.map((t) => legacyRecordFor(t))
    const { completed, toBackfill } = reconcileTrialsWithRatings(trials, legacyFile)
    expect(completed.size).toBe(trials.length)
    expect(toBackfill).toHaveLength(trials.length)
  })

  it('same trial_id, different arm content: offered again under a suffixed id, not skipped', () => {
    // A record that LOOKS like it belongs to this trial_id but carries a
    // content hash from a different (already-migrated) candidate set.
    const staleHashes = [optTrial.arm_hashes[0] + 1, optTrial.arm_hashes[1] + 1]
    const stale = { ...legacyRecordFor(optTrial), arm_hashes: staleHashes }

    const { trials: resolved, completed } = reconcileTrialsWithRatings(trials, [stale])

    const thisTrial = resolved.find((t) => t.sample_id === optTrial.sample_id && t.kind === 'optimizer')
    expect(thisTrial.trial_id).toBe(`${optTrial.trial_id}::r2`)
    // Offered, not skipped: neither the old id nor the new suffixed one is
    // in the completed set.
    expect(completed.has(optTrial.trial_id)).toBe(false)
    expect(completed.has(thisTrial.trial_id)).toBe(false)
  })

  it('hash-mismatch is counted for the archived-verdicts notice', () => {
    const staleHashes = [optTrial.arm_hashes[0] + 1, optTrial.arm_hashes[1] + 1]
    const stale = { ...legacyRecordFor(optTrial), arm_hashes: staleHashes }
    const { archived } = reconcileTrialsWithRatings(trials, [stale])
    expect(archived).toBe(1)
  })

  it('a verdict for a sample no longer in the candidate set is archived, not resumed', () => {
    const orphan = { ...legacyRecordFor(optTrial), trial_id: 'sample_removed::optimizer_1_vs_gold' }
    const { completed, archived } = reconcileTrialsWithRatings(trials, [orphan])
    expect(completed.size).toBe(0)
    expect(archived).toBe(1)
  })

  it('re-rating the same suffixed variant resumes it correctly on a later load', () => {
    // Round 2's own verdict, once written, must be recognised on a subsequent
    // reload of the SAME (round-2) candidates.json.
    const staleHashes = [optTrial.arm_hashes[0] + 1, optTrial.arm_hashes[1] + 1]
    const stale = { ...legacyRecordFor(optTrial), arm_hashes: staleHashes }
    const first = reconcileTrialsWithRatings(trials, [stale])
    const suffixedTrial = first.trials.find((t) => t.sample_id === optTrial.sample_id && t.kind === 'optimizer')

    const round2Verdict = makeRatingRecord(suffixedTrial, { winner: 'B', timestamp: 'T1' })
    const second = reconcileTrialsWithRatings(trials, [stale, round2Verdict])

    expect(second.completed.has(`${optTrial.trial_id}::r2`)).toBe(true)
    // The genuinely stale verdict is still the only OTHER thing on file for
    // this slot and still doesn't match current content.
    expect(second.archived).toBe(1)
  })

  it('brand new trial with no prior verdict at all is simply offered, not flagged', () => {
    const { trials: resolved, completed, archived } = reconcileTrialsWithRatings(trials, [])
    expect(completed.size).toBe(0)
    expect(archived).toBe(0)
    expect(resolved.find((t) => t.trial_id === optTrial.trial_id)).toBeTruthy()
  })

  it('end-to-end: round-1 legacy ratings, migrated, then round-2 candidates correctly re-offers', () => {
    // Step 1 — round 1: legacy verdicts for every trial (the real corpus shape).
    const round1Legacy = trials.map((t) => legacyRecordFor(t))
    const pass1 = reconcileTrialsWithRatings(trials, round1Legacy)
    expect(pass1.completed.size).toBe(trials.length)
    expect(pass1.toBackfill).toHaveLength(trials.length)

    // Persist the migration, exactly as the app would (append, never rewrite).
    const migratedFile = [...round1Legacy, ...pass1.toBackfill]

    // Step 2 — round 2: regenerate candidates.json with different loop points
    // for ONE optimizer arm on ONE sample. Same sample_id/arm_id, so the SAME
    // trial_id as before — this is exactly the bug's shape.
    const doc2 = JSON.parse(JSON.stringify(doc))
    const targetSample = doc2.samples.find((s) => s.sample_id === optTrial.sample_id)
    const targetArm = targetSample.arms.find((a) => a.arm_id === 'optimizer_1')
    targetArm.loop.start += 500
    targetArm.loop.end += 500
    const trials2 = buildTrials(parseCandidatesDoc(JSON.stringify(doc2)))

    const pass2 = reconcileTrialsWithRatings(trials2, migratedFile)

    // The changed sample's optimizer trial is OFFERED again, not skipped.
    const changedTrial = pass2.trials.find((t) => t.sample_id === optTrial.sample_id && t.kind === 'optimizer')
    expect(changedTrial.trial_id).toBe(`${optTrial.trial_id}::r2`)
    expect(pass2.completed.has(optTrial.trial_id)).toBe(false)
    expect(pass2.completed.has(changedTrial.trial_id)).toBe(false)

    // Every OTHER trial (unchanged content) is still correctly resumed.
    const otherTrials = pass2.trials.filter((t) => t.sample_id !== optTrial.sample_id)
    for (const t of otherTrials) expect(pass2.completed.has(t.trial_id)).toBe(true)

    // The notice fires: the stale round-1 verdict for the changed sample
    // belongs to a different candidate set now.
    expect(pass2.archived).toBeGreaterThanOrEqual(1)
  })
})

describe('vocabulary', () => {
  it('exposes the six failure tags the brief names', () => {
    expect(FAILURE_TAGS).toEqual(['click', 'hollow', 'wobble', 'chorusing', 'flam', 'timbre-jump'])
  })
  it('is pairwise only — no absolute score anywhere in the vocabulary', () => {
    expect(VERDICTS).toEqual(['A', 'tie', 'B'])
  })
})
