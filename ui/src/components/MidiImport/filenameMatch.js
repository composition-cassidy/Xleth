// GM percussion names, index 0 = MIDI note 35, index 46 = MIDI note 81.
// Must stay in sync with engine/src/audio/GMDrumMap.h.
const GM_DRUM_NAMES = [
  'Acoustic Bass Drum', // 35
  'Bass Drum 1',        // 36
  'Side Stick',         // 37
  'Acoustic Snare',     // 38
  'Hand Clap',          // 39
  'Electric Snare',     // 40
  'Low Floor Tom',      // 41
  'Closed Hi-Hat',      // 42
  'High Floor Tom',     // 43
  'Pedal Hi-Hat',       // 44
  'Low Tom',            // 45
  'Open Hi-Hat',        // 46
  'Low-Mid Tom',        // 47
  'Hi-Mid Tom',         // 48
  'Crash Cymbal 1',     // 49
  'High Tom',           // 50
  'Ride Cymbal 1',      // 51
  'Chinese Cymbal',     // 52
  'Ride Bell',          // 53
  'Tambourine',         // 54
  'Splash Cymbal',      // 55
  'Cowbell',            // 56
  'Crash Cymbal 2',     // 57
  'Vibraslap',          // 58
  'Ride Cymbal 2',      // 59
  'Hi Bongo',           // 60
  'Low Bongo',          // 61
  'Mute Hi Conga',      // 62
  'Open Hi Conga',      // 63
  'Low Conga',          // 64
  'High Timbale',       // 65
  'Low Timbale',        // 66
  'High Agogo',         // 67
  'Low Agogo',          // 68
  'Cabasa',             // 69
  'Maracas',            // 70
  'Short Whistle',      // 71
  'Long Whistle',       // 72
  'Short Guiro',        // 73
  'Long Guiro',         // 74
  'Claves',             // 75
  'Hi Wood Block',      // 76
  'Low Wood Block',     // 77
  'Mute Cuica',         // 78
  'Open Cuica',         // 79
  'Mute Triangle',      // 80
  'Open Triangle',      // 81
]

export function gmDrumName(noteNumber) {
  return (noteNumber >= 35 && noteNumber <= 81)
    ? GM_DRUM_NAMES[noteNumber - 35]
    : null
}

// ── Name normalization ───────────────────────────────────────────────────────
// Lowercase, collapse any run of non-alphanumeric characters (hyphens,
// underscores, punctuation, multiple spaces) into a single space, and trim.
// "Acoustic Snare" / "acoustic-snare" / "Acoustic  Snare!" all normalize to
// the same "acoustic snare" key.
export function normalizeName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// ── GM alias table ────────────────────────────────────────────────────────────
// Maps the normalized form of GM drum names that are stylistic variants of the
// same instrument onto one canonical token, so e.g. a track named "Acoustic
// Snare" can match a user sample region named "Snare 1". Keys are normalized
// GM_DRUM_NAMES entries; only names with a meaningfully different short form
// need an entry — names that are already a single distinctive word (Cowbell,
// Tambourine, Claves, ...) match fine on their own via the scorer below.
const GM_ALIAS_MAP = {
  'acoustic bass drum': 'kick',
  'bass drum 1': 'kick',
  'side stick': 'sidestick',
  'acoustic snare': 'snare',
  'electric snare': 'snare',
  'hand clap': 'clap',
  'low floor tom': 'tom',
  'high floor tom': 'tom',
  'low tom': 'tom',
  'low mid tom': 'tom',
  'hi mid tom': 'tom',
  'high tom': 'tom',
  'closed hi hat': 'hihat',
  'open hi hat': 'hihat',
  'pedal hi hat': 'hihat',
  'crash cymbal 1': 'crash',
  'crash cymbal 2': 'crash',
  'ride cymbal 1': 'ride',
  'ride cymbal 2': 'ride',
  'ride bell': 'ride',
  'hi bongo': 'bongo',
  'low bongo': 'bongo',
  'mute hi conga': 'conga',
  'open hi conga': 'conga',
  'low conga': 'conga',
  'high timbale': 'timbale',
  'low timbale': 'timbale',
  'high agogo': 'agogo',
  'low agogo': 'agogo',
  'short whistle': 'whistle',
  'long whistle': 'whistle',
  'short guiro': 'guiro',
  'long guiro': 'guiro',
  'hi wood block': 'woodblock',
  'low wood block': 'woodblock',
  'mute cuica': 'cuica',
  'open cuica': 'cuica',
  'mute triangle': 'triangle',
  'open triangle': 'triangle',
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// Tiers, highest confidence first. Each tier below "exact" carries a minimum
// length/ratio guard so a short, low-signal query (e.g. "1") can't cheaply
// score against everything — a wrong auto-assignment is worse than none.
const SCORE_EXACT = 100
const SCORE_PREFIX = 80
const SCORE_WORD_BOUNDARY = 65
const SCORE_SUBSTRING = 50

const MIN_PREFIX_LEN = 3
const MIN_WORD_LEN = 3
const MIN_SUBSTRING_LEN = 3
const MIN_SUBSTRING_RATIO = 0.5

// Minimum score for a match to be trusted as an auto-assignment.
export const MIN_MATCH_SCORE = SCORE_SUBSTRING

// Scores one already-normalized query string against one already-normalized
// candidate string. Returns 0 when nothing qualifies.
function scoreNormalized(query, candidate) {
  if (!query || !candidate) return 0
  if (query === candidate) return SCORE_EXACT

  if (candidate.startsWith(query) || query.startsWith(candidate)) {
    if (Math.min(query.length, candidate.length) >= MIN_PREFIX_LEN) return SCORE_PREFIX
  }

  const queryWords = query.split(' ')
  const candidateWords = candidate.split(' ')
  const sharesWord = queryWords.some(w => w.length >= MIN_WORD_LEN && candidateWords.includes(w))
    || candidateWords.some(w => w.length >= MIN_WORD_LEN && queryWords.includes(w))
  if (sharesWord) return SCORE_WORD_BOUNDARY

  if (candidate.includes(query) || query.includes(candidate)) {
    const shorter = Math.min(query.length, candidate.length)
    const longer = Math.max(query.length, candidate.length)
    if (shorter >= MIN_SUBSTRING_LEN && shorter / longer >= MIN_SUBSTRING_RATIO) {
      return SCORE_SUBSTRING
    }
  }

  return 0
}

// Scores a raw (un-normalized) name against a raw candidate name, resolving
// the GM alias of `name` if it has one and taking the best of the two.
// Exported for reuse by the future re-import-into-existing-tracks matcher.
export function scoreName(name, candidateName) {
  const query = normalizeName(name)
  const candidate = normalizeName(candidateName)
  if (!query || !candidate) return 0
  let score = scoreNormalized(query, candidate)
  const alias = GM_ALIAS_MAP[query]
  if (alias) score = Math.max(score, scoreNormalized(alias, candidate))
  return score
}

// Deterministic tie-break for equal-score candidates: shortest name wins,
// then lowest id.
function preferCandidate(a, b) {
  const aName = a.name || ''
  const bName = b.name || ''
  if (aName.length !== bName.length) return aName.length < bName.length ? a : b
  return Number(a.id) <= Number(b.id) ? a : b
}

// Returns the best-scoring existing Pattern track for `name`, or null if no
// candidate reaches MIN_MATCH_SCORE. Same scorer as findMatchingSample — the
// re-import matcher deliberately does not introduce a second set of rules — but
// a different tie-break: for tracks the stable, user-visible ordering is the
// track id, so equal scores resolve to the LOWEST trackId rather than to the
// shortest name.
//
// `tracks` are midi.getReimportTargets() rows; ineligible rows (a Pattern track
// carrying more than one distinct pattern) are never suggested, because the
// engine would hard-fail them.
export function findMatchingTrack(name, tracks, { minScore = MIN_MATCH_SCORE } = {}) {
  if (!name) return null
  let best = null
  let bestScore = 0
  for (const track of tracks || []) {
    if (!track || !track.name) continue
    if (track.eligible === false) continue
    const score = scoreName(name, track.name)
    if (score < minScore) continue
    if (score > bestScore) {
      best = track
      bestScore = score
    } else if (score === bestScore && best && Number(track.trackId) < Number(best.trackId)) {
      best = track
    }
  }
  return best
}

// Returns the best-scoring Sample Selector region for `name`, or null if no
// candidate reaches MIN_MATCH_SCORE. Conservative by design: a low-confidence
// guess is worse than leaving the track unassigned.
export function findMatchingSample(name, regions, { minScore = MIN_MATCH_SCORE } = {}) {
  if (!name) return null
  let best = null
  let bestScore = 0
  for (const region of regions || []) {
    if (!region || !region.name) continue
    const score = scoreName(name, region.name)
    if (score < minScore) continue
    if (score > bestScore) {
      best = region
      bestScore = score
    } else if (score === bestScore && best) {
      best = preferCandidate(best, region)
    }
  }
  return best
}
