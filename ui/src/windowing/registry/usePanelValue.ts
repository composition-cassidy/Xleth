import { usePanelRegistry, type PanelRegistryState, type PanelState } from './PanelRegistry';
import type { PanelId } from './panelCatalog';

// Two rules used to be copy-pasted into every windowing component; they live
// here now so each component states what it needs and nothing else.
//
// 1. SELECT PRIMITIVES. Zustand v5 wraps each selector in useCallback, so an
//    inline arrow gets a fresh identity every render and React 18's
//    useSyncExternalStore re-runs getSnapshot and compares with Object.is. A
//    selector returning an object then compares unequal every time the panel
//    map is cloned — even for panels whose data did not change — which raises
//    "getSnapshot should be cached" and ends in "Maximum update depth
//    exceeded". Primitives compare by value, so they stay stable.
//
// 2. READ getState() UNDER SSR. renderToStaticMarkup drives
//    useSyncExternalStore from getInitialState(), not the mutated getState(),
//    so a test that arranged the registry before rendering would see none of
//    its own setup. `typeof window` cannot change within one environment, so
//    the branch below never changes hook order.

export function useRegistryValue<T extends string | number | boolean | null | undefined>(
  select: (state: PanelRegistryState) => T,
): T {
  const reactive = usePanelRegistry(select);
  if (typeof window === 'undefined') return select(usePanelRegistry.getState());
  return reactive;
}

export function usePanelValue<T extends string | number | boolean | null | undefined>(
  id: PanelId,
  select: (panel: PanelState) => T,
): T {
  return useRegistryValue((state) => select(state.panels[id]));
}

/**
 * The per-open context whoever opened this panel handed it.
 *
 * Before this existed, `openPanel(id)` took only an id, so every panel that
 * needed an argument grew its own zustand store purely to carry one — a store
 * that existed to pass a parameter. Props live in the registry beside the panel
 * they belong to and are deliberately excluded from the persisted layout: they
 * describe one opening, not an arrangement.
 */
export function usePanelProps<T = Record<string, unknown>>(id: PanelId): T | null {
  const reactive = usePanelRegistry((state) => state.panelProps[id]);
  if (typeof window === 'undefined') {
    return (usePanelRegistry.getState().panelProps[id] ?? null) as T | null;
  }
  return (reactive ?? null) as T | null;
}
