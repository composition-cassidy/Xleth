/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginPointerGesture } from '../managers/pointerGesture';
import {
  armPanelDrag,
  cancelDrag,
  getDragState,
  registerWorkAreaRect,
  type ActiveDragState,
} from '../managers/DragManager';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

function makeTarget(withCapture: boolean) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  if (withCapture) {
    (el as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();
    (el as HTMLElement & { releasePointerCapture: (id: number) => void }).releasePointerCapture = vi.fn();
  }
  return el;
}

function pointerEvent(type: string, init: Record<string, unknown> = {}) {
  // jsdom has no PointerEvent constructor; an Event with the fields the
  // handlers read is equivalent for this purpose.
  const event = new Event(type, { bubbles: true });
  Object.assign(event, {
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  });
  return event;
}

describe('pointerGesture', () => {
  let handlers: {
    onMove: ReturnType<typeof vi.fn>;
    onEnd: ReturnType<typeof vi.fn>;
    onCancel: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    handlers = { onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn() };
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('captures the pointer on the handle so events outside the window still arrive', () => {
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    expect((target as HTMLElement & { setPointerCapture: ReturnType<typeof vi.fn> })
      .setPointerCapture).toHaveBeenCalledWith(1);

    // Captured: the element itself receives the moves, not window.
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 40, clientY: 20 }));
    expect(handlers.onMove).toHaveBeenCalledWith(40, 20, expect.objectContaining({ shiftKey: false }));
  });

  it('falls back to window listeners when the pointer cannot be captured', () => {
    const target = makeTarget(false);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    window.dispatchEvent(pointerEvent('pointermove', { clientX: 5, clientY: 6 }));
    expect(handlers.onMove).toHaveBeenCalledWith(5, 6, expect.anything());
  });

  it('still works when setPointerCapture throws for a pointer that is already gone', () => {
    const target = makeTarget(true);
    (target as HTMLElement & { setPointerCapture: () => never }).setPointerCapture = () => {
      throw new Error('NotFoundError');
    };

    expect(() => beginPointerGesture({ target, pointerId: 1 }, handlers)).not.toThrow();
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 1, clientY: 2 }));
    expect(handlers.onMove).toHaveBeenCalled();
  });

  it('ends exactly once and detaches before the handler runs', () => {
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    target.dispatchEvent(pointerEvent('pointerup'));
    target.dispatchEvent(pointerEvent('pointerup'));
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 99, clientY: 99 }));

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    // Detached: a move after the release must not reach the gesture.
    expect(handlers.onMove).not.toHaveBeenCalled();
  });

  it('treats pointercancel as a cancel, not a commit', () => {
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    target.dispatchEvent(pointerEvent('pointercancel'));

    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });

  it('commits when the browser takes the capture away', () => {
    // lostpointercapture is what fires when the window is deactivated mid-drag.
    // Committing at the last position beats stranding the panel on the cursor.
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    target.dispatchEvent(pointerEvent('lostpointercapture'));

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('commits on window blur so an alt-tab cannot strand the gesture', () => {
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    window.dispatchEvent(new Event('blur'));

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores events belonging to a different pointer', () => {
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    target.dispatchEvent(pointerEvent('pointerup', { pointerId: 2 }));
    expect(handlers.onEnd).not.toHaveBeenCalled();

    target.dispatchEvent(pointerEvent('pointerup', { pointerId: 1 }));
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('detach() releases the capture and is safe to call twice', () => {
    const target = makeTarget(true);
    const release = (target as HTMLElement & { releasePointerCapture: ReturnType<typeof vi.fn> })
      .releasePointerCapture;
    const detach = beginPointerGesture({ target, pointerId: 1 }, handlers);

    detach();
    detach();

    expect(release).toHaveBeenCalledTimes(1);
    target.dispatchEvent(pointerEvent('pointerup'));
    expect(handlers.onEnd).not.toHaveBeenCalled();
  });
});

describe('armPanelDrag threshold', () => {
  beforeEach(() => {
    cancelDrag();
    registerWorkAreaRect({ left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 });
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
    usePanelRegistry.getState().dockPanel('mixer', 'bottom');
  });

  afterEach(() => {
    cancelDrag();
    document.body.innerHTML = '';
  });

  it('a press and release without travel does not start a drag or undock', () => {
    // The bug this guards: dragging a docked panel undocks it, so with no
    // threshold a plain click on a dock tab tore the panel out of its slot
    // before the click handler could select it.
    const target = makeTarget(true);
    armPanelDrag('mixer', 100, 100, 0, 0, { target, pointerId: 1 });

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 102, clientY: 101 }));
    expect(getDragState().state).toBe('idle');

    target.dispatchEvent(pointerEvent('pointerup', { clientX: 102, clientY: 101 }));
    expect(getDragState().state).toBe('idle');
    expect(usePanelRegistry.getState().panels.mixer.mode).toBe('docked');
  });

  it('promotes to a drag once the pointer travels past the threshold', () => {
    const target = makeTarget(true);
    armPanelDrag('mixer', 100, 100, 0, 0, { target, pointerId: 1 });

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 160 }));

    expect(getDragState().state).toBe('dragging');
    // Promotion undocks, exactly as dragging a docked panel always has.
    expect(usePanelRegistry.getState().panels.mixer.mode).toBe('floating');
  });

  it('never captures the pressed handle, before or after promotion', () => {
    // Capturing before promotion would retarget the click and break
    // click-to-select on a tab; capturing the handle after promotion is the bug
    // below — it dies when the undock unmounts it.
    const target = makeTarget(true);
    const capture = (target as HTMLElement & { setPointerCapture: ReturnType<typeof vi.fn> })
      .setPointerCapture;
    const release = (target as HTMLElement & { releasePointerCapture: ReturnType<typeof vi.fn> })
      .releasePointerCapture;
    armPanelDrag('mixer', 100, 100, 0, 0, { target, pointerId: 1 });

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 140, clientY: 160 }));
    expect(capture).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    target.dispatchEvent(pointerEvent('pointermove', { clientX: 200, clientY: 200 }));
    expect(getDragState().state).toBe('dragging');
  });

  it('captures on the work area, which outlives the undock', () => {
    // THE regression: promotion undocks the panel, React re-parents it into the
    // floating layer and unmounts the titlebar that was pressed. A capture on
    // that node dies with it and swallows pointerup, so the drag ran forever
    // with the snap ghost painted over the workspace until the window blurred.
    const workArea = document.createElement('div');
    workArea.className = 'xleth-app-workarea';
    (workArea as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    (workArea as HTMLElement & { releasePointerCapture: unknown }).releasePointerCapture = vi.fn();
    document.body.appendChild(workArea);

    const handle = document.createElement('div');
    (handle as HTMLElement & { setPointerCapture: unknown }).setPointerCapture = vi.fn();
    (handle as HTMLElement & { releasePointerCapture: unknown }).releasePointerCapture = vi.fn();
    workArea.appendChild(handle);

    armPanelDrag('mixer', 100, 100, 0, 0, { target: handle, pointerId: 1 });
    window.dispatchEvent(pointerEvent('pointermove', { clientX: 160, clientY: 160 }));

    expect(getDragState().state).toBe('dragging');
    expect((handle as HTMLElement & { setPointerCapture: ReturnType<typeof vi.fn> })
      .setPointerCapture).not.toHaveBeenCalled();
    expect((workArea as HTMLElement & { setPointerCapture: ReturnType<typeof vi.fn> })
      .setPointerCapture).toHaveBeenCalledWith(1);

    // What React does on undock.
    handle.remove();

    workArea.dispatchEvent(pointerEvent('pointerup', { clientX: 200, clientY: 200 }));
    expect(getDragState().state).toBe('idle');
  });

  it('the promotion move itself is applied, so a one-move flick still resolves a drop', () => {
    const target = makeTarget(true);
    armPanelDrag('mixer', 600, 400, 0, 0, { target, pointerId: 1 });

    // One move, straight into the left edge band.
    target.dispatchEvent(pointerEvent('pointermove', { clientX: 10, clientY: 400 }));

    expect((getDragState() as ActiveDragState).currentSnapTarget).toBe('left');
  });
});

describe('pointerGesture backstop', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('a release still ends the gesture when the capture target is gone', () => {
    // Belt and braces for the class of bug above: whatever happens to the
    // capture target, pointerup bubbles to window from wherever the pointer
    // actually is, so a gesture always has a way to finish.
    const handlers = { onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn() };
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    target.remove();
    window.dispatchEvent(pointerEvent('pointerup'));

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when the release reaches both the host and window', () => {
    const handlers = { onMove: vi.fn(), onEnd: vi.fn(), onCancel: vi.fn() };
    const target = makeTarget(true);
    beginPointerGesture({ target, pointerId: 1 }, handlers);

    // Bubbles target -> … -> window, hitting both registrations.
    target.dispatchEvent(pointerEvent('pointerup'));

    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });
});
