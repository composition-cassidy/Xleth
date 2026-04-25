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
    expect(rebind('F9', 'F12')).toBe(true);

    handleKeyEvent(keyEvent('F12'));
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
});
