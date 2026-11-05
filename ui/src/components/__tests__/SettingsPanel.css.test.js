import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// ─── Settings panel CSS contract ────────────────────────────────────────────
//
// app.css styles the Settings panel TWICE: a base layer built on --theme-*
// tokens, and a later flat-skin layer built on --xleth-flat-* that re-skins it
// and wins by source order. A structural value set only in the base layer is
// silently dead whenever the flat layer restates the same property — which is
// exactly how a spacing change can appear to do nothing at all.
//
// These tests pin the consequences of that arrangement rather than specific
// pixel values: the flat layer must skin the controls the panel introduces,
// and the list/divider rules must keep the specificity that makes them apply.

function readAppCss() {
  return readFileSync(path.resolve(process.cwd(), 'src/styles/app.css'), 'utf8')
}

function ruleBodies(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*{([\\s\\S]*?)}`, 'g'))
  return [...matches].map(match => match[1])
}

describe('Settings panel CSS', () => {
  it('skins the scope switcher in the flat layer, not only the base layer', () => {
    const css = readAppCss()
    const tabs = ruleBodies(css, '.settings-panel-tabs')
    const tab = ruleBodies(css, '.settings-panel-tab')

    // Base + flat. Without the flat rule the segmented control keeps the base
    // layer's rounded corners and theme colors while every control around it
    // is square and flat.
    expect(tabs.length).toBeGreaterThanOrEqual(2)
    expect(tab.length).toBeGreaterThanOrEqual(2)
    expect(tabs.some(body => /--xleth-flat-/.test(body))).toBe(true)
    expect(tab.some(body => /border-radius:\s*0\s*;/.test(body))).toBe(true)
  })

  it('skins the shortcut key cap in the flat layer', () => {
    const css = readAppCss()
    const key = ruleBodies(css, '.settings-panel-shortcut-key')

    expect(key.length).toBeGreaterThanOrEqual(2)
    expect(key.some(body => /--xleth-flat-/.test(body))).toBe(true)
  })

  it('draws row dividers only between consecutive rows', () => {
    const css = readAppCss()
    const between = ruleBodies(
      css,
      '.settings-panel-section > .settings-panel-row + .settings-panel-row'
    )

    expect(between.length).toBeGreaterThanOrEqual(1)
    expect(between.some(body => /border-top:/.test(body))).toBe(true)

    // A divider on the bare row selector would also draw above the first row,
    // directly under the section title.
    const bareRow = ruleBodies(css, '.settings-panel-section > .settings-panel-row')
    expect(bareRow.every(body => !/border-top:/.test(body))).toBe(true)
  })

  it('keeps the list variant specific enough to beat the generic row rule', () => {
    const css = readAppCss()

    // Both are (0,3,0); the list rule only wins because it comes later. If it
    // were ever written as `.settings-panel-section--list > .settings-panel-row`
    // alone it would lose, and the shortcut list would silently go back to the
    // roomy standalone-setting spacing.
    const generic = css.indexOf('.settings-panel-section > .settings-panel-row + .settings-panel-row')
    const list = css.lastIndexOf(
      '.settings-panel-section--list > .settings-panel-row + .settings-panel-row'
    )

    expect(generic).toBeGreaterThan(-1)
    expect(list).toBeGreaterThan(generic)
  })
})
