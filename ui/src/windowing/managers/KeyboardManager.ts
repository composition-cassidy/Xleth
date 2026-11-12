import { PANEL_IDS, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { getCommand, panelIdForCommand, SHORTCUT_COMMANDS } from './shortcutCatalog';
import {
  findCommandByCombo,
  resolveCombos,
  resetAll as resetOverrides,
  setComboSync,
  subscribe as subscribeOverrides,
} from './shortcutOverrides';
import { toggleDockFocus } from '../layout/dockFocus';
import { cancelDrag, getDragState } from './DragManager';
import { cancelDockedPanelResizeIfActive } from './DockedPanelResizeManager';
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
// Where the mouse last was. The panel under it is worked out when a key
// arrives (see resolveHoveredPanel), never remembered: a remembered panel goes
// stale whenever the page changes under a still pointer, and a pointerover-only
// tracker cannot recover inside one large element such as the arrangement
// canvas, because no boundary is crossed there to fire another pointerover.
// See dispatchMain for why the hovered panel outranks focus.
let pointerInWindow = false;
let pointerX = 0;
let pointerY = 0;
let pointerTarget: Element | null = null;

// ─── Helpers ───────────────────────────────────────────────────────────────

// <input> types that take no typed text. A focused checkbox, radio, colour
// well or slider is not "typing", so it must not switch every shortcut off.
// (Space/Enter on a checkbox or radio stay theirs: isNativelyActivatedElement.)
const NON_TEXT_INPUT_TYPES = new Set([
  'button', 'checkbox', 'color', 'file', 'image', 'radio', 'range', 'reset', 'submit',
]);

function isTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLElement && element.isContentEditable) return true;
  if (element instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(element.type);
  return element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
}

// A focused control the browser itself activates on Space/Enter (buttons,
// links, [role=button], checkboxes/radios). Space and Enter belong to
// whatever the user just tabbed to — a panel-scoped shortcut bound to the
// same combo (e.g. Sample Sandbox's Space-to-preview) must not preempt it,
// the same way it already can't steal keys from a focused text field. Without
// this, tabbing to a button inside a focused panel and pressing Space fires
// the panel's Space shortcut instead of the button — the shortcut's own
// preventDefault() then also blocks the browser's native activate-on-keyup,
// so the button silently never receives the click at all.
function isNativelyActivatedElement(element: Element | null): boolean {
  if (!element) return false;
  if (element instanceof HTMLButtonElement) return true;
  if (element instanceof HTMLAnchorElement && element.hasAttribute('href')) return true;
  // Every non-text <input> except the slider opens or toggles on Space/Enter.
  if (element instanceof HTMLInputElement) return NON_TEXT_INPUT_TYPES.has(element.type) && element.type !== 'range';
  if (element instanceof HTMLElement && element.getAttribute('role') === 'button') return true;
  return false;
}

function normalizeKey(key: string): string {
  return key;
}

function modifierPrefix(event: KeyboardEvent): string[] {
  const parts: string[] = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  return parts;
}

// The PHYSICAL key for character keys, independent of shift state and layout.
// event.key reports the character PRODUCED, so holding Shift turns the digit 1
// into an exclamation mark and a binding spelled Ctrl+Shift+1 can never match
// what the browser reports. event.code names the key cap instead.
function physicalKeyFromCode(code: unknown): string | null {
  if (typeof code !== 'string') return null;
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6);
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  return null;
}

function normalizeEvent(event: KeyboardEvent): string {
  return [...modifierPrefix(event), event.key].join('+');
}

/**
 * Every spelling this event can satisfy: what the key produced, then what key
 * was physically pressed. Bindings keep matching on event.key exactly as they
 * always have, and shifted-character combos now match as well.
 */
function eventCombos(event: KeyboardEvent): string[] {
  const mods = modifierPrefix(event);
  const combos = [[...mods, event.key].join('+')];
  const physical = physicalKeyFromCode((event as KeyboardEvent & { code?: unknown }).code);
  if (physical !== null && physical !== event.key) {
    combos.push([...mods, physical].join('+'));
  }
  return combos;
}

function comboMatches(reg: Registration, combos: string[]): boolean {
  return combos.includes(reg.combo);
}

// Effective focused panel: must be both focused AND visible.
// Gating on both is intentional — a hidden-but-mounted panel
// (keepAliveWhenHidden) must never receive shortcuts even if a bug
// somewhere left its focused flag set. This is the core of the fix.
export function resolveFocusedPanel(): PanelId | null {
  const { panels } = usePanelRegistry.getState();
  return PANEL_IDS.find((id) => panels[id].focused && !panels[id].hidden) ?? null;
}

// The panel under the mouse, if it can take keys: visible, not collapsed, and
// the active tab of its slot (an inactive tab is display:none, so the pointer
// can't truly be over it, but a stale pointerover from before a tab switch can).
export function resolveHoveredPanel(): PanelId | null {
  const hoveredPanel = panelIdOfTarget(elementUnderPointer());
  if (!hoveredPanel) return null;
  const panel = usePanelRegistry.getState().panels[hoveredPanel];
  if (!panel || panel.hidden || panel.collapsed) return null;
  if (panel.mode === 'docked' && panel.docked.tabActive === false) return null;
  return hoveredPanel;
}

function panelIdOfTarget(target: EventTarget | null): PanelId | null {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return null;
  const id = target.closest('[data-panel-id]')?.getAttribute('data-panel-id');
  return id && (PANEL_IDS as readonly string[]).includes(id) ? (id as PanelId) : null;
}

// What is under the mouse right now. Hit-tested at the last known position, so
// a menu that closed, a tab that switched or a window that opened under a still
// pointer is seen as it is at this instant. Environments with no layout (the
// unit tests) fall back to the element the last pointer event was aimed at.
function elementUnderPointer(): Element | null {
  if (!pointerInWindow || typeof document === 'undefined') return null;
  if (typeof document.elementFromPoint === 'function') {
    return document.elementFromPoint(pointerX, pointerY);
  }
  return pointerTarget && pointerTarget.isConnected ? pointerTarget : null;
}

const onPointerSeen = (event: Event) => {
  const pointer = event as PointerEvent;
  pointerInWindow = true;
  pointerX = pointer.clientX;
  pointerY = pointer.clientY;
  pointerTarget = event.target instanceof Element ? event.target : null;
};
// relatedTarget null = the pointer left the window entirely. If that reading is
// ever wrong, the next pointermove puts it right.
const onPointerOut = (event: Event) => {
  if (!(event as PointerEvent).relatedTarget) pointerInWindow = false;
};
const POINTER_SEEN_EVENTS = ['pointerover', 'pointermove', 'pointerdown'] as const;

function tryFire(reg: Registration, event: KeyboardEvent): boolean {
  if (reg.when && !reg.when()) return false;
  const result = reg.handler(event);
  return result === 'handled' || result === true || event.defaultPrevented;
}

function firePanelScope(panel: PanelId, combos: string[], event: KeyboardEvent): boolean {
  const panelScope: ScopeId = `panel:${panel}`;
  for (const reg of registrations) {
    if (reg.scope !== panelScope) continue;
    if (!comboMatches(reg, combos)) continue;
    if (tryFire(reg, event)) return true;
  }
  return false;
}

// A panel just answered a shortcut aimed at it by the mouse: make it the
// focused panel for real, so the control the user last clicked elsewhere stops
// holding the keyboard (Space/Enter would otherwise still press that button).
function claimKeyboardFor(panel: PanelId): void {
  usePanelRegistry.getState().focusPanel(panel);
  if (typeof document === 'undefined') return;
  const frame = document.querySelector<HTMLElement>(`[data-panel-id="${panel}"][tabindex]`);
  if (frame && !frame.contains(document.activeElement)) frame.focus({ preventScroll: true });
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

function dispatchOverlay(event: KeyboardEvent): boolean {
  const combos = eventCombos(event);
  const targetIsTextEntry = isTextEntryElement(event.target as Element | null);
  // Walk LIFO — topmost overlay claims first.
  for (let i = overlayOrder.length - 1; i >= 0; i--) {
    const reg = overlayOrder[i];
    if (!comboMatches(reg, combos)) continue;
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
  const combos = eventCombos(event);
  const combo = normalizeEvent(event);
  const activeElement = typeof document === 'undefined' ? null : document.activeElement;
  if (isTextEntryElement(activeElement)) {
    // Text-entry guard. Only bindings that opt in fire while typing.
    for (const reg of registrations) {
      if (!reg.allowInTextEntry) continue;
      if (!comboMatches(reg, combos)) continue;
      if (reg.scope === 'overlay') continue; // overlay handled in capture phase
      if (tryFire(reg, event)) return true;
    }
    return false;
  }
  // Same guard, narrowed to Space/Enter: a focused button/link/checkbox owns
  // those two keys natively, so a same-combo shortcut must not preempt them
  // (see isNativelyActivatedElement's comment). Unlike the text-entry guard,
  // this doesn't block every other combo — Escape, F-keys etc. are unrelated
  // to activating the focused control and should still reach their bindings.
  if ((combo === ' ' || combo === 'Enter') && isNativelyActivatedElement(activeElement)) {
    for (const reg of registrations) {
      if (!reg.allowInTextEntry) continue;
      if (!comboMatches(reg, combos)) continue;
      if (reg.scope === 'overlay') continue;
      if (tryFire(reg, event)) return true;
    }
    return false;
  }

  // The panel under the mouse is asked first, then the focused panel.
  //
  // "Focused" means "last panel that received a mousedown", and that goes stale
  // easily: click an Inspector toggle, move back over the timeline, press
  // Ctrl+C — the Inspector still owned the keyboard, had no Ctrl+C, and the
  // copy silently went nowhere until something in the timeline was clicked
  // again. Kit knobs/faders preventDefault their pointerdown (no mousedown, so
  // no focus claim), which made it worse: whether the timeline kept the keys
  // depended on WHICH kind of control had been touched. Where the mouse is is
  // where the user is working. Panels with no binding for the key (Inspector,
  // Preview, Mixer…) fall through to the focused panel exactly as before.
  const focused = resolveFocusedPanel();
  const hovered = resolveHoveredPanel();
  if (hovered && firePanelScope(hovered, combos, event)) {
    // Also when it already is the focused panel: DOM focus can still sit on a
    // control outside every panel (a transport button), which would keep
    // answering Enter.
    claimKeyboardFor(hovered);
    return true;
  }
  if (focused && focused !== hovered && firePanelScope(focused, combos, event)) return true;
  for (const reg of registrations) {
    if (reg.scope !== 'global') continue;
    if (!comboMatches(reg, combos)) continue;
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

// ─── Command registrations (catalog-driven, override-aware) ────────────────
//
// A command is a named action whose combo comes from shortcutCatalog's default
// or the user's override, rather than being hard-coded at the call site. The
// action is registered once; changing the key re-registers it under the new
// combo without the caller knowing a key changed at all.

const commandActions = new Map<string, (event: KeyboardEvent) => HandlerResult>();
const commandRegs = new Map<string, Registration[]>();

// Global combos a registerBinding() caller has taken over. The legacy API's
// contract is one binding per combo — it REPLACES whatever held that key — so
// a command bound to the same combo has to stand down, and stay stood down
// across the re-registration an override change triggers.
const legacySuppressedCombos = new Set<string>();

function applyCommandRegistrations(commandId: string): void {
  const previous = commandRegs.get(commandId);
  if (previous) {
    for (const reg of previous) {
      registrations.delete(reg);
      const idx = overlayOrder.indexOf(reg);
      if (idx >= 0) overlayOrder.splice(idx, 1);
    }
  }
  const action = commandActions.get(commandId);
  const command = getCommand(commandId);
  if (!action || !command) {
    commandRegs.delete(commandId);
    return;
  }
  const regs: Registration[] = [];
  for (const combo of resolveCombos(commandId)) {
    if (!combo) continue;
    if (command.scope === 'global' && legacySuppressedCombos.has(combo)) continue;
    const reg: Registration = {
      scope: command.scope,
      combo,
      handler: action,
    };
    registrations.add(reg);
    if (command.scope === 'overlay') overlayOrder.push(reg);
    regs.push(reg);
  }
  commandRegs.set(commandId, regs);
}

/**
 * Binds `action` to whatever combo the catalog and the user's overrides
 * currently resolve `commandId` to. Returns an unregister function.
 */
export function registerCommand(
  commandId: string,
  action: (event: KeyboardEvent) => HandlerResult,
): () => void {
  commandActions.set(commandId, action);
  applyCommandRegistrations(commandId);
  return () => {
    commandActions.delete(commandId);
    applyCommandRegistrations(commandId);
  };
}

export function reapplyAllCommands(): void {
  for (const commandId of commandActions.keys()) applyCommandRegistrations(commandId);
}

// A rebind in Settings takes effect on the next keystroke, with no reload and
// no re-mount of the panel that owns the command.
subscribeOverrides(reapplyAllCommands);

// ─── Default bindings (global scope) ───────────────────────────────────────

function registerDefaultBindings(): void {
  // Generated from the shortcut catalog, which in turn generates its panel
  // entries from panelCatalog's fKey declarations. A panel therefore still
  // declares its shortcut exactly once, beside its title and icon — this file
  // has no second hand-written mapping, and the Settings editor sees the same
  // list the router does.
  for (const command of SHORTCUT_COMMANDS) {
    const panelId = panelIdForCommand(command.id);
    if (!panelId) continue;
    registerCommand(command.id, () => {
      usePanelRegistry.getState().togglePanel(panelId);
      return 'handled';
    });
  }
  // Returns 'handled' on every path, including the ones that cancel nothing:
  // Escape is claimed unconditionally here exactly as it was when this was a
  // registerBinding (which wrapped every action in a 'handled' return).
  registerCommand('view.cancel', () => {
    if (cancelResizeIfActive()) return 'handled';
    if (cancelDockedPanelResizeIfActive()) return 'handled';
    if (cancelDockRegionResizeIfActive()) return 'handled';
    if (getDragState().state === 'dragging') {
      cancelDrag();
      return 'handled';
    }
    const reg = usePanelRegistry.getState();
    const focusedId = PANEL_IDS.find((id) => reg.panels[id].focused);
    if (focusedId && reg.panels[focusedId].mode === 'maximized') {
      reg.restorePanel(focusedId);
    }
    return 'handled';
  });
  registerCommand('view.presetCompose', () => {
    usePanelRegistry.getState().applyPreset('fl-compose');
    return 'handled';
  });
  registerCommand('view.presetArrange', () => {
    usePanelRegistry.getState().applyPreset('vegas-arrange');
    return 'handled';
  });
  registerCommand('view.dockFocus', () => {
    toggleDockFocus();
    return 'handled';
  });
  registerCommand('view.reopenClosed', () => {
    usePanelRegistry.getState().reopenLastClosed();
    return 'handled';
  });
  // Windows MDI convention for cycling documents. Ctrl+Tab is claimed by the
  // shell on some platforms, so it is deliberately not used here.
  registerCommand('view.focusNext', () => {
    usePanelRegistry.getState().focusNextPanel(1);
    return 'handled';
  });
  registerCommand('view.focusPrev', () => {
    usePanelRegistry.getState().focusNextPanel(-1);
    return 'handled';
  });
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
  for (const type of POINTER_SEEN_EVENTS) {
    document.addEventListener(type, onPointerSeen, { capture: true, passive: true });
  }
  document.addEventListener('pointerout', onPointerOut, true);
  lastFocusedPanel = resolveFocusedPanel();
  unsubscribeRegistry = usePanelRegistry.subscribe(() => syncFocusedPanel());
}

export function destroy(): void {
  if (typeof document === 'undefined') return;
  document.removeEventListener('keydown', onKeyDownDocument);
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', onKeyDownWindowCapture, { capture: true });
  }
  for (const type of POINTER_SEEN_EVENTS) {
    document.removeEventListener(type, onPointerSeen, { capture: true });
  }
  document.removeEventListener('pointerout', onPointerOut, true);
  pointerInWindow = false;
  pointerTarget = null;
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
  // Take the combo off any command that currently answers to it, so this
  // binding is the only global handler for the key — what every caller of
  // this API has always been able to assume.
  if (!legacySuppressedCombos.has(combo)) {
    legacySuppressedCombos.add(combo);
    const displaced = findCommandByCombo(combo, 'global');
    if (displaced) applyCommandRegistrations(displaced.id);
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

/**
 * Moves whatever global binding answers to `oldKey` onto `newKey`, refusing if
 * `newKey` is already claimed.
 *
 * Two layers can own a global combo. The legacy map is tried first for the
 * handful of registerBinding() callers that remain; anything else is a catalog
 * command, and moving one of those is exactly what a user override is — so
 * this writes an override rather than mutating the catalog, and the change is
 * persisted and visible in Settings like any other rebind.
 */
export function rebind(oldKey: string, newKey: string): boolean {
  const oldCombo = normalizeKey(oldKey);
  const newCombo = normalizeKey(newKey);
  if (legacyGlobalRegs.has(newCombo)) return false;

  const reg = legacyGlobalRegs.get(oldCombo);
  if (reg) {
    registrations.delete(reg);
    legacyGlobalRegs.delete(oldCombo);
    const moved: Registration = { ...reg, combo: newCombo };
    registrations.add(moved);
    legacyGlobalRegs.set(newCombo, moved);
    return true;
  }

  const command = findCommandByCombo(oldCombo, 'global');
  if (!command) return true; // nothing bound to oldKey — vacuously done
  if (findCommandByCombo(newCombo, 'global')) return false;
  return setComboSync(command.id, newCombo);
}

// test-only
export function resetBindingsForTest(): void {
  registrations.clear();
  overlayOrder.length = 0;
  legacyGlobalRegs.clear();
  commandActions.clear();
  commandRegs.clear();
  legacySuppressedCombos.clear();
  void resetOverrides();
  panelFocusListeners.clear();
  panelBlurListeners.clear();
  lastFocusedPanel = null;
  pointerInWindow = false;
  pointerTarget = null;
  registerDefaultBindings();
}

registerDefaultBindings();
