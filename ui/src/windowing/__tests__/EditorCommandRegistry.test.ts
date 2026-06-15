import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEditorCommandsForTest,
  registerEditorCommand,
  runEditorCommand,
} from '../managers/EditorCommandRegistry';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

function resetRegistry() {
  usePanelRegistry.setState({ panels: createInitialPanelStates() });
  clearEditorCommandsForTest();
}

describe('EditorCommandRegistry', () => {
  beforeEach(resetRegistry);

  it('runs a command for the focused visible editor panel', async () => {
    const action = vi.fn();
    registerEditorCommand('timeline', 'deleteSelected', action);

    expect(await runEditorCommand('deleteSelected')).toBe(true);

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('routes to the currently focused registered panel', async () => {
    const timelineAction = vi.fn();
    const pianoRollAction = vi.fn();
    registerEditorCommand('timeline', 'deleteSelected', timelineAction);
    registerEditorCommand('pianoRoll', 'deleteSelected', pianoRollAction);
    usePanelRegistry.getState().openPanel('pianoRoll');

    expect(await runEditorCommand('deleteSelected')).toBe(true);

    expect(timelineAction).not.toHaveBeenCalled();
    expect(pianoRollAction).toHaveBeenCalledTimes(1);
  });

  it('returns false when no focused panel command is registered', async () => {
    registerEditorCommand('pianoRoll', 'deleteSelected', vi.fn());

    expect(await runEditorCommand('deleteSelected')).toBe(false);
  });

  it('unregisters only the matching handler', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerEditorCommand('timeline', 'deleteSelected', first);
    registerEditorCommand('timeline', 'deleteSelected', second);

    unregisterFirst();
    expect(await runEditorCommand('deleteSelected')).toBe(true);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
