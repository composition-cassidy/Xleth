import { createContext, useContext } from 'react';
import type { ComponentType, SVGProps } from 'react';
import { PHOSPHOR, type PhosphorName } from './phosphor.generated';
import { CUSTOM, type CustomName, type Prim } from './custom';

/**
 * XLETH's one icon family: Phosphor (MIT, 256 grid, Regular at rest, Fill when active), plus a
 * few custom glyphs drawn to the same grid and weight (./custom.ts). Colour is always
 * currentColor; there is no colour prop and no stroke-width override.
 * docs/ICON_PROPOSAL.md has the mapping and the rules.
 */
export type { PhosphorName } from './phosphor.generated';
export type { CustomName } from './custom';
export type IconName = PhosphorName | CustomName;
export type IconWeight = 'regular' | 'fill';

/**
 * The old house glyph names, kept as aliases so panel registries, the FX graph and saved data that
 * name a glyph keep working. Each resolves to the Phosphor or custom icon that replaced it.
 */
const LEGACY = {
  timeline: 'xleth-timeline', browser: 'xleth-browser', preview: 'monitor-play', inspector: 'xleth-inspector',
  devices: 'xleth-devices', mixer: 'faders', pianoRoll: 'piano-keys', sampler: 'xleth-sampler', fxGraph: 'graph',
  nodeEditor: 'flow-arrow', quickNotation: 'xleth-quick-notation', splitSyllables: 'xleth-split-syllables',
  sandbox: 'xleth-sandbox', select: 'cursor', draw: 'pencil-simple', paint: 'paint-brush', slice: 'scissors',
  delete: 'eraser', sourceVideo: 'film-strip', sourceAudio: 'waveform', media: 'images-square',
  nodeInput: 'sign-in', nodeOutput: 'sign-out', nodeEffect: 'xleth-node-effect', nodeMacro: 'xleth-node-macro',
  nodeLfo: 'wave-sine', nodeEnvelope: 'xleth-node-envelope', nodeSidechain: 'xleth-node-sidechain',
} as const satisfies Record<string, IconName>;
export type GlyphName = keyof typeof LEGACY;
export const GLYPH_NAMES = Object.keys(LEGACY) as GlyphName[];
export const ICON_NAMES = [...Object.keys(PHOSPHOR), ...Object.keys(CUSTOM)] as IconName[];

export function resolveIconName(name: IconName | GlyphName): IconName {
  return (LEGACY as Record<string, IconName>)[name] ?? (name as IconName);
}

/**
 * True inside a control that is "on" (a pressed IconButton, an on Toggle, a selected segment).
 * Icons inside render in Fill unless given an explicit weight. This is what makes
 * "active = Fill" automatic for every kit control.
 */
export const IconActive = createContext(false);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref' | 'color' | 'fill' | 'stroke'> {
  /** Pixel size. Default 16 (toolbars); 14 for rows, menus and glyph slots. Kit CSS may size it too. */
  size?: number | string;
  /** Force a weight. Omit to follow the host control: Fill when it is on, Regular otherwise. */
  weight?: IconWeight;
  /** Ignored: Phosphor has no stroke weight to override. Accepted so old call sites compile. */
  strokeWidth?: unknown;
}

function primEl(p: Prim, sw: number, key: number) {
  return (
    <path
      key={key}
      d={p.d}
      fill={p.fill ? 'currentColor' : 'none'}
      fillRule={p.evenodd ? 'evenodd' : undefined}
      stroke={p.stroke && sw > 0 ? 'currentColor' : undefined}
      strokeWidth={p.stroke && sw > 0 ? sw : undefined}
      strokeLinecap={p.stroke ? 'round' : undefined}
      strokeLinejoin={p.stroke ? 'round' : undefined}
      strokeDasharray={p.dash}
    />
  );
}

/** One icon. Decorative by default (aria-hidden); pass aria-label to make it a named image. */
export function Icon({ name, size = 16, weight, strokeWidth: _ignored, ...rest }: IconProps & { name: IconName | GlyphName }) {
  const active = useContext(IconActive);
  const w: IconWeight = weight ?? (active ? 'fill' : 'regular');
  const key = resolveIconName(name);
  const named = typeof rest['aria-label'] === 'string' && rest['aria-label'] !== '';
  const ph = (PHOSPHOR as Record<string, readonly [string, string]>)[key];
  const custom = ph ? null : (CUSTOM as Record<string, (typeof CUSTOM)[CustomName]>)[key];
  if (!ph && !custom && import.meta.env?.DEV) console.warn(`[Icon] unknown icon "${name}"`);
  const [s, tx, ty] = custom ? custom.tf : [1, 0, 0];
  return (
    <svg
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      role={named ? 'img' : undefined}
      aria-hidden={named ? undefined : true}
      data-icon={key}
      data-weight={w}
      {...rest}
    >
      {ph ? <path d={w === 'fill' ? ph[1] : ph[0]} /> : null}
      {custom ? (
        <g transform={s === 1 && tx === 0 && ty === 0 ? undefined : `translate(${tx} ${ty}) scale(${s})`}>
          {(w === 'fill' ? custom.fill : custom.regular).map((p, i) => primEl(p, custom.sw, i))}
        </g>
      ) : null}
    </svg>
  );
}

function make(name: IconName, displayName: string): ComponentType<IconProps> {
  const Glyph = (props: IconProps) => <Icon name={name} {...props} />;
  Glyph.displayName = displayName;
  return Glyph;
}

// Panel / tool / source components, used where an icon is passed as a component (panel registry,
// menus, tabs). They render the replacement icons listed in LEGACY.
export const TimelineIcon = make('xleth-timeline', 'TimelineIcon');
export const BrowserIcon = make('xleth-browser', 'BrowserIcon');
export const PreviewIcon = make('monitor-play', 'PreviewIcon');
export const InspectorIcon = make('xleth-inspector', 'InspectorIcon');
export const DevicesIcon = make('xleth-devices', 'DevicesIcon');
export const MixerIcon = make('faders', 'MixerIcon');
export const PianoRollIcon = make('piano-keys', 'PianoRollIcon');
export const SamplerIcon = make('xleth-sampler', 'SamplerIcon');
export const FxGraphIcon = make('graph', 'FxGraphIcon');
export const NodeEditorIcon = make('flow-arrow', 'NodeEditorIcon');
export const QuickNotationIcon = make('xleth-quick-notation', 'QuickNotationIcon');
export const SplitSyllablesIcon = make('xleth-split-syllables', 'SplitSyllablesIcon');
export const SandboxIcon = make('xleth-sandbox', 'SandboxIcon');
export const SelectToolIcon = make('cursor', 'SelectToolIcon');
export const DrawToolIcon = make('pencil-simple', 'DrawToolIcon');
export const SliceToolIcon = make('scissors', 'SliceToolIcon');
export const PaintToolIcon = make('paint-brush', 'PaintToolIcon');
export const DeleteToolIcon = make('eraser', 'DeleteToolIcon');
export const SourceVideoIcon = make('film-strip', 'SourceVideoIcon');
export const SourceAudioIcon = make('waveform', 'SourceAudioIcon');
export const MediaIcon = make('images-square', 'MediaIcon');

/** Build a component for any icon name, for APIs that take an icon component (menus, tabs). */
export function iconComponent(name: IconName, weight?: IconWeight): ComponentType<IconProps> {
  const Glyph = (props: IconProps) => <Icon name={name} weight={weight} {...props} />;
  Glyph.displayName = `Icon(${name})`;
  return Glyph;
}

export { drawIcon } from './canvas';
