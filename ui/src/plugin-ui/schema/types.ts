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

// Appearance is closed declarative presentation data. Layout JSON stores
// symbolic token ids, never raw colors, CSS variables, classes, or styles.

export type SurfaceTokenId =
  | 'surface.panel'
  | 'surface.control'
  | 'surface.controlRaised'
  | 'surface.inset'

export type TextTokenId =
  | 'text.primary'
  | 'text.muted'
  | 'text.subtle'

export type AccentTokenId =
  | 'accent.primary'
  | 'accent.secondary'
  | 'accent.focus'

export type MeterTokenId =
  | 'meter.good'
  | 'meter.warn'
  | 'meter.danger'
  | 'meter.gr'

export type TokenSlotId = SurfaceTokenId | TextTokenId | AccentTokenId | MeterTokenId

export type KnobPresetId =
  | 'xleth-default'
  | 'studio-ring'
  | 'flat-minimal'
  | 'encoder'
  | 'hardware-cap'
  | 'tiny-strip'

export interface Appearance {
  preset?: string
}

export interface KnobAppearance extends Appearance {
  preset?: KnobPresetId
  sizePreset?: 'inherit' | 'compact' | 'standard' | 'large'
  cap?: 'default' | 'flat-disk' | 'soft-disk' | 'hardware-cap' | 'encoder-cap'
  ring?: 'default' | 'none' | 'metered-arc' | 'full-track' | 'split-track' | 'thin-line'
  pointer?: 'default' | 'line' | 'needle' | 'dot' | 'notch' | 'none'
  ticks?: 'none' | 'major' | 'minor' | 'numbered'
  tickDensity?: 'sparse' | 'normal' | 'dense'
  valueReadout?: 'below' | 'center' | 'tooltip' | 'hidden'
  labelPlacement?: 'bottom' | 'top' | 'left' | 'hidden'
  depth?: 'flat' | 'raised' | 'sunken'
  surfaceToken?: SurfaceTokenId
  accentToken?: AccentTokenId
  textToken?: TextTokenId
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
  appearance?: KnobAppearance
  color?:     never    // invalid in plugin UI layout JSON; validator blocks props.color
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

// ── Freeform frame ────────────────────────────────────────────────────────────
// Required on every direct child of a freeformLayer; forbidden elsewhere.

export interface NodeFrame {
  x:            number   // integer, -2000..4000
  y:            number   // integer, -2000..4000
  widthPx:      number   // integer, 1..4096
  heightPx:     number   // integer, 1..4096
  rotationDeg?: number   // integer, -360..360; only on decor* and decal
  zIndex?:      number   // integer, 0..999
  locked?:      boolean  // Designer only; runtime ignores
}

// ── Freeform layer ────────────────────────────────────────────────────────────

export interface FreeformLayerSnap {
  gridPx?:   1 | 2 | 4 | 8 | 16
  enabled?:  boolean
}

export interface FreeformLayerProps {
  snap?:       FreeformLayerSnap
  background?: 'transparent' | 'panel' | 'inset'
  clip?:       'panel' | 'visible'
}

// ── Decoration node props ─────────────────────────────────────────────────────
// All use props.frame (required when inside a freeformLayer).
// No raw colors, no raw CSS strings, no URLs, no filesystem paths.

export type DecorTextVariant     = 'default' | 'muted' | 'header' | 'caption' | 'value'
export type DecorTextAlign       = 'left' | 'center' | 'right'
export type DecorLetterSpacing   = 'tight' | 'normal' | 'wide' | 'wider'

export interface DecorTextProps {
  frame:          NodeFrame
  text:           string            // plain text, ≤ 80 chars, no HTML
  variant?:       DecorTextVariant
  textToken?:     TextTokenId
  align?:         DecorTextAlign
  letterSpacing?: DecorLetterSpacing
}

export type DecorLineOrientation = 'horizontal' | 'vertical'
export type DecorLineThickness   = 'hair' | 'thin' | 'medium' | 'thick'
export type DecorLineStyle       = 'solid' | 'dashed' | 'dotted'

export interface DecorLineProps {
  frame:         NodeFrame
  orientation:   DecorLineOrientation
  thickness?:    DecorLineThickness
  strokeToken?:  AccentTokenId | TextTokenId | MeterTokenId | 'stroke.none'
  lineStyle?:    DecorLineStyle
}

export type DecorShape         = 'rect' | 'roundedRect' | 'circle' | 'pill'
export type DecorCornerRadius  = 0 | 2 | 4 | 8 | 12 | 16
export type DecorStrokeWidth   = 0 | 1 | 2 | 3 | 4
export type DecorOpacity       = 25 | 50 | 75 | 100

export interface DecorShapeProps {
  frame:        NodeFrame
  shape:        DecorShape
  cornerRadius?: DecorCornerRadius
  fillToken?:   SurfaceTokenId | AccentTokenId | 'fill.none'
  strokeToken?: AccentTokenId | TextTokenId | 'stroke.none'
  strokeWidth?: DecorStrokeWidth
  opacity?:     DecorOpacity
}

export type DecalFit = 'contain' | 'cover' | 'stretch'

export interface DecalProps {
  frame:      NodeFrame
  assetId:    string   // "builtin.*" or "user.imported.*" only
  fit?:       DecalFit
  opacity?:   DecorOpacity
  tintToken?: AccentTokenId | TextTokenId | 'tint.none'
}

// ── Component types ───────────────────────────────────────────────────────────

export type ContainerType = 'panel' | 'group' | 'row' | 'column' | 'tabGroup' | 'freeformLayer'
export type DecorLeafType = 'decorText' | 'decorLine' | 'decorShape' | 'decal'
export type LeafType      = 'knob' | 'toggle' | 'button' | 'meter' | 'visualizer' | 'label' | 'spacer' | DecorLeafType
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
