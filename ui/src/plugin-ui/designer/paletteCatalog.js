import { COMPONENT_REGISTRY } from '../runtime/registry.js'

export const DESIGNER_VISIBLE_TYPES = new Set([
  'group',
  'row',
  'column',
  'knob',
  'toggle',
  'meter',
  'visualizer',
  'label',
  'spacer',
  // Freeform-B:
  'freeformLayer',
  'decorText',
  'decorLine',
  'decorShape',
  'decal',
])

const CATALOG_DEFINITIONS = [
  {
    type: 'group',
    label: 'Group',
    template: { type: 'group', children: [] },
  },
  {
    type: 'row',
    label: 'Row',
    template: { type: 'row', children: [] },
  },
  {
    type: 'column',
    label: 'Column',
    template: { type: 'column', children: [] },
  },
  {
    type: 'knob',
    label: 'Knob',
    template: {
      type: 'knob',
      props: { param: '<unset>', label: 'Knob', size: 52, format: 'raw' },
    },
  },
  {
    type: 'toggle',
    label: 'Toggle',
    template: {
      type: 'toggle',
      props: { param: '<unset>', mode: 'discreteValue', valueWhenOn: 1, label: 'Toggle' },
    },
  },
  {
    type: 'meter',
    label: 'Meter',
    template: {
      type: 'meter',
      style: { widthPx: 32 },
      props: {
        source: { kind: 'effectMeter', slot: 'GAIN_REDUCTION' },
        label: 'Meter',
        unit: 'dB',
        range: { min: 0, max: 40, scale: 'linear' },
        orientation: 'vertical',
        format: 'dB1',
      },
    },
  },
  {
    type: 'visualizer',
    label: 'Visualizer',
    template: {
      type: 'visualizer',
      props: {
        source: 'compressor.combined',
        preset: 'compressorCombined',
        heightPx: 110,
      },
    },
  },
  {
    type: 'label',
    label: 'Label',
    template: {
      type: 'label',
      props: { text: 'Label' },
    },
  },
  {
    type: 'spacer',
    label: 'Spacer',
    template: {
      type: 'spacer',
      style: { heightPx: 12 },
    },
  },
  // ── Freeform-B ───────────────────────────────────────────────────────────────
  {
    type: 'freeformLayer',
    label: 'Freeform Layer',
    template: {
      type: 'freeformLayer',
      style: { widthPx: 480, heightPx: 160 },
      props: { snap: { gridPx: 8, enabled: true }, background: 'transparent', clip: 'panel' },
      children: [],
    },
  },
  {
    type: 'decorText',
    label: 'Text',
    template: {
      type: 'decorText',
      props: {
        frame:         { x: 16, y: 16, widthPx: 120, heightPx: 18 },
        text:          'Text',
        variant:       'default',
        align:         'left',
        letterSpacing: 'normal',
        textToken:     'text.primary',
      },
    },
  },
  {
    type: 'decorLine',
    label: 'Line',
    template: {
      type: 'decorLine',
      props: {
        frame:       { x: 16, y: 16, widthPx: 120, heightPx: 1 },
        orientation: 'horizontal',
        thickness:   'hair',
        lineStyle:   'solid',
        strokeToken: 'text.subtle',
      },
    },
  },
  {
    type: 'decorShape',
    label: 'Shape',
    template: {
      type: 'decorShape',
      props: {
        frame:       { x: 16, y: 16, widthPx: 64, heightPx: 64 },
        shape:       'roundedRect',
        cornerRadius: 4,
        fillToken:   'surface.controlRaised',
        strokeToken: 'stroke.none',
        strokeWidth: 0,
        opacity:     100,
      },
    },
  },
  {
    type: 'decal',
    label: 'Decal',
    template: {
      type: 'decal',
      props: {
        frame:   { x: 16, y: 16, widthPx: 64, heightPx: 64 },
        assetId: 'builtin.placeholder.missing',
        fit:     'contain',
        opacity: 100,
      },
    },
  },
]

export const PALETTE_ENTRIES = CATALOG_DEFINITIONS
  .filter(entry => DESIGNER_VISIBLE_TYPES.has(entry.type))
  .filter(entry => Object.prototype.hasOwnProperty.call(COMPONENT_REGISTRY, entry.type))

export function getPaletteEntry(type) {
  return PALETTE_ENTRIES.find(entry => entry.type === type) || null
}
