// Clones (docs/XLETH_CLONE_SPEC.md): the pure model every UI surface shares.
//
// A Clone is an extra, video-only cell driven by a Pattern Track (its source):
//   Voice clone  plays the notes the source cannot (polyphony). Voice 0 is the
//                source; Voice 1, 2, ... are its Voice clones in track order.
//   Trail clone  replays the source's whole cell result delayTicks later.
//
// The engine is the authority (engine/src/model/Clone.h). assignVoices below is
// a line-for-line port of clones::assignVoices so the Reel lanes, the piano roll
// and Motion view's reference strips show exactly the notes each cell plays
// without a round trip; bridge/test_clones_contract.js checks the two agree.
//
// Track shape (timeline.getTracks / trackToJs): { id, name, type, order, cloneOf
// (-1 = an ordinary track), clone?: { cloneOf, kind: 'Voice'|'Trail', voice,
// lensMode: 'Linked'|'Own', delayTicks, tint: '#RRGGBB', opacity, opacityKeys } }.
// Note shape (patterns): { id, positionTicks, durationTicks, pitch, isSlide,
// voicePin? (absent / -1 = Auto, 0 = source, k = Voice clone k) }.

export const VOICE_PIN_AUTO = -1
export const PPQ = 960

// ── Tracks ────────────────────────────────────────────────────────────────────

export function isClone(track) {
  return !!track && Number.isInteger(track.cloneOf) && track.cloneOf >= 0
}

export function cloneKindOf(track) {
  if (!isClone(track)) return null
  return track.clone?.kind === 'Trail' ? 'Trail' : 'Voice'
}

export const isVoiceClone = (track) => cloneKindOf(track) === 'Voice'
export const isTrailClone = (track) => cloneKindOf(track) === 'Trail'

function byOrder(a, b) {
  const oa = Number.isFinite(a.order) ? a.order : 0
  const ob = Number.isFinite(b.order) ? b.order : 0
  return oa !== ob ? oa - ob : a.id - b.id
}

/** A source's Clones in track order (order, then id) — the engine's order. */
export function clonesOf(tracks, sourceId, kind = null) {
  if (!Array.isArray(tracks)) return []
  return tracks
    .filter((t) => isClone(t) && t.cloneOf === sourceId && t.id !== sourceId
      && (kind == null || cloneKindOf(t) === kind))
    .sort(byOrder)
}

export const voiceClonesOf = (tracks, sourceId) => clonesOf(tracks, sourceId, 'Voice')
export const trailClonesOf = (tracks, sourceId) => clonesOf(tracks, sourceId, 'Trail')

/** The live source of a Clone (null when it is not one or the source is gone). */
export function sourceOf(tracks, clone) {
  if (!isClone(clone) || !Array.isArray(tracks)) return null
  const s = tracks.find((t) => t.id === clone.cloneOf)
  return s && !isClone(s) ? s : null
}

/** The voice a track plays: 0 for a source, k for its k-th Voice clone, null otherwise. */
export function voiceNumberOf(tracks, track) {
  if (!track) return null
  if (!isClone(track)) return 0
  if (!isVoiceClone(track)) return null
  const v = voiceClonesOf(tracks, track.cloneOf).findIndex((t) => t.id === track.id)
  return v < 0 ? null : v + 1
}

/** True when a Pattern track can get Clones (not a Clone itself). */
export function canHaveClones(track) {
  return !!track && track.type === 'Pattern' && !isClone(track)
}

// ── Voice assignment (port of engine clones::assignVoices) ───────────────────

/**
 * For each note (index-aligned): { voice: 0..voiceCloneCount, overflow }.
 *   - Decided from the pattern alone; no chord window.
 *   - Pinned notes (0 <= pin <= voiceCloneCount) are placed first.
 *   - Auto notes in start order; same tick: highest pitch first, then id, then
 *     index. Each takes the LOWEST voice free for its whole span [start, end).
 *   - No free voice: overflow (voice 0, overflow true); it occupies nothing.
 *   - Slide notes and notes with no length: voice 0, never overflow, occupy nothing.
 */
export function assignVoices(notes, voiceCloneCount) {
  const list = Array.isArray(notes) ? notes : []
  const out = list.map(() => ({ voice: 0, overflow: false }))
  const count = Math.max(0, Math.trunc(voiceCloneCount || 0))
  if (count === 0 || list.length === 0) return out
  const voices = count + 1
  const busy = Array.from({ length: voices }, () => [])
  const isFree = (v, s, e) => busy[v].every(([bs, be]) => !(s < be && bs < e))
  const span = (n) => {
    const s = Math.trunc(Number(n.positionTicks) || 0)
    return [s, s + Math.trunc(Number(n.durationTicks) || 0)]
  }
  const live = (n) => {
    const [s, e] = span(n)
    return !n.isSlide && e > s
  }
  const pinOf = (n) => (Number.isInteger(n.voicePin) ? n.voicePin : VOICE_PIN_AUTO)

  const autoIdx = []
  list.forEach((n, i) => {
    if (!live(n)) return
    const pin = pinOf(n)
    if (pin >= 0 && pin <= count) {
      out[i].voice = pin
      busy[pin].push(span(n))
    } else {
      autoIdx.push(i)
    }
  })
  autoIdx.sort((a, b) => {
    const x = list[a]
    const y = list[b]
    const [xs] = span(x)
    const [ys] = span(y)
    if (xs !== ys) return xs - ys
    if (x.pitch !== y.pitch) return (y.pitch ?? 60) - (x.pitch ?? 60)
    if ((x.id ?? 0) !== (y.id ?? 0)) return (x.id ?? 0) - (y.id ?? 0)
    return a - b
  })
  for (const i of autoIdx) {
    const [s, e] = span(list[i])
    let chosen = -1
    for (let v = 0; v < voices; v++) {
      if (isFree(v, s, e)) { chosen = v; break }
    }
    if (chosen < 0) { out[i] = { voice: 0, overflow: true }; continue }
    out[i].voice = chosen
    busy[chosen].push([s, e])
  }
  return out
}

/** noteId -> { voice, overflow } for one pattern and a voice clone count. */
export function voiceMapFor(pattern, voiceCloneCount) {
  const map = new Map()
  const notes = pattern?.notes ?? []
  const slots = assignVoices(notes, voiceCloneCount)
  notes.forEach((n, i) => map.set(n.id, slots[i]))
  return map
}

/**
 * Which notes of `pattern` a track shows, as a predicate on a note:
 *   source (voice 0)  voice-0 notes and the overflow ones (it plays those);
 *   Voice clone k     the notes assigned to voice k;
 *   Trail clone       what Voice 0 shows (the Trail replays the source cell).
 * Returns null for a track that is none of these (show everything).
 */
export function noteFilterFor(tracks, track, pattern) {
  if (!track || !pattern) return null
  const sourceId = isClone(track) ? track.cloneOf : track.id
  const count = voiceClonesOf(tracks, sourceId).length
  if (count === 0 && !isClone(track)) return null
  const map = voiceMapFor(pattern, count)
  const voice = isTrailClone(track) ? 0 : voiceNumberOf(tracks, track)
  if (voice == null) return () => false
  return (note) => {
    const slot = map.get(note.id)
    return !!slot && slot.voice === voice
  }
}

// ── Trails ───────────────────────────────────────────────────────────────────

export const TRAIL_DELAY_PRESETS = [
  { label: '1/32', ticks: 120 },
  { label: '1/16', ticks: 240 },
  { label: '1/8', ticks: 480 },
  { label: '3/16', ticks: 720 },
  { label: '1/4', ticks: 960 },
  { label: '3/8', ticks: 1440 },
  { label: '1/2', ticks: 1920 },
  { label: '1 bar', ticks: 3840 },
]

/** A delay as a musical value when it is one, else "N ticks". */
export function formatDelay(ticks) {
  const t = Math.round(Number(ticks) || 0)
  const preset = TRAIL_DELAY_PRESETS.find((p) => p.ticks === t)
  if (preset) return preset.label
  return `${t} ticks`
}

/** '#RRGGBB' -> [r, g, b] 0..255, or null. */
export function parseTint(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex ?? ''))
  if (!m) return null
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
}

/** A Trail's opacity at a timeline tick: its keys (absolute, linear/hold/ease) or its base. */
export function trailOpacityAt(clone, tick) {
  const base = Math.min(1, Math.max(0, Number(clone?.opacity ?? 1)))
  const keys = Array.isArray(clone?.opacityKeys) ? clone.opacityKeys : []
  if (keys.length === 0) return base
  if (!(tick >= keys[0].pos)) return keys[0].value
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]
    const b = keys[i]
    if (tick < b.pos) {
      const u = (tick - a.pos) / (b.pos - a.pos)
      if (a.interp === 'Hold') return a.value
      if (a.interp === 'EaseOut') return a.value + (b.value - a.value) * (1 - (1 - u) * (1 - u))
      return a.value + (b.value - a.value) * u
    }
  }
  return keys[keys.length - 1].value
}

// ── Names ────────────────────────────────────────────────────────────────────

export function cloneKindLabel(track) {
  const k = cloneKindOf(track)
  return k === 'Trail' ? 'Trail clone' : k === 'Voice' ? 'Voice clone' : null
}

/** The voice-pin choices for a source: Auto, the source, then each Voice clone. */
export function voicePinOptions(tracks, sourceId) {
  const source = (tracks ?? []).find((t) => t.id === sourceId)
  const opts = [{ pin: VOICE_PIN_AUTO, label: 'Auto' }, { pin: 0, label: source ? `Source (${source.name})` : 'Source' }]
  voiceClonesOf(tracks, sourceId).forEach((c, i) => opts.push({ pin: i + 1, label: c.name || `Clone ${i + 1}` }))
  return opts
}
