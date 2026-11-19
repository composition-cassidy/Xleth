import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import TitleBarRegions, { REGION_TOGGLES, TOOL_PANELS, panelShortcut } from '../TitleBarRegions.jsx'
import { usePanelRegistry } from '../../windowing/registry/PanelRegistry'
import { DETAIL_DOCK_TAB_IDS } from '../../windowing/registry/panelCatalog'

beforeEach(() => usePanelRegistry.getState().resetLayout())

describe('top bar panel controls', () => {
  const html = renderToStaticMarkup(<TitleBarRegions />)

  it('keeps four region toggles and one Tools menu', () => {
    for (const name of ['Toggle Browser', 'Toggle Preview', 'Toggle Inspector', 'Toggle Detail dock']) {
      expect(html).toContain(`aria-label="${name}"`)
    }
    expect(html).toContain('>Tools<')
    expect(html.match(/<button/g)).toHaveLength(5)
  })

  it('no longer repeats what the detail dock tabs open', () => {
    for (const name of ['Piano Roll', 'Mixer', 'FX Graph', 'Sampler', 'Timeline']) {
      expect(html).not.toContain(`Toggle ${name}`)
    }
    expect(REGION_TOGGLES).not.toEqual(expect.arrayContaining(DETAIL_DOCK_TAB_IDS))
  })

  it('every control documents itself in the hint bar, shortcut included where one exists', () => {
    const buttons = html.match(/<button[^>]*>/g)
    for (const tag of buttons) expect(tag).toContain('data-hint="')
    expect(html).toContain('data-hint-mods="F6"')
    expect(html).toContain('data-hint-mods="F8"')
    expect(html).toContain('data-hint-mods="F10 opens the Sample Sandbox"')
  })

  it('puts the floating tools in the menu with their own F-keys unchanged', () => {
    expect(TOOL_PANELS).toEqual(['sampleSandbox', 'quickNotation', 'splitSyllables', 'colorGrade'])
    expect(panelShortcut('sampleSandbox')).toBe('F10')
    expect(panelShortcut('preview')).toBe('F8')
    expect(panelShortcut('inspector')).toBe('')
  })
})
