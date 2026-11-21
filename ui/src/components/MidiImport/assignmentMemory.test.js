import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ASSIGNMENT_MEMORY_STORAGE_KEY,
  readAssignmentMemory,
  recallAssignment,
  rememberAssignments,
  resolveAutoAssignment,
} from './assignmentMemory.js'

// vitest runs this suite under Node (see vitest.config.ts: environment: 'node'),
// which has no global localStorage. Stand in a minimal synchronous in-memory
// implementation — same surface (getItem/setItem/removeItem) the module uses.
class FakeLocalStorage {
  constructor() { this.store = new Map() }
  getItem(key) { return this.store.has(key) ? this.store.get(key) : null }
  setItem(key, value) { this.store.set(key, String(value)) }
  removeItem(key) { this.store.delete(key) }
  clear() { this.store.clear() }
}

let originalLocalStorage

beforeEach(() => {
  originalLocalStorage = globalThis.localStorage
  globalThis.localStorage = new FakeLocalStorage()
})

afterEach(() => {
  globalThis.localStorage = originalLocalStorage
})

describe('readAssignmentMemory', () => {
  it('returns {} when nothing is stored', () => {
    expect(readAssignmentMemory()).toEqual({})
  })

  it('returns {} for corrupt JSON without throwing', () => {
    localStorage.setItem(ASSIGNMENT_MEMORY_STORAGE_KEY, '{not valid json')
    expect(readAssignmentMemory()).toEqual({})
  })

  it('returns {} for a stored value that is not an object map', () => {
    localStorage.setItem(ASSIGNMENT_MEMORY_STORAGE_KEY, '[1,2,3]')
    expect(readAssignmentMemory()).toEqual({})
    localStorage.setItem(ASSIGNMENT_MEMORY_STORAGE_KEY, '"just a string"')
    expect(readAssignmentMemory()).toEqual({})
  })

  it('drops individually malformed entries but keeps valid ones', () => {
    localStorage.setItem(ASSIGNMENT_MEMORY_STORAGE_KEY, JSON.stringify({
      kick: { regionId: 5, regionName: 'Kick 1' },
      snare: { regionId: null, regionName: 'Snare' }, // missing regionId
      hihat: 'not an object',
      tom: { regionName: 'Tom 1' }, // missing regionId entirely
    }))
    expect(readAssignmentMemory()).toEqual({
      kick: { regionId: 5, regionName: 'Kick 1' },
    })
  })
})

describe('rememberAssignments', () => {
  it('writes entries keyed by normalized track name', () => {
    rememberAssignments([
      { trackName: 'Acoustic Snare', regionId: 7, regionName: 'Snare 1' },
    ])
    expect(readAssignmentMemory()).toEqual({
      'acoustic snare': { regionId: 7, regionName: 'Snare 1' },
    })
  })

  it('merges into existing memory instead of clobbering it', () => {
    rememberAssignments([{ trackName: 'Kick', regionId: 1, regionName: 'Kick 1' }])
    rememberAssignments([{ trackName: 'Snare', regionId: 2, regionName: 'Snare 1' }])
    expect(readAssignmentMemory()).toEqual({
      kick: { regionId: 1, regionName: 'Kick 1' },
      snare: { regionId: 2, regionName: 'Snare 1' },
    })
  })

  it('overwrites a prior assignment for the same normalized track name', () => {
    rememberAssignments([{ trackName: 'Kick', regionId: 1, regionName: 'Kick 1' }])
    rememberAssignments([{ trackName: 'kick', regionId: 9, regionName: 'Kick 2' }])
    expect(readAssignmentMemory()).toEqual({
      kick: { regionId: 9, regionName: 'Kick 2' },
    })
  })

  it('skips entries with no regionId', () => {
    rememberAssignments([{ trackName: 'Unassigned Track', regionId: null, regionName: '' }])
    expect(readAssignmentMemory()).toEqual({})
  })
})

describe('recallAssignment', () => {
  it('resolves via the remembered regionId when the region still exists', () => {
    rememberAssignments([{ trackName: 'Acoustic Snare', regionId: 7, regionName: 'Snare 1' }])
    const regions = [{ id: 7, name: 'Snare 1' }, { id: 8, name: 'Other' }]
    expect(recallAssignment('Acoustic Snare', regions)).toEqual({ id: 7, name: 'Snare 1' })
  })

  it('is case/punctuation-insensitive on the track name', () => {
    rememberAssignments([{ trackName: 'Acoustic Snare', regionId: 7, regionName: 'Snare 1' }])
    const regions = [{ id: 7, name: 'Snare 1' }]
    expect(recallAssignment('acoustic-snare', regions)).toEqual({ id: 7, name: 'Snare 1' })
  })

  it('falls back to an exact regionName match when the regionId is stale', () => {
    rememberAssignments([{ trackName: 'Kick', regionId: 999, regionName: 'Kick 1' }])
    // Region was deleted and re-imported under a new id, same name.
    const regions = [{ id: 42, name: 'Kick 1' }]
    expect(recallAssignment('Kick', regions)).toEqual({ id: 42, name: 'Kick 1' })
  })

  it('drops the entry (returns null) when neither id nor name resolve', () => {
    rememberAssignments([{ trackName: 'Kick', regionId: 999, regionName: 'Kick 1' }])
    const regions = [{ id: 42, name: 'Totally Different' }]
    expect(recallAssignment('Kick', regions)).toBe(null)
  })

  it('returns null when nothing is remembered for this track name', () => {
    expect(recallAssignment('Lead Synth', [{ id: 1, name: 'Lead Synth' }])).toBe(null)
  })
})

describe('resolveAutoAssignment precedence', () => {
  it('prefers a remembered assignment over a better-scoring fuzzy match', () => {
    // Memory says "Acoustic Snare" -> region 2 ("Old Snare"), even though
    // region 1 ("Acoustic Snare") would be an exact fuzzy match.
    rememberAssignments([{ trackName: 'Acoustic Snare', regionId: 2, regionName: 'Old Snare' }])
    const regions = [
      { id: 1, name: 'Acoustic Snare' },
      { id: 2, name: 'Old Snare' },
    ]
    const result = resolveAutoAssignment('Acoustic Snare', regions)
    expect(result.source).toBe('memory')
    expect(result.region).toEqual({ id: 2, name: 'Old Snare' })
  })

  it('falls back to the fuzzy matcher when nothing is remembered', () => {
    const regions = [{ id: 3, name: 'Snare 1' }]
    const result = resolveAutoAssignment('Acoustic Snare', regions)
    expect(result.source).toBe('fuzzy')
    expect(result.region).toEqual({ id: 3, name: 'Snare 1' })
  })

  it('returns a null region and source when nothing matches at all', () => {
    const regions = [{ id: 3, name: 'Lead Synth' }]
    const result = resolveAutoAssignment('Acoustic Snare', regions)
    expect(result).toEqual({ region: null, source: null })
  })
})
