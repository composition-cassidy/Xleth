import { useEffect, useRef } from 'react';
import {
  register,
  registerCommand,
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

/**
 * The catalog-driven form of useKeyboardBinding: binds a named command rather
 * than a literal combo, so the key it answers to is whatever Settings →
 * Application → Shortcuts currently resolves for that command.
 *
 * The scope and the combo both come from the catalog entry, which is the point
 * — a component that owns an action should not also be the place its key is
 * spelled, or the Settings editor and the component can disagree.
 *
 * Like useKeyboardBinding, the handler is read through a ref so a consumer can
 * close over fresh state every render without re-registering. Re-registration
 * happens only when the user rebinds, driven from KeyboardManager's own
 * subscription to the override store.
 */
export function useShortcutCommand(
  commandId: string,
  handler: (event: KeyboardEvent) => HandlerResult,
  options?: { enabled?: boolean },
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!enabled) return;
    return registerCommand(commandId, (e) => handlerRef.current(e));
  }, [commandId, enabled]);
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
