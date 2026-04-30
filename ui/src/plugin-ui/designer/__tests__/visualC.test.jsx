import { beforeEach, describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  KNOB_PRESETS,
  KNOB_PRESET_IDS,
} from '../../appearance/knobPresets.js'
import {
  getAppearanceOptionLabel,
  getAppearanceOptions,
  getRepairableEnumOptions,
  getRepairableTokenOptions,
  isAppearanceEnumKey,
  isAppearanceTokenKey,
} from '../../appearance/appearanceRegistry.js'
import {
  APPEARANCE_REMOVE_SENTINEL,
  buildPresetPatch,
  patchAppearance,
  removeAppearanceKey,
} from '../inspectors/inspectorHelpers.js'
import AppearanceFields, {
  getAppearanceErrorForKey,
  getAppearanceErrors,
  isAppearanceError,
} from '../inspectors/AppearanceFields.jsx'
import KnobInspector from '../inspectors/KnobInspector.jsx'
import { findNode } from '../layoutMutations.js'
import { usePluginUIDesignerStore } from '../usePluginUIDesignerStore.js'
import { patchSelectedProps } from '../designerActions.js'

describe('Visual-C registry helpers', () => {
  it('lists every knob preset id', () => {
    expect(KNOB_PRESET_IDS).toEqual([
      'xleth-default',
      'studio-ring',
      'flat-minimal',
      'encoder',
      'hardware-cap',
      'tiny-strip',
    ])
  })

  it('isAppearanceEnumKey recognizes closed enums', () => {
    expect(isAppearanceEnumKey('knob', 'cap')).toBe(true)
    expect(isAppearanceEnumKey('knob', 'ring')).toBe(true)
    expect(isAppearanceEnumKey('knob', 'preset')).toBe(true)
    expect(isAppearanceEnumKey('knob', 'accentToken')).toBe(false)
    expect(isAppearanceEnumKey('knob', 'unknownKey')).toBe(false)
  })

  it('isAppearanceTokenKey recognizes token slots', () => {
    expect(isAppearanceTokenKey('knob', 'accentToken')).toBe(true)
    expect(isAppearanceTokenKey('knob', 'surfaceToken')).toBe(true)
    expect(isAppearanceTokenKey('knob', 'textToken')).toBe(true)
    expect(isAppearanceTokenKey('knob', 'cap')).toBe(false)
  })

  it('getAppearanceOptions for accentToken includes accent.primary and accent.secondary', () => {
    const options = getAppearanceOptions('knob', 'accentToken').map(option => option.value)
    expect(options).toContain('accent.primary')
    expect(options).toContain('accent.secondary')
    expect(options).toContain('accent.focus')
  })

  it('getAppearanceOptions never includes raw CSS or hex values', () => {
    const tokenKeys = ['surfaceToken', 'accentToken', 'textToken']
    for (const key of tokenKeys) {
      const options = getAppearanceOptions('knob', key)
      for (const option of options) {
        expect(option.value).not.toMatch(/^#/)
        expect(option.value).not.toMatch(/^var\(/)
        expect(option.value).not.toMatch(/^rgb/)
        expect(option.value).not.toMatch(/^hsl/)
        expect(option.value).not.toMatch(/^--/)
      }
    }
  })

  it('getAppearanceOptions for enum keys returns closed allowed values', () => {
    const capOptions = getAppearanceOptions('knob', 'cap').map(option => option.value)
    expect(capOptions).toContain('default')
    expect(capOptions).toContain('hardware-cap')
    expect(capOptions).not.toContain('arbitrary-cap-name')
  })

  it('getAppearanceOptionLabel returns user-friendly labels for tokens', () => {
    expect(getAppearanceOptionLabel('knob', 'accentToken', 'accent.primary')).toBe('Accent Primary')
    expect(getAppearanceOptionLabel('knob', 'surfaceToken', 'surface.controlRaised')).toBe('Raised Control')
    expect(getAppearanceOptionLabel('knob', 'textToken', 'text.muted')).toBe('Muted Text')
  })

  it('getAppearanceOptionLabel returns preset labels for knob presets', () => {
    expect(getAppearanceOptionLabel('knob', 'preset', 'studio-ring')).toBe(KNOB_PRESETS['studio-ring'].label)
  })

  it('getRepairableTokenOptions surfaces unknown current token as disabled removed entry', () => {
    const options = getRepairableTokenOptions('knob', 'accentToken', 'accent.neonFuture')
    expect(options[0]).toMatchObject({
      value: 'accent.neonFuture',
      label: '(removed) accent.neonFuture',
      disabled: true,
      removed: true,
    })
    const validValues = options.slice(1).map(option => option.value)
    expect(validValues).toContain('accent.primary')
  })

  it('getRepairableTokenOptions does not add a removed entry when current value is valid', () => {
    const options = getRepairableTokenOptions('knob', 'accentToken', 'accent.primary')
    expect(options.every(option => !option.removed)).toBe(true)
  })

  it('getRepairableEnumOptions surfaces unknown current value as disabled removed entry', () => {
    const options = getRepairableEnumOptions('knob', 'cap', 'unknown-cap')
    expect(options[0]).toMatchObject({
      value: 'unknown-cap',
      disabled: true,
      removed: true,
    })
  })
})

describe('Visual-C appearance helpers', () => {
  it('patchAppearance preserves other keys', () => {
    const next = patchAppearance(
      { preset: 'studio-ring', cap: 'soft-disk' },
      { ring: 'metered-arc' },
    )
    expect(next).toEqual({ preset: 'studio-ring', cap: 'soft-disk', ring: 'metered-arc' })
  })

  it('patchAppearance removes a key when value is undefined', () => {
    const next = patchAppearance(
      { preset: 'studio-ring', cap: 'soft-disk' },
      { cap: undefined },
    )
    expect(next).toEqual({ preset: 'studio-ring' })
  })

  it('patchAppearance removes a key when value is the remove sentinel', () => {
    const next = patchAppearance(
      { preset: 'studio-ring', cap: 'soft-disk' },
      { cap: APPEARANCE_REMOVE_SENTINEL },
    )
    expect(next).toEqual({ preset: 'studio-ring' })
  })

  it('patchAppearance returns null when the appearance object becomes empty', () => {
    const next = patchAppearance(
      { preset: 'studio-ring' },
      { preset: undefined },
    )
    expect(next).toBeNull()
  })

  it('removeAppearanceKey removes the key', () => {
    const next = removeAppearanceKey({ preset: 'studio-ring', cap: 'soft-disk' }, 'cap')
    expect(next).toEqual({ preset: 'studio-ring' })
  })

  it('removeAppearanceKey returns null when last key is removed', () => {
    const next = removeAppearanceKey({ preset: 'studio-ring' }, 'preset')
    expect(next).toBeNull()
  })

  it('patchAppearance does not mutate the input object', () => {
    const input = { preset: 'studio-ring' }
    const frozen = Object.freeze({ ...input })
    expect(() => patchAppearance(frozen, { cap: 'soft-disk' })).not.toThrow()
  })
})

describe('Visual-C buildPresetPatch', () => {
  it('builds a preset-only patch by default', () => {
    expect(buildPresetPatch('studio-ring')).toEqual({ preset: 'studio-ring' })
  })

  it('builds a preset defaults patch when mode is apply-defaults', () => {
    const patch = buildPresetPatch('studio-ring', 'apply-defaults')
    expect(patch.preset).toBe('studio-ring')
    expect(patch.cap).toBe('soft-disk')
    expect(patch.surfaceToken).toBe('surface.controlRaised')
  })

  it('returns null for unknown preset id', () => {
    expect(buildPresetPatch('not-a-real-preset')).toBeNull()
    expect(buildPresetPatch('')).toBeNull()
    expect(buildPresetPatch(null)).toBeNull()
  })
})

describe('Visual-C AppearanceFields error helpers', () => {
  it('isAppearanceError recognizes appearance-related codes', () => {
    expect(isAppearanceError({ code: 'UNKNOWN_APPEARANCE_TOKEN' })).toBe(true)
    expect(isAppearanceError({ code: 'RAW_APPEARANCE_VALUE' })).toBe(true)
    expect(isAppearanceError({ code: 'PLUGIN_KNOB_COLOR_FORBIDDEN' })).toBe(true)
    expect(isAppearanceError({ code: 'UNKNOWN_PARAM' })).toBe(false)
    expect(isAppearanceError(null)).toBe(false)
  })

  it('getAppearanceErrors filters validation errors', () => {
    const errors = [
      { code: 'UNKNOWN_PARAM' },
      { code: 'UNKNOWN_APPEARANCE_TOKEN', key: 'accentToken' },
      { code: 'RAW_APPEARANCE_VALUE', key: 'surfaceToken' },
    ]
    expect(getAppearanceErrors(errors)).toHaveLength(2)
  })

  it('getAppearanceErrorForKey returns the matching key error', () => {
    const errors = [
      { code: 'UNKNOWN_APPEARANCE_TOKEN', key: 'accentToken' },
      { code: 'UNKNOWN_APPEARANCE_VALUE', key: 'cap' },
    ]
    expect(getAppearanceErrorForKey(errors, 'accentToken')?.code).toBe('UNKNOWN_APPEARANCE_TOKEN')
    expect(getAppearanceErrorForKey(errors, 'cap')?.code).toBe('UNKNOWN_APPEARANCE_VALUE')
    expect(getAppearanceErrorForKey(errors, 'ring')).toBeNull()
  })
})

describe('Visual-C AppearanceFields rendering', () => {
  it('renders preset cards for every knob preset', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring' }}
        onPatchAppearance={() => {}}
        onApplyPresetDefaults={() => {}}
      />,
    )

    for (const presetId of KNOB_PRESET_IDS) {
      expect(html).toContain(`data-preset="${presetId}"`)
    }
    expect(html).toContain('Apply preset defaults')
  })

  it('renders dropdowns for knob enum and token keys', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{}}
        onPatchAppearance={() => {}}
      />,
    )

    expect(html).toContain('Cap')
    expect(html).toContain('Ring')
    expect(html).toContain('Pointer')
    expect(html).toContain('Tick density')
    expect(html).toContain('Value readout')
    expect(html).toContain('Label placement')
    expect(html).toContain('Depth')
    expect(html).toContain('Surface')
    expect(html).toContain('Accent')
    expect(html).toContain('Text')
    expect(html).toContain('Accent Primary')
    expect(html).toContain('Raised Control')
  })

  it('shows removed marker for unknown current token', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ accentToken: 'accent.neonFuture' }}
        onPatchAppearance={() => {}}
      />,
    )

    expect(html).toContain('(removed) accent.neonFuture')
  })

  it('returns null for non-knob node types', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields nodeType="toggle" appearance={{}} onPatchAppearance={() => {}} />,
    )
    expect(html).toBe('')
  })

  it('shows knob color forbidden hint when error is present', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{}}
        onPatchAppearance={() => {}}
        validationErrors={[{ code: 'PLUGIN_KNOB_COLOR_FORBIDDEN', key: 'color' }]}
      />,
    )
    expect(html).toContain('props.color is forbidden')
  })

  it('does not render any color picker, hex input, or var() text', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{
          preset: 'studio-ring',
          accentToken: 'accent.primary',
          surfaceToken: 'surface.controlRaised',
          textToken: 'text.primary',
        }}
        onPatchAppearance={() => {}}
      />,
    )

    expect(html).not.toContain('type="color"')
    expect(html).not.toMatch(/var\(--/)
    expect(html).not.toMatch(/#[0-9a-fA-F]{6}\b/)
    expect(html).not.toMatch(/\brgb\(/)
    expect(html).not.toMatch(/\bhsl\(/)
  })
})

describe('Visual-C KnobInspector wiring', () => {
  beforeEach(async () => {
    usePluginUIDesignerStore.getState().reset()
    await usePluginUIDesignerStore.getState().loadInitial('compressor')
    usePluginUIDesignerStore.getState().setSelectedNodeId('k-threshold')
  })

  it('patchAppearance through patchSelectedProps sets props.appearance.preset without changing param', () => {
    const before = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold')
    const beforeParam = before.props.param

    patchSelectedProps({ appearance: { preset: 'studio-ring' } })

    const after = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold')
    expect(after.props.param).toBe(beforeParam)
    expect(after.props.appearance).toEqual({ preset: 'studio-ring' })
  })

  it('clearing all appearance keys removes props.appearance entirely', () => {
    patchSelectedProps({ appearance: { preset: 'studio-ring' } })
    expect(findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold').props.appearance).toEqual({ preset: 'studio-ring' })

    patchSelectedProps({ appearance: undefined })
    const after = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold')
    expect(after.props.appearance).toBeUndefined()
  })

  it('undo restores prior appearance state', () => {
    patchSelectedProps({ appearance: { preset: 'studio-ring' } })
    patchSelectedProps({ appearance: { preset: 'flat-minimal' } })

    usePluginUIDesignerStore.getState().undo()

    const after = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold')
    expect(after.props.appearance).toEqual({ preset: 'studio-ring' })
  })

  it('renders KnobInspector with appearance section', () => {
    const node = findNode(usePluginUIDesignerStore.getState().workingLayout, 'k-threshold')
    const html = renderToStaticMarkup(
      <KnobInspector
        node={node}
        manifest={usePluginUIDesignerStore.getState().manifest}
        onPatchProps={() => {}}
        validationErrors={[]}
      />,
    )
    expect(html).toContain('Appearance')
    expect(html).toContain('data-preset="studio-ring"')
  })
})
