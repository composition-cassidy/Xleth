import { ACTIVE_PANEL_IDS, PANEL_CATALOG, type PanelId } from '../registry/panelCatalog';
import type { ScopeId } from './KeyboardManager';

// ─── The rebindable command catalog ─────────────────────────────────────────
//
// One entry per user-visible keyboard command, holding the three things the
// Settings editor needs and the code previously kept in three separate places:
// a stable id, a human-readable label, and the default combo.
//
// ── Why a catalog and not just rebind() ─────────────────────────────────────
// KeyboardManager can already rebind a combo, but a combo is not a command:
// registrations are anonymous, so a shortcut editor built on rebind() alone
// could offer the user "Ctrl+Shift+T → ?" with no way to say what that key
// does, and no way to restore it once the user had changed it twice. The
// catalog gives every command an identity that survives rebinding.
//
// ── The id is the persistence key ───────────────────────────────────────────
// Overrides are stored as { [commandId]: combo }. Renaming an id silently
// drops that user's override for it, so ids are treated as permanent even
// when the label changes.

export type ShortcutGroupId = 'file' | 'view' | 'panels' | 'sandboxEdit' | 'sandboxView';

export interface ShortcutGroup {
  id: ShortcutGroupId;
  label: string;
  description: string;
}

export interface ShortcutCommand {
  id: string;
  label: string;
  group: ShortcutGroupId;
  scope: ScopeId;
  /** The shipped combo. `rebind`/overrides never mutate this. */
  defaultCombo: string;
  /**
   * Extra spellings of the SAME physical gesture that must move with the
   * primary combo — Caps Lock's uppercase 'X' for Ctrl+x, '=' for '+', and so
   * on. These are not alternative shortcuts the user picked; they are the
   * other strings KeyboardManager's event.key-derived combo can arrive as for
   * one key press. Rebinding replaces the whole set.
   */
  aliases?: string[];
  /**
   * False for commands whose key is structural rather than a preference —
   * Escape cancels a drag, a resize and a maximize; rebinding it would leave
   * those gestures with no way out.
   */
  editable?: boolean;
  description?: string;
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  { id: 'file', label: 'File and project', description: 'Project lifecycle and export.' },
  { id: 'view', label: 'View and layout', description: 'Zoom, workspace presets and panel cycling.' },
  { id: 'panels', label: 'Panel toggles', description: 'Show or hide a workspace panel.' },
  { id: 'sandboxEdit', label: 'Sample Sandbox: edit', description: 'Only while the Sample Sandbox panel is focused.' },
  { id: 'sandboxView', label: 'Sample Sandbox: navigation', description: 'Only while the Sample Sandbox panel is focused.' },
];

const FILE_COMMANDS: ShortcutCommand[] = [
  { id: 'file.new', label: 'New Project', group: 'file', scope: 'global', defaultCombo: 'Ctrl+n', aliases: ['Ctrl+N'] },
  { id: 'file.open', label: 'Open Project', group: 'file', scope: 'global', defaultCombo: 'Ctrl+o', aliases: ['Ctrl+O'] },
  { id: 'file.save', label: 'Save', group: 'file', scope: 'global', defaultCombo: 'Ctrl+s', aliases: ['Ctrl+S'] },
  { id: 'file.saveAs', label: 'Save As…', group: 'file', scope: 'global', defaultCombo: 'Ctrl+Shift+s', aliases: ['Ctrl+Shift+S'] },
  { id: 'file.importSource', label: 'Import Source', group: 'file', scope: 'global', defaultCombo: 'Ctrl+i', aliases: ['Ctrl+I'] },
  { id: 'file.exportAudio', label: 'Export Audio', group: 'file', scope: 'global', defaultCombo: 'Ctrl+e', aliases: ['Ctrl+E'] },
  { id: 'file.exportVideo', label: 'Export Video', group: 'file', scope: 'global', defaultCombo: 'Ctrl+Shift+e', aliases: ['Ctrl+Shift+E'] },
];

const VIEW_COMMANDS: ShortcutCommand[] = [
  { id: 'view.zoomIn', label: 'Zoom In', group: 'view', scope: 'global', defaultCombo: 'Ctrl+=', aliases: ['Ctrl++', 'Ctrl+Shift+=', 'Ctrl+Shift++'] },
  { id: 'view.zoomOut', label: 'Zoom Out', group: 'view', scope: 'global', defaultCombo: 'Ctrl+-', aliases: ['Ctrl+_', 'Ctrl+Shift+-', 'Ctrl+Shift+_'] },
  { id: 'view.resetZoom', label: 'Reset Zoom', group: 'view', scope: 'global', defaultCombo: 'Ctrl+0' },
  {
    id: 'view.presetCompose',
    label: 'Workspace Preset: Compose',
    group: 'view',
    scope: 'global',
    defaultCombo: 'Ctrl+Shift+1',
  },
  {
    id: 'view.presetArrange',
    label: 'Workspace Preset: Arrange',
    group: 'view',
    scope: 'global',
    defaultCombo: 'Ctrl+Shift+2',
  },
  {
    id: 'view.dockFocus',
    label: 'Focus Detail Dock',
    group: 'view',
    scope: 'global',
    defaultCombo: 'Ctrl+Shift+d',
    aliases: ['Ctrl+Shift+D'],
    description: 'Gives the detail dock the whole centre column, hiding the Preview row and the arrangement; press again to restore.',
  },
  { id: 'view.reopenClosed', label: 'Reopen Last Closed Panel', group: 'view', scope: 'global', defaultCombo: 'Ctrl+Shift+T' },
  { id: 'view.focusNext', label: 'Focus Next Panel', group: 'view', scope: 'global', defaultCombo: 'Ctrl+F6' },
  { id: 'view.focusPrev', label: 'Focus Previous Panel', group: 'view', scope: 'global', defaultCombo: 'Ctrl+Shift+F6' },
  {
    id: 'view.cancel',
    label: 'Cancel / Restore Panel',
    group: 'view',
    scope: 'global',
    defaultCombo: 'Escape',
    editable: false,
    description: 'Cancels an in-progress drag or resize and un-maximizes the focused panel.',
  },
];

// Generated from panelCatalog so a panel's toggle appears in the editor by
// virtue of declaring an fKey — exactly the property PANEL_FKEY_BINDINGS
// relies on, so the two can never disagree about which panels have a shortcut.
const PANEL_COMMANDS: ShortcutCommand[] = ACTIVE_PANEL_IDS
  .filter((id) => !!PANEL_CATALOG[id].fKey)
  .map((id) => ({
    id: `panel.${id}`,
    label: `Toggle ${PANEL_CATALOG[id].title}`,
    group: 'panels' as const,
    scope: 'global' as const,
    defaultCombo: PANEL_CATALOG[id].fKey as string,
  }));

export function panelIdForCommand(commandId: string): PanelId | null {
  if (!commandId.startsWith('panel.')) return null;
  const id = commandId.slice('panel.'.length);
  return (ACTIVE_PANEL_IDS as string[]).includes(id) ? (id as PanelId) : null;
}

const SANDBOX_SCOPE: ScopeId = 'panel:sampleSandbox';

const SANDBOX_EDIT_COMMANDS: ShortcutCommand[] = [
  { id: 'sandbox.cut', label: 'Cut Selection', group: 'sandboxEdit', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+x', aliases: ['Ctrl+X'] },
  {
    id: 'sandbox.delete',
    label: 'Delete Selection',
    group: 'sandboxEdit',
    scope: SANDBOX_SCOPE,
    defaultCombo: 'Delete',
    aliases: ['Backspace'],
    description: 'Delete is Cut — the removed range goes to the clipboard.',
  },
  { id: 'sandbox.copy', label: 'Copy Selection', group: 'sandboxEdit', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+c', aliases: ['Ctrl+C'] },
  { id: 'sandbox.paste', label: 'Paste', group: 'sandboxEdit', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+v', aliases: ['Ctrl+V'] },
  { id: 'sandbox.duplicateLayer', label: 'Duplicate Layer', group: 'sandboxEdit', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+d', aliases: ['Ctrl+D'] },
];

const SANDBOX_VIEW_COMMANDS: ShortcutCommand[] = [
  { id: 'sandbox.zoomIn', label: 'Zoom In', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: '+', aliases: ['='] },
  { id: 'sandbox.zoomOut', label: 'Zoom Out', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: '-', aliases: ['_'] },
  { id: 'sandbox.zoomToSelection', label: 'Zoom to Selection', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+e', aliases: ['Ctrl+E'] },
  { id: 'sandbox.zoomToFit', label: 'Zoom to Fit', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'Ctrl+f', aliases: ['Ctrl+F'] },
  { id: 'sandbox.scrollLeft', label: 'Scroll Left', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'ArrowLeft', aliases: ['Shift+ArrowLeft'] },
  { id: 'sandbox.scrollRight', label: 'Scroll Right', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'ArrowRight', aliases: ['Shift+ArrowRight'] },
  { id: 'sandbox.cursorStart', label: 'Cursor to Start', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'Home', aliases: ['Ctrl+Home'] },
  { id: 'sandbox.cursorEnd', label: 'Cursor to End', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'End', aliases: ['Ctrl+End'] },
  {
    id: 'sandbox.auditionLayer',
    label: 'Audition Active Layer',
    group: 'sandboxView',
    scope: SANDBOX_SCOPE,
    defaultCombo: 'Shift+ ',
    aliases: ['Shift+Spacebar'],
    description: 'Plays the active layer alone; plain Space plays the composite.',
  },
  { id: 'sandbox.toggleLoop', label: 'Toggle Loop Playback', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: 'l', aliases: ['L'] },
  { id: 'sandbox.playComposite', label: 'Play Composite', group: 'sandboxView', scope: SANDBOX_SCOPE, defaultCombo: ' ' },
];

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  ...FILE_COMMANDS,
  ...VIEW_COMMANDS,
  ...PANEL_COMMANDS,
  ...SANDBOX_EDIT_COMMANDS,
  ...SANDBOX_VIEW_COMMANDS,
];

const BY_ID = new Map(SHORTCUT_COMMANDS.map((c) => [c.id, c]));

export function getCommand(id: string): ShortcutCommand | undefined {
  return BY_ID.get(id);
}

export function isEditable(command: ShortcutCommand): boolean {
  return command.editable !== false;
}

// ─── Combo formatting ───────────────────────────────────────────────────────

const KEY_DISPLAY: Record<string, string> = {
  ' ': 'Space',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
};

/** Human-facing spelling of a stored combo, e.g. 'Ctrl+x' → 'Ctrl + X'. */
export function formatCombo(combo: string): string {
  if (!combo) return 'Unassigned';
  // Split on '+' but keep a literal '+' key: 'Ctrl++' is Ctrl plus the plus key.
  const parts: string[] = [];
  let rest = combo;
  for (const mod of ['Meta', 'Ctrl', 'Shift', 'Alt']) {
    if (rest.startsWith(`${mod}+`)) {
      parts.push(mod);
      rest = rest.slice(mod.length + 1);
    }
  }
  const key = KEY_DISPLAY[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest);
  parts.push(key);
  return parts.join(' + ');
}

/**
 * Builds the stored combo string for a captured KeyboardEvent, in the same
 * shape KeyboardManager's normalizeEvent produces — modifiers in Meta, Ctrl,
 * Shift, Alt order followed by event.key.
 */
export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key;
  // A bare modifier is the user still assembling the chord, not a shortcut.
  if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(key)) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Meta');
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.shiftKey) parts.push('Shift');
  if (event.altKey) parts.push('Alt');
  parts.push(key);
  return parts.join('+');
}
