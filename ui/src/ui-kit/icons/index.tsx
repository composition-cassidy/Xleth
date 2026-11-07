import type { ComponentType, SVGProps } from 'react';
import { GLYPHS, type GlyphName } from './glyphs';

export type { GlyphName } from './glyphs';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name' | 'ref'> {
  /** Pixel size; the glyph is drawn on a 16px grid and scales from it. Default 16. */
  size?: number | string;
  /** Accepted so call sites written for Lucide still compile; the stroke is fixed at 1.5. */
  strokeWidth?: unknown;
}

/**
 * One icon. Decorative by default (`aria-hidden`); pass `aria-label` to make it
 * a named image. The stroke weight is the family's 1.5 and cannot be overridden.
 */
export function Icon({ name, size = 16, strokeWidth: _ignored, ...rest }: IconProps & { name: GlyphName }) {
  const named = typeof rest['aria-label'] === 'string' && rest['aria-label'] !== '';
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      focusable="false"
      role={named ? 'img' : undefined}
      aria-hidden={named ? undefined : true}
      {...rest}
    >
      {GLYPHS[name]}
    </svg>
  );
}

function make(name: GlyphName, displayName: string): ComponentType<IconProps> {
  const Glyph = (props: IconProps) => <Icon name={name} {...props} />;
  Glyph.displayName = displayName;
  return Glyph;
}

export const TimelineIcon = make('timeline', 'TimelineIcon');
export const BrowserIcon = make('browser', 'BrowserIcon');
export const PreviewIcon = make('preview', 'PreviewIcon');
export const InspectorIcon = make('inspector', 'InspectorIcon');
export const DevicesIcon = make('devices', 'DevicesIcon');
export const MixerIcon = make('mixer', 'MixerIcon');
export const PianoRollIcon = make('pianoRoll', 'PianoRollIcon');
export const SamplerIcon = make('sampler', 'SamplerIcon');
export const FxGraphIcon = make('fxGraph', 'FxGraphIcon');
export const NodeEditorIcon = make('nodeEditor', 'NodeEditorIcon');
export const QuickNotationIcon = make('quickNotation', 'QuickNotationIcon');
export const SplitSyllablesIcon = make('splitSyllables', 'SplitSyllablesIcon');
export const SandboxIcon = make('sandbox', 'SandboxIcon');
export const SelectToolIcon = make('select', 'SelectToolIcon');
export const DrawToolIcon = make('draw', 'DrawToolIcon');
export const SliceToolIcon = make('slice', 'SliceToolIcon');
export const DeleteToolIcon = make('delete', 'DeleteToolIcon');
export const SourceVideoIcon = make('sourceVideo', 'SourceVideoIcon');
export const SourceAudioIcon = make('sourceAudio', 'SourceAudioIcon');
export const MediaIcon = make('media', 'MediaIcon');

export const GLYPH_NAMES = Object.keys(GLYPHS) as GlyphName[];
