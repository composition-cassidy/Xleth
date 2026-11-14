// @vitest-environment jsdom
//
// Landings in the Snapshots cue lane (docs/XLETH_LANDING_SPEC.md §8 and §9).
// The UI only authors: these tests cover what it owns.
//   • the Landings section of the cue editor: rows, Add landing, remove, the
//     controls' payloads, "Where it was" disabled for a track the outgoing
//     snapshot does not place;
//   • Reflow wiring, down to window.xleth.timeline.reflowCueLandings;
//   • the lead-in tails: a drag of a tail's left end previews without any IPC
//     and emits EXACTLY ONE setCueLandings on release, with the snapped lead-in.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import SnapshotCueLane, { useSnapshotCues } from './SnapshotCueLane.jsx'
import { beatsToTicks } from '../../constants/timeline.js'
import { LANDING_EASING_PRESETS, landingTailRowY } from './cueLandings.js'
import { paintLandingTails } from './LandingTails.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const BEAT = beatsToTicks(1)             // 960 ticks
const PIN_TICK = beatsToTicks(8)         // beat 8; at 40 px per beat the pin is at x 320
const LAND = LANDING_EASING_PRESETS.land.curve
const LANDING_KEYS = ['trackId', 'leadInTicks', 'from', 'edgeAngleDeg', 'custom', 'fromOpacity', 'easing']

const TRACKS = [
  { id: 1, name: 'Chords' }, { id: 2, name: 'Bass' }, { id: 3, name: 'Lead' },
  { id: 4, name: 'Perc 1' }, { id: 5, name: 'Perc 2' },
]
// The spec's reference scenario: chords and bass are in both snapshots, lead
// and percussion only in the incoming one.
const SNAPSHOTS = [
  { id: 'one', name: 'One', active: true, slotTrackIds: [1, 2], fullscreenTrackIds: [] },
  { id: 'two', name: 'Two', active: false, slotTrackIds: [1, 2, 3, 4, 5], fullscreenTrackIds: [] },
]
const landing = (trackId, fields = {}) => ({
  trackId, leadInTicks: BEAT, from: 'edge', edgeAngleDeg: 270,
  custom: { x: 0, y: 0, w: 0, h: 0 }, fromOpacity: 1, easing: { ...LAND }, ...fields,
})
const REFERENCE_LANDINGS = [
  landing(1, { from: 'whereItWas', fromOpacity: 0.7 }),
  landing(2, { from: 'whereItWas', fromOpacity: 0.7 }),
  landing(3, { leadInTicks: beatsToTicks(0.5) }),
]

describe('Landings in the cue lane', () => {
  let container
  let root
  let spies = []
  let drawn

  function fakeCtx() {
    const noop = () => {}
    return new Proxy({ measureText: () => ({ width: 0 }), canvas: {} }, {
      get(target, prop) {
        if (prop === 'fillRect') return (...args) => drawn.push(['fillRect', ...args])
        if (prop === 'fillText') return (...args) => drawn.push(['fillText', ...args])
        return prop in target ? target[prop] : noop
      },
      set(target, prop, val) { target[prop] = val; return true },
    })
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    drawn = []
    spies = [
      vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000),
      vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200),
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({
        left: 0, top: 0, right: 1000, bottom: 200, width: 1000, height: 200, x: 0, y: 0, toJSON() {},
      })),
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => fakeCtx()),
    ]
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    document.body.querySelectorAll('[data-xleth-menu]').forEach((el) => el.remove())
    for (const spy of spies) spy.mockRestore()
    delete window.xleth
  })

  function pointer(type, target, clientX = 0, clientY = 10, opts = {}) {
    const Ctor = window.PointerEvent || window.MouseEvent
    target.dispatchEvent(new Ctor(type, {
      bubbles: true, cancelable: true, button: 0, clientX, clientY, ...opts,
    }))
  }

  async function click(el) {
    await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  }

  async function typeValue(box, text) {
    await act(async () => { box.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })) })
    const input = box.querySelector('input')
    expect(input, 'the NumberBox opened its type-in field').toBeTruthy()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }))
    })
  }

  async function renderLane({ landings = REFERENCE_LANDINGS, cues, snapGranularity = '1/16', handlers = {} } = {}) {
    const props = {
      pixelsPerBeatRef: { current: 40 },
      scrollOffsetRef: { current: 0 },
      cues: cues ?? [{ tick: PIN_TICK, snapshotId: 'two', transition: { enabled: false }, ...(landings ? { landings } : {}) }],
      snapshots: SNAPSHOTS,
      defaultSnapshotId: 'one',
      totalBeats: 64,
      snapGranularity,
      tracks: TRACKS,
      onMoveCue: vi.fn().mockResolvedValue(true),
      onRemoveCue: vi.fn(),
      onRepointCue: vi.fn(),
      onSetCueTransition: vi.fn(),
      onSetCueLandings: vi.fn(),
      onReflowCueLandings: vi.fn(),
      ...handlers,
    }
    // Two renders: the first mounts and measures the lane, the second lays
    // the pins and tails out against that width.
    await act(async () => { root.render(<SnapshotCueLane {...props} />) })
    await act(async () => { root.render(<SnapshotCueLane {...props} />) })
    return props
  }

  async function selectCue() {
    const marker = container.querySelector('.vmt-cue-marker')
    expect(marker).toBeTruthy()
    await act(async () => {
      pointer('pointerdown', marker, 320)
      pointer('pointerup', window, 320)
    })
    expect(container.querySelector('.vmt-cue-editor')).toBeTruthy()
  }

  const rowFor = (trackId) => container.querySelector(`.vmt-landing-row[data-track-id="${trackId}"]`)
  const detailFor = (trackId) => container.querySelector(`.vmt-landing-body[data-track-id="${trackId}"]`)
  // Opening a row shows that landing's controls in the detail pane under the list.
  async function openRow(trackId) {
    await click(rowFor(trackId).querySelector('.vmt-landing-toggle'))
    expect(rowFor(trackId).querySelector('.vmt-landing-toggle').getAttribute('aria-expanded')).toBe('true')
    expect(detailFor(trackId)).toBeTruthy()
    return detailFor(trackId)
  }

  // ── The section ───────────────────────────────────────────────────────────

  it('lists one row per landing with its track name, start and lead-in', async () => {
    await renderLane()
    await selectCue()
    const section = container.querySelector('.vmt-landings')
    expect(section).toBeTruthy()
    expect(section.getAttribute('aria-label')).toBe('Landings')
    const rows = [...container.querySelectorAll('.vmt-landing-row')]
    expect(rows.map((row) => row.getAttribute('data-track-id'))).toEqual(['1', '2', '3'])
    expect(rows[0].textContent).toContain('Chords')
    expect(rows[0].textContent).toContain('Where it was')
    expect(rows[0].textContent).toContain('1 beat')
    expect(rows[2].textContent).toContain('Lead')
    expect(rows[2].textContent).toContain('Edge')
    expect(rows[2].textContent).toContain('0.5 beats')
    expect(section.textContent).toContain('3 / 16')
    // Rows are collapsed until asked: no controls are mounted for them.
    expect(container.querySelector('.vmt-landing-body')).toBeNull()
  })

  it('says so when a cue has no landings, and draws no tails canvas', async () => {
    await renderLane({ landings: null })
    await selectCue()
    expect(container.querySelector('.vmt-landings-empty')).toBeTruthy()
    expect(container.querySelectorAll('.vmt-landing-row')).toHaveLength(0)
    expect(container.querySelector('.vmt-landing-tails')).toBeNull()
  })

  it('Add landing lists the tracks with a slot in the cue snapshot and no landing yet', async () => {
    const props = await renderLane()
    await selectCue()
    const add = container.querySelector('.vmt-landings-add')
    expect(add.disabled).toBe(false)
    await click(add)
    const items = [...document.body.querySelectorAll('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Perc 1', 'Perc 2'])

    await click(items[0])
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    const [tick, list] = props.onSetCueLandings.mock.calls[0]
    expect(tick).toBe(PIN_TICK)
    expect(list).toHaveLength(4)
    expect(list.slice(0, 3)).toEqual(REFERENCE_LANDINGS)      // the others are untouched
    // Perc 1 is not in the outgoing snapshot, so it comes in from the edge.
    expect(list[3]).toEqual(landing(4))
    for (const entry of list) expect(Object.keys(entry).sort()).toEqual([...LANDING_KEYS].sort())
  })

  it('a track the outgoing snapshot already shows is added as Where it was', async () => {
    const props = await renderLane({ landings: [landing(3)] })
    await selectCue()
    await click(container.querySelector('.vmt-landings-add'))
    const items = [...document.body.querySelectorAll('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Chords', 'Bass', 'Perc 1', 'Perc 2'])
    await click(items[0])
    expect(props.onSetCueLandings.mock.calls[0][1][1]).toEqual(landing(1, { from: 'whereItWas' }))
  })

  it('Add landing is disabled when every slot track has one, and on a full cue', async () => {
    await renderLane({ landings: [1, 2, 3, 4, 5].map((id) => landing(id)) })
    await selectCue()
    expect(container.querySelector('.vmt-landings-add').disabled).toBe(true)
  })

  it('removes a landing with one write', async () => {
    const props = await renderLane()
    await selectCue()
    await click(rowFor(2).querySelector('.vmt-landing-remove'))
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    expect(props.onSetCueLandings).toHaveBeenCalledWith(PIN_TICK, [REFERENCE_LANDINGS[0], REFERENCE_LANDINGS[2]])
  })

  it('"Where it was" is disabled for a track that is not in the outgoing snapshot', async () => {
    await renderLane()
    await selectCue()
    // Lead (3) is only in the incoming snapshot; chords (1) are in both.
    const leadRow = await openRow(3)
    const leadFrom = leadRow.querySelector('.vmt-landing-from')
    await click(leadFrom.querySelector('button') ?? leadFrom)
    const leadOptions = [...document.body.querySelectorAll('[role="option"]')]
    const whereItWas = leadOptions.find((option) => option.textContent === 'Where it was')
    expect(whereItWas, 'the From select lists Where it was').toBeTruthy()
    expect(whereItWas.getAttribute('aria-disabled') === 'true' || whereItWas.disabled === true).toBe(true)
    const edge = leadOptions.find((option) => option.textContent === 'Edge')
    expect(edge.getAttribute('aria-disabled') === 'true' || edge.disabled === true).toBe(false)
  })

  it('shows only the controls its start needs', async () => {
    await renderLane({ landings: [landing(3), landing(1, { from: 'custom' }), landing(2, { from: 'grow' })] })
    await selectCue()
    const edgeRow = await openRow(3)
    expect(edgeRow.querySelector('.vmt-line-sweep-compass')).toBeTruthy()
    expect(edgeRow.querySelector('.vmt-landing-custom')).toBeNull()
    expect(edgeRow.querySelector('.vmt-landing-lead-in')).toBeTruthy()
    expect(edgeRow.querySelector('.vmt-landing-from-opacity')).toBeTruthy()
    expect(edgeRow.querySelector('.vmt-landing-easing')).toBeTruthy()
    expect(edgeRow.querySelector('.vmt-easing-summary')).toBeTruthy()

    const customRow = await openRow(1)      // opening one closes the other
    expect(detailFor(3)).toBeNull()
    expect(container.querySelectorAll('.vmt-landing-body')).toHaveLength(1)
    expect(rowFor(3).querySelector('.vmt-landing-toggle').getAttribute('aria-expanded')).toBe('false')
    expect(customRow.querySelector('.vmt-line-sweep-compass')).toBeNull()
    expect(customRow.querySelectorAll('.vmt-landing-custom [role="slider"]')).toHaveLength(4)

    const growRow = await openRow(2)
    expect(growRow.querySelector('.vmt-line-sweep-compass')).toBeNull()
    expect(growRow.querySelector('.vmt-landing-custom')).toBeNull()
  })

  it('a typed lead-in is snapped to the grid and written once, in ticks', async () => {
    const props = await renderLane({ snapGranularity: '1/8' })
    await selectCue()
    const row = await openRow(1)
    const leadIn = row.querySelector('.vmt-landing-lead-in')
    expect(leadIn.getAttribute('aria-valuetext') ?? leadIn.textContent).toContain('1 beat')
    await typeValue(leadIn, '2.3')
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    const [tick, list] = props.onSetCueLandings.mock.calls[0]
    expect(tick).toBe(PIN_TICK)
    expect(list[0]).toEqual({ ...REFERENCE_LANDINGS[0], leadInTicks: beatsToTicks(2.5) })   // 1/8 grid
    expect(list.slice(1)).toEqual(REFERENCE_LANDINGS.slice(1))
  })

  it('a typed From opacity is written once as a 0..1 value', async () => {
    const props = await renderLane()
    await selectCue()
    const row = await openRow(1)
    await typeValue(row.querySelector('.vmt-landing-from-opacity'), '40')
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    expect(props.onSetCueLandings.mock.calls[0][1][0]).toEqual({ ...REFERENCE_LANDINGS[0], fromOpacity: 0.4 })
  })

  it('a typed custom edge keeps the other three', async () => {
    const start = landing(1, { from: 'custom', custom: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })
    const props = await renderLane({ landings: [start] })
    await selectCue()
    const row = await openRow(1)
    await typeValue(row.querySelector('.vmt-landing-custom-w'), '55')
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    expect(props.onSetCueLandings.mock.calls[0][1][0].custom).toEqual({ x: 0.1, y: 0.2, w: 0.55, h: 0.4 })
  })

  it('the edge compass writes the angle on a key press', async () => {
    const props = await renderLane()
    await selectCue()
    const row = await openRow(3)
    const compass = row.querySelector('.vmt-line-sweep-compass')
    expect(compass.getAttribute('aria-valuenow')).toBe('270')
    await act(async () => {
      compass.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowLeft', shiftKey: true }))
    })
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    expect(props.onSetCueLandings.mock.calls[0][1][2]).toEqual({ ...REFERENCE_LANDINGS[2], edgeAngleDeg: 260 })
  })

  it('the curve editor edits one curve and writes it once', async () => {
    const props = await renderLane()
    await selectCue()
    const row = await openRow(3)
    await click(row.querySelector('.vmt-easing-summary'))
    const controls = [...row.querySelectorAll('.vmt-easing-control')]
    expect(controls, 'a landing has ONE curve: two control points').toHaveLength(2)
    expect(row.textContent).toContain('Reset to Land')
    await act(async () => {
      controls[0].dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight', shiftKey: true }))
    })
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    const written = props.onSetCueLandings.mock.calls[0][1][2]
    expect(written.easing.x1).toBeCloseTo(LAND.x1 + 0.1, 6)
    expect(written.easing.y1).toBe(LAND.y1)
    expect({ ...written, easing: LAND }).toEqual({ ...REFERENCE_LANDINGS[2], easing: LAND })
  })

  // ── Reflow ────────────────────────────────────────────────────────────────

  it('Reflow asks for a one-beat reflow of this cue, once', async () => {
    const props = await renderLane()
    await selectCue()
    const reflow = container.querySelector('.vmt-landings-reflow')
    expect(reflow.textContent).toBe('Reflow')
    await click(reflow)
    expect(props.onReflowCueLandings).toHaveBeenCalledOnce()
    expect(props.onReflowCueLandings).toHaveBeenCalledWith(PIN_TICK, BEAT)
    expect(props.onSetCueLandings).not.toHaveBeenCalled()
  })

  it('Reflow and setCueLandings reach the engine through useSnapshotCues and re-read the cues', async () => {
    const afterReflow = [{ tick: PIN_TICK, snapshotId: 'two', transition: { enabled: false }, landings: REFERENCE_LANDINGS }]
    let stored = [{ tick: PIN_TICK, snapshotId: 'two', transition: { enabled: false } }]
    const timeline = {
      listCues: vi.fn(async () => stored),
      listSnapshots: vi.fn(async () => SNAPSHOTS),
      getDefaultSnapshot: vi.fn(async () => 'one'),
      reflowCueLandings: vi.fn(async () => { stored = afterReflow; return stored }),
      setCueLandings: vi.fn(async (tick, landings) => {
        stored = [{ ...stored[0], landings }]
        return stored
      }),
    }
    window.xleth = { timeline }

    function Harness() {
      const cueApi = useSnapshotCues({ current: 0 })
      return (
        <SnapshotCueLane
          pixelsPerBeatRef={{ current: 40 }}
          scrollOffsetRef={{ current: 0 }}
          cues={cueApi.cues}
          snapshots={cueApi.snapshots}
          defaultSnapshotId={cueApi.defaultSnapshotId}
          totalBeats={64}
          tracks={TRACKS}
          onMoveCue={cueApi.moveCue}
          onRemoveCue={cueApi.removeCue}
          onRepointCue={cueApi.repointCue}
          onSetCueTransition={cueApi.setCueTransition}
          onSetCueLandings={cueApi.setCueLandings}
          onReflowCueLandings={cueApi.reflowCueLandings}
        />
      )
    }
    await act(async () => { root.render(<Harness />) })
    await act(async () => { await Promise.resolve() })
    await act(async () => { root.render(<Harness />) })
    await selectCue()
    expect(container.querySelectorAll('.vmt-landing-row')).toHaveLength(0)

    const readsBefore = timeline.listCues.mock.calls.length
    await click(container.querySelector('.vmt-landings-reflow'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(timeline.reflowCueLandings).toHaveBeenCalledOnce()
    expect(timeline.reflowCueLandings).toHaveBeenCalledWith(PIN_TICK, BEAT)
    expect(timeline.listCues.mock.calls.length).toBeGreaterThan(readsBefore)
    // The rows come from the engine's answer, not from a local guess.
    expect([...container.querySelectorAll('.vmt-landing-row')].map((row) => row.getAttribute('data-track-id')))
      .toEqual(['1', '2', '3'])

    await click(rowFor(3).querySelector('.vmt-landing-remove'))
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(timeline.setCueLandings).toHaveBeenCalledOnce()
    expect(timeline.setCueLandings).toHaveBeenCalledWith(PIN_TICK, REFERENCE_LANDINGS.slice(0, 2))
    expect(container.querySelectorAll('.vmt-landing-row')).toHaveLength(2)
  })

  // ── Lead-in tails ─────────────────────────────────────────────────────────

  it('draws one tail per landing on a canvas, under the pins', async () => {
    await renderLane()
    const canvas = container.querySelector('canvas.vmt-landing-tails')
    expect(canvas, 'tails are drawn on a canvas, not as DOM bars').toBeTruthy()
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    // Chords and bass start a beat before the pin (x 280), lead half a beat (x 300).
    const bars = drawn.filter((call) => call[0] === 'fillRect' && call[3] > 3)
    const lastPass = bars.slice(-3)
    expect(lastPass.map((call) => [call[1], call[2], call[3]])).toEqual([
      [280, landingTailRowY(0), 40], [280, landingTailRowY(1), 40], [300, landingTailRowY(2), 20],
    ])
  })

  it('paints "+N" when a cue has more landings than rows', () => {
    const calls = []
    const ctx = {
      clearRect() {}, fillRect: (...args) => calls.push(['fillRect', ...args]),
      fillText: (...args) => calls.push(['fillText', ...args]),
    }
    const tails = [0, 1, 2, 3].map((row) => ({ trackId: row + 1, row, startTick: PIN_TICK - BEAT, leadInTicks: BEAT, pinTick: PIN_TICK }))
    paintLandingTails(ctx, {
      items: [{ cueTick: PIN_TICK, floorTick: 0, selected: true, tails, overflow: 2 }],
      draft: null, width: 1000, height: 24, scrollOffset: 0, pixelsPerBeat: 40, ink: '#fff', font: '10px sans-serif',
    })
    expect(calls.filter((call) => call[0] === 'fillRect' && call[3] > 3)).toHaveLength(4)
    expect(calls.find((call) => call[0] === 'fillText')[1]).toBe('+2')
    expect(ctx.font).toBe('10px sans-serif')
  })

  it('dragging a tail end emits exactly one setCueLandings on release, with the snapped lead-in', async () => {
    const props = await renderLane()
    await selectCue()
    const lane = container.querySelector('.vmt-cue-lane')
    const y = landingTailRowY(0) + 1          // chords' row

    // Press on the left end of the chords' tail (x 280) and drag to x 243:
    // beat 6.075, which snaps to beat 6 on the 1/16 grid = two beats of lead-in.
    await act(async () => { pointer('pointerdown', lane, 280, y) })
    await act(async () => { pointer('pointermove', window, 262, y) })
    await act(async () => { pointer('pointermove', window, 251, y) })
    await act(async () => { pointer('pointermove', window, 243, y) })
    expect(props.onSetCueLandings, 'no IPC while the drag is in flight').not.toHaveBeenCalled()

    // The preview is painted locally: the dragged tail now starts at beat 6 (x 240).
    const previewBars = drawn.filter((call) => call[0] === 'fillRect' && call[2] === landingTailRowY(0) && call[3] > 3)
    expect(previewBars[previewBars.length - 1].slice(1, 4)).toEqual([240, landingTailRowY(0), 80])

    await act(async () => { pointer('pointerup', window, 243, y) })
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    const [tick, list] = props.onSetCueLandings.mock.calls[0]
    expect(tick).toBe(PIN_TICK)
    expect(list).toHaveLength(3)
    expect(list[0]).toEqual({ ...REFERENCE_LANDINGS[0], leadInTicks: beatsToTicks(2) })
    expect(list.slice(1)).toEqual(REFERENCE_LANDINGS.slice(1))        // only that landing changed
    for (const entry of list) expect(Object.keys(entry).sort()).toEqual([...LANDING_KEYS].sort())

    // The click that ends the drag must not deselect the cue.
    await click(lane)
    expect(container.querySelector('.vmt-cue-editor')).toBeTruthy()
  })

  it('Alt frees the snap but the lead-in is still a whole tick', async () => {
    const props = await renderLane()
    await selectCue()
    const lane = container.querySelector('.vmt-cue-lane')
    const y = landingTailRowY(2) + 1          // lead's row; its tail starts at x 300
    await act(async () => { pointer('pointerdown', lane, 300, y) })
    await act(async () => { pointer('pointermove', window, 243, y, { altKey: true }) })
    await act(async () => { pointer('pointerup', window, 243, y, { altKey: true }) })
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    const leadInTicks = props.onSetCueLandings.mock.calls[0][1][2].leadInTicks
    expect(leadInTicks).toBe(1848)
    expect(Number.isInteger(leadInTicks)).toBe(true)
  })

  it('a press that does not move writes nothing', async () => {
    const props = await renderLane()
    await selectCue()
    const lane = container.querySelector('.vmt-cue-lane')
    const y = landingTailRowY(0) + 1
    await act(async () => { pointer('pointerdown', lane, 280, y) })
    await act(async () => { pointer('pointerup', window, 280, y) })
    expect(props.onSetCueLandings).not.toHaveBeenCalled()
  })

  it('tails of an unselected cue are not grabbable', async () => {
    const props = await renderLane()
    const lane = container.querySelector('.vmt-cue-lane')
    const y = landingTailRowY(0) + 1
    await act(async () => { pointer('pointerdown', lane, 280, y) })
    await act(async () => { pointer('pointermove', window, 200, y) })
    await act(async () => { pointer('pointerup', window, 200, y) })
    expect(props.onSetCueLandings).not.toHaveBeenCalled()
  })

  it('a transition grip keeps its hit area over a tail', async () => {
    // Transition start one beat before the pin: its grip sits exactly on the
    // left end of the chords' and bass's tails (x 280).
    const cues = [{
      tick: PIN_TICK, snapshotId: 'two', landings: REFERENCE_LANDINGS,
      transition: { enabled: true, startOffsetTicks: BEAT, endOffsetTicks: BEAT, type: 'crossfade' },
    }]
    const props = await renderLane({ cues })
    await selectCue()
    const grip = container.querySelector('.vmt-transition-handle-start')
    expect(grip).toBeTruthy()
    const y = landingTailRowY(0) + 1
    await act(async () => { pointer('pointerdown', grip, 280, y) })
    await act(async () => { pointer('pointermove', window, 240, y) })
    await act(async () => { pointer('pointerup', window, 240, y) })
    expect(props.onSetCueTransition, 'the grip took the drag').toHaveBeenCalledOnce()
    expect(props.onSetCueTransition.mock.calls[0][1].startOffsetTicks).toBe(beatsToTicks(2))
    expect(props.onSetCueLandings, 'the tail under it did not').not.toHaveBeenCalled()
  })

  it('a tail is clamped at the previous cue while it is dragged', async () => {
    const cues = [
      { tick: beatsToTicks(6), snapshotId: 'one', transition: { enabled: false } },
      { tick: PIN_TICK, snapshotId: 'two', transition: { enabled: false }, landings: [landing(3, { leadInTicks: beatsToTicks(0.5) })] },
    ]
    const props = await renderLane({ cues })
    const markers = [...container.querySelectorAll('.vmt-cue-marker')]
    await act(async () => {
      pointer('pointerdown', markers[1], 320)
      pointer('pointerup', window, 320)
    })
    const lane = container.querySelector('.vmt-cue-lane')
    const y = landingTailRowY(0) + 1
    await act(async () => { pointer('pointerdown', lane, 300, y) })
    await act(async () => { pointer('pointermove', window, 80, y) })     // far left of the previous pin (x 240)
    await act(async () => { pointer('pointerup', window, 80, y) })
    expect(props.onSetCueLandings).toHaveBeenCalledOnce()
    expect(props.onSetCueLandings.mock.calls[0][1][0].leadInTicks).toBe(beatsToTicks(2))
  })
})
