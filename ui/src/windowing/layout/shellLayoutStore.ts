import { create } from 'zustand';
import type { TopRowMode } from './shellLayout';

// Renderer-only shell state that is not part of a saved layout: whether the top
// row is folded to its strip (derived from the window size by useShellLayout)
// and whether the user has peeked it open as a sheet. Nothing here is persisted.

export interface ShellLayoutState {
  topMode: TopRowMode;
  /** The folded top row is shown as a 200px sheet over the arrangement. */
  peek: boolean;
  setTopMode: (mode: TopRowMode) => void;
  setPeek: (peek: boolean) => void;
}

export const useShellLayoutStore = create<ShellLayoutState>((set) => ({
  topMode: 'full',
  peek: false,
  setTopMode: (topMode) => set((s) => (s.topMode === topMode ? s : {
    topMode,
    // A peek only means something while the row is folded.
    peek: topMode === 'strip' ? s.peek : false,
  })),
  setPeek: (peek) => set((s) => (s.peek === peek ? s : { peek })),
}));

/**
 * Regions the shell is not showing right now. Their panels stay mounted (state,
 * caches, engine subscriptions survive) but report themselves not visible, so
 * the Preview stops decoding and canvases stop drawing into a 0-size box.
 */
export function isRegionHiddenByShell(
  state: Pick<ShellLayoutState, 'topMode' | 'peek'>,
  region: string,
): boolean {
  if (region === 'top') return state.topMode === 'strip' && !state.peek;
  return false;
}

export function resetShellLayoutStore(): void {
  useShellLayoutStore.setState({ topMode: 'full', peek: false });
}
