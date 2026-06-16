// Full token catalog — enumerates every themeable token, its category, its
// gradient capability (per spec §3.5), and its derivation rule (base /
// formula / var-reference / explicit default).
//
// Per Clarification #2 (user, 2026-04-19): every §3.4 subsystem appears in
// this catalog even when the Track A audit found zero raw-literal hits,
// because Advanced mode MUST be able to detach and customize every
// subsystem's chrome independently of the base tokens.
//
// Per Clarification #3 (user, 2026-04-19): the sample category-label colors
// (kick / snare / hihat / crash / pitch / quote / custom / perc) are hoisted
// to their own top-level "Labels" subsystem — they cross-cut sample-selector,
// timeline, pattern-list, and grid-editor, and are not chrome of any single
// subsystem.
//
// Token naming convention: --theme-<subsystem>-<element>[-<state>]
// Foundational tokens (base, derived, semantic, text, borders) use shorter
// names that omit the subsystem segment: --theme-bg-primary, --theme-text-muted.

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type GradientCapability = 'any' | 'linear' | 'solid';
export type TokenKind = 'color' | 'dimension' | 'duration' | 'opacity' | 'shadow';

export type DerivationRule =
  | { type: 'base' }
  | { type: 'derived-formula' }            // deriveTheme() computes it
  | { type: 'derived-var'; ref: string }   // default value is var(--ref)
  | { type: 'explicit'; value: string };   // hardcoded CSS value

export interface TokenDef {
  name: string;
  kind: TokenKind;
  capability: GradientCapability;
  category: string;   // top-level Advanced-tree section
  subsystem: string;  // spec §3.3/§3.4 slug
  derivation: DerivationRule;
  description?: string;
  // When true, the v2 enrichment classifier bypasses Gate 3 (subsystem scope)
  // for this token — it can match values in any subsystem. Used for
  // cross-cutting shared primitives whose subsystem (e.g. waveform-shared,
  // stock-effects.shared) is narrower than the set of subsystems that
  // legitimately consume the value. Gate 3 acceptance via this flag is
  // recorded as `gatesPassed: [..., 'subsystem:crossSubsystem']` in v2 output.
  crossSubsystem?: true;
}

export interface SubsystemMeta {
  key: string;
  section: string;            // spec §3.3/§3.4.x
  displayName: string;
  category: string;
  plannedDeferred?: boolean;  // filter — has no built UI yet, per spec §3.4.10 note
  aliases?: string[];         // alternate slugs the audit tool may emit for this subsystem
}

// ──────────────────────────────────────────────────────────────────────────
// Subsystem catalog — feeds the Advanced-mode tree order in spec §5.4
// ──────────────────────────────────────────────────────────────────────────

export const CATEGORIES = [
  'Foundations',
  'Window system',
  'Global UI',
  'Workspace panels',
  'Stock effects',
  'Specialized editors',
  'Labels',
] as const;
export type CategoryName = (typeof CATEGORIES)[number];

export const SUBSYSTEMS: ReadonlyArray<SubsystemMeta> = [
  // Foundations
  { key: 'base',       section: '3.1', displayName: 'Base (5)',     category: 'Foundations' },
  { key: 'derived',    section: '3.2', displayName: 'Derived',      category: 'Foundations' },
  { key: 'semantic',   section: '3.2', displayName: 'Semantic',     category: 'Foundations' },
  { key: 'text',       section: '3.2', displayName: 'Text',         category: 'Foundations' },
  { key: 'borders',    section: '3.2', displayName: 'Borders',      category: 'Foundations' },
  { key: 'depth',      section: '3.2', displayName: 'Depth & elevation', category: 'Foundations' },

  // Window system
  { key: 'panel-chrome', section: '3.3', displayName: 'Panel chrome',        category: 'Window system', aliases: ['chrome-layout'] },
  { key: 'top-toolbar',  section: '3.3', displayName: 'Top toolbar',         category: 'Window system' },
  { key: 'dock-snap',    section: '3.3', displayName: 'Dock regions & snap', category: 'Window system', aliases: ['chrome-layout'] },
  { key: 'panel-types',  section: '3.2', displayName: 'Panel types',         category: 'Window system' },

  // Global UI
  { key: 'buttons',          section: '3.4.5',  displayName: 'Buttons',               category: 'Global UI' },
  { key: 'dialogs-modals',   section: '3.4.4',  displayName: 'Dialogs, modals, tooltips', category: 'Global UI' },
  { key: 'context-menus',    section: '3.4.3',  displayName: 'Context menus',         category: 'Global UI' },
  { key: 'menu-bar-toolbar', section: '3.4.2',  displayName: 'Menu bar & toolbar',    category: 'Global UI' },
  { key: 'transport-bar',    section: '3.4.1',  displayName: 'Transport bar',         category: 'Global UI' },
  { key: 'toast',            section: '3.4.25', displayName: 'Toast notifications',   category: 'Global UI' },

  // Workspace panels
  { key: 'timeline',         section: '3.4.16', displayName: 'Timeline',         category: 'Workspace panels' },
  { key: 'piano-roll',       section: '3.4.14', displayName: 'Piano roll',       category: 'Workspace panels' },
  { key: 'mixer',            section: '3.4.6',  displayName: 'Mixer',            category: 'Workspace panels' },
  { key: 'sampler',          section: '3.4.15', displayName: 'Sampler',          category: 'Workspace panels' },
  { key: 'preview-player',   section: '3.4.22', displayName: 'Preview player',   category: 'Workspace panels' },
  { key: 'grid-editor',      section: '3.4.17', displayName: 'Grid editor',      category: 'Workspace panels' },
  { key: 'sample-selector',  section: '3.4.18', displayName: 'Sample selector',  category: 'Workspace panels' },
  { key: 'project-media',    section: '3.4.23', displayName: 'Project media / sources', category: 'Workspace panels' },
  { key: 'pattern-list',     section: '3.4.24', displayName: 'Pattern list',     category: 'Workspace panels' },
  { key: 'node-editor',      section: '3.4.19', displayName: 'Node editor',      category: 'Workspace panels' },

  // Stock effects
  { key: 'stock-effects.shared',    section: '3.4.7',  displayName: 'Shared primitives', category: 'Stock effects' },
  { key: 'stock-effects.eq',        section: '3.4.8',  displayName: 'Xleth EQ',          category: 'Stock effects' },
  { key: 'stock-effects.dynamics',  section: '3.4.9',  displayName: 'Dynamics',          category: 'Stock effects' },
  { key: 'stock-effects.filter',    section: '3.4.10', displayName: 'Filter',            category: 'Stock effects', plannedDeferred: true },
  { key: 'stock-effects.modulation',section: '3.4.11', displayName: 'Modulation',        category: 'Stock effects' },
  { key: 'stock-effects.time',      section: '3.4.12', displayName: 'Time (Delay, Reverb)', category: 'Stock effects' },
  { key: 'stock-effects.distortion',section: '3.4.13', displayName: 'Distortion',        category: 'Stock effects' },

  // Specialized editors
  { key: 'syllable-splitter', section: '3.4.20', displayName: 'Syllable splitter', category: 'Specialized editors' },
  { key: 'lip-sync-picker',   section: '3.4.21', displayName: 'Lip sync picker',   category: 'Specialized editors' },
  // Shared waveform-rendering primitives — consumed by sampler, syllable
  // splitter, and lip-sync picker. Tokens in this subsystem carry
  // crossSubsystem:true so they match values in any consumer subsystem.
  { key: 'waveform-shared',   section: '3.4.26', displayName: 'Waveform (shared)', category: 'Specialized editors' },

  // Labels (promoted per Clarification #3)
  { key: 'labels',         section: '3.4.x (label)',         displayName: 'Labels',         category: 'Labels' },
  { key: 'track-palette',  section: '3.4.x (track-palette)', displayName: 'Track palette',  category: 'Labels' },
];

// ──────────────────────────────────────────────────────────────────────────
// Token builder helpers
// ──────────────────────────────────────────────────────────────────────────

const base = (name: string, kind: TokenKind = 'color', category = 'Foundations', subsystem = 'base'): TokenDef => ({
  name, kind, capability: 'solid', category, subsystem, derivation: { type: 'base' },
});
const derivedFormula = (name: string, capability: GradientCapability, category: string, subsystem: string): TokenDef => ({
  name, kind: 'color', capability, category, subsystem, derivation: { type: 'derived-formula' },
});
const ref = (
  name: string, refName: string, capability: GradientCapability, category: string, subsystem: string, kind: TokenKind = 'color',
): TokenDef => ({ name, kind, capability, category, subsystem, derivation: { type: 'derived-var', ref: refName } });
const explicit = (
  name: string, value: string, capability: GradientCapability, category: string, subsystem: string, kind: TokenKind = 'color',
): TokenDef => ({ name, kind, capability, category, subsystem, derivation: { type: 'explicit', value } });

// Variant of explicit() that marks the token as cross-subsystem for Gate 3.
const explicitX = (
  name: string, value: string, capability: GradientCapability, category: string, subsystem: string, kind: TokenKind = 'color',
): TokenDef => ({ name, kind, capability, category, subsystem, derivation: { type: 'explicit', value }, crossSubsystem: true });

// Shorthand for alias tokens that default to a base var — used heavily for
// subsystem tokens per Clarification #2 (every subsystem exposes its own
// handles even if they alias base tokens by default).
const alias = (name: string, baseRef: string, subsystem: string, category = 'Workspace panels', capability: GradientCapability = 'solid'): TokenDef =>
  ref(name, baseRef, capability, category, subsystem);

// ──────────────────────────────────────────────────────────────────────────
// TOKEN LIST
// ──────────────────────────────────────────────────────────────────────────

export const TOKENS: ReadonlyArray<TokenDef> = [

  // ─── Foundations: Base (§3.1) ─────────────────────────────────────────
  base('--theme-bg-primary'),
  base('--theme-bg-surface'),
  base('--theme-accent'),
  base('--theme-text'),
  base('--theme-danger'),
  // Universal foreground inverse — used for canvas strokes, text-on-dark
  // markers, and other places where plain white is the semantic choice
  // regardless of accent. Kept distinct from the deriveTheme-computed
  // --theme-text-inverse (which is a tonal inverse of --theme-text).
  explicit('--theme-fg-inverse', '#ffffff', 'solid', 'Foundations', 'base'),
  // Intentionally-darker-than-bg-primary inset background for canvas
  // panels (piano-roll body, mixer SmartBalance canvas). Sits below
  // bg-primary on the depth scale; not a derived formula because the
  // offset from bg-primary is not consistent across themes.
  explicit('--theme-bg-inset', '#0d0d14', 'any', 'Foundations', 'base'),
  // Modal/overlay backdrop tints - stepped opacity scale for dark overlays
  explicit('--theme-overlay-subtle', 'rgba(0, 0, 0, 0.25)', 'solid', 'Foundations', 'base'),
  explicit('--theme-overlay-medium', 'rgba(0, 0, 0, 0.60)', 'solid', 'Foundations', 'base'),
  explicit('--theme-overlay-heavy',  'rgba(0, 0, 0, 0.75)', 'solid', 'Foundations', 'base'),

  // ─── Foundations: Derived backgrounds (§3.2) ──────────────────────────
  derivedFormula('--theme-bg-secondary', 'any', 'Foundations', 'derived'),
  derivedFormula('--theme-bg-tertiary',  'any', 'Foundations', 'derived'),
  derivedFormula('--theme-bg-hover',     'any', 'Foundations', 'derived'),
  derivedFormula('--theme-bg-active',    'any', 'Foundations', 'derived'),
  derivedFormula('--theme-bg-elevated',  'any', 'Foundations', 'derived'),

  // ─── Foundations: Text family (§3.2) ──────────────────────────────────
  derivedFormula('--theme-text-muted',       'solid', 'Foundations', 'text'),
  derivedFormula('--theme-text-subtle',      'solid', 'Foundations', 'text'),
  derivedFormula('--theme-text-placeholder', 'solid', 'Foundations', 'text'),
  derivedFormula('--theme-text-inverse',     'solid', 'Foundations', 'text'),
  // Dark foreground for text sitting on accent/danger button backgrounds.
  // Same raw value as --theme-bg-inset but carries a distinct semantic:
  // "contrast text color on colored bg", not "inset panel surface".
  // Future convergence with --theme-text-inverse (derived) is a candidate —
  // see theming-catalog-gaps.md "Future cleanup".
  explicit('--theme-text-on-accent', '#0d0d14', 'solid', 'Foundations', 'text'),

  // ─── Foundations: Border family (§3.2) ────────────────────────────────
  derivedFormula('--theme-border-subtle', 'solid', 'Foundations', 'borders'),
  derivedFormula('--theme-border-strong', 'solid', 'Foundations', 'borders'),
  derivedFormula('--theme-border-focus',  'solid', 'Foundations', 'borders'),

  // ─── Foundations: Depth & elevation (Pass 1 — registered, not yet
  // consumed by selectors). Vocabulary for raised surfaces, recessed
  // editor wells, floating panels, pressed controls, and accent glow.
  // Pass 2/3/4 will read these in app.css / windowing.css. The hardcoded
  // rgba(51, 206, 214, …) glow values match --theme-accent (#33CED6) for
  // the shipped default; Pass 2/3 must convert them to accent-derived
  // formulas before broad selector adoption (otherwise non-default themes
  // won't get accent-matched glow). See docs/plans/ui-depth-pass1-token-foundation.md.
  // ──────────────────────────────────────────────────────────────────────

  // Surface aliases
  ref('--theme-depth-elevation-1-bg', '--theme-bg-secondary', 'solid', 'Foundations', 'depth'),
  ref('--theme-depth-elevation-2-bg', '--theme-bg-surface',   'solid', 'Foundations', 'depth'),
  ref('--theme-depth-elevation-3-bg', '--theme-bg-elevated',  'solid', 'Foundations', 'depth'),
  ref('--theme-depth-well-bg',        '--theme-bg-inset',     'solid', 'Foundations', 'depth'),
  ref('--theme-depth-floating-bg',    '--theme-bg-elevated',  'solid', 'Foundations', 'depth'),
  ref('--theme-depth-pressed-bg',     '--theme-bg-active',    'solid', 'Foundations', 'depth'),

  // Borders
  ref     ('--theme-depth-elevation-1-border',      '--theme-border-subtle', 'solid', 'Foundations', 'depth'),
  explicit('--theme-depth-elevation-2-border',      'rgba(232, 232, 237, 0.10)', 'solid', 'Foundations', 'depth'),
  ref     ('--theme-depth-elevation-3-border',      '--theme-border-strong', 'solid', 'Foundations', 'depth'),
  ref     ('--theme-depth-floating-border',         '--theme-border-subtle', 'solid', 'Foundations', 'depth'),
  ref     ('--theme-depth-floating-focused-border', '--theme-border-focus',  'solid', 'Foundations', 'depth'),
  explicit('--theme-depth-well-border',             'rgba(0, 0, 0, 0.5)',    'solid', 'Foundations', 'depth'),

  // Highlights / inset edges (kind: shadow — they're inset box-shadow strings)
  explicit('--theme-depth-elevation-1-top-highlight', 'inset 0 1px 0 rgba(255, 255, 255, 0.04)', 'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-elevation-2-top-highlight', 'inset 0 1px 0 rgba(255, 255, 255, 0.06)', 'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-elevation-3-top-highlight', 'inset 0 1px 0 rgba(255, 255, 255, 0.08)', 'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-floating-top-highlight',    'inset 0 1px 0 rgba(255, 255, 255, 0.06)', 'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-elevation-1-bottom-edge',   'inset 0 -1px 0 rgba(0, 0, 0, 0.30)',      'solid', 'Foundations', 'depth', 'shadow'),

  // Outer / inner shadows
  explicit('--theme-depth-elevation-2-outer-shadow', '0 4px 12px rgba(0, 0, 0, 0.35)',                                           'solid', 'Foundations', 'depth', 'shadow'),
  ref     ('--theme-depth-elevation-3-outer-shadow', '--theme-chrome-shadow',                                                    'solid', 'Foundations', 'depth', 'shadow'),
  ref     ('--theme-depth-floating-shadow',          '--theme-chrome-shadow',                                                    'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-floating-focused-shadow',  'var(--theme-depth-floating-shadow)',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-well-inner-shadow',        'inset 0 2px 4px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(0, 0, 0, 0.30)', 'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-well-inner-shadow-soft',   'inset 0 1px 3px rgba(0,0,0,0.6)',                                          'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-well-top-shadow',          'inset 0 4px 8px rgba(0, 0, 0, 0.35)',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-pressed-inner-shadow',     'inset 0 1px 2px rgba(0, 0, 0, 0.45)',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-hard-shadow',              '4px 5px 0 rgba(0,0,0,0.5)',                                                'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-panel-hard-shadow',        '6px 8px 0 rgba(0,0,0,0.45)',                                               'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-top-light-bevel',          'inset 0 1px 0 rgba(255,255,255,0.08)',                                     'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-control-hard-shadow-filter','drop-shadow(4px 5px 0 rgba(0, 0, 0, 0.45))',                              'solid', 'Foundations', 'depth', 'shadow'),

  // Accent glow / focus halo (TEMP hardcoded accent literals — see Pass 2/3 cleanup note above)
  explicit('--theme-depth-accent-glow-subtle', 'none',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-accent-glow-medium', 'none',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-accent-glow-strong', 'none',                                      'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-accent-ring',        '0 0 0 1px var(--theme-border-focus)',       'solid', 'Foundations', 'depth', 'shadow'),
  explicit('--theme-depth-accent-halo',        '0 0 0 1px var(--theme-border-focus)',       'solid', 'Foundations', 'depth', 'shadow'),

  // Amplitude knob — unitless multiplier consumed at SELECTOR level via
  // calc() in future passes (NEVER inside token values; the catalog has
  // no calc() synthesis). 0 = flat, 0.5 = subtle, 1 = default, 1.5–2 = strong.
  // Future Theme Editor exposes this as a range slider; SimpleMode unaffected this pass.
  explicit('--theme-depth-amplitude', '1', 'solid', 'Foundations', 'depth', 'dimension'),

  // Density scale for utility panels. These keep peripheral controls closer
  // to the timeline/mixer cadence without changing panel structure.
  explicit('--theme-panel-padding-compact',      '8px',      'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-panel-gap-compact',          '8px',      'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-section-padding-compact',    '6px',      'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-section-gap-compact',        '6px',      'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-padding-compact',    '3px 6px',  'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-gap-compact',        '6px',      'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-height-compact',     '28px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-size-compact',       '42px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-slider-thumb-size',  '14px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-control-value-font-compact', '18px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-knob-size-compact',          '44px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-notation-min-height-compact','52px',     'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-grid-controls-width-compact','112px',    'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-empty-padding-compact',      '12px 8px', 'solid', 'Foundations', 'density', 'dimension'),
  explicit('--theme-empty-margin-compact',       '4px',      'solid', 'Foundations', 'density', 'dimension'),

  // ─── Foundations: Semantic (§3.2 / §3.3) ──────────────────────────────
  // --theme-info passes through accent via deriveTheme.
  // --theme-success / --theme-warning are independent semantic colors
  // (spec §3.3); they are NOT derivable from accent at a useful ΔE, so
  // they ship as explicit defaults. Users override them via Advanced mode.
  explicit('--theme-success', '#22C55E', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-warning', '#FFAA33', 'solid', 'Foundations', 'semantic'),
  derivedFormula('--theme-info',    'solid', 'Foundations', 'semantic'),
  ref('--theme-state-active', '--theme-accent', 'solid', 'Foundations', 'semantic'),
  ref('--theme-state-on',     '--theme-accent', 'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-body',         '--theme-bg-surface',    'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-track',        '--theme-border-subtle', 'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-border',       '--theme-border-subtle', 'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-pointer',      '--theme-text-muted',    'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-arc',          '--theme-accent',        'solid', 'Foundations', 'semantic'),
  ref('--theme-knob-arc-modified', '--theme-warning',       'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-app-bg',            '--theme-bg-primary',      'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-panel-bg',          '--theme-bg-surface',      'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-header-bg',         '--theme-bg-secondary',    'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-bg',        '--theme-bg-tertiary',     'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-hover-bg',  '--theme-bg-hover',        'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-active-bg', '--theme-bg-active',       'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-well-bg',           '--theme-bg-inset',        'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-border',    '--theme-border-subtle',   'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-fg',        '--theme-text-muted',      'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-control-active-fg', '--theme-text',            'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-active-accent',     '--theme-accent',          'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-meter-rail',        '--theme-depth-well-bg',   'solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-meter-idle',        '--theme-accent-bg-subtle','solid', 'Foundations', 'semantic'),
  ref('--theme-primitive-meter-fill',        '--theme-success',         'solid', 'Foundations', 'semantic'),
  explicit('--theme-led-green', '#5fe08f', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-led-red',   '#ff5a52', 'solid', 'Foundations', 'semantic'),
  // Default drag-preview tint for pattern-list items and timeline drag
  // shadows. In the semantic subsystem (UNIVERSAL) so any consumer may
  // reference it regardless of its own subsystem.
  explicit('--theme-drag-preview-default', '#6aa9ff', 'solid', 'Foundations', 'semantic'),
  // Accent alpha backgrounds - stepped tints for hover/selection states
  derivedFormula('--theme-accent-bg-subtle', 'solid', 'Foundations', 'semantic'),
  derivedFormula('--theme-accent-bg-medium', 'solid', 'Foundations', 'semantic'),
  // Danger alpha backgrounds - stepped tints for destructive hover/active states
  explicit('--theme-semantic-danger-bg-subtle', 'rgba(255, 71, 87, 0.12)', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-semantic-danger-bg-medium', 'rgba(255, 71, 87, 0.15)', 'solid', 'Foundations', 'semantic'),
  // Semantic text and border colors
  explicit('--theme-semantic-danger-text',    '#ff8a8a', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-semantic-success-border', '#5adc86', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-semantic-warning-border', '#d8a23a', 'solid', 'Foundations', 'semantic'),
  explicit('--theme-semantic-warning-text',      '#f2d079',              'solid', 'Foundations', 'semantic'),
  explicit('--theme-semantic-warning-bg-subtle', 'rgba(255, 170, 51, 0.15)', 'solid', 'Foundations', 'semantic'),

  // ─── Foundations: Accent states (§3.2) ────────────────────────────────
  derivedFormula('--theme-accent-hover',  'solid', 'Foundations', 'semantic'),
  derivedFormula('--theme-accent-active', 'solid', 'Foundations', 'semantic'),
  derivedFormula('--theme-focus-ring',    'solid', 'Foundations', 'semantic'),

  // ─── Window system: Panel types (§3.2) ────────────────────────────────
  derivedFormula('--theme-panel-mixer',     'solid', 'Window system', 'panel-types'),
  derivedFormula('--theme-panel-timeline',  'solid', 'Window system', 'panel-types'),
  derivedFormula('--theme-panel-pianoroll', 'solid', 'Window system', 'panel-types'),
  derivedFormula('--theme-panel-preview',   'solid', 'Window system', 'panel-types'),
  derivedFormula('--theme-panel-grid',      'solid', 'Window system', 'panel-types'),
  derivedFormula('--theme-panel-node',      'solid', 'Window system', 'panel-types'),

  // ─── Window system: Panel chrome (§3.3) ───────────────────────────────
  ref('--theme-chrome-titlebar-bg', '--theme-bg-surface', 'any',   'Window system', 'panel-chrome'),
  ref('--theme-chrome-titlebar-fg', '--theme-text',       'solid', 'Window system', 'panel-chrome'),
  explicit('--theme-chrome-titlebar-height',     '32px', 'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-accent-bar-width',    '3px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-underline-thickness', '2px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-border-radius',       '4px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-unfocused-opacity',   '0.4',  'solid', 'Window system', 'panel-chrome', 'opacity'),
  explicit('--theme-chrome-radius-sm',           '4px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-radius-md',           '6px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-radius-lg',           '8px',  'solid', 'Window system', 'panel-chrome', 'dimension'),
  explicit('--theme-chrome-transition-fast',     '0.1s ease',  'solid', 'Window system', 'panel-chrome', 'duration'),
  explicit('--theme-chrome-transition',          '0.15s ease', 'solid', 'Window system', 'panel-chrome', 'duration'),
  explicit('--theme-chrome-shadow', '0 12px 40px rgba(0, 0, 0, 0.6)', 'solid', 'Window system', 'panel-chrome', 'shadow'),

  // ─── Window system: Top toolbar (§3.3) ────────────────────────────────
  ref('--theme-toolbar-bg',             '--theme-bg-surface',   'any',   'Window system', 'top-toolbar'),
  ref('--theme-toolbar-border',         '--theme-border-subtle','solid', 'Window system', 'top-toolbar'),
  ref('--theme-toolbar-fg',             '--theme-text',         'solid', 'Window system', 'top-toolbar'),
  ref('--theme-toolbar-icon-open',      '--theme-accent',       'solid', 'Window system', 'top-toolbar'),
  ref('--theme-toolbar-icon-hidden',    '--theme-text-muted',   'solid', 'Window system', 'top-toolbar'),
  ref('--theme-toolbar-icon-hover-bg',  '--theme-bg-hover',     'any',   'Window system', 'top-toolbar'),
  ref('--theme-toolbar-focus-indicator','--theme-accent',       'solid', 'Window system', 'top-toolbar'),

  // ─── Window system: Dock regions & snap (§3.3) ────────────────────────
  ref('--theme-dock-divider',         '--theme-border-subtle', 'solid', 'Window system', 'dock-snap'),
  ref('--theme-dock-divider-hover',   '--theme-border-strong', 'solid', 'Window system', 'dock-snap'),
  ref('--theme-dock-divider-active',  '--theme-accent',        'solid', 'Window system', 'dock-snap'),
  derivedFormula('--theme-snap-ghost-fill',  'solid', 'Window system', 'dock-snap'),
  derivedFormula('--theme-snap-ghost-border', 'solid', 'Window system', 'dock-snap'),

  // ─── Global UI: Transport bar (§3.4.1) ────────────────────────────────
  ref('--theme-transport-bar-bg',            '--theme-bg-surface',   'any',   'Global UI', 'transport-bar'),
  ref('--theme-transport-bar-border',        '--theme-border-subtle','solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-bar-fg',            '--theme-text',         'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-playhead',          '--theme-accent',       'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-time-fg',           '--theme-text',         'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-bpm-fg',            '--theme-text',         'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-hint-fg',           '--theme-text-muted',   'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-button-bg',         '--theme-bg-surface',   'any',   'Global UI', 'transport-bar'),
  ref('--theme-transport-button-fg',         '--theme-text',         'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-button-hover-bg',   '--theme-bg-hover',     'any',   'Global UI', 'transport-bar'),
  ref('--theme-transport-button-active-bg',  '--theme-bg-active',    'any',   'Global UI', 'transport-bar'),
  ref('--theme-transport-button-disabled-fg','--theme-text-subtle',  'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-play-bg',           '--theme-accent',       'solid', 'Global UI', 'transport-bar'),
  explicit('--theme-transport-play-fg',      '#06201f',              'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-record-indicator',  '--theme-danger',       'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-metronome-on',      '--theme-accent',       'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-metronome-off',     '--theme-text-muted',   'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-device-bg',         '--theme-bg-surface',   'any',   'Global UI', 'transport-bar'),
  ref('--theme-transport-device-fg',         '--theme-text',         'solid', 'Global UI', 'transport-bar'),
  ref('--theme-transport-device-hover-bg',   '--theme-bg-hover',     'any',   'Global UI', 'transport-bar'),
  explicit('--theme-transport-bar-height',   '48px', 'solid', 'Global UI', 'transport-bar', 'dimension'),

  // ─── Global UI: Menu bar & top toolbar (§3.4.2) ───────────────────────
  ref('--theme-menubar-bg',                '--theme-bg-surface',   'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-item-fg',           '--theme-text',         'solid', 'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-item-hover-bg',     '--theme-bg-hover',     'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-item-active-bg',    '--theme-bg-active',    'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-title-fg',          '--theme-text',         'solid', 'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-separator',         '--theme-border-subtle','solid', 'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-action-bg',         '--theme-bg-surface',   'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-action-fg',         '--theme-text',         'solid', 'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-action-hover-bg',   '--theme-bg-hover',     'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-action-active-bg',  '--theme-bg-active',    'any',   'Global UI', 'menu-bar-toolbar'),
  ref('--theme-menubar-action-disabled-fg','--theme-text-subtle',  'solid', 'Global UI', 'menu-bar-toolbar'),

  // ─── Global UI: Context menus (§3.4.3) ────────────────────────────────
  ref('--theme-contextmenu-bg',               '--theme-bg-elevated',  'any',   'Global UI', 'context-menus'),
  ref('--theme-contextmenu-border',           '--theme-border-subtle','solid', 'Global UI', 'context-menus'),
  explicit('--theme-contextmenu-shadow', '0 4px 18px rgba(0, 0, 0, 0.45)', 'solid', 'Global UI', 'context-menus', 'shadow'),
  ref('--theme-contextmenu-item-bg',          '--theme-bg-elevated',  'any',   'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-hover-bg',    '--theme-bg-hover',     'any',   'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-selected-bg', '--theme-bg-active',    'any',   'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-disabled-bg', '--theme-bg-elevated',  'any',   'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-fg',          '--theme-text',         'solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-muted-fg',    '--theme-text-muted',   'solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-destructive-fg','--theme-danger',     'solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-item-icon-fg',     '--theme-text-muted',   'solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-separator',        '--theme-border-subtle','solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-submenu-arrow',    '--theme-text-muted',   'solid', 'Global UI', 'context-menus'),
  ref('--theme-contextmenu-check-indicator',  '--theme-accent',       'solid', 'Global UI', 'context-menus'),

  // ─── Global UI: Dialogs, modals, popovers, tooltips (§3.4.4) ──────────
  explicit('--theme-dialog-backdrop', 'rgba(0, 0, 0, 0.55)', 'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-modal-bg',             '--theme-bg-elevated',  'any',   'Global UI', 'dialogs-modals'),
  ref('--theme-modal-border',         '--theme-border-subtle','solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-modal-title-fg',       '--theme-text',         'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-modal-body-fg',        '--theme-text',         'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-modal-header-divider', '--theme-border-subtle','solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-modal-footer-bg',      '--theme-bg-surface',   'any',   'Global UI', 'dialogs-modals'),
  // Primary / secondary / destructive button variants referenced from
  // generic buttons — see §3.4.5 block below.
  ref('--theme-tooltip-bg',           '--theme-bg-elevated',  'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-tooltip-fg',           '--theme-text',         'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-tooltip-border',       '--theme-border-subtle','solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-tooltip-arrow',        '--theme-bg-elevated',  'solid', 'Global UI', 'dialogs-modals'),
  ref('--theme-popover-bg',           '--theme-bg-elevated',  'any',   'Global UI', 'dialogs-modals'),
  ref('--theme-popover-border',       '--theme-border-subtle','solid', 'Global UI', 'dialogs-modals'),
  explicit('--theme-modal-shadow', '0 12px 40px rgba(0, 0, 0, 0.6)', 'solid', 'Global UI', 'dialogs-modals', 'shadow'),

  // ─── Global UI: Generic buttons (§3.4.5) ──────────────────────────────
  ref('--theme-button-bg',                '--theme-bg-surface',   'any',   'Global UI', 'buttons'),
  ref('--theme-button-fg',                '--theme-text',         'solid', 'Global UI', 'buttons'),
  ref('--theme-button-border',            '--theme-border-subtle','solid', 'Global UI', 'buttons'),
  ref('--theme-button-hover-bg',          '--theme-bg-hover',     'any',   'Global UI', 'buttons'),
  ref('--theme-button-hover-fg',          '--theme-text',         'solid', 'Global UI', 'buttons'),
  ref('--theme-button-hover-border',      '--theme-border-strong','solid', 'Global UI', 'buttons'),
  ref('--theme-button-active-bg',         '--theme-bg-active',    'any',   'Global UI', 'buttons'),
  ref('--theme-button-active-fg',         '--theme-text',         'solid', 'Global UI', 'buttons'),
  ref('--theme-button-active-border',     '--theme-border-strong','solid', 'Global UI', 'buttons'),
  ref('--theme-button-disabled-bg',       '--theme-bg-surface',   'any',   'Global UI', 'buttons'),
  ref('--theme-button-disabled-fg',       '--theme-text-subtle',  'solid', 'Global UI', 'buttons'),
  ref('--theme-button-disabled-border',   '--theme-border-subtle','solid', 'Global UI', 'buttons'),
  ref('--theme-button-focused-border',    '--theme-border-focus', 'solid', 'Global UI', 'buttons'),
  // Variants
  ref('--theme-button-primary-bg',        '--theme-accent',       'any',   'Global UI', 'buttons'),
  ref('--theme-button-primary-fg',        '--theme-text-inverse', 'solid', 'Global UI', 'buttons'),
  ref('--theme-button-primary-hover-bg',  '--theme-accent-hover', 'any',   'Global UI', 'buttons'),
  ref('--theme-button-primary-active-bg', '--theme-accent-active','any',   'Global UI', 'buttons'),
  ref('--theme-button-secondary-bg',      '--theme-bg-surface',   'any',   'Global UI', 'buttons'),
  ref('--theme-button-secondary-fg',      '--theme-text',         'solid', 'Global UI', 'buttons'),
  ref('--theme-button-destructive-bg',    '--theme-danger',       'any',   'Global UI', 'buttons'),
  ref('--theme-button-destructive-fg',    '--theme-text-inverse', 'solid', 'Global UI', 'buttons'),
  ref('--theme-button-icon-fg',           '--theme-text',         'solid', 'Global UI', 'buttons'),
  ref('--theme-button-icon-hover-fg',     '--theme-accent',       'solid', 'Global UI', 'buttons'),
  ref('--theme-button-toggle-on-bg',      '--theme-accent',       'any',   'Global UI', 'buttons'),
  ref('--theme-button-toggle-on-fg',      '--theme-text-inverse', 'solid', 'Global UI', 'buttons'),
  ref('--theme-button-toggle-off-bg',     '--theme-bg-surface',   'any',   'Global UI', 'buttons'),
  ref('--theme-button-toggle-off-fg',     '--theme-text-muted',   'solid', 'Global UI', 'buttons'),

  // ─── Workspace: Mixer (§3.4.6) ────────────────────────────────────────
  ref('--theme-mixer-strip-bg',           '--theme-bg-primary',   'any',   'Workspace panels', 'mixer'),
  ref('--theme-mixer-strip-divider',      '--theme-border-subtle','solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-channel-name-fg',    '--theme-text',         'solid', 'Workspace panels', 'mixer'),
  // Pan knob
  ref('--theme-mixer-pan-knob-track',  '--theme-border-subtle','linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-pan-knob-fill',   '--theme-accent',       'linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-pan-knob-ring',   '--theme-text',         'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-pan-knob-label',  '--theme-text-muted',   'solid', 'Workspace panels', 'mixer'),
  // Width knob
  ref('--theme-mixer-width-knob-track','--theme-border-subtle','linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-width-knob-fill', '--theme-accent',       'linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-width-knob-label','--theme-text-muted',   'solid', 'Workspace panels', 'mixer'),
  // Fader
  ref('--theme-mixer-fader-track', '--theme-border-subtle','linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-fader-thumb', '--theme-accent',       'linear','Workspace panels', 'mixer'),
  ref('--theme-mixer-fader-fill',  '--theme-accent',       'linear','Workspace panels', 'mixer'),
  // Meter (gradient-capable per §3.5)
  ref('--theme-mixer-meter-track', '--theme-bg-primary',   'linear','Workspace panels', 'mixer'),
  explicit('--theme-mixer-meter-fill',
    'linear-gradient(0deg, #22C55E 0%, #22C55E 40%, #FFAA33 75%, #FFAA33 88%, #FF4757 88%, #FF4757 100%)',
    'linear', 'Workspace panels', 'mixer'),
  explicit('--theme-mixer-meter-peak-hold', '#E8E8ED', 'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-meter-clip',   '--theme-danger',     'solid', 'Workspace panels', 'mixer'),
  // Chain/Node toggle
  ref('--theme-mixer-chain-toggle-bg',    '--theme-bg-surface',   'any',   'Workspace panels', 'mixer'),
  ref('--theme-mixer-chain-toggle-fg',    '--theme-text',         'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-chain-toggle-on-bg', '--theme-accent',       'any',   'Workspace panels', 'mixer'),
  // Effect slot
  ref('--theme-mixer-effect-slot-bg',       '--theme-bg-surface',   'any',   'Workspace panels', 'mixer'),
  ref('--theme-mixer-effect-slot-hover-bg', '--theme-bg-hover',     'any',   'Workspace panels', 'mixer'),
  ref('--theme-mixer-effect-drag-handle',   '--theme-text-muted',   'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-effect-enable-toggle', '--theme-accent',       'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-add-effect-button',    '--theme-accent',       'solid', 'Workspace panels', 'mixer'),
  ref('--theme-mixer-master-accent',        '--theme-accent',       'solid', 'Workspace panels', 'mixer'),
  explicit('--theme-mixer-panel-height', '400px', 'solid', 'Workspace panels', 'mixer', 'dimension'),

  // ─── Workspace: Piano roll (§3.4.14) ──────────────────────────────────
  explicit('--theme-pianoroll-grid-bg', '#111118', 'any', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-bar-line',         'rgba(255, 255, 255, 0.14)', 'solid', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-beat-line',        'rgba(255, 255, 255, 0.06)', 'solid', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-subdivision-line', 'rgba(255, 255, 255, 0.04)', 'solid', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-key-black-bg', '#0A0A10', 'any', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-key-white-bg', '#15151C', 'any', 'Workspace panels', 'piano-roll'),
  // Highlighted (hover/preview) key states — match the literals previously
  // hardcoded in PianoRollKeyboard.jsx; light theme overrides for contrast.
  explicit('--theme-pianoroll-key-black-highlight', '#4a3a58', 'any', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-key-white-highlight', '#3a3a4a', 'any', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-key-label-fg', '--theme-text-muted', 'solid', 'Workspace panels', 'piano-roll'),
  // Scrollbar thumb — white-on-dark in dark themes, black-on-light in light theme.
  // Light overrides live in xleth-light.json.
  explicit('--theme-pianoroll-scrollbar-thumb',       'rgba(255, 255, 255, 0.22)', 'any', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-scrollbar-thumb-hover',  'rgba(255, 255, 255, 0.36)', 'any', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-note-fill',     '--theme-accent',       'solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-note-stroke',   '--theme-border-strong','solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-note-selected', '--theme-accent-active','solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-note-hover',    '--theme-accent-hover', 'solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-note-resize-handle', '--theme-text', 'solid', 'Workspace panels', 'piano-roll'),
  // Per-note material depth overlays — drawn as 1px bands inside each note in
  // PianoRollCanvas drawNotes. Hue-agnostic neutral overlays composite over
  // the note body fill (regular cyan / slide magenta) without per-hue tuning.
  // Light themes override these to softer alphas in xleth-light.json.
  explicit('--theme-pianoroll-note-highlight-band', 'rgba(255, 255, 255, 0.16)', 'solid', 'Workspace panels', 'piano-roll'),
  explicit('--theme-pianoroll-note-shadow-band',    'rgba(0, 0, 0, 0.22)',       'solid', 'Workspace panels', 'piano-roll'),
  derivedFormula('--theme-pianoroll-note-slide-stroke', 'solid', 'Workspace panels', 'piano-roll'),
  // Slide-note identity color — kept constant across themes so slide notes
  // remain visually distinct from regular notes (which derive from accent).
  // Same pattern as sampler-mod-color-* identity tokens.
  explicit('--theme-pianoroll-note-slide-fill', '#E64FE6', 'solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-velocity-bar-fill', '--theme-accent',        'linear','Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-velocity-track',    '--theme-bg-primary',    'linear','Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-playhead',          '--theme-accent',        'solid', 'Workspace panels', 'piano-roll'),
  derivedFormula('--theme-pianoroll-loop-region',  'any', 'Workspace panels', 'piano-roll'),
  derivedFormula('--theme-pianoroll-selection-rect', 'any', 'Workspace panels', 'piano-roll'),
  // Automation
  ref('--theme-pianoroll-automation-bg',       '--theme-bg-primary',    'any',   'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-automation-grid',     '--theme-border-subtle', 'solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-automation-point',    '--theme-accent',        'solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-automation-point-selected','--theme-accent-active','solid','Workspace panels','piano-roll'),
  ref('--theme-pianoroll-automation-point-hover','--theme-accent-hover','solid', 'Workspace panels', 'piano-roll'),
  ref('--theme-pianoroll-automation-curve',    '--theme-accent',        'solid', 'Workspace panels', 'piano-roll'),
  // referenced by all four stops of the resize-handle linear-gradient
  explicit('--theme-pianoroll-resize-handle-stripe', 'rgba(255, 255, 255, 0.25)', 'solid', 'Workspace panels', 'piano-roll'),
  // Velocity lane background — semantically distinct from key-black-bg so the
  // lane surface can be independently tuned per theme.
  explicit('--theme-pianoroll-velocity-bg',           '#090912',                  'any',   'Workspace panels', 'piano-roll'),
  // Dashed guide lines at 25 / 50 / 75 % velocity — internal lane structure.
  explicit('--theme-pianoroll-velocity-level-line',   'rgba(255, 255, 255, 0.05)','solid', 'Workspace panels', 'piano-roll'),
  // Canvas-drawn top-edge shadow at the grid boundary — theme-controlled so
  // custom themes can tune or remove the depth cue without touching JS.
  explicit('--theme-pianoroll-well-top-shadow',       'rgba(0, 0, 0, 0.22)',      'solid', 'Workspace panels', 'piano-roll'),

  // ─── Workspace: Sampler UI (§3.4.15) ──────────────────────────────────
  ref('--theme-sampler-envelope-bg',     '--theme-bg-primary',  'any',   'Workspace panels', 'sampler'),
  ref('--theme-sampler-envelope-stroke', '--theme-accent',      'solid', 'Workspace panels', 'sampler'),
  // Envelope fill re-exports the shared waveform envelope-fill value via
  // var-ref (was explicit rgba(51,206,214,0.08) — drift; ground truth at
  // SamplerWaveform.jsx:110 is 0.35). Overriding --theme-waveform-envelope-fill
  // cascades to sampler + syllable + lipsync together.
  ref('--theme-sampler-envelope-fill',   '--theme-waveform-envelope-fill', 'any',  'Workspace panels', 'sampler'),
  ref('--theme-sampler-envelope-handle', '--theme-text',        'solid', 'Workspace panels', 'sampler'),
  ref('--theme-sampler-sustain-line',    '--theme-accent',      'solid', 'Workspace panels', 'sampler'),
  ref('--theme-sampler-tension-indicator','--theme-text-muted', 'solid', 'Workspace panels', 'sampler'),
  // LFO
  ref('--theme-sampler-mod-bg',      '--theme-bg-primary',  'any',   'Workspace panels', 'sampler'),
  ref('--theme-sampler-mod-stroke',  '--theme-accent',      'solid', 'Workspace panels', 'sampler'),
  // Per-tab LFO accent colors. Ground truth = LfoSection.jsx:5 LFO_COLORS.
  // pitch↔volume values were swapped in v1 catalog and the purple tab was
  // mis-named "filter" (component tab is "pan").
  explicit('--theme-sampler-mod-color-pitch',  '#E8A020', 'solid', 'Workspace panels', 'sampler'),
  explicit('--theme-sampler-mod-color-pan',    '#9B59B6', 'solid', 'Workspace panels', 'sampler'),
  derivedFormula('--theme-sampler-mod-color-volume', 'solid', 'Workspace panels', 'sampler'),
  explicit('--theme-sampler-mod-bg-pitch',     '#3C2E1A', 'any',   'Workspace panels', 'sampler'),
  explicit('--theme-sampler-mod-bg-pan',       '#2A1E3A', 'any',   'Workspace panels', 'sampler'),
  explicit('--theme-sampler-mod-bg-volume',    '#1E3A3C', 'any',   'Workspace panels', 'sampler'),
  // Waveform
  ref('--theme-sampler-waveform-fg',       '--theme-text-muted',   'solid', 'Workspace panels', 'sampler'),
  ref('--theme-sampler-waveform-bg',       '--theme-bg-primary',   'any',   'Workspace panels', 'sampler'),
  ref('--theme-sampler-waveform-playhead', '--theme-accent',       'solid', 'Workspace panels', 'sampler'),
  explicit('--theme-sampler-trim-handle',  'rgba(255, 160, 60, 0.85)','solid','Workspace panels','sampler'),
  explicit('--theme-sampler-loop-marker',  'rgba(105, 219, 124, 0.85)','solid','Workspace panels','sampler'),
  explicit('--theme-sampler-loop-crossfade-fill','rgba(105, 219, 124, 0.12)','any','Workspace panels','sampler'),
  ref('--theme-sampler-pitch-envelope-curve','--theme-accent',     'solid', 'Workspace panels', 'sampler'),
  ref('--theme-sampler-portamento-indicator','--theme-accent',     'solid', 'Workspace panels', 'sampler'),
  // Arpeggiator
  ref('--theme-sampler-arp-cell-active',   '--theme-accent',       'any',   'Workspace panels', 'sampler'),
  ref('--theme-sampler-arp-cell-inactive', '--theme-bg-surface',   'any',   'Workspace panels', 'sampler'),
  ref('--theme-sampler-mono-poly-toggle',  '--theme-accent',       'solid', 'Workspace panels', 'sampler'),
  explicit('--theme-sampler-declick-region','rgba(255, 255, 255, 0.06)','any','Workspace panels','sampler'),
  explicit('--theme-sampler-key-border', '#2A2A38', 'solid', 'Workspace panels', 'sampler'),
  explicit('--theme-sampler-key-black',  '#000000', 'solid', 'Workspace panels', 'sampler'),

  // ─── Workspace: Timeline (§3.4.16) ────────────────────────────────────
  ref('--theme-timeline-ruler-bg',   '--theme-bg-surface',  'any',   'Workspace panels', 'timeline'),
  ref('--theme-timeline-ruler-fg',   '--theme-text',        'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-playhead',   '--theme-accent',      'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-track-row-alt-bg','--theme-bg-secondary','any','Workspace panels', 'timeline'),
  ref('--theme-timeline-track-header-bg', '--theme-bg-surface',   'any',   'Workspace panels', 'timeline'),
  ref('--theme-timeline-track-header-fg', '--theme-text',         'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-track-color-stripe','--theme-accent',     'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-mute-default',    '--theme-text-muted',   'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-mute-active',     '--theme-danger',       'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-solo-default',    '--theme-text-muted',   'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-solo-active',     '--theme-warning',      'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-clip-bg',         '--theme-accent',       'any',   'Workspace panels', 'timeline'),
  explicit('--theme-timeline-clip-waveform-fg', 'rgba(255, 255, 255, 0.65)', 'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-clip-waveform-bg', 'rgba(255, 255, 255, 0.18)', 'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-clip-title-fg',   '--theme-text',         'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-clip-volume-handle','--theme-text',       'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-fade-curve-fill','rgba(0, 0, 0, 0.45)','any','Workspace panels','timeline'),
  ref('--theme-timeline-empty-region-bg', '--theme-bg-primary',   'any',   'Workspace panels', 'timeline'),
  ref('--theme-timeline-pattern-clip-bg', '--theme-accent',       'any',   'Workspace panels', 'timeline'),
  explicit('--theme-timeline-bar-line',        'rgba(255, 255, 255, 0.26)', 'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-beat-line',       'rgba(255, 255, 255, 0.11)', 'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-subdivision-line','rgba(255, 255, 255, 0.05)', 'solid', 'Workspace panels', 'timeline'),
  ref('--theme-timeline-playhead-line',   '--theme-accent',       'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-panel-accent-width', '3px',          'solid', 'Workspace panels', 'timeline', 'dimension'),
  explicit('--theme-timeline-track-stripe-width', '4px',          'solid', 'Workspace panels', 'timeline', 'dimension'),
  explicit('--theme-timeline-track-stripe-top-height', '2px',     'solid', 'Workspace panels', 'timeline', 'dimension'),
  explicit('--theme-timeline-playhead-cap-size', '8px',           'solid', 'Workspace panels', 'timeline', 'dimension'),
  explicit('--theme-timeline-loop-brace', 'rgba(255, 217, 61, 0.6)', 'solid', 'Workspace panels', 'timeline'),
  derivedFormula('--theme-timeline-selection-rect', 'any', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-pattern-lane-tint','rgba(106, 169, 255, 0.07)','any','Workspace panels', 'timeline'),
  ref('--theme-timeline-section-marker',  '--theme-accent',       'solid', 'Workspace panels', 'timeline'),
  // Bezier control-point handle colors — must remain visually distinguishable
  // from each other in any theme (data encoding for bezier control points).
  explicit('--theme-timeline-bezier-handle-cp1', '#f59e0b', 'solid', 'Workspace panels', 'timeline'),
  explicit('--theme-timeline-bezier-handle-cp2', '#3b82f6', 'solid', 'Workspace panels', 'timeline'),
  // Top-edge well shadow — gradient darkening at the top of the canvas, matching
  // the Piano Roll Pass 4A.1 well-top-shadow pattern.
  explicit('--theme-timeline-well-top-shadow', 'rgba(0, 0, 0, 0.22)', 'any', 'Workspace panels', 'timeline'),
  // Dedicated arrangement lane/work-bed background. Isolated from --theme-bg-inset
  // so the Timeline canvas bed contrast can be tuned independently of shared inset
  // surfaces (Piano Roll, SmartBalance). Not consumed until Pass 5E.3.
  explicit('--theme-timeline-lane-bg', '#07070B', 'any', 'Workspace panels', 'timeline'),

  // ─── Workspace: Grid editor (§3.4.17) ─────────────────────────────────
  ref('--theme-grid-canvas-bg',          '--theme-bg-primary',   'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-cell-empty-bg',      '--theme-bg-secondary', 'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-cell-occupied-bg',   '--theme-bg-surface',   'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-cell-border',        '--theme-border-subtle','solid', 'Workspace panels', 'grid-editor'),
  ref('--theme-grid-cell-divider',       '--theme-border-subtle','solid', 'Workspace panels', 'grid-editor'),
  derivedFormula('--theme-grid-chorus-overlay', 'any', 'Workspace panels', 'grid-editor'),
  explicit('--theme-grid-crash-overlay', 'rgba(255, 107, 157, 0.22)','any','Workspace panels','grid-editor'),
  ref('--theme-grid-settings-bg',        '--theme-bg-surface',   'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-trackcard-bg',       '--theme-bg-surface',   'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-trackcard-border',   '--theme-border-subtle','solid', 'Workspace panels', 'grid-editor'),
  ref('--theme-grid-trackcard-hover-bg', '--theme-bg-hover',     'any',   'Workspace panels', 'grid-editor'),
  ref('--theme-grid-bounce-btn-active',  '--theme-accent',       'solid', 'Workspace panels', 'grid-editor'),
  ref('--theme-grid-bounce-btn-inactive','--theme-text-muted',   'solid', 'Workspace panels', 'grid-editor'),
  explicit('--theme-grid-editor-text-shadow', 'rgba(0, 0, 0, 0.8)',       'solid', 'Workspace panels', 'grid-editor'),
  explicit('--theme-grid-editor-crosshair',   'rgba(255, 255, 255, 0.15)', 'solid', 'Workspace panels', 'grid-editor'),
  explicit('--theme-grid-preview-line',        'rgba(255,255,255,0.10)',    'solid', 'Workspace panels', 'grid-editor'),

  // ─── Workspace: Sample selector (§3.4.18) ─────────────────────────────
  ref('--theme-sampleselector-list-bg',         '--theme-bg-surface',   'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-item-bg',         '--theme-bg-surface',   'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-item-hover-bg',   '--theme-bg-hover',     'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-item-selected-bg','--theme-bg-active',    'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-category-bg',     '--theme-bg-surface',   'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-category-fg',     '--theme-text',         'solid', 'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-play-button',     '--theme-accent',       'solid', 'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-metadata-fg',     '--theme-text-muted',   'solid', 'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-status-bg',       '--theme-bg-active',    'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-status-fg',       '--theme-text',         'solid', 'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-search-bg',       '--theme-bg-primary',   'any',   'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-search-fg',       '--theme-text',         'solid', 'Workspace panels', 'sample-selector'),
  ref('--theme-sampleselector-search-placeholder','--theme-text-placeholder','solid','Workspace panels','sample-selector'),
  ref('--theme-sampleselector-search-border',   '--theme-border-subtle','solid', 'Workspace panels', 'sample-selector'),

  // ─── Workspace: Node editor (§3.4.19) ─────────────────────────────────
  ref('--theme-nodeeditor-canvas-bg',  '--theme-bg-primary',   'any',   'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-grid',       '--theme-border-subtle','solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-node-bg',    '--theme-bg-surface',   'any',   'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-node-border','--theme-border-subtle','solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-node-selected','--theme-accent',     'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-node-titlebar-bg','--theme-bg-elevated','any','Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-node-titlebar-fg','--theme-text',    'solid', 'Workspace panels', 'node-editor'),
  explicit('--theme-nodeeditor-port-default', '#555566', 'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-port-hover',        '--theme-accent-hover','solid','Workspace panels','node-editor'),
  explicit('--theme-nodeeditor-port-connected','#FFAA33', 'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-connection',        '--theme-text-muted',   'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-connection-selected','--theme-accent',      'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-connection-hover',  '--theme-accent-hover', 'solid', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-connection-audio',  '--theme-accent',       'solid', 'Workspace panels', 'node-editor'),
  explicit('--theme-nodeeditor-connection-cv',   '#FFAA33', 'solid', 'Workspace panels', 'node-editor'),
  explicit('--theme-nodeeditor-connection-event','#B197FC', 'solid', 'Workspace panels', 'node-editor'),
  derivedFormula('--theme-nodeeditor-selection-rect', 'any', 'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-zoom-bg', '--theme-bg-surface', 'any',   'Workspace panels', 'node-editor'),
  ref('--theme-nodeeditor-zoom-fg', '--theme-text',       'solid', 'Workspace panels', 'node-editor'),

  // ─── Workspace: Preview player (§3.4.22) ──────────────────────────────
  explicit('--theme-preview-loaded-bg', '#111118', 'any', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-empty-bg',   '--theme-bg-primary',   'any',   'Workspace panels', 'preview-player'),
  ref('--theme-preview-fps-fg',     '--theme-text-muted',   'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-resolution-fg','--theme-text-muted', 'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-zoom-fg',    '--theme-text-muted',   'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-grid-label-fg','--theme-text',       'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-chorus-pill-bg','--theme-accent',    'any',   'Workspace panels', 'preview-player'),
  ref('--theme-preview-chorus-pill-fg','--theme-text-inverse','solid','Workspace panels', 'preview-player'),
  ref('--theme-preview-editgrid-btn',  '--theme-accent',    'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-import-btn',    '--theme-accent',    'solid', 'Workspace panels', 'preview-player'),
  ref('--theme-preview-fx-btn',        '--theme-accent',    'solid', 'Workspace panels', 'preview-player'),

  // ─── Workspace: Project media / sources (§3.4.23) ─────────────────────
  ref('--theme-projectmedia-panel-bg',     '--theme-bg-surface',   'any',   'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-panel-border', '--theme-border-subtle','solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-tree-item',    '--theme-text',         'solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-tree-item-hover','--theme-accent-hover','solid','Workspace panels','project-media'),
  ref('--theme-projectmedia-tree-item-selected-bg','--theme-bg-active','any','Workspace panels','project-media'),
  ref('--theme-projectmedia-icon-folder',  '--theme-text-muted',   'solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-icon-file',    '--theme-text-muted',   'solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-icon-video',   '--theme-accent',       'solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-icon-audio',   '--theme-warning',      'solid', 'Workspace panels', 'project-media'),
  derivedFormula('--theme-projectmedia-dropzone', 'any', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-empty-bg',     '--theme-bg-primary',   'any',   'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-empty-fg',     '--theme-text-muted',   'solid', 'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-cta-button',   '--theme-accent',       'any',   'Workspace panels', 'project-media'),
  ref('--theme-projectmedia-add-button',   '--theme-accent',       'solid', 'Workspace panels', 'project-media'),
  explicit('--theme-projectmedia-shadow', '0 8px 32px rgba(0, 0, 0, 0.5)', 'solid', 'Workspace panels', 'project-media', 'shadow'),

  // ─── Workspace: Pattern list (§3.4.24) ────────────────────────────────
  ref('--theme-patternlist-bg',          '--theme-bg-surface',   'any',   'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-item-bg',     '--theme-bg-surface',   'any',   'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-item-hover',  '--theme-bg-hover',     'any',   'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-item-selected','--theme-bg-active',   'any',   'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-name-fg',     '--theme-text',         'solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-bar-count-fg','--theme-text-muted',   'solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-add-button',  '--theme-accent',       'solid', 'Workspace panels', 'pattern-list'),
  // Pattern color stripes (7 slots — derived from accent by hue rotation)
  ref('--theme-patternlist-color-1', '--theme-accent',       'solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-color-2', '--theme-panel-timeline','solid','Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-color-3', '--theme-panel-pianoroll','solid','Workspace panels','pattern-list'),
  ref('--theme-patternlist-color-4', '--theme-panel-preview','solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-color-5', '--theme-panel-grid',   'solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-color-6', '--theme-panel-node',   'solid', 'Workspace panels', 'pattern-list'),
  ref('--theme-patternlist-color-7', '--theme-warning',      'solid', 'Workspace panels', 'pattern-list'),
  explicit('--theme-pattern-list-item-hover-bg', '#1d1f28', 'any', 'Workspace panels', 'pattern-list'),

  // ─── Stock effects: Shared primitives (§3.4.7) ────────────────────────
  ref('--theme-fx-plugin-bg',              '--theme-bg-surface',   'any',   'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-plugin-border',          '--theme-border-subtle','solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-plugin-titlebar-bg',     '--theme-bg-elevated',  'any',   'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-plugin-titlebar-fg',     '--theme-text',         'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-bypass-off',             '--theme-text-muted',   'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-bypass-on',              '--theme-accent',       'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-preset-bg',              '--theme-bg-surface',   'any',   'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-preset-fg',              '--theme-text',         'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-preset-hover',           '--theme-bg-hover',     'any',   'Stock effects', 'stock-effects.shared'),
  // Large knob
  explicit('--theme-fx-knob-lg-track', 'rgba(255, 255, 255, 0.08)', 'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-lg-fill',       '--theme-accent',           'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-lg-ring',       '--theme-border-strong',    'solid',  'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-lg-indicator',  '--theme-text',             'solid',  'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-lg-label',      '--theme-text-muted',       'solid',  'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-lg-value',      '--theme-text',             'solid',  'Stock effects', 'stock-effects.shared'),
  explicit('--theme-fx-knob-lg-bg',    '#1A1A24',                  'any',    'Stock effects', 'stock-effects.shared'),
  explicit('--theme-fx-knob-lg-border','#2A2A38',                  'solid',  'Stock effects', 'stock-effects.shared'),
  // Small knob
  explicit('--theme-fx-knob-sm-track', 'rgba(255, 255, 255, 0.08)', 'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-sm-fill',       '--theme-accent',           'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-sm-label',      '--theme-text-muted',       'solid',  'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-knob-sm-value',      '--theme-text',             'solid',  'Stock effects', 'stock-effects.shared'),
  // Slider
  ref('--theme-fx-slider-track', '--theme-border-subtle','linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-slider-thumb', '--theme-accent',       'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-slider-fill',  '--theme-accent',       'linear', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-slider-label', '--theme-text-muted',   'solid',  'Stock effects', 'stock-effects.shared'),
  // Toggle
  ref('--theme-fx-toggle-off',   '--theme-text-muted',   'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-toggle-on',    '--theme-accent',       'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-toggle-label', '--theme-text',         'solid', 'Stock effects', 'stock-effects.shared'),
  // Display surface
  ref('--theme-fx-display-bg',        '--theme-bg-primary',  'any',   'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-display-grid-major','--theme-border-strong','solid','Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-display-grid-minor','--theme-border-subtle','solid','Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-axis-label',        '--theme-text-muted',  'solid', 'Stock effects', 'stock-effects.shared'),
  // Draggable handle
  ref('--theme-fx-handle-default',  '--theme-text',         'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-handle-hover',    '--theme-accent-hover', 'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-handle-dragging', '--theme-accent-active','solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-handle-selected', '--theme-accent',       'solid', 'Stock effects', 'stock-effects.shared'),
  ref('--theme-fx-readout-fg',      '--theme-text',         'solid', 'Stock effects', 'stock-effects.shared'),
  // Plugin window drop shadow — applied to all floating effect panels
  explicit('--theme-fx-plugin-shadow', '0 8px 32px rgba(0, 0, 0, 0.5)', 'solid', 'Stock effects', 'stock-effects.shared', 'shadow'),
  explicit('--theme-fx-plugin-shadow-top', '0 -4px 24px rgba(0, 0, 0, 0.5)', 'solid', 'Stock effects', 'stock-effects.shared', 'shadow'),
  // Active-drag stroke on interactive handles — maximum-contrast white
  explicit('--theme-fx-drag-indicator', '#FFFFFF', 'solid', 'Stock effects', 'stock-effects.shared'),

  // Subtle surface tint used across FX subsystems for inset panel backgrounds
  // (19 sites across eq/dynamics/filter/modulation/time/dist + time-based
  // mixer surfaces). crossSubsystem:true so any FX consumer's Gate 3
  // admits it without the subsystem-shared hop.
  explicitX('--theme-fx-surface-tint-subtle', 'rgba(255, 255, 255, 0.05)', 'any', 'Stock effects', 'stock-effects.shared'),
  explicitX('--theme-fx-surface-tint-medium', 'rgba(255, 255, 255, 0.12)', 'any', 'Stock effects', 'stock-effects.shared'),
  explicitX('--theme-fx-surface-tint-strong', 'rgba(255, 255, 255, 0.25)', 'any', 'Stock effects', 'stock-effects.shared'),

  // ─── Stock effects: Xleth EQ (§3.4.8) ─────────────────────────────────
  // 16 band colors, matching eqStore.js exactly
  derivedFormula('--theme-eq-band-1',  'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-2',  '#FF6B6B', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-3',  '#69DB7C', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-4',  '#FFA94D', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-5',  '#748FFC', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-6',  '#B197FC', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-7',  '#FFD93D', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-8',  '#FF6B9D', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-9',  '#4ECDC4', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-10', '#FC5C65', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-11', '#45AAF2', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-12', '#FED330', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-13', '#A55EEA', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-14', '#26DE81', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-15', '#FD9644', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-band-16', '#2BCBBA', 'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-handle-default',  '--theme-text',         'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-handle-hover',    '--theme-accent-hover', 'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-handle-selected', '--theme-accent',       'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-handle-dragging', '--theme-accent-active','solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-response-curve',        '--theme-accent',       'solid', 'Stock effects', 'stock-effects.eq'),
  derivedFormula('--theme-eq-response-fill', 'any', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-spectrum-pre',  'rgba(255, 255, 255, 0.10)', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-spectrum-post', 'rgba(255, 255, 255, 0.25)', 'solid', 'Stock effects', 'stock-effects.eq'),
  // EQ-A spectrum-fill gradient stops + stroke. The post-EQ analyzer is
  // rendered as a vertical linear gradient over the live spectrum bars; the
  // pre-EQ overlay uses a muted variant of the same shape. Stroke colors are
  // the crisp top edge that defines local peaks. Defaults match the current
  // cool blue / muted gray-blue Xleth EQ palette and are user-editable
  // through the theme editor (Stock effects → Xleth EQ).
  explicit('--theme-eq-spectrum-fill-top',        'rgba(122, 184, 255, 0.55)', 'any',   'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-spectrum-fill-bottom',     'rgba(122, 184, 255, 0.05)', 'any',   'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-spectrum-stroke',          'rgba(122, 184, 255, 0.85)', 'solid', 'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-pre-spectrum-fill-top',    'rgba(74, 85, 104, 0.40)',   'any',   'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-pre-spectrum-fill-bottom', 'rgba(74, 85, 104, 0.05)',   'any',   'Stock effects', 'stock-effects.eq'),
  explicit('--theme-eq-pre-spectrum-stroke',      'rgba(74, 85, 104, 0.55)',   'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-octave-grid', '--theme-border-subtle', 'solid', 'Stock effects', 'stock-effects.eq'),
  ref('--theme-eq-db-grid',     '--theme-border-subtle', 'solid', 'Stock effects', 'stock-effects.eq'),

  // ─── Stock effects: Dynamics (§3.4.9) ─────────────────────────────────
  ref('--theme-dyn-transfer-curve',       '--theme-accent',        'solid', 'Stock effects', 'stock-effects.dynamics'),
  derivedFormula('--theme-dyn-transfer-fill', 'any', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-threshold-line',       '--theme-warning',       'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-threshold-label',      '--theme-text',          'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-ceiling-line',         '--theme-danger',        'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-knee-visualization',   '--theme-accent',        'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-gr-meter-fg',          '--theme-danger',        'linear','Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-gr-peak-line',         '--theme-text',          'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-attack-indicator',     '--theme-accent',        'solid', 'Stock effects', 'stock-effects.dynamics'),
  ref('--theme-dyn-release-indicator',    '--theme-accent',        'solid', 'Stock effects', 'stock-effects.dynamics'),
  explicit('--theme-dyn-transient-attack-fill', 'rgba(255, 160, 60, 0.30)','any','Stock effects','stock-effects.dynamics'),
  derivedFormula('--theme-dyn-transient-sustain-fill', 'any', 'Stock effects', 'stock-effects.dynamics'),
  // Smart Balance stereo field
  explicit('--theme-dyn-sb-left-fill',  'rgba(255, 107, 107, 0.25)','any','Stock effects','stock-effects.dynamics'),
  explicit('--theme-dyn-sb-right-fill', 'rgba(77, 150, 255, 0.25)', 'any','Stock effects','stock-effects.dynamics'),
  explicit('--theme-dyn-sb-center-dot', '#FFD93D',                  'solid','Stock effects','stock-effects.dynamics'),
  explicit('--theme-dyn-sb-boundary',   'rgba(255, 255, 255, 0.15)','solid','Stock effects','stock-effects.dynamics'),
  explicit('--theme-smartbalance-band-sub',      '#FF6B6B', 'solid', 'Stock effects', 'stock-effects.dynamics'),
  explicit('--theme-smartbalance-band-lowmid',   '#FFD93D', 'solid', 'Stock effects', 'stock-effects.dynamics'),
  explicit('--theme-smartbalance-band-uppermid', '#6BCB77', 'solid', 'Stock effects', 'stock-effects.dynamics'),
  explicit('--theme-smartbalance-band-air',      '#4D96FF', 'solid', 'Stock effects', 'stock-effects.dynamics'),

  // ─── Stock effects: Filter (§3.4.10) — plannedDeferred ────────────────
  ref('--theme-filter-response-curve',     '--theme-accent',        'solid', 'Stock effects', 'stock-effects.filter'),
  derivedFormula('--theme-filter-response-fill', 'any', 'Stock effects', 'stock-effects.filter'),
  ref('--theme-filter-cutoff-indicator',   '--theme-warning',       'solid', 'Stock effects', 'stock-effects.filter'),
  ref('--theme-filter-resonance-marker',   '--theme-danger',        'solid', 'Stock effects', 'stock-effects.filter'),
  ref('--theme-filter-type-label',         '--theme-text-muted',    'solid', 'Stock effects', 'stock-effects.filter'),

  // ─── Stock effects: Modulation (§3.4.11) ──────────────────────────────
  ref('--theme-mod-lfo-stroke',     '--theme-accent',       'solid', 'Stock effects', 'stock-effects.modulation'),
  ref('--theme-mod-phase-indicator','--theme-warning',      'solid', 'Stock effects', 'stock-effects.modulation'),
  ref('--theme-mod-depth-fill',     '--theme-accent',       'linear','Stock effects', 'stock-effects.modulation'),
  ref('--theme-mod-rate-indicator', '--theme-accent',       'solid', 'Stock effects', 'stock-effects.modulation'),
  ref('--theme-mod-drywet-indicator','--theme-text-muted',  'solid', 'Stock effects', 'stock-effects.modulation'),
  // Phanjer per-effect submixes
  ref('--theme-mod-phanjer-chorus',  '--theme-panel-pianoroll','solid','Stock effects','stock-effects.modulation'),
  ref('--theme-mod-phanjer-flanger', '--theme-panel-timeline', 'solid','Stock effects','stock-effects.modulation'),
  ref('--theme-mod-phanjer-phaser',  '--theme-panel-grid',     'solid','Stock effects','stock-effects.modulation'),

  // ─── Stock effects: Time — Delay, Reverb (§3.4.12) ────────────────────
  ref('--theme-time-delay-tap',       '--theme-accent',     'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-feedback-loop',   '--theme-warning',    'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-division-marker', '--theme-text-muted', 'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-reverb-ir-primary',   '--theme-accent',     'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-reverb-ir-secondary', '--theme-text-muted', 'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-damping-curve',    '--theme-warning',    'solid', 'Stock effects', 'stock-effects.time'),
  ref('--theme-time-predelay-indicator','--theme-text',      'solid', 'Stock effects', 'stock-effects.time'),

  // ─── Stock effects: Distortion (§3.4.13) ──────────────────────────────
  ref('--theme-dist-waveshape-curve',    '--theme-accent',        'solid', 'Stock effects', 'stock-effects.distortion'),
  derivedFormula('--theme-dist-waveshape-fill', 'any', 'Stock effects', 'stock-effects.distortion'),
  explicit('--theme-dist-input-overlay', 'rgba(255, 255, 255, 0.25)','solid','Stock effects','stock-effects.distortion'),
  ref('--theme-dist-drive-indicator',     '--theme-warning',      'solid', 'Stock effects', 'stock-effects.distortion'),
  ref('--theme-dist-asymmetry-indicator', '--theme-danger',       'solid', 'Stock effects', 'stock-effects.distortion'),

  // ─── Specialized editors: Syllable Splitter (§3.4.20) ─────────────────
  ref('--theme-syllable-modal-bg',       '--theme-bg-elevated',   'any',   'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-waveform-bg',    '--theme-bg-primary',    'any',   'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-waveform-fg',    '--theme-text-muted',    'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-marker',         '--theme-accent',        'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-marker-hover',   '--theme-accent-hover',  'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-marker-dragging','--theme-accent-active', 'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-segment-bg',     '--theme-bg-surface',    'any',   'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-segment-fg',     '--theme-text',          'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-input-bg',       '--theme-bg-primary',    'any',   'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-input-fg',       '--theme-text',          'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-input-placeholder','--theme-text-placeholder','solid','Specialized editors','syllable-splitter'),
  ref('--theme-syllable-play-button',    '--theme-accent',        'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-clear-button',   '--theme-danger',        'solid', 'Specialized editors', 'syllable-splitter'),
  ref('--theme-syllable-save-button',    '--theme-accent',        'solid', 'Specialized editors', 'syllable-splitter'),
  derivedFormula('--theme-syllable-accent-light', 'solid', 'Specialized editors', 'syllable-splitter'),
  // dimmed canvas waveform color for inactive regions
  explicit('--theme-syllable-splitter-wave-dim',  '#3a3a4a', 'solid', 'Specialized editors', 'syllable-splitter'),
  // canvas-painted label text; intentionally dimmer than --theme-text because canvas text lacks subpixel anti-aliasing and reads brighter at the same value
  explicit('--theme-syllable-splitter-label-fg',  '#d0d0d8', 'solid', 'Specialized editors', 'syllable-splitter'),
  // canvas background constant — darker than --theme-bg-primary (SyllableSplitter.jsx:10).
  explicit('--theme-syllable-splitter-bg', '#1b1b24', 'any', 'Specialized editors', 'syllable-splitter'),
  // alternating section tint for the syllable timeline (SyllableSplitter.jsx:15).
  derivedFormula('--theme-syllable-section-alt', 'any', 'Specialized editors', 'syllable-splitter'),

  // ─── Specialized editors: Lip Sync Picker (§3.4.21) ───────────────────
  ref('--theme-lipsync-video-bg',    '--theme-bg-primary',   'any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-video-frame', '--theme-border-subtle','solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-waveform-fg', '--theme-text-muted',   'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-waveform-bg', '--theme-bg-primary',   'any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-waveform-playhead','--theme-accent',  'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-in-marker',   '--theme-accent',       'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-out-marker',  '--theme-warning',      'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-timecode-fg', '--theme-text',         'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-category-dropdown','--theme-bg-surface','any', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-sample-input-bg','--theme-bg-primary','any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-sample-input-fg','--theme-text',      'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-add-button',  '--theme-accent',       'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-marked-list-bg','--theme-bg-surface', 'any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-marked-item-bg','--theme-bg-surface', 'any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-marked-item-hover','--theme-bg-hover','any',   'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-count-chip-bg','--theme-bg-active',   'any',   'Specialized editors', 'lip-sync-picker'),
  derivedFormula('--theme-lipsync-selection-fill', 'solid', 'Specialized editors', 'lip-sync-picker'),
  ref('--theme-lipsync-handle',                  '--theme-accent',           'solid', 'Specialized editors', 'lip-sync-picker'),
  // NOTE: --theme-lipsync-playback-indicator (0.35) and --theme-lipsync-scroll-thumb
  // (0.55) were renamed to --theme-waveform-envelope-fill and --theme-waveform-rms-body
  // and moved to the waveform-shared subsystem. Their previous names were
  // semantically incorrect per spec §3.4.21 — sampler, syllable splitter, and
  // lip-sync picker all use these values for the same roles.

  // ─── Specialized editors: Waveform (shared) (§3.4.26) ─────────────────
  // Cross-subsystem primitives for waveform rendering. crossSubsystem:true
  // allows Gate 3 of the v2 enrichment classifier to accept these tokens as
  // matches for values found in sampler/syllable-splitter/lip-sync-picker
  // without requiring subsystem equality; such acceptance is flagged as
  // gatesPassed:[...,'subsystem:crossSubsystem'] in the v2 audit trail.
  derivedFormula('--theme-waveform-envelope-fill', 'any', 'Specialized editors', 'waveform-shared'),
  derivedFormula('--theme-waveform-rms-body',  'any', 'Specialized editors', 'waveform-shared'),

  // ─── Global UI: Toast notifications (§3.4.25) ─────────────────────────
  explicit('--theme-toast-shadow', '0 6px 20px rgba(0, 0, 0, 0.5)', 'solid', 'Global UI', 'toast', 'shadow'),

  // ─── Labels (§3.4.x — promoted top-level per Clarification #3) ────────
  // Cross-cutting sample-category identity colors — used across
  // sample-selector, grid-editor, timeline track stripes, pattern-list.
  // Values mirror constants/labels.js + theme.css exactly.
  explicit('--theme-label-kick',   '#FF6B6B', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-snare',  '#FFA94D', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-hihat',  '#FFD93D', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-crash',  '#FF6B9D', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-pitch',  '#69DB7C', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-quote',  '#748FFC', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-custom', '#B197FC', 'solid', 'Labels', 'labels'),
  explicit('--theme-label-perc', '#E67E51', 'solid', 'Labels', 'labels'),

  // ─── Labels: Track palette (Pass 6B) ──────────────────────────────────────
  // User-editable 16-slot track identity color palette.
  // Consumed by Timeline/Mixer/Grid in future passes; not consumed here.
  // Values must remain solid hex — Theme Editor ColorPicker and canvas
  // hexToRgba() helpers both require valid #RRGGBB.
  explicit('--theme-track-palette-1',  '#4CC9F0', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-2',  '#7BD88F', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-3',  '#FF9F5A', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-4',  '#9B7BFF', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-5',  '#F472B6', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-6',  '#FFD166', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-7',  '#5B8DEF', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-8',  '#2DD4BF', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-9',  '#FF6B6B', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-10', '#A3D65C', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-11', '#C084FC', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-12', '#38BDF8', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-13', '#FBBF24', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-14', '#8EA4D2', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-15', '#6EE7B7', 'solid', 'Labels', 'track-palette'),
  explicit('--theme-track-palette-16', '#FB7185', 'solid', 'Labels', 'track-palette'),
];

// ──────────────────────────────────────────────────────────────────────────
// Indices + helpers
// ──────────────────────────────────────────────────────────────────────────

export const TOKENS_BY_NAME: Readonly<Record<string, TokenDef>> = (() => {
  const out: Record<string, TokenDef> = {};
  for (const t of TOKENS) {
    if (out[t.name]) throw new Error(`catalog: duplicate token "${t.name}"`);
    out[t.name] = t;
  }
  return out;
})();

export const TOKEN_NAMES: ReadonlyArray<string> = TOKENS.map(t => t.name);

/** Names of the 5 base tokens — for quick membership checks. */
export const BASE_TOKEN_NAMES_SET: ReadonlySet<string> = new Set(
  TOKENS.filter(t => t.derivation.type === 'base').map(t => t.name),
);

/** Names of tokens computed by deriveTheme() — detachable via `derivationDetached`. */
export const DERIVED_FORMULA_TOKEN_NAMES_SET: ReadonlySet<string> = new Set(
  TOKENS.filter(t => t.derivation.type === 'derived-formula').map(t => t.name),
);

export function tokensByCategory(): Record<CategoryName, TokenDef[]> {
  const out: Record<string, TokenDef[]> = {};
  for (const c of CATEGORIES) out[c] = [];
  for (const t of TOKENS) (out[t.category] ??= []).push(t);
  return out as Record<CategoryName, TokenDef[]>;
}

export function tokensBySubsystem(): Record<string, TokenDef[]> {
  const out: Record<string, TokenDef[]> = {};
  for (const s of SUBSYSTEMS) out[s.key] = [];
  for (const t of TOKENS) (out[t.subsystem] ??= []).push(t);
  return out;
}

export const CATALOG_STATS = {
  totalTokens: TOKENS.length,
  byCategory: (() => {
    const c: Record<string, number> = {};
    for (const t of TOKENS) c[t.category] = (c[t.category] || 0) + 1;
    return c;
  })(),
  bySubsystem: (() => {
    const c: Record<string, number> = {};
    for (const t of TOKENS) c[t.subsystem] = (c[t.subsystem] || 0) + 1;
    return c;
  })(),
};
