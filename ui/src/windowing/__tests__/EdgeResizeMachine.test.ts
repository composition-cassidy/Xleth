import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEdgeResizeMachine } from '../managers/EdgeResizeMachine';

interface TestBounds {
  start: number;
}

interface TestPreview {
  size: number;
}

function makeMachine() {
  const commit = vi.fn();
  const machine = createEdgeResizeMachine<string, TestBounds, TestPreview>({
    name: 'test',
    computePreview: (start, dx) => ({ size: Math.max(10, start.start + dx) }),
    commit,
    arePreviewsEqual: (a, b) => a.size === b.size,
  });
  return { machine, commit };
}

describe('EdgeResizeMachine', () => {
  beforeEach(() => {
    // ensure no listener leakage across tests
  });

  it('starts idle', () => {
    const { machine } = makeMachine();
    expect(machine.isActive()).toBe(false);
    expect(machine.cancelIfActive()).toBe(false);
  });

  it('commits exactly once on end with the final preview', () => {
    const { machine, commit } = makeMachine();
    machine.begin('alpha', 0, 0, { start: 100 });
    machine.update(50, 0);
    machine.update(80, 0);
    expect(commit).not.toHaveBeenCalled();
    machine.end();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('alpha', { size: 180 });
  });

  it('does not commit on cancel', () => {
    const { machine, commit } = makeMachine();
    machine.begin('alpha', 0, 0, { start: 100 });
    machine.update(50, 0);
    machine.cancel();
    expect(commit).not.toHaveBeenCalled();
    expect(machine.isActive()).toBe(false);
  });

  it('cancelIfActive returns true when resizing and false when idle', () => {
    const { machine, commit } = makeMachine();
    expect(machine.cancelIfActive()).toBe(false);
    machine.begin('alpha', 0, 0, { start: 100 });
    expect(machine.cancelIfActive()).toBe(true);
    expect(commit).not.toHaveBeenCalled();
    expect(machine.isActive()).toBe(false);
    expect(machine.cancelIfActive()).toBe(false);
  });

  it('clamps via computePreview', () => {
    const { machine, commit } = makeMachine();
    machine.begin('alpha', 0, 0, { start: 100 });
    machine.update(-1000, 0);
    machine.end();
    expect(commit).toHaveBeenCalledWith('alpha', { size: 10 });
  });

  it('emits to subscribers on begin/update/end/cancel', () => {
    const { machine } = makeMachine();
    const listener = vi.fn();
    machine.subscribe(listener);

    machine.begin('alpha', 0, 0, { start: 100 });
    expect(listener).toHaveBeenCalledTimes(1);

    machine.update(10, 0);
    expect(listener).toHaveBeenCalledTimes(2);

    machine.end();
    expect(listener).toHaveBeenCalledTimes(3);

    machine.begin('alpha', 0, 0, { start: 100 });
    machine.cancel();
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it('subscribe returns an unsubscribe', () => {
    const { machine } = makeMachine();
    const listener = vi.fn();
    const unsubscribe = machine.subscribe(listener);
    machine.begin('alpha', 0, 0, { start: 100 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    machine.update(10, 0);
    expect(listener).toHaveBeenCalledTimes(1);
    machine.cancel();
  });

  it('rebinds cleanly when begin is called twice without end', () => {
    const { machine, commit } = makeMachine();
    machine.begin('alpha', 0, 0, { start: 100 });
    machine.begin('beta', 0, 0, { start: 50 });
    machine.update(20, 0);
    machine.end();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith('beta', { size: 70 });
  });

  it('update is a no-op when idle', () => {
    const { machine } = makeMachine();
    expect(() => machine.update(10, 10)).not.toThrow();
  });

  it('end is a no-op when idle', () => {
    const { machine, commit } = makeMachine();
    machine.end();
    expect(commit).not.toHaveBeenCalled();
  });

  it('cancel is a no-op when idle', () => {
    const { machine } = makeMachine();
    expect(() => machine.cancel()).not.toThrow();
  });
});
