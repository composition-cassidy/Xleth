// @vitest-environment jsdom
//
// AutomationTarget makes a non-knob control (dropdown, switch, toggle) automatable
// from the right-click menu without adding a layout box, and stays inert when the
// device did not give it a parameter id.
import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import AutomationTarget from '../AutomationTarget.jsx'
import useEffectChainStore from '../../../stores/effectChainStore.js'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

let container, root

describe('AutomationTarget', () => {
  beforeEach(() => {
    useEffectChainStore.setState({ chains: { 3: [{ nodeId: 7, effectInstanceId: 'fx-7' }] } })
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => root.unmount()); container.remove() })

  const rightClick = (el) => act(() => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }))
  })
  const menuItem = () => Array.from(document.querySelectorAll('[role="menuitem"]'))
    .find((e) => e.textContent.trim() === 'Create automation clip')

  it('adds the Create automation clip menu to a wrapped control', () => {
    act(() => root.render(
      <AutomationTarget paramId="mode" target={{ trackId: 3, nodeId: 7 }}>
        <select aria-label="Mode"><option>A</option></select>
      </AutomationTarget>))
    const wrapper = container.querySelector('[data-automation-param="mode"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper.style.display).toBe('contents')
    rightClick(container.querySelector('select'))
    expect(menuItem()).toBeTruthy()
  })

  it('is inert without a parameter id', () => {
    act(() => root.render(
      <AutomationTarget paramId={undefined} target={{ trackId: 3, nodeId: 7 }}>
        <select aria-label="Mode"><option>A</option></select>
      </AutomationTarget>))
    rightClick(container.querySelector('select'))
    expect(menuItem()).toBeFalsy()
  })
})
