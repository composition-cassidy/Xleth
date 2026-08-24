import { describe, it, expect } from 'vitest'
import { findCoveringEntry, insertEntry, touchEntry } from '../hiResRegionCache.js'

function entry(startSec, endSec, tag) {
  return { startSec, endSec, tag }
}

describe('findCoveringEntry', () => {
  it('returns null for an empty/missing array', () => {
    expect(findCoveringEntry([], 0, 1)).toBe(null)
    expect(findCoveringEntry(null, 0, 1)).toBe(null)
  })

  it('finds a covering entry among several', () => {
    const entries = [entry(0, 5, 'a'), entry(10, 20, 'b'), entry(30, 40, 'c')]
    expect(findCoveringEntry(entries, 12, 18)).toBe(entries[1])
  })

  it('returns null when no entry covers the window — the core collision fix', () => {
    // This is the exact scenario that used to be a single overwritten slot:
    // two DIFFERENT clip windows on the same region must each get their own
    // entry, and a lookup for one must never spuriously match the other.
    const entries = [entry(0, 5, 'clip-A-window')]
    expect(findCoveringEntry(entries, 10, 15)).toBe(null)
  })

  it('does not match a partially-overlapping entry', () => {
    const entries = [entry(10, 15, 'a')]
    expect(findCoveringEntry(entries, 12, 20)).toBe(null)
  })

  it('prefers the most recently inserted covering entry', () => {
    const entries = [entry(0, 100, 'wide-old'), entry(10, 20, 'narrow-new')]
    expect(findCoveringEntry(entries, 12, 18)).toBe(entries[1])
  })
})

describe('insertEntry', () => {
  it('appends without evicting under the cap', () => {
    const entries = insertEntry([entry(0, 1, 'a')], entry(2, 3, 'b'), 5)
    expect(entries.map((e) => e.tag)).toEqual(['a', 'b'])
  })

  it('evicts the oldest entry once over the cap (FIFO)', () => {
    let entries = []
    for (const tag of ['a', 'b', 'c']) entries = insertEntry(entries, entry(0, 1, tag), 2)
    expect(entries.map((e) => e.tag)).toEqual(['b', 'c'])
  })

  it('never exceeds maxEntries even after many inserts', () => {
    let entries = []
    for (let i = 0; i < 50; i++) entries = insertEntry(entries, entry(i, i + 1, i), 8)
    expect(entries.length).toBe(8)
    expect(entries[entries.length - 1].tag).toBe(49)
  })

  it('does not mutate the array it was given', () => {
    const original = [entry(0, 1, 'a')]
    const snapshot = [...original]
    insertEntry(original, entry(2, 3, 'b'), 5)
    expect(original).toEqual(snapshot)
  })

  it('treats a null/undefined starting array as empty', () => {
    expect(insertEntry(null, entry(0, 1, 'a'), 5).map((e) => e.tag)).toEqual(['a'])
    expect(insertEntry(undefined, entry(0, 1, 'a'), 5).map((e) => e.tag)).toEqual(['a'])
  })
})

describe('touchEntry', () => {
  it('moves an entry to the most-recently-used end', () => {
    const a = entry(0, 1, 'a'), b = entry(2, 3, 'b'), c = entry(4, 5, 'c')
    const entries = touchEntry([a, b, c], a)
    expect(entries.map((e) => e.tag)).toEqual(['b', 'c', 'a'])
  })

  it('leaves the array untouched if already at the end', () => {
    const a = entry(0, 1, 'a'), b = entry(2, 3, 'b')
    const entries = [a, b]
    expect(touchEntry(entries, b)).toEqual([a, b])
  })

  it('is a no-op for an entry not present', () => {
    const entries = [entry(0, 1, 'a')]
    expect(touchEntry(entries, entry(9, 9, 'ghost'))).toBe(entries)
  })

  it('does not mutate the array it was given', () => {
    const a = entry(0, 1, 'a'), b = entry(2, 3, 'b')
    const original = [a, b]
    const snapshot = [...original]
    touchEntry(original, a)
    expect(original).toEqual(snapshot)
  })

  it('keeps a touched entry alive through subsequent evictions', () => {
    // The whole point: an entry that keeps getting reused should outlive
    // ones fetched once and never needed again.
    let entries = [entry(0, 1, 'kept')]
    entries = insertEntry(entries, entry(1, 2, 'b'), 2)
    entries = touchEntry(entries, entries[0]) // touch "kept" — moves to MRU end
    entries = insertEntry(entries, entry(2, 3, 'c'), 2) // should evict "b", not "kept"
    expect(entries.map((e) => e.tag)).toEqual(['kept', 'c'])
  })
})
