/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ColorGradePanel from '../ColorGradePanel.jsx'
import GradeStack, { GradeIndicator, stackRows } from '../GradeStack.jsx'
import BulkApplyDialog from '../BulkApplyDialog.jsx'
import { isActive, isNeutral, neutralGrade, normalizeGrade, targetKey } from '../../../colorGrade/gradeModel.js'
import { useGradeAutoStore, useGradeClipboard } from '../../../colorGrade/gradeActions.js'
import { useGradeSummaryStore } from '../../../colorGrade/useColorGrade.js'

// The Color Grade panel, the stack view and bulk apply, against a stand-in
// engine that keeps grades the way the real one does: preview writes live and
// remembers what was there, commit ends the drag, cancel puts it back.

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container
let root
let engine
let api

const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
}

function makeEngine() {
  const grades = new Map()        // targetKey -> grade
  const sessions = new Map()      // targetKey -> baseline
  const read = (t) => normalizeGrade(grades.get(targetKey(t)))
  const state = (t) => {
    const grade = read(t)
    return { level: t.level, id: t.id ?? 0, exists: true, grade, isDefault: !grade.bypassed && isNeutral(grade), lutError: '' }
  }
  const undo = []                 // one entry per undoable write
  return {
    grades, sessions, undo, read,
    set: (t, g) => grades.set(targetKey(t), normalizeGrade(g)),
    api: {
      get: vi.fn(async (t) => state(t)),
      getAll: vi.fn(async () => {
        const out = { sources: [], clips: [], regions: [], layers: [], master: null, compare: false }
        const table = { source: 'sources', clip: 'clips', region: 'regions', layer: 'layers' }
        for (const [key, grade] of grades) {
          if (!grade.bypassed && isNeutral(grade)) continue
          const entry = { grade, active: isActive(grade) }
          if (key === 'master') out.master = { id: 0, ...entry }
          else {
            const [level, id] = key.split(':')
            out[table[level]].push({ id: Number(id), ...entry })
          }
        }
        return out
      }),
      preview: vi.fn(async (t, g) => {
        const key = targetKey(t)
        if (!sessions.has(key)) sessions.set(key, read(t))
        grades.set(key, normalizeGrade(g))
        return true
      }),
      commit: vi.fn(async (t, g, label) => {
        const key = targetKey(t)
        const before = sessions.has(key) ? sessions.get(key) : read(t)
        sessions.delete(key)
        const after = normalizeGrade(g)
        const changed = JSON.stringify(before) !== JSON.stringify(after)
        grades.set(key, after)
        if (changed) undo.push({ key, before, after, label })
        return { ...state(t), changed }
      }),
      cancel: vi.fn(async (t) => {
        const key = targetKey(t)
        if (sessions.has(key)) { grades.set(key, sessions.get(key)); sessions.delete(key) }
        return state(t)
      }),
      setMany: vi.fn(async (entries, label) => {
        let changed = 0
        for (const e of entries) {
          const before = read(e)
          const after = normalizeGrade(e.grade)
          if (JSON.stringify(before) !== JSON.stringify(after)) changed++
          grades.set(targetKey(e), after)
        }
        if (changed) undo.push({ many: entries.length, label })
        return { changed }
      }),
      analyze: vi.fn(async () => ({
        ok: true,
        analysis: { r: new Array(256).fill(1), g: new Array(256).fill(1), b: new Array(256).fill(1), luma: new Array(256).fill(1) },
        auto: { ...neutralGrade(), lift: { x: -0.1, y: 0.05, lum: -0.5 }, gain: { x: 0, y: 0, lum: 0.3 }, vibrance: 0.2 },
      })),
      setCompare: vi.fn(),
      checkLut: vi.fn(async () => ({ ok: true, size: 33, title: 'Look' })),
    },
  }
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)   // jsdom has no 2D context
  engine = makeEngine()
  api = engine.api
  window.xleth = {
    colorGrade: api,
    timeline: {
      getSources: vi.fn(async () => [
        { id: 1, fileName: 'a.mp4', hasVideo: true },
        { id: 2, fileName: 'b.mp4', hasVideo: true },
        { id: 3, fileName: 'c.mp4', hasVideo: true },
        { id: 4, fileName: 'voice.wav', hasVideo: false },
      ]),
    },
  }
  useGradeAutoStore.setState({ byKey: {} })
  useGradeClipboard.setState({ grade: null, level: null })
  useGradeSummaryStore.setState({
    sources: new Map(), clips: new Map(), regions: new Map(), layers: new Map(), master: null, loaded: false,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  delete window.xleth
  vi.restoreAllMocks()
})

const key = (el, k, opts = {}) => act(async () => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }))
})
const click = (el) => act(async () => { el.click() })
const q = (sel) => document.body.querySelector(sel)
const slider = (label) => [...document.body.querySelectorAll('[role="slider"]')].find((e) => e.getAttribute('aria-label') === label)

describe('ColorGradePanel', () => {
  it('is the same panel at every level, named for the level it edits', async () => {
    for (const [level, title] of [['source', 'Source grade'], ['clip', 'Clip grade'], ['region', 'Sample grade'], ['layer', 'Layer grade'], ['master', 'Master grade']]) {
      await act(async () => { root.render(<ColorGradePanel key={level} target={{ level, id: 7 }} name="Owner" />) })
      await flush()
      expect(q('[data-testid="xleth-grade-panel"]').getAttribute('data-level')).toBe(level)
      expect(q('h2').textContent).toBe(title)
      // The same controls, whatever the level.
      for (const name of ['Exposure', 'Contrast', 'Saturation', 'Vibrance', 'Temperature', 'Tint', 'Hue shift']) {
        expect(slider(name), `${level}: ${name}`).toBeTruthy()
      }
      expect(q('[data-testid="xleth-grade-auto"]')).toBeTruthy()
    }
  })

  it('a change previews in the engine and commits as exactly one undo step', async () => {
    const target = { level: 'source', id: 1 }
    await act(async () => { root.render(<ColorGradePanel target={target} name="a.mp4" />) })
    await flush()

    await key(slider('Exposure'), 'ArrowUp')
    await flush()
    expect(api.preview).toHaveBeenCalled()
    expect(api.commit).toHaveBeenCalledTimes(1)
    const [sentTarget, sentGrade] = api.commit.mock.calls[0]
    expect(sentTarget).toEqual(target)
    expect(sentGrade.exposure).toBeCloseTo(0.05, 6)
    // Everything else went back unchanged: a control edits its own value only.
    expect({ ...sentGrade, exposure: 0 }).toEqual(neutralGrade())
    expect(engine.undo.length).toBe(1)
    expect(engine.read(target).exposure).toBeCloseTo(0.05, 6)
    // The value on show is the engine's.
    expect(slider('Exposure').getAttribute('aria-valuetext')).toContain('+0.05')
  })

  it('a second control leaves the first one alone', async () => {
    const target = { level: 'layer', id: 5 }
    engine.set(target, { ...neutralGrade(), exposure: 1 })
    await act(async () => { root.render(<ColorGradePanel target={target} name="Chorus" />) })
    await flush()
    await key(slider('Contrast'), 'ArrowUp')
    await flush()
    const g = engine.read(target)
    expect(g.exposure).toBe(1)
    expect(g.contrast).toBeCloseTo(0.01, 6)
  })

  it('switching the grade off keeps its values and says so three ways', async () => {
    const target = { level: 'clip', id: 9 }
    engine.set(target, { ...neutralGrade(), saturation: -0.5 })
    await act(async () => { root.render(<ColorGradePanel target={target} name="Take 1" />) })
    await flush()
    const toggle = q('[data-testid="xleth-grade-on"]')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')

    await click(toggle)
    await flush()
    const g = engine.read(target)
    expect(g.bypassed).toBe(true)
    expect(g.saturation).toBe(-0.5)                       // values kept
    expect(engine.undo.length).toBe(1)                    // one undo step
    expect(q('[data-testid="xleth-grade-on"]').getAttribute('aria-pressed')).toBe('false')
    expect(q('h2').textContent).toBe('Clip grade · Off')
  })

  it('Auto writes ordinary controls, as one step, and offers a strength', async () => {
    const target = { level: 'source', id: 2 }
    engine.set(target, { ...neutralGrade(), exposure: 0.4 })
    await act(async () => { root.render(<ColorGradePanel target={target} name="b.mp4" />) })
    await flush()

    await click(q('[data-testid="xleth-grade-auto"]'))
    await flush()
    expect(api.analyze).toHaveBeenCalledWith(target)
    expect(api.commit).toHaveBeenCalledTimes(1)
    expect(api.commit.mock.calls[0][2]).toBe('Auto color grade')
    const g = engine.read(target)
    expect(g.lift.lum).toBe(-0.5)
    expect(g.gain.lum).toBe(0.3)
    expect(g.vibrance).toBe(0.2)
    expect(g.exposure).toBe(0.4)                          // Auto left the user's exposure alone
    expect(engine.undo.length).toBe(1)

    // Strength: turn it down a step; the correction scales, still one step each.
    const strength = slider('Auto strength')
    expect(strength).toBeTruthy()
    await key(strength, 'ArrowDown')
    await flush()
    expect(engine.read(target).lift.lum).toBeCloseTo(-0.5 * 0.99, 3)
    expect(engine.undo.length).toBe(2)
  })

  it('Auto on healthy footage changes nothing and says so', async () => {
    api.analyze.mockResolvedValueOnce({ ok: true, analysis: null, auto: neutralGrade() })
    const target = { level: 'source', id: 3 }
    await act(async () => { root.render(<ColorGradePanel target={target} name="c.mp4" />) })
    await flush()
    await click(q('[data-testid="xleth-grade-auto"]'))
    await flush()
    expect(api.commit).not.toHaveBeenCalled()
    expect(q('[role="status"]').textContent).toContain('already looks balanced')
    expect(slider('Auto strength')).toBeFalsy()
  })

  it('a failed analysis is reported and writes nothing', async () => {
    api.analyze.mockResolvedValueOnce({ ok: false, error: 'this source has no picture' })
    await act(async () => { root.render(<ColorGradePanel target={{ level: 'source', id: 4 }} name="voice.wav" />) })
    await flush()
    await click(q('[data-testid="xleth-grade-auto"]'))
    await flush()
    expect(api.commit).not.toHaveBeenCalled()
    expect(q('[role="status"]').textContent).toContain('this source has no picture')
  })
})

describe('GradeStack', () => {
  const stack = {
    source: { id: 1, name: 'a.mp4' },
    clip: { level: 'clip', id: 9, name: 'Take 1' },
    layer: { id: 5, name: 'Chorus' },
  }

  it('lists the levels in the order they are applied, Master always last', () => {
    expect(stackRows(stack).map((r) => r.target.level)).toEqual(['source', 'clip', 'layer', 'master'])
    const pattern = { ...stack, clip: { level: 'region', id: 3, name: 'Kick' } }
    expect(stackRows(pattern).map((r) => r.target.level)).toEqual(['source', 'region', 'layer', 'master'])
    expect(stackRows({ layer: stack.layer }).map((r) => r.target.level)).toEqual(['layer', 'master'])
    expect(stackRows(null).map((r) => r.target.level)).toEqual(['master'])
  })

  it('shows which levels are on, off, and ungraded', async () => {
    engine.set({ level: 'source', id: 1 }, { ...neutralGrade(), exposure: 0.5 })
    engine.set({ level: 'layer', id: 5 }, { ...neutralGrade(), saturation: -1, bypassed: true })
    await act(async () => { root.render(<GradeStack stack={stack} />) })
    await flush()
    const rows = [...document.body.querySelectorAll('[data-testid="xleth-grade-stack"] > li')]
    expect(rows.map((r) => r.getAttribute('data-level'))).toEqual(['source', 'clip', 'layer', 'master'])
    expect(rows.map((r) => r.getAttribute('data-state'))).toEqual(['on', 'none', 'off', 'none'])
    expect(rows[0].textContent).toContain('On')
    expect(rows[1].textContent).toContain('No grade')
    expect(rows[2].textContent).toContain('Off')
    // A level with no grade has nothing to switch.
    expect(q('[data-testid="xleth-grade-stack-on-clip"]').disabled).toBe(true)
    expect(q('[data-testid="xleth-grade-stack-on-source"]').getAttribute('aria-pressed')).toBe('true')
    expect(q('[data-testid="xleth-grade-stack-on-layer"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('switching a level off from the stack is the same write as from its own panel', async () => {
    const target = { level: 'source', id: 1 }
    engine.set(target, { ...neutralGrade(), exposure: 0.5 })
    await act(async () => {
      root.render(
        <>
          <GradeStack stack={stack} />
          <ColorGradePanel target={target} name="a.mp4" />
        </>,
      )
    })
    await flush()

    // From the stack...
    await click(q('[data-testid="xleth-grade-stack-on-source"]'))
    await flush()
    expect(engine.read(target).bypassed).toBe(true)
    const fromStack = api.commit.mock.calls.at(-1)
    // ...the panel shows it at once...
    expect(q('[data-testid="xleth-grade-on"]').getAttribute('aria-pressed')).toBe('false')
    expect(q('[data-testid="xleth-grade-stack"] > li[data-level="source"]').getAttribute('data-state')).toBe('off')

    // ...and from the panel, back on: the same call, the same shape.
    await click(q('[data-testid="xleth-grade-on"]'))
    await flush()
    expect(engine.read(target).bypassed).toBe(false)
    const fromPanel = api.commit.mock.calls.at(-1)
    expect(fromPanel[0]).toEqual(fromStack[0])
    expect({ ...fromPanel[1], bypassed: true }).toEqual(fromStack[1])
    expect(q('[data-testid="xleth-grade-stack-on-source"]').getAttribute('aria-pressed')).toBe('true')
    expect(engine.undo.length).toBe(2)
  })

  it('opens the level that was asked for', async () => {
    const onOpen = vi.fn()
    await act(async () => { root.render(<GradeStack stack={stack} onOpen={onOpen} />) })
    await flush()
    await click(q('[data-testid="xleth-grade-stack-open-layer"]'))
    expect(onOpen).toHaveBeenCalledWith({ level: 'layer', id: 5 }, 'Chorus')
    await click(q('[data-testid="xleth-grade-stack-open-master"]'))
    expect(onOpen).toHaveBeenLastCalledWith({ level: 'master' }, 'Whole picture')
  })
})

describe('GradeIndicator', () => {
  it('marks a graded owner, differently when switched off, and nothing when ungraded', async () => {
    engine.set({ level: 'source', id: 1 }, { ...neutralGrade(), exposure: 0.5 })
    engine.set({ level: 'source', id: 2 }, { ...neutralGrade(), exposure: 0.5, bypassed: true })
    await act(async () => {
      root.render(
        <>
          <span data-slot="1"><GradeIndicator target={{ level: 'source', id: 1 }} /></span>
          <span data-slot="2"><GradeIndicator target={{ level: 'source', id: 2 }} /></span>
          <span data-slot="3"><GradeIndicator target={{ level: 'source', id: 3 }} /></span>
        </>,
      )
    })
    await flush()
    const mark = (n) => q(`[data-slot="${n}"] [data-testid="xleth-grade-indicator"]`)
    expect(mark(1).getAttribute('data-state')).toBe('on')
    expect(mark(1).getAttribute('aria-label')).toBe('Source grade: on')
    expect(mark(2).getAttribute('data-state')).toBe('off')
    expect(mark(2).getAttribute('aria-label')).toBe('Source grade: switched off')
    expect(mark(3)).toBeNull()
  })
})

describe('BulkApplyDialog', () => {
  const grade = { ...neutralGrade(), exposure: 0.7, contrast: 0.2 }
  const boxes = () => [...document.body.querySelectorAll('input[type="checkbox"]')]
  const segment = (text) => [...document.body.querySelectorAll('[role="radio"]')].find((r) => r.textContent === text)

  it('applies one grade to every ticked source as one write', async () => {
    await act(async () => {
      root.render(<BulkApplyDialog fromSourceId={1} fromName="a.mp4" grade={grade} onClose={() => {}} />)
    })
    await flush()
    // The source it came from and the audio-only source are not offered.
    expect(document.body.textContent).toContain('b.mp4')
    expect(document.body.textContent).toContain('c.mp4')
    expect(document.body.textContent).not.toContain('voice.wav')
    expect(boxes().length).toBe(3)                        // "all" + two sources

    await click(q('[data-testid="xleth-grade-bulk-all"]'))
    await flush()
    await click(q('[data-testid="xleth-grade-bulk-apply"]'))
    await flush()
    expect(api.setMany).toHaveBeenCalledTimes(1)
    const [entries, label] = api.setMany.mock.calls[0]
    expect(entries.map((e) => [e.level, e.id])).toEqual([['source', 2], ['source', 3]])
    expect(entries.every((e) => e.grade.exposure === 0.7 && e.grade.contrast === 0.2)).toBe(true)
    expect(label).toBe('Apply color grade to 2 sources')
    expect(engine.undo.length).toBe(1)                    // one undo step for the batch
    expect(document.body.textContent).toContain('2 sources graded')
  })

  it('never overwrites an existing grade without being told to', async () => {
    const existing = { ...neutralGrade(), hue: 40 }
    engine.set({ level: 'source', id: 3 }, existing)
    await act(async () => {
      root.render(<BulkApplyDialog fromSourceId={1} fromName="a.mp4" grade={grade} onClose={() => {}} />)
    })
    await flush()
    await click(q('[data-testid="xleth-grade-bulk-all"]'))
    await flush()
    // The dialog says one of them already has a grade, and defaults to skipping it.
    expect(document.body.textContent).toContain('1 of the ticked source already has a grade')
    expect(segment('Skip them').getAttribute('aria-checked')).toBe('true')

    await click(q('[data-testid="xleth-grade-bulk-apply"]'))
    await flush()
    expect(api.setMany.mock.calls[0][0].map((e) => e.id)).toEqual([2])
    expect(engine.read({ level: 'source', id: 3 })).toEqual(normalizeGrade(existing))   // untouched
    expect(document.body.textContent).toContain('1 skipped')
  })

  it('replaces existing grades when the user chooses to', async () => {
    engine.set({ level: 'source', id: 3 }, { ...neutralGrade(), hue: 40 })
    await act(async () => {
      root.render(<BulkApplyDialog fromSourceId={1} fromName="a.mp4" grade={grade} onClose={() => {}} />)
    })
    await flush()
    await click(q('[data-testid="xleth-grade-bulk-all"]'))
    await flush()
    await click(segment('Replace them'))
    await flush()
    await click(q('[data-testid="xleth-grade-bulk-apply"]'))
    await flush()
    expect(api.setMany.mock.calls[0][0].map((e) => e.id)).toEqual([2, 3])
    expect(engine.read({ level: 'source', id: 3 }).exposure).toBe(0.7)
  })

  it('Auto analyses each source on its own and still writes once', async () => {
    api.analyze
      .mockResolvedValueOnce({ ok: true, analysis: null, auto: { ...neutralGrade(), lift: { x: 0, y: 0, lum: -0.4 } } })
      .mockResolvedValueOnce({ ok: true, analysis: null, auto: { ...neutralGrade(), vibrance: 0.5 } })
    await act(async () => {
      root.render(<BulkApplyDialog fromSourceId={1} fromName="a.mp4" grade={grade} onClose={() => {}} />)
    })
    await flush()
    await click(segment('Auto, each on its own'))
    await click(q('[data-testid="xleth-grade-bulk-all"]'))
    await flush()
    await click(q('[data-testid="xleth-grade-bulk-apply"]'))
    await flush()
    expect(api.analyze).toHaveBeenCalledTimes(2)
    expect(api.analyze.mock.calls.map((c) => c[0])).toEqual([{ level: 'source', id: 2 }, { level: 'source', id: 3 }])
    expect(api.setMany).toHaveBeenCalledTimes(1)
    const entries = api.setMany.mock.calls[0][0]
    expect(entries[0].grade.lift.lum).toBe(-0.4)          // each source its own correction
    expect(entries[1].grade.vibrance).toBe(0.5)
    expect(entries[0].grade.vibrance).toBe(0)
    expect(engine.undo.length).toBe(1)
  })
})
