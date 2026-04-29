import { useEffect, useRef } from 'react';
import {
  register,
  onPanelBlur,
  onPanelFocus,
  type BindingOptions,
  type HandlerResult,
  type ScopeId,
} from './KeyboardManager';
import type { PanelId } from '../registry/panelCatalog';

export interface UseKeyboardBindingOptions {
  enabled?: boolean;
  when?: () => boolean;
  allowInTextEntry?: boolean;
}

// Registers a single keyboard binding for the lifetime of the component.
// The handler is read through a ref, so consumers can close over fresh
// state on every render without re-registering — that's the point: it
// kills the long-dep-array re-registration churn that compounded Bug 1.
export function useKeyboardBinding(
  scope: ScopeId,
  combo: string,
  handler: (event: KeyboardEvent) => HandlerResult,
  options?: UseKeyboardBindingOptions,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const whenRef = useRef(options?.when);
  whenRef.current = options?.when;

  const enabled = options?.enabled ?? true;
  const allowInTextEntry = options?.allowInTextEntry ?? false;

  useEffect(() => {
    if (!enabled) return;
    const opts: BindingOptions = {
      scope,
      combo,
      handler: (e) => handlerRef.current(e),
      when: () => (whenRef.current ? whenRef.current() : true),
      allowInTextEntry,
    };
    return register(opts);
  }, [scope, combo, enabled, allowInTextEntry]);
}

export function usePanelFocusEffect(
  panelId: PanelId,
  onFocus: (() => void) | null | undefined,
  onBlur: (() => void) | null | undefined,
): void {
  const focusRef = useRef(onFocus);
  focusRef.current = onFocus;
  const blurRef = useRef(onBlur);
  blurRef.current = onBlur;

  useEffect(() => {
    const unsubFocus = onPanelFocus(panelId, () => { focusRef.current?.(); });
    const unsubBlur = onPanelBlur(panelId, () => { blurRef.current?.(); });
    return () => { unsubFocus(); unsubBlur(); };
  }, [panelId]);
}
