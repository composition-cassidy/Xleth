// ── Slot clipboard ──────────────────────────────────────────────────────────
// Copy one slot's SETTINGS onto another. Deliberately not a zustand store: the
// clipboard is scratch state with exactly one consumer (the slot tab strip's
// context menu), it must survive a panel close/reopen, and nothing needs to
// re-render when it changes — the menu reads it at open time.
//
// AUDIO IDENTITY IS NEVER COPIED. `audioFilePath` and `name` stay with the
// target slot: pasting is "make this layer behave like that one", not "make
// this layer be that one". Copying the path would silently repoint a layer at
// another file with no loader having run, which is not something a paste should
// ever do.

// Everything a paste carries, grouped by whether it is sample-length-relative.
//
// SCALE_FREE fields mean the same thing whatever the target sample is: a
// semitone is a semitone, a 20 ms fade is 20 ms.
const SCALE_FREE_FIELDS = [
  'rootNote', 'octave', 'semitone', 'fine', 'coarse',
  'volume', 'pan',
  'declickMs', 'fadeInMs', 'fadeOutMs',
  'loopEnabled', 'loopMode', 'exitLoopOnRelease',
  'prepAlgorithm', 'prepStretch', 'prepShiftCents',
  'dcOffsetRemoved', 'normalized', 'polarityReversed', 'reversed',
]

// SAMPLE_INDEX fields are absolute positions in the SOURCE buffer, so they only
// mean anything against the length of the sample they were measured on. Pasted
// onto a shorter layer they would point past the end, which the engine clamps
// but the UI would then draw as a trim/loop collapsed onto the last sample. We
// clamp them here instead, against the target's real length, so what lands is
// what the editor draws.
const SAMPLE_INDEX_FIELDS = ['smpStart', 'smpLength', 'loopStart', 'loopEnd', 'crossfadeSamples']

// MUTE/SOLO are performance state, not settings — pasting them would silence a
// layer as a side effect of copying a tuning. They stay out on purpose.

let clipboard = null

export function copySlotSettings(slot, sourceNumSamples) {
  if (!slot) return false
  const payload = { sourceNumSamples: Number(sourceNumSamples) || 0 }
  for (const f of SCALE_FREE_FIELDS) if (slot[f] !== undefined) payload[f] = slot[f]
  for (const f of SAMPLE_INDEX_FIELDS) if (slot[f] !== undefined) payload[f] = slot[f]
  // The MANGLE chain is an array of objects — deep-copy it so a later edit to
  // the source slot cannot reach into what is on the clipboard.
  payload.mangleChain = Array.isArray(slot.mangleChain)
    ? slot.mangleChain.map((mi) => ({
        mode: mi.mode ?? 0, amount: mi.amount ?? 0, mix: mi.mix ?? 1, bypass: !!mi.bypass,
      }))
    : []
  clipboard = payload
  return true
}

export function hasSlotClipboard() {
  return clipboard != null
}

export function peekSlotClipboard() {
  return clipboard
}

// Build the patch to apply to a target slot. `targetNumSamples` is the target
// layer's own length (0 = unknown, in which case sample-index fields are passed
// through untouched and the engine's own clamp is the only guard).
export function buildSlotPaste(targetNumSamples) {
  if (!clipboard) return null
  const out = {}
  for (const f of SCALE_FREE_FIELDS) if (clipboard[f] !== undefined) out[f] = clipboard[f]
  out.mangleChain = Array.isArray(clipboard.mangleChain)
    ? clipboard.mangleChain.map((mi) => ({ ...mi }))
    : []

  const total = Number(targetNumSamples) || 0
  if (total <= 0) {
    for (const f of SAMPLE_INDEX_FIELDS) if (clipboard[f] !== undefined) out[f] = clipboard[f]
    return out
  }

  // 0 is the sentinel for "to the end" on smpLength and loopEnd, so it must
  // survive the clamp rather than being pulled up to a real index.
  const clampIndex = (v) => Math.max(0, Math.min(total, Math.round(Number(v) || 0)))
  out.smpStart = Math.max(0, Math.min(Math.max(0, total - 1), Math.round(Number(clipboard.smpStart) || 0)))
  out.smpLength = (clipboard.smpLength === 0 || clipboard.smpLength == null)
    ? 0
    : (clampIndex(clipboard.smpLength) >= total ? 0 : clampIndex(clipboard.smpLength))
  out.loopStart = Math.max(0, Math.min(Math.max(0, total - 1), Math.round(Number(clipboard.loopStart) || 0)))
  out.loopEnd = (clipboard.loopEnd === 0 || clipboard.loopEnd == null)
    ? 0
    : (clampIndex(clipboard.loopEnd) >= total ? 0 : clampIndex(clipboard.loopEnd))
  // A crossfade wider than the loop it sits in is meaningless; cap it at the
  // resolved loop length as well as the buffer.
  const resolvedEnd = out.loopEnd === 0 ? total : out.loopEnd
  const loopLen = Math.max(0, resolvedEnd - out.loopStart)
  out.crossfadeSamples = Math.max(0, Math.min(
    Math.min(total, loopLen),
    Math.round(Number(clipboard.crossfadeSamples) || 0),
  ))
  return out
}

// Test seam — the module-level clipboard would otherwise leak between cases.
export function __resetSlotClipboard() {
  clipboard = null
}
