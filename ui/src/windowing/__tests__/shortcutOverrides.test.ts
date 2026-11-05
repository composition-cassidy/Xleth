import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SHORTCUT_COMMANDS,
  comboFromEvent,
  formatCombo,
  getCommand,
} from '../managers/shortcutCatalog';
import {
  _setForTest,
  findConflicts,
  hasOverride,
  resetAll,
  resolveCombo,
  resolveCombos,
  setCombo,
} from '../managers/shortcutOverrides';

describe('shortcutCatalog', () => {
  it('gives every command a unique id', () => {
    const ids = SHORTCUT_COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not ship two commands in the same scope on the same combo', () => {
    // A same-scope duplicate means one of the two silently never fires —
    // KeyboardManager stops at the first registration that claims the key.
    // That is the exact failure the catalog exists to make visible.
    const seen = new Map<string, string>();
    for (const command of SHORTCUT_COMMANDS) {
      for (const combo of [command.defaultCombo, ...(command.aliases ?? [])]) {
        const key = `${command.scope}::${combo}`;
        const existing = seen.get(key);
        expect(
          existing,
          `${command.scope} combo "${combo}" claimed by both ${existing} and ${command.id}`,
        ).toBeUndefined();
        seen.set(key, command.id);
      }
    }
  });

  it('formats combos for display without losing a literal plus key', () => {
    expect(formatCombo('Ctrl+x')).toBe('Ctrl + X');
    expect(formatCombo('Ctrl+Shift+F6')).toBe('Ctrl + Shift + F6');
    expect(formatCombo(' ')).toBe('Space');
    expect(formatCombo('Ctrl++')).toBe('Ctrl + +');
    expect(formatCombo('')).toBe('Unassigned');
  });

  it('builds a combo from an event and ignores a bare modifier', () => {
    const event = { key: 's', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    expect(comboFromEvent(event as unknown as KeyboardEvent)).toBe('Ctrl+s');

    const bare = { key: 'Control', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false };
    expect(comboFromEvent(bare as unknown as KeyboardEvent)).toBeNull();
  });
});

describe('shortcutOverrides', () => {
  beforeEach(async () => {
    (globalThis as any).window = { xleth: { settings: { get: vi.fn(), set: vi.fn() } } };
    await resetAll();
  });

  it('falls back to the catalog default until something is overridden', () => {
    expect(resolveCombo('file.save')).toBe(getCommand('file.save')!.defaultCombo);
    expect(hasOverride('file.save')).toBe(false);
  });

  it('keeps a default combo aliases and drops them once overridden', () => {
    // Aliases describe other spellings of the SHIPPED key, so they must not
    // survive onto a key the user picked.
    expect(resolveCombos('sandbox.cut')).toContain('Ctrl+X');

    _setForTest({ 'sandbox.cut': 'Ctrl+q' });
    expect(resolveCombos('sandbox.cut')).toEqual(['Ctrl+q']);
  });

  it('clears the stored entry when a command is set back to its default', async () => {
    await setCombo('file.save', 'Ctrl+q');
    expect(hasOverride('file.save')).toBe(true);

    await setCombo('file.save', getCommand('file.save')!.defaultCombo);
    expect(hasOverride('file.save')).toBe(false);
  });

  it('refuses to rebind a command marked non-editable', async () => {
    expect(await setCombo('view.cancel', 'Ctrl+q')).toBe(false);
    expect(resolveCombo('view.cancel')).toBe('Escape');
  });

  it('discards persisted overrides for unknown or frozen commands', () => {
    _setForTest({ 'file.save': 'Ctrl+q', 'view.cancel': 'F4', 'gone.command': 'F3' });
    expect(hasOverride('file.save')).toBe(true);
    expect(hasOverride('view.cancel')).toBe(false);
    expect(hasOverride('gone.command')).toBe(false);
  });

  it('reports a conflict only within the same scope', () => {
    // Ctrl+E is shipped as Export Audio globally AND Zoom to Selection inside
    // the Sandbox. That is deliberate, so it must not read as a conflict.
    expect(findConflicts('sandbox.zoomToSelection', 'Ctrl+e')).toEqual([]);

    const clash = findConflicts('file.save', getCommand('file.open')!.defaultCombo);
    expect(clash.map((c) => c.id)).toContain('file.open');
  });
});
