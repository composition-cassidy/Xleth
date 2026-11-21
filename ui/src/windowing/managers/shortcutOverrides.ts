import {
  SHORTCUT_COMMANDS,
  getCommand,
  isEditable,
  type ShortcutCommand,
} from './shortcutCatalog';

// ─── User shortcut overrides ────────────────────────────────────────────────
//
// A flat { [commandId]: combo } map persisted to userData/xleth-settings.json
// under SETTINGS_KEY. Only commands the user actually changed appear — a
// command sitting on its shipped default stores nothing, so a later change to
// a default reaches every user who never touched that key.
//
// ── Why this is not a zustand store ────────────────────────────────────────
// KeyboardManager is a plain module that registers its defaults at import
// time, long before React mounts, and useKeyboardBinding resolves combos
// inside useEffect. A subscribable module-level map serves both without
// forcing KeyboardManager to take a React dependency.

export const SETTINGS_KEY = 'keyboardShortcuts';

type Overrides = Record<string, string>;

let overrides: Overrides = {};
let loaded = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function xleth(): any {
  return typeof window !== 'undefined' ? (window as any).xleth : undefined;
}

function sanitize(raw: unknown): Overrides {
  if (!raw || typeof raw !== 'object') return {};
  const out: Overrides = {};
  for (const [id, combo] of Object.entries(raw as Record<string, unknown>)) {
    // Drop entries for commands that no longer exist, and for ones that are
    // not editable: a stale override on Escape from an older build must not
    // outlive the decision to freeze it.
    const command = getCommand(id);
    if (!command || !isEditable(command)) continue;
    if (typeof combo !== 'string' || !combo) continue;
    out[id] = combo;
  }
  return out;
}

/** Reads persisted overrides. Safe to call before the bridge exists. */
export async function load(): Promise<Overrides> {
  try {
    const raw = await xleth()?.settings?.get?.(SETTINGS_KEY);
    overrides = sanitize(raw);
  } catch {
    overrides = {};
  }
  loaded = true;
  notify();
  return overrides;
}

export function isLoaded(): boolean {
  return loaded;
}

async function persist(): Promise<void> {
  try {
    await xleth()?.settings?.set?.(SETTINGS_KEY, overrides);
  } catch {
    // A failed write leaves the in-memory binding active for this session.
    // Surfacing it would mean a modal on a keystroke; the Settings panel
    // re-reads on open, so a lost write shows up as the key reverting.
  }
}

/** The combo actually in force for a command. */
export function resolveCombo(commandId: string): string {
  const command = getCommand(commandId);
  if (!command) return '';
  const override = overrides[commandId];
  if (override && isEditable(command)) return override;
  return command.defaultCombo;
}

/**
 * Every spelling a command answers to. A command on its default keeps its
 * aliases (the Caps Lock / '=' variants of the same physical key); an
 * overridden one has exactly the combo the user captured, because the aliases
 * described the OLD key and carry no meaning for the new one.
 */
export function resolveCombos(commandId: string): string[] {
  const command = getCommand(commandId);
  if (!command) return [];
  const override = overrides[commandId];
  if (override && isEditable(command)) return [override];
  return [command.defaultCombo, ...(command.aliases ?? [])];
}

export function hasOverride(commandId: string): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, commandId);
}

export function getAll(): Readonly<Overrides> {
  return overrides;
}

/**
 * Commands that would answer to the same combo in the same scope. Global and
 * panel-scoped commands are allowed to share a combo — that is how Ctrl+E can
 * be Export Audio globally and Zoom to Selection inside the Sandbox, which is
 * the shipped arrangement — so a conflict is only reported within one scope.
 */
export function findConflicts(commandId: string, combo: string): ShortcutCommand[] {
  const target = getCommand(commandId);
  if (!target || !combo) return [];
  return SHORTCUT_COMMANDS.filter((other) => {
    if (other.id === commandId) return false;
    if (other.scope !== target.scope) return false;
    return resolveCombos(other.id).includes(combo);
  });
}

/**
 * Assigns a combo without waiting for the write. The in-memory map and its
 * subscribers update synchronously, so the new key is live on the very next
 * keystroke; persistence follows. Returns false (and changes nothing) for a
 * frozen command.
 */
export function setComboSync(commandId: string, combo: string): boolean {
  const command = getCommand(commandId);
  if (!command || !isEditable(command)) return false;
  if (combo === command.defaultCombo) {
    delete overrides[commandId];
  } else {
    overrides[commandId] = combo;
  }
  notify();
  void persist();
  return true;
}

/** setComboSync, awaiting the write — what the Settings editor uses. */
export async function setCombo(commandId: string, combo: string): Promise<boolean> {
  const command = getCommand(commandId);
  if (!command || !isEditable(command)) return false;
  if (combo === command.defaultCombo) {
    delete overrides[commandId];
  } else {
    overrides[commandId] = combo;
  }
  notify();
  await persist();
  return true;
}

/** The first command in `scope` that currently answers to `combo`. */
export function findCommandByCombo(combo: string, scope?: string): ShortcutCommand | null {
  for (const command of SHORTCUT_COMMANDS) {
    if (scope && command.scope !== scope) continue;
    if (resolveCombos(command.id).includes(combo)) return command;
  }
  return null;
}

export async function reset(commandId: string): Promise<void> {
  if (!hasOverride(commandId)) return;
  delete overrides[commandId];
  notify();
  await persist();
}

export async function resetAll(): Promise<void> {
  overrides = {};
  notify();
  await persist();
}

// test-only
export function _setForTest(next: Overrides): void {
  overrides = sanitize(next);
  loaded = true;
  notify();
}
