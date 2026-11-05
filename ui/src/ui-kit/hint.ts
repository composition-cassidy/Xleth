// Hint plumbing: every kit control takes `hint` / `hintMods` and renders them as
// `data-hint` / `data-hint-mods`, which the hint bar reads (components/HintBar).
export interface HintProps {
  /** What the control is and does; shown in the hint bar on hover. */
  hint?: string;
  /** Modifier help shown on the right of the hint bar ("Shift: fine · Ctrl+click: reset"). */
  hintMods?: string;
}

export function hintAttrs({ hint, hintMods }: HintProps): { 'data-hint'?: string; 'data-hint-mods'?: string } {
  const out: { 'data-hint'?: string; 'data-hint-mods'?: string } = {};
  if (hint) out['data-hint'] = hint;
  if (hintMods) out['data-hint-mods'] = hintMods;
  return out;
}

/** The modifier help every draggable value control shares (DESIGN.md section 7). */
export const VALUE_HINT_MODS = 'Drag: change · Shift: fine · Ctrl+click: reset · Double-click: type · Wheel: step';
