/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  findSidewaysWheelTarget,
  installWheelToHorizontalScroll,
} from '../wheelToHorizontalScroll'

// jsdom has no layout, so the scroll geometry is faked per element. scrollLeft
// and scrollTop are stored as plain values (no clamping), which is enough to
// check where the handler sent them.
function fakeGeometry(el, { scrollWidth, clientWidth, scrollHeight, clientHeight, scrollLeft = 0, scrollTop = 0, rect }) {
  let left = scrollLeft
  let top = scrollTop
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth })
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight ?? clientHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
  Object.defineProperty(el, 'clientTop', { configurable: true, value: 0 })
  Object.defineProperty(el, 'scrollLeft', {
    configurable: true,
    get: () => left,
    set: (v) => { left = v },
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v) => { top = v },
  })
  el.getBoundingClientRect = () => rect ?? { top: 0, bottom: clientHeight, left: 0, right: clientWidth, width: clientWidth, height: clientHeight }
  return el
}

function wheel(target, init = {}) {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ...init })
  target.dispatchEvent(e)
  return e
}

describe('wheelToHorizontalScroll', () => {
  let root
  let cleanup

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    cleanup?.()
    cleanup = null
    root.remove()
  })

  function sidewaysStrip({ scrollLeft = 0, rect } = {}) {
    const strip = document.createElement('div')
    strip.style.overflowX = 'auto'
    strip.style.overflowY = 'hidden'
    fakeGeometry(strip, { scrollWidth: 1000, clientWidth: 200, clientHeight: 60, scrollLeft, rect })
    const child = document.createElement('div')
    strip.appendChild(child)
    root.appendChild(strip)
    return { strip, child }
  }

  it('turns a plain vertical wheel tick into a sideways scroll', () => {
    const { strip, child } = sidewaysStrip()
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(child, { deltaY: 100 })

    expect(strip.scrollLeft).toBe(100)
    expect(e.defaultPrevented).toBe(true)
  })

  it('scrolls back the other way on wheel up', () => {
    const { strip, child } = sidewaysStrip({ scrollLeft: 300 })
    cleanup = installWheelToHorizontalScroll(window)

    wheel(child, { deltaY: -120 })

    expect(strip.scrollLeft).toBe(180)
  })

  it('leaves the wheel alone when the strip is already at the start going up', () => {
    const { child } = sidewaysStrip({ scrollLeft: 0 })
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(child, { deltaY: -120 })

    expect(e.defaultPrevented).toBe(false)
  })

  it('leaves the wheel alone when the strip is already at the end going down', () => {
    const { strip, child } = sidewaysStrip({ scrollLeft: 800 })
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(child, { deltaY: 100 })

    expect(e.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(800)
  })

  it('leaves wheel-owning controls (canvas, slider, data-wheel-owner svg) alone', () => {
    const { strip, child } = sidewaysStrip()
    const canvas = document.createElement('canvas')
    const slider = document.createElement('div')
    slider.setAttribute('role', 'slider')
    const svgHost = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svgHost.setAttribute('data-wheel-owner', 'true')
    const svgChild = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
    svgHost.appendChild(svgChild)
    child.append(canvas, slider, svgHost)
    cleanup = installWheelToHorizontalScroll(window)

    for (const t of [canvas, slider, svgChild]) {
      const e = wheel(t, { deltaY: 100 })
      expect(e.defaultPrevented).toBe(false)
    }
    expect(strip.scrollLeft).toBe(0)

    // ...while the bare strip around them still scrolls sideways.
    wheel(child, { deltaY: 100 })
    expect(strip.scrollLeft).toBe(100)
  })

  it('ignores wheel events that already carry a horizontal delta', () => {
    const { strip, child } = sidewaysStrip()
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(child, { deltaX: 40, deltaY: 5 })

    expect(e.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(0)
  })

  it('leaves ctrl+wheel alone so zoom gestures keep working', () => {
    const { strip, child } = sidewaysStrip()
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(child, { deltaY: 100, ctrlKey: true })

    expect(e.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(0)
  })

  it('does nothing when the event was already handled', () => {
    const { strip, child } = sidewaysStrip()
    child.addEventListener('wheel', (ev) => ev.preventDefault(), { passive: false })
    cleanup = installWheelToHorizontalScroll(window)

    wheel(child, { deltaY: 100 })

    expect(strip.scrollLeft).toBe(0)
  })

  it('lets a vertically scrolling element nearer the pointer keep the wheel', () => {
    const { strip } = sidewaysStrip()
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    fakeGeometry(list, { scrollWidth: 200, clientWidth: 200, scrollHeight: 900, clientHeight: 300, scrollTop: 0 })
    const row = document.createElement('div')
    list.appendChild(row)
    strip.firstElementChild.appendChild(list)
    cleanup = installWheelToHorizontalScroll(window)

    const e = wheel(row, { deltaY: 100 })

    expect(e.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(0)
  })

  it('falls through to the sideways strip when the vertical list is at its end', () => {
    const { strip } = sidewaysStrip()
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    fakeGeometry(list, { scrollWidth: 200, clientWidth: 200, scrollHeight: 900, clientHeight: 300, scrollTop: 600 })
    const row = document.createElement('div')
    list.appendChild(row)
    strip.firstElementChild.appendChild(list)
    cleanup = installWheelToHorizontalScroll(window)

    wheel(row, { deltaY: 100 })

    expect(strip.scrollLeft).toBe(100)
  })

  it('scrolls sideways when the pointer is on the horizontal bar of an element that also scrolls vertically', () => {
    const host = document.createElement('div')
    host.style.overflowX = 'auto'
    host.style.overflowY = 'auto'
    // Bar strip sits from y=60 to y=75 in this fake layout.
    fakeGeometry(host, {
      scrollWidth: 1000, clientWidth: 200, scrollHeight: 900, clientHeight: 60,
      rect: { top: 0, bottom: 75, left: 0, right: 200, width: 200, height: 75 },
    })
    root.appendChild(host)
    cleanup = installWheelToHorizontalScroll(window)

    const onBar = wheel(host, { deltaY: 100, clientX: 10, clientY: 70 })
    expect(host.scrollLeft).toBe(100)
    expect(onBar.defaultPrevented).toBe(true)

    host.scrollLeft = 0
    const onContent = wheel(host, { deltaY: 100, clientX: 10, clientY: 20 })
    expect(onContent.defaultPrevented).toBe(false)
    expect(host.scrollLeft).toBe(0)
  })

  it('removes the listener when disposed', () => {
    const { strip, child } = sidewaysStrip()
    const dispose = installWheelToHorizontalScroll(window)
    dispose()

    const e = wheel(child, { deltaY: 100 })

    expect(e.defaultPrevented).toBe(false)
    expect(strip.scrollLeft).toBe(0)
  })
})

describe('findSidewaysWheelTarget', () => {
  it('returns null for a non-wheel-able target without geometry', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    const e = new WheelEvent('wheel', { deltaY: 10 })
    expect(findSidewaysWheelTarget(e, div)).toBe(null)
    div.remove()
  })
})
