/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  destroy,
  handleKeyEvent,
  init,
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

  describe('the panel under the mouse', () => {
    // Real DOM panels, so pointerover resolves through [data-panel-id].
    function mountPanel(id: string): HTMLElement {
      const frame = document.createElement('section');
      frame.setAttribute('data-panel-id', id);
      frame.tabIndex = -1;
      const inner = document.createElement('div');
      frame.appendChild(inner);
      document.body.appendChild(frame);
      return inner;
    }
    function hover(el: Element) {
      el.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    }

    beforeEach(() => {
      document.body.innerHTML = '';
      init();
    });

    it('gets Ctrl+C even when a control in another panel still holds focus', () => {
      // Repro: click an Inspector toggle (the Inspector becomes the focused
      // panel and the button keeps DOM focus), move back over the timeline,
      // press Ctrl+C. The Inspector has no Ctrl+C, so the copy went nowhere.
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      usePanelRegistry.getState().openPanel('inspector');
      const inspectorButton = document.createElement('button');
      mountPanel('inspector').appendChild(inspectorButton);
      inspectorButton.focus();
      const timelineBody = mountPanel('timeline');

      hover(timelineBody);
      const event = shortcutEvent('c', { ctrlKey: true });
      handleKeyEvent(event);

      expect(copy).toHaveBeenCalledTimes(1);
      // ...and the timeline now owns the keyboard, so the stale button no
      // longer catches Space/Enter.
      expect(usePanelRegistry.getState().panels.timeline.focused).toBe(true);
      expect(document.activeElement).toBe(timelineBody.parentElement);
    });

    it('outranks the focused panel when both bind the key', () => {
      const pianoCopy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      const timelineCopy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:pianoRoll', combo: 'Ctrl+c', handler: pianoCopy });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: timelineCopy });
      usePanelRegistry.getState().openPanel('pianoRoll');
      mountPanel('pianoRoll');
      hover(mountPanel('timeline'));

      handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));

      expect(timelineCopy).toHaveBeenCalledTimes(1);
      expect(pianoCopy).not.toHaveBeenCalled();
    });

    it('falls through to the focused panel when it has no binding for the key', () => {
      // Hovering the Preview to watch it must not swallow the timeline's Delete.
      const del = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Delete', handler: del });
      usePanelRegistry.getState().focusPanel('timeline');
      mountPanel('timeline');
      hover(mountPanel('preview'));

      handleKeyEvent(shortcutEvent('Delete'));

      expect(del).toHaveBeenCalledTimes(1);
      expect(usePanelRegistry.getState().panels.timeline.focused).toBe(true);
    });

    it('does not override a text field that has focus', () => {
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      const input = document.createElement('input');
      mountPanel('inspector').appendChild(input);
      input.focus();
      hover(mountPanel('timeline'));

      handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));

      expect(copy).not.toHaveBeenCalled();
    });

    it('forgets the panel once the pointer leaves the window', () => {
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      usePanelRegistry.getState().openPanel('inspector');
      const timelineBody = mountPanel('timeline');
      hover(timelineBody);
      timelineBody.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));

      handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));

      expect(copy).not.toHaveBeenCalled();
    });

    it('picks the panel up again on the next move inside the same element', () => {
      // The arrangement canvas is one large element. After anything reset the
      // tracker, moving around inside it crosses no boundary, so a tracker fed
      // by pointerover alone stayed blind until the mouse left and came back.
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      usePanelRegistry.getState().openPanel('inspector');
      const timelineBody = mountPanel('timeline');
      hover(timelineBody);
      timelineBody.dispatchEvent(new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }));
      timelineBody.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));

      handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));

      expect(copy).toHaveBeenCalledTimes(1);
    });

    it('hit-tests where the pointer is when the key arrives, not where it last entered', () => {
      // A menu closes (or a tab switches) under a still pointer: no pointer
      // event fires, but what is under the mouse has changed.
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      usePanelRegistry.getState().openPanel('inspector');
      const menu = document.createElement('div');
      document.body.appendChild(menu);
      const timelineBody = mountPanel('timeline');
      menu.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, clientX: 40, clientY: 50 }));
      const hitTest = vi.fn(() => timelineBody as Element | null);
      Object.defineProperty(document, 'elementFromPoint', { value: hitTest, configurable: true });
      try {
        handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));
      } finally {
        delete (document as unknown as Record<string, unknown>).elementFromPoint;
      }

      expect(hitTest).toHaveBeenCalledWith(40, 50);
      expect(copy).toHaveBeenCalledTimes(1);
    });

    it('forgets a hovered element that has left the page', () => {
      const copy = vi.fn((event: KeyboardEvent) => { event.preventDefault(); return 'handled' as const; });
      register({ scope: 'panel:timeline', combo: 'Ctrl+c', handler: copy });
      usePanelRegistry.getState().openPanel('inspector');
      const timelineBody = mountPanel('timeline');
      hover(timelineBody);
      timelineBody.parentElement!.remove();

      handleKeyEvent(shortcutEvent('c', { ctrlKey: true }));

      expect(copy).not.toHaveBeenCalled();
    });
  });

  describe('controls that hold focus without being text entry', () => {
    beforeEach(() => { document.body.innerHTML = ''; });
    // A text field left focused would swallow every later test's key.
    afterEach(() => { document.body.innerHTML = ''; });

    function focusInput(type: string): HTMLInputElement {
      const input = document.createElement('input');
      input.type = type;
      document.body.appendChild(input);
      input.focus();
      return input;
    }

    it.each(['checkbox', 'radio', 'range', 'color'])('a focused %s input does not switch shortcuts off', (type) => {
      // They are <input> elements, so the text-entry guard used to treat a
      // ticked checkbox like a text field and drop every key until a click
      // moved focus somewhere else.
      const undo = vi.fn(() => 'handled' as const);
      register({ scope: 'panel:timeline', combo: 'Ctrl+z', handler: undo });
      usePanelRegistry.getState().focusPanel('timeline');
      focusInput(type);

      handleKeyEvent(shortcutEvent('z', { ctrlKey: true }));

      expect(undo).toHaveBeenCalledTimes(1);
    });

    it('a focused checkbox still owns Space', () => {
      const play = vi.fn(() => 'handled' as const);
      register({ scope: 'panel:timeline', combo: ' ', handler: play });
      usePanelRegistry.getState().focusPanel('timeline');
      focusInput('checkbox');

      handleKeyEvent(shortcutEvent(' '));

      expect(play).not.toHaveBeenCalled();
    });

    it.each(['text', 'search', 'number'])('a focused %s input still takes every key', (type) => {
      const undo = vi.fn(() => 'handled' as const);
      register({ scope: 'panel:timeline', combo: 'Ctrl+z', handler: undo });
      usePanelRegistry.getState().focusPanel('timeline');
      focusInput(type);

      handleKeyEvent(shortcutEvent('z', { ctrlKey: true }));

      expect(undo).not.toHaveBeenCalled();
    });
  });

  it('a global binding answers when neither the hovered nor the focused panel binds the key', () => {
    // Ctrl+Z with the mouse and the last click both on the Inspector: the
    // project undo is registered globally so it is not lost.
    const undo = vi.fn(() => 'handled' as const);
    const graphUndo = vi.fn(() => 'handled' as const);
    register({ scope: 'global', combo: 'Ctrl+z', handler: undo });
    register({ scope: 'panel:fxGraph', combo: 'Ctrl+z', handler: graphUndo });
    usePanelRegistry.getState().openPanel('inspector');

    handleKeyEvent(shortcutEvent('z', { ctrlKey: true }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(graphUndo).not.toHaveBeenCalled();

    // A panel with an undo of its own keeps the key while it is focused.
    usePanelRegistry.getState().openPanel('fxGraph');
    handleKeyEvent(shortcutEvent('z', { ctrlKey: true }));
    expect(graphUndo).toHaveBeenCalledTimes(1);
    expect(undo).toHaveBeenCalledTimes(1);
  });

  it('a "`" binding matches the physical Backquote key on any layout', () => {
    // German '^', Russian 'ё', French '²': the key left of 1 still means '`'.
    const toggle = vi.fn(() => 'handled' as const);
    register({ scope: 'global', combo: '`', handler: toggle });
    handleKeyEvent(shortcutEvent('^', { code: 'Backquote' } as Partial<KeyboardEvent>));
    handleKeyEvent(shortcutEvent('ё', { code: 'Backquote' } as Partial<KeyboardEvent>));
    handleKeyEvent(shortcutEvent('`', { code: 'Backquote' } as Partial<KeyboardEvent>));
    expect(toggle).toHaveBeenCalledTimes(3);
    // A '`' printed by some OTHER key cap matches on event.key as before; another key does not.
    handleKeyEvent(shortcutEvent('`', { code: 'Equal' } as Partial<KeyboardEvent>));
    expect(toggle).toHaveBeenCalledTimes(4);
    handleKeyEvent(shortcutEvent('^', { code: 'Digit6' } as Partial<KeyboardEvent>));
    expect(toggle).toHaveBeenCalledTimes(4);
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
