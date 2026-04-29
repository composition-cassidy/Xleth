// TypeScript types for the Xleth stock plugin UI layout schema.
// These are documentation + compile-time aids only; no runtime code here.
// Schema version: 1

// ── Style ────────────────────────────────────────────────────────────────────

export type PaddingValue = number | [number, number, number, number]

export type StyleAlign  = 'start' | 'center' | 'end' | 'stretch'
export type StyleJustify = 'start' | 'center' | 'end' | 'spaceBetween' | 'spaceAround'

export interface NodeStyle {
  paddingPx?:   PaddingValue
  gapPx?:       number
  widthPx?:     number
  heightPx?:    number
  growsToFill?: boolean
  align?:       StyleAlign
  justify?:     StyleJustify
  flexBasis?:   number
}

// ── Meter source ─────────────────────────────────────────────────────────────

export interface EffectMeterSource {
  kind: 'effectMeter'
  slot: string   // semantic key from meterSlots.js (e.g. 'GAIN_REDUCTION')
}

export type MeterSource = EffectMeterSource

export interface MeterRange {
  min:   number
  max:   number
  scale?: 'linear' | 'log'
}

// ── Component prop shapes ─────────────────────────────────────────────────────

export interface PanelProps  {}
export interface GroupProps  { title?: string | null; columns?: number }
export interface RowProps    { variant?: 'borderTop' | 'borderBottom' }
export interface ColumnProps { variant?: string }
export interface TabGroupProps {}   // each child declares props.tabLabel

export interface KnobProps {
  param:      string   // engine parameter id
  label?:     string
  size?:      number
  dragRange?: number
  format?:    string   // key in formats registry
  color?:     string   // CSS color override for the value arc
}

export interface ToggleProps {
  param:        string
  mode:         'boolParam' | 'discreteValue'
  valueWhenOn?: number   // required for discreteValue mode
  label:        string
}

export interface ButtonProps {
  action: string   // key in actions registry
  label:  string
}

export interface MeterProps {
  source:       MeterSource
  label?:       string
  unit?:        string
  range:        MeterRange
  orientation?: 'vertical' | 'horizontal'
  format?:      string
}

export interface VisualizerProps {
  source:    string   // visualization source key, e.g. 'compressor.gainReductionHistory'
  preset:    string   // painter preset name
  heightPx?: number
}

export interface LabelProps {
  text:     string
  variant?: 'default' | 'muted' | 'header'
}

export interface SpacerProps {}

// ── Component types ───────────────────────────────────────────────────────────

export type ContainerType = 'panel' | 'group' | 'row' | 'column' | 'tabGroup'
export type LeafType      = 'knob' | 'toggle' | 'button' | 'meter' | 'visualizer' | 'label' | 'spacer'
export type NodeType      = ContainerType | LeafType

// ── Node ─────────────────────────────────────────────────────────────────────

export interface LayoutNode {
  id:        string
  type:      NodeType
  style?:    NodeStyle
  props?:    Record<string, unknown>
  children?: LayoutNode[]
  // Injected by validator on soft failures — not in source JSON
  _invalid?: boolean
}

// ── Top-level document ────────────────────────────────────────────────────────

export interface PanelSize {
  width:  number
  height: number
}

export interface PluginUILayout {
  $xleth?:       string   // discriminator: 'plugin-ui-layout' (present on disk exports)
  schemaVersion: number   // must be 1
  pluginId:      string
  name?:         string
  panel?: {
    preferredSize?: PanelSize
    minSize?:       PanelSize
  }
  root: LayoutNode        // must be type 'panel'
}

// ── Validation result ─────────────────────────────────────────────────────────

export interface ValidationError {
  nodeId?:  string
  code:     string
  message:  string
}

export type ValidationResult =
  | { ok: true;  doc: PluginUILayout; errors: ValidationError[] }
  | { ok: false; errors: ValidationError[] }
