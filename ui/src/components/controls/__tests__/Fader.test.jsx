/**
 * @vitest-environment jsdom
 *
 * Smoke test for the Fader primitive (ui/src/components/controls/Fader.jsx):
 * grab-relative dragging through the shared drag law, the fine-mode rebase
 * (see dragLaw.realComponents.test.jsx for the same property on Knob/
 * VolumeFader), per-rAF-frame coalescing, and the onLiveChange/onCommit
 * split ("only commits may cross the bridge").
 *
 * jsdom has no Pointer Lock API and no getCoalescedEvents — both are
 * feature-detected in Fader.jsx and fall back to plain clientX/clientY
 * deltas, which is exactly the path exercised here.
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Fader from '../Fader.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container = null
let root = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  container = null
  root = null
})

async function mount(el) {
  await act(async () => { root.render(el) })
  return container
}

function stubCapture(el) {
  el.setPointerCapture = () => {}
  el.releasePointerCapture = () => {}
}

function pointer(type, init) {
  const e = new Event(type, { bubbles: true })
  Object.assign(e, { clientX: 0, clientY: 0, pointerId: 1, shiftKey: false, ctrlKey: false, metaKey: false, button: 0, ...init })
  return e
}

// Flush the single pending requestAnimationFrame Fader batches pointermoves
// into — the whole point of the coalescing is that a burst of moves before
// this resolves collapses into ONE onLiveChange call.
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

describe('Fader — grab-relative drag, rebase, coalescing, commit-once', () => {
  it('dragging the groove (not the thumb) still moves the value — grab-relative, not absolute', async () => {
    const live = []
    const c = await mount(
      <Fader value={500} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={() => {}} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 100 })) })
    // No movement yet — grab-relative means pointerdown alone never emits a change.
    expect(live.length).toBe(0)

    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 82 })) })
    await flushFrame()
    // +18px up / 180px range * 1000 span = +100 -> 600.
    expect(live.at(-1)).toBeCloseTo(600, 5)

    act(() => { el.dispatchEvent(pointer('pointerup', { clientY: 82 })) })
  })

  it('coalesces a burst of pointermoves into a single onLiveChange per animation frame', async () => {
    const live = []
    const c = await mount(
      <Fader value={500} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={() => {}} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 100 })) })
    act(() => {
      el.dispatchEvent(pointer('pointermove', { clientY: 91 }))
      el.dispatchEvent(pointer('pointermove', { clientY: 82 }))
      el.dispatchEvent(pointer('pointermove', { clientY: 73 }))
    })
    // Three raw moves, still zero flushed frames' worth of live updates.
    expect(live.length).toBe(0)

    await flushFrame()
    // Exactly one update for the whole burst, reflecting the LAST position.
    expect(live.length).toBe(1)
    expect(live[0]).toBeCloseTo(650, 5) // +27px / 180 * 1000 = +150 -> 650

    act(() => { el.dispatchEvent(pointer('pointerup', { clientY: 73 })) })
  })

  it('shift toggled mid-drag rebases instead of snapping the value back', async () => {
    const live = []
    const c = await mount(
      <Fader value={500} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={() => {}} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 500 })) })
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 482 })) })
    await flushFrame()
    const beforeShift = live.at(-1)
    expect(beforeShift).toBeCloseTo(600, 5)

    // Shift ON, same pointer position — must not jump.
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 482, shiftKey: true })) })
    await flushFrame()
    expect(live.at(-1)).toBeCloseTo(beforeShift, 5)

    // Fine drag continues from here.
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 464, shiftKey: true })) })
    await flushFrame()
    const afterFineStep = live.at(-1)
    expect(afterFineStep).toBeCloseTo(612.5, 5) // 18px / 180 / 8 * 1000 = +12.5 -> 612.5

    // Shift OFF, same position — must hold, not snap back toward the original anchor.
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 464, shiftKey: false })) })
    await flushFrame()
    expect(live.at(-1)).toBeCloseTo(afterFineStep, 5)

    act(() => { el.dispatchEvent(pointer('pointerup', { clientY: 464 })) })
  })

  it('onCommit fires exactly once per drag gesture, on release — only commits cross the bridge', async () => {
    const live = []
    const commits = []
    const c = await mount(
      <Fader value={500} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={(v) => commits.push(v)} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 500 })) })
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 480 })) })
    await flushFrame()
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 460 })) })
    await flushFrame()
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 440 })) })
    // No flush before release — endDrag() must flush the pending frame itself.
    expect(commits.length).toBe(0)
    expect(live.length).toBeGreaterThan(0)

    act(() => { el.dispatchEvent(pointer('pointerup', { clientY: 440 })) })

    expect(commits.length).toBe(1)
    expect(commits[0]).toBeCloseTo(live.at(-1), 5)
  })

  it('ctrl+click resets to defaultValue without starting a drag', async () => {
    const live = []
    const commits = []
    const c = await mount(
      <Fader value={750} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={(v) => commits.push(v)} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => { el.dispatchEvent(pointer('pointerdown', { clientY: 100, ctrlKey: true })) })

    expect(live.at(-1)).toBe(500)
    expect(commits.at(-1)).toBe(500)

    // No drag was started — a follow-up move must NOT change the value.
    act(() => { el.dispatchEvent(pointer('pointermove', { clientY: 40 })) })
    await flushFrame()
    expect(live.length).toBe(1)
  })

  it('wheel adjusts and commits immediately (a discrete step, not a drag)', async () => {
    const live = []
    const commits = []
    const c = await mount(
      <Fader value={500} min={0} max={1000} defaultValue={500} length={180}
        onLiveChange={(v) => live.push(v)} onCommit={(v) => commits.push(v)} />
    )
    const el = c.querySelector('.xleth-fader')
    stubCapture(el)

    act(() => {
      el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }))
    })

    expect(live.length).toBe(1)
    expect(commits.length).toBe(1)
    expect(live[0]).toBeGreaterThan(500)
    expect(commits[0]).toBe(live[0])
  })
})
