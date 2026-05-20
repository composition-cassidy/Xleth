import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destroy,
  handleKeyEvent,
  rebind,
  registerBinding,
  resetBindingsForTest,
} from '../managers/KeyboardManager';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

function keyEvent(key: string): KeyboardEvent {
  return { key, type: 'keydown' } as KeyboardEvent;
}

function resetRegistry() {
  destroy();
  resetBindingsForTest();
  usePanelRegistry.setState({ panels: createInitialPanelStates() });
}

describe('KeyboardManager', () => {
  beforeEach(resetRegistry);

  it('F9 toggles mixer open', () => {
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(true);

    handleKeyEvent(keyEvent('F9'));

    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('F9 toggles mixer closed', () => {
    usePanelRegistry.getState().openPanel('mixer');

    handleKeyEvent(keyEvent('F9'));

    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(true);
  });

  it('F5 toggles timeline', () => {
    expect(usePanelRegistry.getState().panels.timeline.hidden).toBe(false);

    handleKeyEvent(keyEvent('F5'));

    expect(usePanelRegistry.getState().panels.timeline.hidden).toBe(true);
  });

  it('F11 does not open the quarantined legacy nodeEditor panel', () => {
    expect(usePanelRegistry.getState().panels.nodeEditor.hidden).toBe(true);

    handleKeyEvent(keyEvent('F11'));

    expect(usePanelRegistry.getState().panels.nodeEditor.hidden).toBe(true);
  });

  it('Escape restores focused maximized panel', () => {
    const registry = usePanelRegistry.getState();
    registry.maximizePanel('timeline');

    handleKeyEvent(keyEvent('Escape'));

    const panel = usePanelRegistry.getState().panels.timeline;
    expect(panel.mode).toBe('floating');
    expect(panel.preMaximizeState).toBeNull();
  });

  it('Escape is a no-op when no panel is maximized', () => {
    const before = usePanelRegistry.getState().panels.timeline;

    expect(() => handleKeyEvent(keyEvent('Escape'))).not.toThrow();

    expect(usePanelRegistry.getState().panels.timeline).toEqual(before);
  });

  it.skip('input focus guard requires jsdom', () => {
    expect(true).toBe(true);
  });

  it('registerBinding adds a new binding', () => {
    const action = vi.fn();
    registerBinding('F12', action);

    handleKeyEvent(keyEvent('F12'));

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('rebind moves a binding', () => {
    expect(rebind('F9', 'F13')).toBe(true);

    handleKeyEvent(keyEvent('F13'));
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);

    handleKeyEvent(keyEvent('F9'));
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
  });

  it('rebind returns false when target key is already taken', () => {
    expect(rebind('F9', 'F5')).toBe(false);

    handleKeyEvent(keyEvent('F9'));
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);

    handleKeyEvent(keyEvent('F5'));
    expect(usePanelRegistry.getState().panels.timeline.hidden).toBe(true);
  });

  describe('Ctrl+Shift preset bindings', () => {
    beforeEach(resetRegistry);

    it('Ctrl+Shift+1 applies fl-compose preset', () => {
      handleKeyEvent({
        key: '1',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      const panels = usePanelRegistry.getState().panels;
      expect(panels.timeline.hidden).toBe(false);
      expect(panels.timeline.mode).toBe('floating');
      expect(panels.mixer.mode).toBe('docked');
      expect(panels.sampleSelector.mode).toBe('docked');
      expect(panels.preview.hidden).toBe(true);
    });

    it('Ctrl+Shift+2 applies vegas-arrange preset', () => {
      handleKeyEvent({
        key: '2',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      const panels = usePanelRegistry.getState().panels;
      expect(panels.preview.hidden).toBe(false);
      expect(panels.preview.mode).toBe('floating');
      expect(panels.timeline.mode).toBe('floating');
      expect(panels.mixer.hidden).toBe(true);
    });

    it('Ctrl+Shift+3 applies grid-edit preset', () => {
      handleKeyEvent({
        key: '3',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      const panels = usePanelRegistry.getState().panels;
      expect(panels.gridSettings.hidden).toBe(false);
      expect(panels.gridSettings.mode).toBe('floating');
      expect(panels.preview.mode).toBe('floating');
      expect(panels.mixer.hidden).toBe(true);
    });

    it('plain 1 without modifiers does not trigger preset', () => {
      handleKeyEvent({ key: '1', type: 'keydown' } as KeyboardEvent);

      expect(usePanelRegistry.getState().panels.mixer.mode).not.toBe('docked');
    });
  });
});
