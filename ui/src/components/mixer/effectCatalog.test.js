import { describe, expect, it } from 'vitest'
import {
  EFFECT_CATEGORIES,
  NO_SCANNED_PLUGINS_LABEL,
  VST_GROUP_LABEL,
  buildEffectPickerGroups,
  countEffectPickerOptions,
  filterEffectPickerGroups,
  formatVstPluginLabel,
  sortRackVstPlugins,
} from './effectCatalog.js'

// The catalog is the single source of truth shared by the Mixer Chain
// (EffectChainPanel) and the FX Graph picker (FxGraphEffectPicker). These tests
// pin the shared shape so the two add flows can never silently diverge.

function stockPluginIds() {
  return EFFECT_CATEGORIES.flatMap((category) => category.submenu.map((effect) => effect.id))
}

describe('effectCatalog shared add-effect source', () => {
  it('exposes the same stock effect ids the Mixer Chain offers', () => {
    // Spot-check the well-known stock effects so a regression that drops one is caught.
    expect(stockPluginIds()).toEqual(
      expect.arrayContaining([
        'compressor', 'limiter', 'overdone', 'transientproc', 'resonancesuppressor',
        'xletheq', 'xlethfilter', 'distortion', 'waveshaper',
        'uniflange', 'chorus', 'flanger', 'phaser', 'phanjer',
        'delay', 'reverb', 'smartbalance',
      ]),
    )
  })

  it('builds one group per stock category plus a VST group, in order', () => {
    const groups = buildEffectPickerGroups({ vstPlugins: [] })

    expect(groups.map((group) => group.label)).toEqual([
      ...EFFECT_CATEGORIES.map((category) => category.label),
      VST_GROUP_LABEL,
    ])
    expect(groups.every((group) => group.kind === 'stock' || group.kind === 'vst')).toBe(true)
  })

  it('carries pluginId + displayName on every stock option', () => {
    const groups = buildEffectPickerGroups({ vstPlugins: [] })
    const dynamics = groups.find((group) => group.label === 'Dynamics')

    const compressor = dynamics.options.find((option) => option.pluginId === 'compressor')
    expect(compressor).toEqual({
      pluginId: 'compressor',
      label: 'Compressor',
      displayName: 'Compressor',
      kind: 'stock',
    })

    // displayName is always present so a created graph node has a readable label.
    const everyStockOption = groups
      .filter((group) => group.kind === 'stock')
      .flatMap((group) => group.options)
    expect(everyStockOption.every((option) => option.pluginId && option.displayName)).toBe(true)
  })

  it('sources scanned VST entries from the same sorted plugin list as the Mixer Chain', () => {
    const vstPlugins = [
      { id: 'vst-zeta', name: 'Zeta Reverb', vendor: 'Acme' },
      { id: 'vst-alpha', name: 'Alpha Comp', vendor: 'Widgets' },
    ]
    const groups = buildEffectPickerGroups({ vstPlugins })
    const vstGroup = groups.find((group) => group.label === VST_GROUP_LABEL)

    // Same ordering helper the Mixer Chain submenu uses (name, then vendor).
    const sorted = sortRackVstPlugins(vstPlugins)
    expect(vstGroup.options.map((option) => option.pluginId)).toEqual(sorted.map((p) => p.id))

    const alpha = vstGroup.options.find((option) => option.pluginId === 'vst-alpha')
    expect(alpha).toEqual({
      pluginId: 'vst-alpha',
      label: 'Alpha Comp - Widgets',
      displayName: 'Alpha Comp',
      kind: 'vst',
    })
    expect(formatVstPluginLabel(vstPlugins[1])).toBe('Alpha Comp - Widgets')
  })

  it('marks the VST group empty (not absent) when nothing is scanned', () => {
    const groups = buildEffectPickerGroups({ vstPlugins: [] })
    const vstGroup = groups.find((group) => group.label === VST_GROUP_LABEL)

    expect(vstGroup.options).toEqual([])
    expect(vstGroup.emptyLabel).toBe(NO_SCANNED_PLUGINS_LABEL)
  })

  it('filters options by label case-insensitively and drops emptied groups', () => {
    const groups = buildEffectPickerGroups({
      vstPlugins: [{ id: 'vst-1', name: 'Reverberator', vendor: 'X' }],
    })
    const filtered = filterEffectPickerGroups(groups, 'REVERB')

    // "Reverb" (stock, Time) and "Reverberator" (VST) survive; everything else drops.
    const labels = filtered.flatMap((group) => group.options.map((option) => option.label))
    expect(labels).toContain('Reverb')
    expect(labels).toContain('Reverberator - X')
    expect(filtered.every((group) => group.options.length > 0)).toBe(true)
    expect(countEffectPickerOptions(filtered)).toBe(2)
  })

  it('returns the full catalog when the query is blank', () => {
    const groups = buildEffectPickerGroups({ vstPlugins: [] })
    expect(filterEffectPickerGroups(groups, '   ')).toBe(groups)
  })
})
