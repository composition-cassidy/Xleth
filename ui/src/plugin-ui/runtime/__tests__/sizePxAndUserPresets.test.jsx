import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  getAppearanceNumberRange,
  isAppearanceNumberKey,
  validateAppearanceValue,
} from '../../appearance/appearanceRegistry.js'
import {
  buildPluginKnobRenderModel,
  resolveEffectiveKnobSize,
} from '../components/PluginUIKitKnob.jsx'
import { useUserKnobPresetsStore } from '../../appearance/useUserKnobPresetsStore.js'
import AppearanceFields from '../../designer/inspectors/AppearanceFields.jsx'

describe('sizePx schema', () => {
  it('isAppearanceNumberKey identifies sizePx as a number key', () => {
    expect(isAppearanceNumberKey('knob', 'sizePx')).toBe(true)
    expect(isAppearanceNumberKey('knob', 'sizePreset')).toBe(false)
    expect(isAppearanceNumberKey('knob', 'cap')).toBe(false)
    expect(isAppearanceNumberKey('knob', 'accentToken')).toBe(false)
  })

  it('getAppearanceNumberRange returns the configured range', () => {
    const range = getAppearanceNumberRange('knob', 'sizePx')
    expect(range).toMatchObject({ min: 24, max: 128, integer: true })
  })

  it('validateAppearanceValue accepts integers in range', () => {
    expect(validateAppearanceValue('knob', 'sizePx', 24).ok).toBe(true)
    expect(validateAppearanceValue('knob', 'sizePx', 64).ok).toBe(true)
    expect(validateAppearanceValue('knob', 'sizePx', 128).ok).toBe(true)
  })

  it('validateAppearanceValue rejects out-of-range, non-integer, and non-number values', () => {
    expect(validateAppearanceValue('knob', 'sizePx', 23).ok).toBe(false)
    expect(validateAppearanceValue('knob', 'sizePx', 129).ok).toBe(false)
    expect(validateAppearanceValue('knob', 'sizePx', 50.5).ok).toBe(false)
    expect(validateAppearanceValue('knob', 'sizePx', '50').ok).toBe(false)
    expect(validateAppearanceValue('knob', 'sizePx', NaN).ok).toBe(false)
    const result = validateAppearanceValue('knob', 'sizePx', 200)
    expect(result.code).toBe('BAD_APPEARANCE_NUMBER')
  })
})

describe('resolveEffectiveKnobSize', () => {
  it('sizePx overrides sizePreset and baseSizeProp when valid', () => {
    expect(resolveEffectiveKnobSize({ sizePx: 80, sizePreset: 'compact' }, 52)).toBe(80)
    expect(resolveEffectiveKnobSize({ sizePx: 96 }, 40)).toBe(96)
  })

  it('falls back to sizePreset map when sizePx is invalid', () => {
    expect(resolveEffectiveKnobSize({ sizePx: 0, sizePreset: 'large' }, 52)).toBe(64)
    expect(resolveEffectiveKnobSize({ sizePx: '50', sizePreset: 'compact' }, 52)).toBe(40)
  })

  it('falls back to baseSizeProp for inherit + missing sizePx', () => {
    expect(resolveEffectiveKnobSize({ sizePreset: 'inherit' }, 60)).toBe(60)
    expect(resolveEffectiveKnobSize({}, 48)).toBe(48)
  })

  it('rounds non-integer sizePx values', () => {
    expect(resolveEffectiveKnobSize({ sizePx: 50.7 }, 52)).toBe(51)
  })
})

describe('buildPluginKnobRenderModel with sizePx', () => {
  it('returns sizePx as effectiveSize when set', () => {
    const model = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePx: 90 }, 52)
    expect(model.effectiveSize).toBe(90)
  })

  it('ignores invalid sizePx and uses sizePreset', () => {
    const model = buildPluginKnobRenderModel({ preset: 'studio-ring', sizePx: 999 }, 52)
    expect(model.effectiveSize).toBe(52)
  })
})

describe('AppearanceFields renders sizePx input', () => {
  it('renders a number input for sizePx', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring', sizePx: 80 }}
        onPatchAppearance={() => {}}
      />,
    )

    expect(html).toContain('Custom size (px)')
    expect(html).toContain('type="number"')
    expect(html).toContain('value="80"')
  })

  it('renders empty number input when sizePx is unset', () => {
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring' }}
        onPatchAppearance={() => {}}
      />,
    )

    expect(html).toContain('Custom size (px)')
    expect(html).toContain('placeholder="(preset default)"')
  })
})

describe('useUserKnobPresetsStore', () => {
  let listSpy
  let saveSpy
  let deleteSpy

  beforeEach(() => {
    useUserKnobPresetsStore.getState().reset()
    listSpy = vi.fn(async () => [])
    saveSpy = vi.fn(async (preset) => [preset])
    deleteSpy = vi.fn(async () => [])

    globalThis.window = globalThis.window || globalThis
    globalThis.window.xleth = {
      pluginUi: {
        listKnobPresets: listSpy,
        saveKnobPreset: saveSpy,
        deleteKnobPreset: deleteSpy,
      },
    }
  })

  afterEach(() => {
    if (globalThis.window) delete globalThis.window.xleth
  })

  it('load() populates presets from IPC', async () => {
    listSpy.mockResolvedValueOnce([
      { id: 'user-warm', label: 'Warm Knob', appearance: { preset: 'studio-ring' } },
    ])

    const list = await useUserKnobPresetsStore.getState().load()

    expect(listSpy).toHaveBeenCalled()
    expect(list).toHaveLength(1)
    expect(useUserKnobPresetsStore.getState().presets[0].label).toBe('Warm Knob')
    expect(useUserKnobPresetsStore.getState().isLoaded).toBe(true)
  })

  it('load() handles missing IPC by returning empty list', async () => {
    delete window.xleth
    const list = await useUserKnobPresetsStore.getState().load()
    expect(list).toEqual([])
    expect(useUserKnobPresetsStore.getState().isLoaded).toBe(true)
  })

  it('saveCurrent() rejects empty labels', async () => {
    const result = await useUserKnobPresetsStore.getState().saveCurrent({
      label: '   ',
      appearance: { preset: 'studio-ring' },
    })
    expect(result.ok).toBe(false)
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it('saveCurrent() snapshots the appearance and calls IPC with normalized record', async () => {
    saveSpy.mockResolvedValueOnce([
      { id: 'user-my-preset', label: 'My Preset', appearance: { preset: 'studio-ring' } },
    ])

    const result = await useUserKnobPresetsStore.getState().saveCurrent({
      label: 'My Preset',
      description: 'A nice tone',
      appearance: { preset: 'studio-ring', cap: 'soft-disk' },
    })

    expect(result.ok).toBe(true)
    expect(saveSpy).toHaveBeenCalledTimes(1)
    const arg = saveSpy.mock.calls[0][0]
    expect(arg.id).toMatch(/^user-/)
    expect(arg.label).toBe('My Preset')
    expect(arg.appearance.preset).toBe('studio-ring')
  })

  it('saveCurrent() generates unique ids when slugs collide', async () => {
    useUserKnobPresetsStore.setState({
      presets: [{ id: 'user-warm', label: 'Warm', appearance: { preset: 'studio-ring' } }],
      isLoaded: true,
    })
    saveSpy.mockImplementation(async (preset) => [...useUserKnobPresetsStore.getState().presets, preset])

    await useUserKnobPresetsStore.getState().saveCurrent({
      label: 'Warm',
      appearance: { preset: 'studio-ring' },
    })

    const arg = saveSpy.mock.calls[0][0]
    expect(arg.id).not.toBe('user-warm')
    expect(arg.id).toMatch(/^user-warm-\d+$/)
  })

  it('remove() calls IPC delete', async () => {
    deleteSpy.mockResolvedValueOnce([])
    const result = await useUserKnobPresetsStore.getState().remove('user-warm')
    expect(result.ok).toBe(true)
    expect(deleteSpy).toHaveBeenCalledWith('user-warm')
  })

  it('remove() rejects ids that do not match the safe pattern', async () => {
    const result = await useUserKnobPresetsStore.getState().remove('../etc/passwd')
    expect(result.ok).toBe(false)
    expect(deleteSpy).not.toHaveBeenCalled()
  })
})

describe('AppearanceFields user presets section', () => {
  beforeEach(() => {
    useUserKnobPresetsStore.getState().reset()
  })

  it('renders empty state when there are no user presets', () => {
    useUserKnobPresetsStore.setState({ presets: [], isLoaded: true })
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring' }}
        onPatchAppearance={() => {}}
        onApplyPresetDefaults={() => {}}
        onReplaceAppearance={() => {}}
      />,
    )
    expect(html).toContain('Your presets')
    expect(html).toContain('No saved presets yet')
    expect(html).toContain('Save current as preset')
  })

  it('renders saved user presets as cards', () => {
    useUserKnobPresetsStore.setState({
      presets: [
        { id: 'user-warm', label: 'Warm Studio', description: 'My go-to', appearance: { preset: 'studio-ring' } },
        { id: 'user-flat', label: 'Flat Tiny', appearance: { preset: 'flat-minimal' } },
      ],
      isLoaded: true,
    })

    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring' }}
        onPatchAppearance={() => {}}
        onApplyPresetDefaults={() => {}}
        onReplaceAppearance={() => {}}
      />,
    )

    expect(html).toContain('Warm Studio')
    expect(html).toContain('My go-to')
    expect(html).toContain('Flat Tiny')
    expect(html).toContain('data-user-preset-id="user-warm"')
    expect(html).toContain('data-user-preset-id="user-flat"')
  })

  it('hides the user presets section when onReplaceAppearance is not provided', () => {
    useUserKnobPresetsStore.setState({
      presets: [{ id: 'user-warm', label: 'Warm', appearance: { preset: 'studio-ring' } }],
      isLoaded: true,
    })
    const html = renderToStaticMarkup(
      <AppearanceFields
        nodeType="knob"
        appearance={{ preset: 'studio-ring' }}
        onPatchAppearance={() => {}}
      />,
    )
    expect(html).not.toContain('Your presets')
    expect(html).not.toContain('data-user-preset-id="user-warm"')
  })
})
