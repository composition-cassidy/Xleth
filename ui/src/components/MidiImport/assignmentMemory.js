// Persistent per-track-name sample-assignment memory for MIDI import.
// Learns from every successful import (including manual overrides) so that
// re-importing the same file, or a file using similar track names, pre-fills
// the sample assignments a user already made instead of starting from scratch.
import { findMatchingSample, normalizeName } from './filenameMatch.js'

export const ASSIGNMENT_MEMORY_STORAGE_KEY = 'xleth.midiImport.assignmentMemory'

// Reads the persisted memory map. Returns {} for "nothing stored" as well as
// for a corrupt/malformed stored value — a bad localStorage entry must never
// break the import dialog. Entries that don't look like { regionId, regionName }
// are dropped individually rather than discarding the whole map.
export function readAssignmentMemory() {
  let stored
  try {
    stored = localStorage.getItem(ASSIGNMENT_MEMORY_STORAGE_KEY)
  } catch {
    return {}
  }
  if (stored == null) return {}

  let parsed
  try {
    parsed = JSON.parse(stored)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const out = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue
    if (value.regionId == null || typeof value.regionName !== 'string') continue
    out[key] = { regionId: value.regionId, regionName: value.regionName }
  }
  return out
}

function writeAssignmentMemory(memory) {
  try {
    localStorage.setItem(ASSIGNMENT_MEMORY_STORAGE_KEY, JSON.stringify(memory))
  } catch {
    // Storage unavailable/full — memory is a nice-to-have, never fatal.
  }
}

// Merges a completed import's final track→sample assignments into the
// persisted memory, keyed by normalized track name. entries: array of
// { trackName, regionId, regionName }. Entries with no regionId are skipped
// (an unassigned track teaches nothing).
export function rememberAssignments(entries) {
  const memory = readAssignmentMemory()
  let changed = false
  for (const entry of entries || []) {
    const key = normalizeName(entry?.trackName)
    if (!key || entry?.regionId == null) continue
    memory[key] = { regionId: entry.regionId, regionName: entry.regionName ?? '' }
    changed = true
  }
  if (changed) writeAssignmentMemory(memory)
}

// Looks up a remembered assignment for trackName among the current regions.
// Precedence: (1) the remembered regionId, if that region still exists;
// (2) an exact regionName match, if the id went stale (region was deleted
// and re-created); (3) null, dropping the stale entry rather than guessing.
export function recallAssignment(trackName, regions) {
  const memory = readAssignmentMemory()
  const entry = memory[normalizeName(trackName)]
  if (!entry) return null

  const byId = (regions || []).find(r => String(r.id) === String(entry.regionId))
  if (byId) return byId

  return (regions || []).find(r => r.name === entry.regionName) || null
}

// The seeding precedence for a new output track, once carry-forward-by-
// _stableKey has already been ruled out by the caller: remembered assignment
// first, then the scored fuzzy matcher, then no match. `source` is included
// for the dialog's diagnostic logging.
export function resolveAutoAssignment(trackName, regions) {
  const remembered = recallAssignment(trackName, regions)
  if (remembered) return { region: remembered, source: 'memory' }

  const fuzzy = findMatchingSample(trackName, regions)
  if (fuzzy) return { region: fuzzy, source: 'fuzzy' }

  return { region: null, source: null }
}
