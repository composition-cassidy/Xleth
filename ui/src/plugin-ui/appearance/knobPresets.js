import { isKnownTokenId } from './tokenSlots.js'

export const KNOB_PRESETS = {
  'xleth-default': {
    label: 'Xleth Default',
    description: 'Current stock knob behavior expressed through closed appearance data.',
    defaults: {
      preset: 'xleth-default',
      sizePreset: 'inherit',
      cap: 'default',
      ring: 'default',
      pointer: 'default',
      ticks: 'none',
      tickDensity: 'normal',
      valueReadout: 'below',
      labelPlacement: 'bottom',
      depth: 'flat',
      surfaceToken: 'surface.control',
      accentToken: 'accent.primary',
      textToken: 'text.primary',
    },
    className: 'pluginui-knob--xleth-default',
  },
  'studio-ring': {
    label: 'Studio Ring',
    description: 'Clear value arc, restrained ticks, and a polished raised cap.',
    defaults: {
      preset: 'studio-ring',
      sizePreset: 'standard',
      cap: 'soft-disk',
      ring: 'metered-arc',
      pointer: 'line',
      ticks: 'major',
      tickDensity: 'normal',
      valueReadout: 'below',
      labelPlacement: 'bottom',
      depth: 'raised',
      surfaceToken: 'surface.controlRaised',
      accentToken: 'accent.primary',
      textToken: 'text.primary',
    },
    className: 'pluginui-knob--studio-ring',
  },
  'flat-minimal': {
    label: 'Flat Minimal',
    description: 'Quiet thin-line control for dense layouts and subtle surfaces.',
    defaults: {
      preset: 'flat-minimal',
      sizePreset: 'standard',
      cap: 'flat-disk',
      ring: 'thin-line',
      pointer: 'dot',
      ticks: 'none',
      tickDensity: 'sparse',
      valueReadout: 'tooltip',
      labelPlacement: 'bottom',
      depth: 'flat',
      surfaceToken: 'surface.control',
      accentToken: 'accent.secondary',
      textToken: 'text.muted',
    },
    className: 'pluginui-knob--flat-minimal',
  },
  encoder: {
    label: 'Encoder',
    description: 'Compact encoder-style cap with dense ticks and a notch indicator.',
    defaults: {
      preset: 'encoder',
      sizePreset: 'compact',
      cap: 'encoder-cap',
      ring: 'full-track',
      pointer: 'notch',
      ticks: 'minor',
      tickDensity: 'dense',
      valueReadout: 'tooltip',
      labelPlacement: 'bottom',
      depth: 'sunken',
      surfaceToken: 'surface.inset',
      accentToken: 'accent.focus',
      textToken: 'text.muted',
    },
    className: 'pluginui-knob--encoder',
  },
  'hardware-cap': {
    label: 'Hardware Cap',
    description: 'Tactile raised cap with visible needle and clear major ticks.',
    defaults: {
      preset: 'hardware-cap',
      sizePreset: 'large',
      cap: 'hardware-cap',
      ring: 'full-track',
      pointer: 'needle',
      ticks: 'major',
      tickDensity: 'sparse',
      valueReadout: 'below',
      labelPlacement: 'bottom',
      depth: 'raised',
      surfaceToken: 'surface.controlRaised',
      accentToken: 'accent.focus',
      textToken: 'text.primary',
    },
    className: 'pluginui-knob--hardware-cap',
  },
  'tiny-strip': {
    label: 'Tiny Strip',
    description: 'Space-saving strip knob defaults for crowded rows.',
    defaults: {
      preset: 'tiny-strip',
      sizePreset: 'compact',
      cap: 'flat-disk',
      ring: 'thin-line',
      pointer: 'dot',
      ticks: 'none',
      tickDensity: 'sparse',
      valueReadout: 'hidden',
      labelPlacement: 'top',
      depth: 'flat',
      surfaceToken: 'surface.control',
      accentToken: 'accent.primary',
      textToken: 'text.subtle',
    },
    className: 'pluginui-knob--tiny-strip',
  },
}

export const KNOB_PRESET_IDS = Object.freeze(Object.keys(KNOB_PRESETS))

export function getKnobPreset(presetId) {
  return typeof presetId === 'string' ? KNOB_PRESETS[presetId] || null : null
}

export function getDefaultKnobAppearance(presetId = 'xleth-default') {
  const preset = getKnobPreset(presetId) || KNOB_PRESETS['xleth-default']
  return { ...preset.defaults }
}

export function presetUsesOnlyKnownTokens(presetId) {
  const preset = getKnobPreset(presetId)
  if (!preset) return false

  return ['surfaceToken', 'accentToken', 'textToken'].every(key => isKnownTokenId(preset.defaults[key]))
}
