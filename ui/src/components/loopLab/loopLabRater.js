// Loop Lab blind A/B rater — pure logic. No React, no engine calls, no I/O, so
// the parts that decide what gets rated and how it is blinded are testable on
// their own. The audition itself (LoopLabRater.jsx) runs through the same
// engine sampler path the authoring panel uses; nothing here touches audio.
//
// The optimizer's report says its top candidate beats the human gold loop on
// tuning and every seam metric at once for most of the corpus. That is a claim
// about six numbers, not about how a loop sounds, and it is only settled by
// listening without knowing which arm is which. Hence: identities hidden,
// presentation order seeded, verdicts pairwise, and the reveal written only to
// the ratings file.

import { fileToEngineLoop, sampleIdFromName } from './loopLabMeta.js'

//: How many samples get an extra naive-vs-gold anchor trial. The anchor is the
//: session's own calibration: a rater who cannot reliably hear a deliberately
//: period-unaligned loop lose to gold was not hearing loop quality in the
//: optimizer trials either, and the whole session should be discarded.
export const ANCHOR_TRIAL_COUNT = 10

//: Failure modes a rater can tag on the WORSE arm. Named after what they sound
//: like, not what causes them — the point is to record the percept, and let the
//: metric that was supposed to catch it be identified afterwards.
export const FAILURE_TAGS = ['click', 'hollow', 'wobble', 'chorusing', 'flam', 'timbre-jump']

//: Pairwise only. No absolute scores: "how good is this loop out of 5" drifts
//: over a 36-trial session in a way "which of these two" does not.
export const VERDICTS = ['A', 'tie', 'B']

export const RATINGS_FILENAME = 'ratings.jsonl'

// ── Seeded randomness ────────────────────────────────────────────────────────
// Both taken from the standard small-PRNG set (xmur3 seeder + mulberry32).
// Math.random() is unusable here: a trial's arm order has to be reproducible
// months later from the seed recorded beside the verdict, or the ratings file
// cannot be audited.

export function seedFromString(str) {
  let h = 1779033703 ^ String(str).length
  for (let i = 0; i < String(str).length; i++) {
    h = Math.imul(h ^ String(str).charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^ (h >>> 16)) >>> 0
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Fisher-Yates against a supplied generator. Returns a new array.
export function seededShuffle(items, rand) {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = out[i]; out[i] = out[j]; out[j] = t
  }
  return out
}

// ── candidates.json ──────────────────────────────────────────────────────────

const SCHEMA = 'xleth.loop-optimizer.candidates/1'

function requireArray(value, what) {
  if (!Array.isArray(value)) throw new Error(`candidates.json: ${what} must be an array`)
  return value
}

function normalizeLoop(loop, where) {
  // `Number(null)` is 0 and `Number('')` is 0, so a missing loop point would
  // otherwise pass validation and audition from the top of the file. Reject the
  // non-numbers before coercing anything.
  const n = (v) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`candidates.json: ${where} has a non-numeric loop point`)
    }
    return Math.round(v)
  }
  const start = n(loop && loop.start)
  const end = n(loop && loop.end)
  if (end <= start) throw new Error(`candidates.json: ${where} has end <= start`)
  return { start, end, xfade: Math.max(0, n(loop && loop.xfade != null ? loop.xfade : 0)) }
}

// Parse + validate the document written by `python -m loop_optimizer export`.
// Throws with a specific message rather than returning a half-built object: a
// malformed arm set silently dropping a trial is exactly the failure that would
// make a session's results wrong without looking wrong.
export function parseCandidatesDoc(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`candidates.json is not valid JSON: ${e.message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error('candidates.json: expected an object')
  if (raw.schema !== SCHEMA) {
    throw new Error(`candidates.json: unsupported schema ${JSON.stringify(raw.schema)} (expected ${SCHEMA})`)
  }
  const metricNames = requireArray(raw.metric_names, 'metric_names')

  const samples = requireArray(raw.samples, 'samples').map((s, i) => {
    const sampleId = String((s && s.sample_id) || '')
    if (!sampleId) throw new Error(`candidates.json: sample ${i} has no sample_id`)
    const arms = requireArray(s.arms, `${sampleId}.arms`).map((a) => {
      const armId = String((a && a.arm_id) || '')
      const provenance = String((a && a.provenance) || '')
      if (!armId) throw new Error(`candidates.json: ${sampleId} has an arm with no arm_id`)
      if (!['optimizer', 'gold', 'naive', 'policy', 'policy_v2'].includes(provenance)) {
        throw new Error(`candidates.json: ${sampleId}/${armId} has unknown provenance ${JSON.stringify(provenance)}`)
      }
      return {
        arm_id: armId,
        provenance,
        rank: a.rank == null ? null : Number(a.rank),
        loop: normalizeLoop(a.loop, `${sampleId}/${armId}`),
        metrics: (a && a.metrics) || {},
      }
    })
    const fileRate = Number(s.file_sample_rate)
    if (!Number.isFinite(fileRate) || fileRate <= 0) {
      throw new Error(`candidates.json: ${sampleId} has no usable file_sample_rate`)
    }
    return {
      sample_id: sampleId,
      file: String(s.file || ''),
      class: s.class == null ? '' : String(s.class),
      behavior_family: s.behavior_family == null ? '' : String(s.behavior_family),
      root_note: s.root_note == null ? null : Number(s.root_note),
      file_sample_rate: fileRate,
      file_num_samples: Number(s.file_num_samples) || 0,
      arms,
    }
  })

  return {
    schema: raw.schema,
    dataset: String(raw.dataset || ''),
    selection: String(raw.selection || ''),
    rank_by: String(raw.rank_by || ''),
    top_k: Number(raw.top_k) || 0,
    metric_names: metricNames.map(String),
    samples,
  }
}

// ── Content hashing ──────────────────────────────────────────────────────────
// A rater session must never treat a verdict recorded against one set of loop
// points as covering a DIFFERENT set that happens to share a trial_id. This bit
// the corpus for real: candidates.json was regenerated with a new ranking,
// sample_id + arm pairing stayed the same so every trial_id was unchanged, and
// every optimizer trial was silently marked "already rated" against loops
// nobody had actually heard — a whole session produced zero valid verdicts with
// no warning. `armContentHash` is the fix's unit: a stable fingerprint of what
// an arm actually IS (its loop + provenance), independent of arm_id naming or
// presentation order, computed here rather than trusted from whatever the
// exporter wrote — so it works identically whether or not the candidates.json
// on disk predates this feature.
export function armContentHash(arm) {
  const l = arm.loop
  return seedFromString(`${arm.provenance}|${l.start}|${l.end}|${l.xfade}`)
}

// Order-independent fingerprint of the pair of loops a trial compares. Sorted
// so re-blinding (arm_order flipping which is A and which is B) never changes
// it — a trial's identity is "these two loops", not "this presentation".
function armPairHash(hashA, hashB) {
  return [hashA, hashB].sort((a, b) => a - b).join(':')
}

// A trial_id's stable FAMILY: the sample+pairing slot shared by every content
// variant that has ever occupied it across regenerations of candidates.json.
// `::rN` is the disambiguating suffix `reconcileTrialsWithRatings` assigns when
// a slot's content changes out from under an otherwise-unchanged trial_id.
function trialFamilyId(trialId) {
  return String(trialId).replace(/::r\d+$/, '')
}

// ── Trial construction ───────────────────────────────────────────────────────

const armById = (sample, id) => sample.arms.find((a) => a.arm_id === id) || null
const topOptimizerArm = (sample) =>
  sample.arms.find((a) => a.provenance === 'optimizer' && a.rank === 1) ||
  sample.arms.find((a) => a.provenance === 'optimizer') ||
  null

//: Provenances that stand as gold's REAL challenger — each gets its own
//: vs-gold trial, unlike `naive`, which is the session's own calibration
//: anchor and handled separately via `anchorCount`. A document carries
//: whichever of these its round exported: rounds 1-2 wrote `optimizer` only
//: (full-auto ranking); round 3 writes `policy` only (the selection-first
//: arm — see loop_optimizer/export.py, not metric-ranked); round 4 writes
//: `policy_v2` only (the same arm with formant-gated placement and a
//: drift-gated fade length). Trying every kind and skipping whichever a
//: given document doesn't have keeps `buildTrials` correct for any of these
//: shapes without a "which round is this" flag anywhere in the rater.
//:
//: The generations are separate provenances rather than one `policy` slot
//: whose meaning changes with the file, and that is load-bearing:
//: `armContentHash` mixes the provenance in, so a round-3 verdict can never
//: be silently credited to a round-4 arm that happens to land on the same
//: loop points. That is the same failure 2d5c5d1 had to fix.
const CHALLENGER_PROVENANCES = ['optimizer', 'policy', 'policy_v2']

//: `optimizer` may have several ranked arms (topOptimizerArm picks rank 1);
//: every other challenger provenance is a single unranked arm named after
//: itself (arm_id === provenance), so a plain lookup is exact.
const challengerArm = (sample, provenance) =>
  provenance === 'optimizer' ? topOptimizerArm(sample) : armById(sample, provenance)

// The default session seed comes from the document itself, not from a clock or
// an RNG: two people rating the same candidates.json then see the same trials in
// the same order with the same blinding, and a resumed session after a crash
// rebuilds the identical list without needing anything persisted alongside it.
// Pass an explicit `sessionSeed` to re-blind the same corpus for a second pass.
export function documentSeed(doc) {
  // Sample ids are SORTED into the seed, not taken in file order: re-exporting
  // the same corpus with the rows in a different order must not re-blind a
  // session that is already half rated.
  const ids = doc.samples.map((s) => s.sample_id).slice().sort().join(',')
  return seedFromString(`${doc.schema}|${doc.selection}|${doc.rank_by}|${ids}`)
}

// Build the full trial list: one vs-gold trial per sample for each challenger
// provenance the document actually has (see CHALLENGER_PROVENANCES — rounds
// 1-2 that's `optimizer`, round 3 that's `policy`), plus a naive-vs-gold
// anchor for `anchorCount` of them.
//
// Presentation order is shuffled across the whole list rather than appending the
// anchors at the end, because a run of obviously-bad trials at a known position
// tells the rater exactly which trials are anchors and defeats the calibration.
export function buildTrials(doc, { anchorCount = ANCHOR_TRIAL_COUNT, sessionSeed } = {}) {
  const base = sessionSeed == null ? documentSeed(doc) : sessionSeed >>> 0
  // Sort by sample_id so the list does not depend on the order the samples
  // happen to appear in the file.
  const samples = doc.samples.slice().sort((a, b) => (a.sample_id < b.sample_id ? -1 : a.sample_id > b.sample_id ? 1 : 0))

  const eligible = (s, provenance) => {
    const gold = armById(s, 'gold')
    const challenger = challengerArm(s, provenance)
    return gold && challenger ? { gold, challenger } : null
  }

  const anchorPool = samples.filter((s) => eligible(s, 'naive'))
  const anchorIds = new Set(
    seededShuffle(anchorPool.map((s) => s.sample_id), mulberry32(seedFromString(`${base}:anchors`)))
      .slice(0, Math.max(0, anchorCount))
  )

  const trials = []
  for (const sample of samples) {
    const kinds = CHALLENGER_PROVENANCES.filter((p) => eligible(sample, p))
    if (anchorIds.has(sample.sample_id)) kinds.push('naive')
    for (const kind of kinds) {
      const pair = eligible(sample, kind)
      if (!pair) continue
      const trialId = `${sample.sample_id}::${pair.challenger.arm_id}_vs_gold`
      // Per-trial seed, recorded with the verdict: it is what makes a blinded
      // arm order reproducible from the ratings file alone.
      const seed = seedFromString(`${base}:${trialId}`)
      const armsInOrder = mulberry32(seed)() < 0.5
        ? [pair.challenger, pair.gold]
        : [pair.gold, pair.challenger]
      trials.push({
        trial_id: trialId,
        sample_id: sample.sample_id,
        kind,
        seed,
        arm_order: armsInOrder.map((a) => a.arm_id),
        // Content fingerprint of the two loops being compared, in arm_order's
        // order. This is what `reconcileTrialsWithRatings` checks a verdict
        // against — never the trial_id alone.
        arm_hashes: armsInOrder.map((a) => armContentHash(a)),
        arms: armsInOrder,
        sample,
      })
    }
  }

  return seededShuffle(trials, mulberry32(seedFromString(`${base}:order`)))
}

// Line each trial's sample up with an imported Loop Lab sample (which owns the
// engine region the audition plays through). Matches on the exported sample_id
// first, then on the WAV's file name, so a corpus imported straight from disk
// lines up even when the panel's sample names have drifted.
export function indexSamplesForCandidates(loopLabSamples) {
  const byId = new Map()
  const byFile = new Map()
  for (const s of loopLabSamples || []) {
    const id = sampleIdFromName(s.name)
    if (!byId.has(id)) byId.set(id, s)
    const base = String(s.filePath || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toLowerCase()
    if (base && !byFile.has(base)) byFile.set(base, s)
  }
  return { byId, byFile }
}

export function resolveLoopLabSample(index, candidateSample) {
  const byId = index.byId.get(candidateSample.sample_id)
  if (byId) return byId
  const base = String(candidateSample.file || '').split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toLowerCase()
  return (base && index.byFile.get(base)) || null
}

// One arm's loop, in the engine-buffer domain the sampler indexes. `llSample` is
// the imported Loop Lab sample: its `sampleRate` is the region's real engine
// rate (from getRegionAudioInfo), which is what the preview will actually use —
// candidates.json's own engine-domain numbers are informational only.
export function armEngineLoop(arm, candidateSample, llSample) {
  return fileToEngineLoop(
    arm.loop,
    candidateSample.file_sample_rate,
    llSample.sampleRate,
    llSample.numSamples
  )
}

// ── ratings.jsonl ────────────────────────────────────────────────────────────

// Parse an append-only ratings file. Tolerates a torn final line: the file is
// appended to after every single verdict precisely so a crash loses at most the
// trial in progress, and a half-written line is that trial, not corruption.
export function parseRatingsJsonl(text) {
  const records = []
  let malformed = 0
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed)
      if (rec && typeof rec.trial_id === 'string') records.push(rec)
      else malformed++
    } catch {
      malformed++
    }
  }
  return { records, malformed }
}

// Trials already rated. A trial rated twice (a deliberate re-rate) counts once;
// the file keeps both lines, and the later one is the verdict that stands.
export function completedTrialIds(records) {
  return new Set((records || []).map((r) => r && r.trial_id).filter((id) => typeof id === 'string'))
}

// Index of the first trial not yet rated, or -1 when the session is complete.
export function firstPendingIndex(trials, completed) {
  for (let i = 0; i < trials.length; i++) {
    if (!completed.has(trials[i].trial_id)) return i
  }
  return -1
}

// Reconcile freshly-built trials against previously recorded verdicts, using
// arm CONTENT rather than trial_id alone. This is the actual fix: a verdict
// only counts as completing a trial when its recorded arm_hashes match what
// THIS candidates.json currently holds for that trial_id.
//
// When a trial_id is reused for genuinely different content (a regenerated
// candidates.json with a new ranking, same sample/pairing), the OLD verdict is
// left exactly where it is — nothing is deleted or rewritten — and the trial
// is offered again under a suffixed id (`::r2`, `::r3`, ...) so the new
// verdict can never collide with the old line in ratings.jsonl.
//
// Verdicts written before this fix existed carry no `arm_hashes` at all —
// trial_id is the only signal they had, until now. Trial_id alone is NOT
// enough to safely upgrade one of these: the fix's whole premise is that a
// trial_id can silently point at different content, so trusting "whatever
// candidates.json happens to be open right now" as ground truth for a legacy
// record is exactly the same mistake with an extra step. This actually
// happened during testing — a legacy verdict rated against round 1 got
// silently stamped with round 2's loop points the first time round 2 was
// opened, because nothing had ever validated it against round 1 first.
//
// The guard: every record, legacy or not, already carries the `seed` field
// (`seedFromString(`${documentSeed(doc)}:${trialId}`)`), and `documentSeed`
// depends on `schema|selection|rank_by|sample_ids` — not on this function's
// arm-content hashing at all, so it is unaffected by anything below. A legacy
// record is only upgraded when ITS OWN stored seed matches what the
// CURRENTLY loaded document recomputes for that trial_id — i.e., the
// currently-open file plausibly has the same overall identity (in
// particular, the same rank_by) as whatever produced the record, not just an
// accidentally-matching trial_id. A regenerated candidates.json with a
// different ranking has a different rank_by and therefore a different seed
// for every trial, so this guard correctly refuses to adopt round 1's
// verdicts as round 2's — the record stays untouched, legacy, and the trial
// is offered fresh. A legacy record that fails this check is not "wrong", it
// is simply unverifiable against what's currently open, so it neither
// completes the trial nor gets backfilled; it is left exactly as it is for
// whichever document it actually matches to pick up later.
//
// Returns:
//   trials     - the input trials, each carrying a possibly-suffixed
//                `trial_id` (every other field unchanged)
//   completed  - Set of (resolved) trial_ids that already have a matching verdict
//   archived   - count of ratings.jsonl records that belong to a different
//                candidate set (a removed sample/pairing, or mismatched content)
//   toBackfill - legacy records to re-append with their content hash filled in,
//                preserving the original verdict's winner/tags/timestamp
export function reconcileTrialsWithRatings(trials, records) {
  const byFamily = new Map()
  for (const r of records || []) {
    if (!r || typeof r.trial_id !== 'string') continue
    const fam = trialFamilyId(r.trial_id)
    if (!byFamily.has(fam)) byFamily.set(fam, [])
    byFamily.get(fam).push(r)
  }

  const isHashed = (r) => Array.isArray(r.arm_hashes) && r.arm_hashes.length === 2
  const recordPairHash = (r) => armPairHash(r.arm_hashes[0], r.arm_hashes[1])

  const familiesInDoc = new Set(trials.map((t) => t.trial_id))
  const completed = new Set()
  const toBackfill = []
  const resolved = []

  for (const trial of trials) {
    const fam = trial.trial_id
    const pairHash = armPairHash(trial.arm_hashes[0], trial.arm_hashes[1])
    const familyRecords = byFamily.get(fam) || []
    const hashed = familyRecords.filter(isHashed)
    const legacy = familyRecords.filter((r) => !isHashed(r))

    const match = hashed.find((r) => recordPairHash(r) === pairHash)

    if (match) {
      // A verdict already exists for exactly this content — resume under
      // whichever trial_id that verdict used (its own base or a prior suffix).
      resolved.push({ ...trial, trial_id: match.trial_id })
      completed.add(match.trial_id)
    } else if (hashed.length > 0) {
      // This slot has a recorded content fingerprint and it does NOT match —
      // the candidate set has genuinely changed under an unchanged trial_id.
      // Offer it again under a suffix distinct from every variant on file.
      const distinct = new Set(hashed.map(recordPairHash))
      resolved.push({ ...trial, trial_id: `${fam}::r${distinct.size + 1}` })
    } else if (legacy.some((r) => r.seed === trial.seed)) {
      // Pre-fix verdict whose seed proves it was built from a document with
      // the SAME overall identity (schema/selection/rank_by/sample set) as
      // what's currently open — the closest thing to "this is plausibly the
      // file it was rated against" available without an arm-content hash to
      // check. Upgrade it: append a new line carrying this content's hash, so
      // a FUTURE regeneration can be detected even though this one predates
      // hashing.
      resolved.push({ ...trial, trial_id: fam })
      completed.add(fam)
      const matching = legacy.filter((r) => r.seed === trial.seed)
      const last = matching[matching.length - 1]
      toBackfill.push({
        ...last,
        trial_id: fam,
        arm_hashes: trial.arm_hashes.slice(),
        migrated_from_legacy: true,
      })
    } else {
      // Either brand new (no records at all), or every legacy record here has
      // a seed from a DIFFERENT document identity — unverifiable against what
      // is currently open, so it is left untouched rather than guessed at.
      resolved.push({ ...trial, trial_id: fam })
    }
  }

  let archived = 0
  for (const r of records || []) {
    if (!r || typeof r.trial_id !== 'string') continue
    const fam = trialFamilyId(r.trial_id)
    if (!familiesInDoc.has(fam)) { archived++; continue } // sample/pairing no longer exists
    const trial = trials.find((t) => t.trial_id === fam)
    if (!isHashed(r)) {
      // Legacy: no content hash to compare, but its seed still says whether it
      // came from a document with the same overall identity as what's open
      // now. A seed mismatch here is exactly "different candidate set" — it
      // just predates hashing, so it never got the chance to be caught by
      // content comparison instead.
      if (r.seed !== trial.seed) archived++
      continue
    }
    const pairHash = armPairHash(trial.arm_hashes[0], trial.arm_hashes[1])
    if (recordPairHash(r) !== pairHash) archived++
  }

  return { trials: resolved, completed, archived, toBackfill }
}

// Build the record appended to ratings.jsonl. This is where the blinding is
// lifted: `arm_order` names which arm was A and which was B, and `seed`
// reproduces that assignment from candidates.json alone. `winner_arm_id` /
// `loser_arm_id` are derivable from the two, and written anyway so the file can
// be analysed without re-implementing the blinding.
export function makeRatingRecord(trial, { winner, failureTags = [], timestamp } = {}) {
  if (!VERDICTS.includes(winner)) throw new Error(`unknown verdict ${JSON.stringify(winner)}`)
  const tags = FAILURE_TAGS.filter((t) => (failureTags || []).includes(t))
  const winIdx = winner === 'A' ? 0 : winner === 'B' ? 1 : -1
  return {
    trial_id: trial.trial_id,
    sample_id: trial.sample_id,
    kind: trial.kind,
    seed: trial.seed,
    arm_order: trial.arm_order.slice(),
    // What content this verdict actually judged, in arm_order's order — the
    // field `reconcileTrialsWithRatings` checks before ever trusting trial_id
    // alone.
    arm_hashes: trial.arm_hashes.slice(),
    winner,
    winner_arm_id: winIdx < 0 ? null : trial.arm_order[winIdx],
    // Tags describe the WORSE arm, so a tie has no arm to hang them on.
    loser_arm_id: winIdx < 0 ? null : trial.arm_order[1 - winIdx],
    failure_tags: tags,
    timestamp: timestamp || new Date().toISOString(),
  }
}

// One JSONL line, newline included. Never pretty-printed: one record per line is
// what makes the file append-only and recoverable.
export function serializeRatingLine(record) {
  return `${JSON.stringify(record)}\n`
}
