// Motion view key copy / paste (docs/XLETH_MOTION_VIEW_DESIGN.md R23): every key keeps
// its time base; the target track; same property only; masks by index; the hint
// when nothing applies.
import { describe, expect, it } from 'vitest'
import { clipboardSummary, copyKeys, cutKeys, pasteKeysPlan } from './motionClipboard.js'
import { buildKeyIndex } from './motionGestureModel.js'
import { buildMotionRows } from './rowRegistry.js'
import { fixtureData, fixtureTracks } from './providers/__tests__/fixtures.js'

const K = (channel, pos, value, interp = 'Linear', anchor = 'Origin') => ({ channel, anchor, pos, value, interp })

function setup() {
  const data = fixtureData()
  const layout = buildMotionRows({ tracks: fixtureTracks(), data, expanded: new Set(), trackRowHeight: 28 })
  const index = buildKeyIndex(layout, data)
  const inst = (id) => index.byId.get(id).inst
  return { data, inst }
}

describe('copy', () => {
  it('one entry per edit target, sorted by tick, with the property and the key', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('r:1:offsetX:3840'), inst('h:1:100:zoom:Head:0@0'), inst('h:1:100:zoom:Head:0@1920'), inst('m:1:1:feather:0')])
    expect(clip.entries.map((e) => [e.kind, e.propId, e.tick])).toEqual([
      ['hit', 'sourceLens.zoom', 0],
      ['mask', 'mask.feather', 0],
      ['roam', 'roam.offsetX', 3840],
    ])
    expect(clip.entries[1].maskIndex).toBe(0)
    expect(clipboardSummary(clip)).toBe('3 keys')
    expect(copyKeys(data, [])).toBeNull()
  })
})

describe('paste', () => {
  it('timeline keys: the earliest lands at the playhead, spacing kept, on their own track', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('r:1:offsetX:0'), inst('r:1:offsetX:3840')])
    const { plan, count, note } = pasteKeysPlan(data, clip, { tick: 1000 })
    expect(count).toBe(2)
    expect(note).toBeNull()
    expect(plan).toEqual([{
      kind: 'roamKeys', trackId: 1,
      keys: [K('offsetX', 0, 0), K('offsetX', 1000, 0), K('offsetX', 3840, 1), K('offsetX', 4840, 1)],
    }])
  })

  it('exactly one selected track takes every key; a pasted key replaces one at its place', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('r:1:offsetX:0'), inst('r:1:offsetX:3840')])
    expect(pasteKeysPlan(data, clip, { tick: 0, targetTrackId: 3 }).plan).toEqual([
      { kind: 'roamKeys', trackId: 3, keys: [K('offsetX', 0, 0), K('offsetX', 3840, 1)] },
    ])
    // Pasting onto itself at 0: the two keys replace themselves (no duplicates).
    expect(pasteKeysPlan(data, clip, { tick: 0 }).plan[0].keys).toEqual([K('offsetX', 0, 0), K('offsetX', 3840, 1)])
  })

  it('clip event keys go into the clip under the playhead, event-relative', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('c:30:zoom:1920')])
    // Playhead 4000 on track 2: clip 31 (3840..7680), so pos 160.
    expect(pasteKeysPlan(data, clip, { tick: 4000 }).plan).toEqual([
      { kind: 'clipLensKeys', clipId: 31, keys: [K('zoom', 160, 2)] },
    ])
    const none = pasteKeysPlan(data, clip, { tick: 4000, targetTrackId: 4 })
    expect(none.plan).toEqual([])
    expect(none.note).toMatch(/no clip under the playhead/)
  })

  it('hit keys keep anchor and pos and go into the target source\'s hit curve', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('h:1:100:zoom:Head:120@0')])
    expect(pasteKeysPlan(data, clip, { tick: 0, targetTrackId: 3 }).plan).toEqual([
      { kind: 'hitCurve', trackId: 3, regionId: 100, curve: { keys: [K('zoom', 120, 1, 'Linear', 'Head')] } },
    ])
  })

  it("a note's own keys go into the note under the playhead (anchor and pos kept)", () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('n:10:2:zoom:Head:0@1920')])
    expect(pasteKeysPlan(data, clip, { tick: 300 }).plan).toEqual([
      { kind: 'notesLensKeys', entries: [{ patternId: 10, noteId: 1, keys: [K('zoom', 0, 1.2, 'Linear', 'Head')] }] },
    ])
    expect(pasteKeysPlan(data, clip, { tick: 1500 }).note).toMatch(/no note under the playhead/)
  })

  it('masks are matched by index; a track without that mask is skipped and named', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('m:1:1:feather:3840')])
    const own = pasteKeysPlan(data, clip, { tick: 960 })
    expect(own.plan).toHaveLength(1)
    expect(own.plan[0].masks[0].keys.map((k) => [k.pos, k.value])).toEqual([[0, 0], [960, 0.2], [3840, 0.2]])
    const other = pasteKeysPlan(data, clip, { tick: 960, targetTrackId: 4 })
    expect(other.plan).toEqual([])
    expect(other.note).toBe('Paste: nothing applies here (the track has no Mask 1)')
  })

  it('same property only: Sweep keys never land on a Clip track; a partial paste says what it skipped', () => {
    const { data, inst } = setup()
    const clip = copyKeys(data, [inst('s:1:zoom:960'), inst('r:1:offsetX:3840')])
    const res = pasteKeysPlan(data, clip, { tick: 0, targetTrackId: 4 })
    expect(res.plan.map((w) => w.kind)).toEqual(['roamKeys'])
    expect(res.note).toBe('Pasted 1 of 2 keys (Sweep keys go on Pattern tracks only)')
  })

  it('an empty clipboard pastes nothing and says why', () => {
    const { data } = setup()
    expect(pasteKeysPlan(data, null, { tick: 0 })).toEqual({ plan: [], count: 0, note: 'Nothing to paste: copy some keys first (Ctrl+C)' })
  })

  it('cut = copy + delete in one plan', () => {
    const { data, inst } = setup()
    const { clipboard, plan } = cutKeys(data, [inst('s:1:zoom:960')])
    expect(clipboard.entries).toHaveLength(1)
    expect(plan).toEqual([{ kind: 'sweepKeys', trackId: 1, keys: [] }])
  })
})
