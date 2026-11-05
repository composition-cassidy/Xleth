/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destroy,
  handleKeyEvent,
  rebind,
  register,
  registerBinding,
  resetBindingsForTest,
} from '../managers/KeyboardManager';
import {
  createInitialPanelStates,
  isPinnedToCenter,
  usePanelRegistry,
} from '../registry/PanelRegistry';
import { PANEL_FKEY_BINDINGS } from '../registry/panelCatalog';

function keyEvent(key: string): KeyboardEvent {
  return { key, type: 'keydown' } as KeyboardEvent;
}

function shortcutEvent(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  const event: Record<string, unknown> = {
    key,
    type: 'keydown',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    defaultPrevented: false,
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...modifiers,
  };
  event.preventDefault = vi.fn(() => {
    event.defaultPrevented = true;
  });
  return event as unknown as KeyboardEvent;
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

  it('F5 brings the arrangement forward instead of emptying the center', () => {
    usePanelRegistry.getState().openPanel('mixer');
    expect(usePanelRegistry.getState().panels.timeline.focused).toBe(false);

    handleKeyEvent(keyEvent('F5'));

    // The timeline is the only panel in the center, so it cannot close; its
    // toggle focuses it rather than doing nothing.
    expect(usePanelRegistry.getState().panels.timeline.hidden).toBe(false);
    expect(usePanelRegistry.getState().panels.timeline.focused).toBe(true);
  });

  it('F11 opens the safe fxGraph shell without opening quarantined nodeEditor', () => {
    expect(usePanelRegistry.getState().panels.fxGraph.hidden).toBe(true);
    expect(usePanelRegistry.getState().panels.nodeEditor.hidden).toBe(true);

    handleKeyEvent(keyEvent('F11'));

    expect(usePanelRegistry.getState().panels.fxGraph.hidden).toBe(false);
    expect(usePanelRegistry.getState().panels.fxGraph.focused).toBe(true);
    expect(usePanelRegistry.getState().panels.nodeEditor.hidden).toBe(true);
  });

  it('Escape restores focused maximized panel', () => {
    const registry = usePanelRegistry.getState();
    registry.maximizePanel('timeline');

    handleKeyEvent(keyEvent('Escape'));

    // It came out of the center and goes back there.
    const panel = usePanelRegistry.getState().panels.timeline;
    expect(panel.mode).toBe('docked');
    expect(panel.docked.region).toBe('center');
    expect(panel.preMaximizeState).toBeNull();
  });

  it('Escape is a no-op when no panel is maximized', () => {
    const before = usePanelRegistry.getState().panels.timeline;

    expect(() => handleKeyEvent(keyEvent('Escape'))).not.toThrow();

    expect(usePanelRegistry.getState().panels.timeline).toEqual(before);
  });

  it('a focused button owns Space/Enter — a same-combo panel shortcut does not preempt it', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();

    const action = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return 'handled' as const;
    });
    register({ scope: 'panel:sampleSandbox', combo: ' ', handler: action });
    usePanelRegistry.getState().openPanel('sampleSandbox');

    const spaceEvent = shortcutEvent(' ');
    handleKeyEvent(spaceEvent);
    expect(action).not.toHaveBeenCalled();
    expect(spaceEvent.defaultPrevented).toBe(false);

    const enterEvent = shortcutEvent('Enter');
    handleKeyEvent(enterEvent);
    expect(enterEvent.defaultPrevented).toBe(false);

    // Once focus leaves the button, the panel shortcut fires as normal.
    button.blur();
    document.body.removeChild(button);
    const spaceAfterBlur = shortcutEvent(' ');
    handleKeyEvent(spaceAfterBlur);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('registerBinding adds a new binding', () => {
    const action = vi.fn();
    registerBinding('F12', action);

    handleKeyEvent(keyEvent('F12'));

    expect(action).toHaveBeenCalledTimes(1);
  });

  it('routes panel-scoped graph undo shortcuts only to the focused fxGraph panel', () => {
    const action = vi.fn((event: KeyboardEvent) => {
      event.preventDefault();
      return 'handled' as const;
    });
    register({ scope: 'panel:fxGraph', combo: 'Ctrl+z', handler: action });

    const timelineEvent = shortcutEvent('z', { ctrlKey: true });
    handleKeyEvent(timelineEvent);
    expect(action).not.toHaveBeenCalled();
    expect(timelineEvent.defaultPrevented).toBe(false);

    usePanelRegistry.getState().openPanel('fxGraph');
    const fxGraphEvent = shortcutEvent('z', { ctrlKey: true });
    handleKeyEvent(fxGraphEvent);
    expect(action).toHaveBeenCalledTimes(1);
    expect(fxGraphEvent.defaultPrevented).toBe(true);

    usePanelRegistry.getState().openPanel('mixer');
    const mixerEvent = shortcutEvent('z', { ctrlKey: true });
    handleKeyEvent(mixerEvent);
    expect(action).toHaveBeenCalledTimes(1);
    expect(mixerEvent.defaultPrevented).toBe(false);
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

    // F5 still reaches the timeline (it stays open: it holds the center).
    usePanelRegistry.getState().focusPanel('mixer');
    handleKeyEvent(keyEvent('F5'));
    expect(usePanelRegistry.getState().panels.timeline.focused).toBe(true);
  });

  describe('Ctrl+Shift preset bindings', () => {
    beforeEach(resetRegistry);

    // What a browser ACTUALLY reports for Ctrl+Shift+1: event.key is the
    // character the chord produces, so it is the shifted symbol, not the digit.
    // The bindings used to match on event.key alone and were dead in the app
    // while these tests passed against a synthetic digit no browser emits.
    it('Ctrl+Shift+1 applies fl-compose preset for a real shifted digit event', () => {
      handleKeyEvent({
        key: '!',
        code: 'Digit1',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      const panels = usePanelRegistry.getState().panels;
      expect(panels.timeline.hidden).toBe(false);
      expect(panels.timeline.mode).toBe('docked');
      expect(panels.timeline.docked.region).toBe('center');
      expect(panels.mixer.mode).toBe('floating');
      expect(panels.sampleSelector.mode).toBe('docked');
      expect(panels.preview.hidden).toBe(true);
    });

    it('Ctrl+Shift+2 applies vegas-arrange preset for a real shifted digit event', () => {
      handleKeyEvent({
        key: '@',
        code: 'Digit2',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      const panels = usePanelRegistry.getState().panels;
      expect(panels.preview.hidden).toBe(false);
      expect(panels.preview.mode).toBe('floating');
      expect(panels.timeline.mode).toBe('docked');
      expect(panels.timeline.docked.region).toBe('center');
      expect(panels.mixer.hidden).toBe(true);
    });

    it('plain 1 without modifiers does not trigger preset', () => {
      handleKeyEvent({ key: '1', code: 'Digit1', type: 'keydown' } as KeyboardEvent);

      // fl-compose opens the mixer; nothing here may have.
      expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(true);
    });

    it('still matches an event that reports the digit in event.key', () => {
      // A layout where the chord yields the digit itself must keep working:
      // the physical-key spelling is an ADDITIONAL match, not a replacement.
      handleKeyEvent({
        key: '1',
        code: 'Digit1',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
    });

    it('tolerates an event with no code at all', () => {
      expect(() => handleKeyEvent({
        key: '!',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent)).not.toThrow();
    });
  });

  describe('catalog-generated function keys', () => {
    beforeEach(resetRegistry);

    it('binds exactly the F-keys the catalog declares, to the panels it names', () => {
      for (const [fKey, panelId] of PANEL_FKEY_BINDINGS) {
        const before = usePanelRegistry.getState().panels;
        const pinned = isPinnedToCenter(before, panelId);
        handleKeyEvent(keyEvent(fKey));
        const after = usePanelRegistry.getState().panels[panelId];
        // The center's only panel answers its key by taking focus.
        if (pinned) expect(after.focused).toBe(true);
        else expect(after.hidden).toBe(!before[panelId].hidden);
      }
    });

    it('gives the quarantined panel no shortcut', () => {
      expect([...PANEL_FKEY_BINDINGS.values()]).not.toContain('nodeEditor');
    });
  });

  describe('layout shortcuts', () => {
    beforeEach(resetRegistry);

    it('Ctrl+Shift+T reopens the last closed panel', () => {
      const registry = usePanelRegistry.getState();
      registry.openPanel('mixer');
      registry.closePanel('mixer');

      handleKeyEvent({
        key: 'T',
        code: 'KeyT',
        type: 'keydown',
        ctrlKey: true,
        shiftKey: true,
      } as KeyboardEvent);

      expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
    });
  });
});
