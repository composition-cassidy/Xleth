import { PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { cancelDrag, getDragState } from './DragManager';
import { cancelDockRegionResizeIfActive } from './DockRegionResizeManager';
import { cancelResizeIfActive } from './ResizeManager';

// ─── Router types ──────────────────────────────────────────────────────────

export type ScopeId = 'global' | 'overlay' | `panel:${PanelId}`;

export type HandlerResult = void | boolean | 'handled';

export interface BindingOptions {
  scope: ScopeId;
  combo: string;
  handler: (event: KeyboardEvent) => HandlerResult;
  when?: () => boolean;
  allowInTextEntry?: boolean;
}

interface Registration extends BindingOptions {}

// ─── Internal state ────────────────────────────────────────────────────────

const registrations = new Set<Registration>();
const overlayOrder: Registration[] = [];
const legacyGlobalRegs = new Map<string, Registration>();

const panelFocusListeners = new Map<PanelId, Set<() => void>>();
const panelBlurListeners = new Map<PanelId, Set<() => void>>();
let lastFocusedPanel: PanelId | null = null;
let unsubscribeRegistry: (() => void) | null = null;

// ─── Helpers ───────────────────────────────────────────────────────────────

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  return (
    element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement
  );
}

function normalizeKey(key: string): string {
  return key;
}

function normalizeEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(event.key);
  return parts.join('+');
}

// Effective focused panel: must be both focused AND visible.
// Gating on both is intentional — a hidden-but-mounted panel
// (keepAliveWhenHidden) must never receive shortcuts even if a bug
// somewhere left its focused flag set. This is the core of the fix.
export function resolveFocusedPanel(): PanelId | null {
  const { panels } = usePanelRegistry.getState();
  return PANEL_IDS.find((id) => panels[id].focused && !panels[id].hidden) ?? null;
}

function tryFire(reg: Registration, event: KeyboardEvent): boolean {
  if (reg.when && !reg.when()) return false;
  const result = reg.handler(event);
  return result === 'handled' || result === true || event.defaultPrevented;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

function dispatchOverlay(event: KeyboardEvent): boolean {
  const combo = normalizeEvent(event);
  const targetIsTextEntry = isTextEntryElement(event.target as Element | null);
  // Walk LIFO — topmost overlay claims first.
  for (let i = overlayOrder.length - 1; i >= 0; i--) {
    const reg = overlayOrder[i];
    if (reg.combo !== combo) continue;
    if (targetIsTextEntry && !reg.allowInTextEntry) continue;
    if (tryFire(reg, event)) {
      // Match SamplePicker's existing semantics: claim the key absolutely so
      // un-migrated bubble listeners (TransportBar etc.) don't also fire.
      event.stopImmediatePropagation();
      return true;
    }
  }
  return false;
}

function dispatchMain(event: KeyboardEvent): boolean {
  const combo = normalizeEvent(event);
  const activeElement = typeof document === 'undefined' ? null : document.activeElement;
  if (isTextEntryElement(activeElement)) {
    // Text-entry guard. Only bindings that opt in fire while typing.
    for (const reg of registrations) {
      if (!reg.allowInTextEntry) continue;
      if (reg.combo !== combo) continue;
      if (reg.scope === 'overlay') continue; // overlay handled in capture phase
      if (tryFire(reg, event)) return true;
    }
    return false;
  }

  const focused = resolveFocusedPanel();
  if (focused) {
    const panelScope: ScopeId = `panel:${focused}`;
    for (const reg of registrations) {
      if (reg.scope !== panelScope) continue;
      if (reg.combo !== combo) continue;
      if (tryFire(reg, event)) return true;
    }
  }
  for (const reg of registrations) {
    if (reg.scope !== 'global') continue;
    if (reg.combo !== combo) continue;
    if (tryFire(reg, event)) return true;
  }
  return false;
}

// ─── Public API: registration ──────────────────────────────────────────────

export function register(opts: BindingOptions): () => void {
  const reg: Registration = { ...opts };
  registrations.add(reg);
  if (opts.scope === 'overlay') overlayOrder.push(reg);
  return () => {
    registrations.delete(reg);
    if (opts.scope === 'overlay') {
      const idx = overlayOrder.indexOf(reg);
      if (idx >= 0) overlayOrder.splice(idx, 1);
    }
  };
}

// ─── Public API: focus subscription ────────────────────────────────────────

export function onPanelFocus(id: PanelId, fn: () => void): () => void {
  let set = panelFocusListeners.get(id);
  if (!set) { set = new Set(); panelFocusListeners.set(id, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}

export function onPanelBlur(id: PanelId, fn: () => void): () => void {
  let set = panelBlurListeners.get(id);
  if (!set) { set = new Set(); panelBlurListeners.set(id, set); }
  set.add(fn);
  return () => { set!.delete(fn); };
}

function syncFocusedPanel(): void {
  const next = resolveFocusedPanel();
  if (next === lastFocusedPanel) return;
  const prev = lastFocusedPanel;
  lastFocusedPanel = next;
  if (prev) panelBlurListeners.get(prev)?.forEach((fn) => fn());
  if (next) panelFocusListeners.get(next)?.forEach((fn) => fn());
}

// ─── Default bindings (global scope) ───────────────────────────────────────

function registerDefaultBindings(): void {
  registerBinding('F5', () => usePanelRegistry.getState().togglePanel('timeline'));
  registerBinding('F6', () => usePanelRegistry.getState().togglePanel('sampleSelector'));
  registerBinding('F7', () => usePanelRegistry.getState().togglePanel('pianoRoll'));
  registerBinding('F8', () => usePanelRegistry.getState().togglePanel('preview'));
  registerBinding('F9', () => usePanelRegistry.getState().togglePanel('mixer'));
  registerBinding('F10', () => usePanelRegistry.getState().togglePanel('gridSettings'));
  registerBinding('F12', () => usePanelRegistry.getState().togglePanel('sampler'));
  registerBinding('Escape', () => {
    if (cancelResizeIfActive()) return;
    if (cancelDockRegionResizeIfActive()) return;
    if (getDragState().state === 'dragging') {
      cancelDrag();
      return;
    }
    const reg = usePanelRegistry.getState();
    const focusedId = PANEL_IDS.find((id) => reg.panels[id].focused);
    if (focusedId && reg.panels[focusedId].mode === 'maximized') {
      reg.restorePanel(focusedId);
    }
  });
  registerBinding('Ctrl+Shift+1', () => usePanelRegistry.getState().applyPreset('fl-compose'));
  registerBinding('Ctrl+Shift+2', () => usePanelRegistry.getState().applyPreset('vegas-arrange'));
  registerBinding('Ctrl+Shift+3', () => usePanelRegistry.getState().applyPreset('grid-edit'));
}

// ─── Backward-compat API (legacy single-binding-per-combo semantics) ───────

export function handleKeyEvent(event: KeyboardEvent): void {
  // Test entrypoint: bypass DOM, run main dispatch synchronously.
  // Overlays are not exercised here — tests don't construct overlay state.
  if (typeof document !== 'undefined' && isTextEntryElement(document.activeElement)) return;
  dispatchMain(event);
}

const onKeyDownDocument = (event: KeyboardEvent) => { dispatchMain(event); };
const onKeyDownWindowCapture = (event: KeyboardEvent) => { dispatchOverlay(event); };

export function init(): void {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', onKeyDownDocument);
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', onKeyDownWindowCapture, { capture: true });
  }
  lastFocusedPanel = resolveFocusedPanel();
  unsubscribeRegistry = usePanelRegistry.subscribe(() => syncFocusedPanel());
}

export function destroy(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', onKeyDownDocument);
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDownWindowCapture, { capture: true });
  }
  unsubscribeRegistry?.();
  unsubscribeRegistry = null;
}

export function registerBinding(key: string, action: () => void): void {
  const combo = normalizeKey(key);
  const existing = legacyGlobalRegs.get(combo);
  if (existing) {
    registrations.delete(existing);
    legacyGlobalRegs.delete(combo);
  }
  const reg: Registration = {
    scope: 'global',
    combo,
    handler: () => { action(); return 'handled'; },
  };
  registrations.add(reg);
  legacyGlobalRegs.set(combo, reg);
}

export function getBindings(): ReadonlyMap<string, () => void> {
  const map = new Map<string, () => void>();
  for (const [combo, reg] of legacyGlobalRegs) {
    map.set(combo, () => { reg.handler({} as KeyboardEvent); });
  }
  return map;
}

export function rebind(oldKey: string, newKey: string): boolean {
  const oldCombo = normalizeKey(oldKey);
  const newCombo = normalizeKey(newKey);
  if (legacyGlobalRegs.has(newCombo)) return false;
  const reg = legacyGlobalRegs.get(oldCombo);
  if (!reg) return true;
  registrations.delete(reg);
  legacyGlobalRegs.delete(oldCombo);
  const moved: Registration = { ...reg, combo: newCombo };
  registrations.add(moved);
  legacyGlobalRegs.set(newCombo, moved);
  return true;
}

// test-only
export function resetBindingsForTest(): void {
  registrations.clear();
  overlayOrder.length = 0;
  legacyGlobalRegs.clear();
  panelFocusListeners.clear();
  panelBlurListeners.clear();
  lastFocusedPanel = null;
  registerDefaultBindings();
}

registerDefaultBindings();
