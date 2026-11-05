/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseValue } from '../parse';
import { useValueDrag, type UseValueDragOptions } from '../useValueDrag';
import { linearScale, logScale } from '../valueScale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let frames: Array<() => void> = [];

// Manual animation-frame queue: coalescing is part of the contract.
function flushFrame() {
  const run = frames;
  frames = [];
  act(() => run.forEach((fn) => fn()));
}

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness(props: Partial<UseValueDragOptions> & { onChange?: (v: number) => void }) {
  const drag = useValueDrag({
    value: 50,
    scale: linearScale(0, 100),
    pxPerRange: 200,
    defaultValue: 25,
    format: (v) => `${v} dB`,
    parse: (t) => parseValue(t, 'dB'),
    ...props,
  });
  return (
    <div ref={drag.ref} tabIndex={0} data-testid="cell" data-dragging={drag.dragging} data-value={drag.displayValue} {...drag.handlers}>
      {drag.editing ? <input data-testid="editor" {...drag.editorProps} /> : <span>{drag.displayValue}</span>}
    </div>
  );
}

const cell = () => container.querySelector('[data-testid="cell"]') as HTMLElement;
const editor = () => container.querySelector('[data-testid="editor"]') as HTMLInputElement | null;

function ptr(type: string, init: Record<string, unknown> = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, ...init });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  return ev;
}
const fire = (el: Element, ev: Event) => act(() => { el.dispatchEvent(ev); });
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  fire(el, new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('drag', () => {
  it('coalesces live changes to one onChange per animation frame, commits once on release', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => root.render(<Harness onChange={onChange} onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientY: 400 }));
    fire(cell(), ptr('pointermove', { clientY: 380 }));
    fire(cell(), ptr('pointermove', { clientY: 360 }));
    fire(cell(), ptr('pointermove', { clientY: 340 }));
    expect(onChange).not.toHaveBeenCalled(); // nothing until the frame
    flushFrame();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(80); // 60px up of 200 = +30
    expect(cell().dataset.value).toBe('80'); // the display follows the drag
    fire(cell(), ptr('pointerup', { clientY: 340 }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(80);
    expect(cell().dataset.dragging).toBe('false');
  });

  it('a plain click (no movement) is not an undo entry', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientY: 400 }));
    fire(cell(), ptr('pointerup', { clientY: 400 }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Shift is fine', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientY: 400, shiftKey: true }));
    fire(cell(), ptr('pointermove', { clientY: 300, shiftKey: true }));
    fire(cell(), ptr('pointerup'));
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(55);
  });

  it('Escape cancels back to the start value without committing', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    act(() => root.render(<Harness onChange={onChange} onCommit={onCommit} onCancel={onCancel} />));
    fire(cell(), ptr('pointerdown', { clientY: 400 }));
    fire(cell(), ptr('pointermove', { clientY: 350 }));
    flushFrame();
    expect(onChange).toHaveBeenLastCalledWith(75);
    key(document.body, 'Escape');
    expect(onChange).toHaveBeenLastCalledWith(50); // live preview reverted
    expect(onCancel).toHaveBeenCalledWith(50);
    expect(cell().dataset.value).toBe('50');
    fire(cell(), ptr('pointerup'));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Ctrl+click resets to defaultValue and commits, without starting a drag', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => root.render(<Harness onChange={onChange} onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { ctrlKey: true }));
    expect(onChange).toHaveBeenCalledWith(25);
    expect(onCommit).toHaveBeenCalledWith(25);
    expect(cell().dataset.dragging).toBe('false');
  });

  it('ignores everything while disabled', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => root.render(<Harness disabled onChange={onChange} onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientY: 400 }));
    fire(cell(), ptr('pointermove', { clientY: 300 }));
    flushFrame();
    key(cell(), 'ArrowUp');
    fire(cell(), ptr('pointerdown', { ctrlKey: true }));
    fire(cell(), new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it('horizontal axis (number box): drag right increases', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness axis="x" onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientX: 100 }));
    fire(cell(), ptr('pointermove', { clientX: 140 }));
    fire(cell(), ptr('pointerup'));
    expect(onCommit).toHaveBeenCalledWith(70);
  });

  it('reads a function pxPerRange at pointerdown (fader rail length)', () => {
    const onCommit = vi.fn();
    const px = vi.fn(() => 100);
    act(() => root.render(<Harness pxPerRange={px} onCommit={onCommit} />));
    fire(cell(), ptr('pointerdown', { clientY: 400 }));
    fire(cell(), ptr('pointermove', { clientY: 380 }));
    fire(cell(), ptr('pointerup'));
    expect(onCommit).toHaveBeenCalledWith(70); // 20px of 100 = +20
  });
});

describe('wheel and keys', () => {
  it('wheel steps once per event (up = increase) and prevents page scroll', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    const up = new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true });
    fire(cell(), up);
    expect(up.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenLastCalledWith(51);
  });

  it('Shift+wheel is fine', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new WheelEvent('wheel', { deltaY: 100, shiftKey: true, bubbles: true, cancelable: true }));
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(49.9);
  });

  it('arrow keys nudge one step; Shift x10; PageUp x10; Home / End', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    key(cell(), 'ArrowUp');
    expect(onCommit).toHaveBeenLastCalledWith(51);
    key(cell(), 'ArrowDown', { shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(40);
    key(cell(), 'ArrowRight');
    expect(onCommit).toHaveBeenLastCalledWith(51);
    key(cell(), 'PageUp');
    expect(onCommit).toHaveBeenLastCalledWith(60);
    key(cell(), 'Home');
    expect(onCommit).toHaveBeenLastCalledWith(0);
    key(cell(), 'End');
    expect(onCommit).toHaveBeenLastCalledWith(100);
  });

  it('modified keys are left to the app shortcuts', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    key(cell(), 'ArrowUp', { ctrlKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a value step (integer parameter) overrides the percentage step', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness step={1} scale={linearScale(0, 8)} value={3} onCommit={onCommit} />));
    key(cell(), 'ArrowUp');
    expect(onCommit).toHaveBeenLastCalledWith(4);
  });
});

describe('type-in', () => {
  it('double-click opens the editor with the formatted value, selected', () => {
    act(() => root.render(<Harness />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    expect(editor()).not.toBeNull();
    expect(editor()!.value).toBe('50 dB');
    expect(document.activeElement).toBe(editor());
  });

  it('Enter parses units and commits; the cell is refocused', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    act(() => root.render(<Harness scale={linearScale(-96, 12)} value={0} defaultValue={0} onChange={onChange} onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, '-6 dB');
    key(editor()!, 'Enter');
    expect(onCommit).toHaveBeenCalledWith(-6);
    expect(onChange).toHaveBeenCalledWith(-6);
    expect(editor()).toBeNull();
    expect(document.activeElement).toBe(cell());
  });

  it('parses frequency shorthand against a log scale: "5k" -> 5000', () => {
    const onCommit = vi.fn();
    act(() => root.render(
      <Harness scale={logScale(20, 20000)} value={440} parse={(t) => parseValue(t, 'Hz')} format={(v) => `${v} Hz`} onCommit={onCommit} />,
    ));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, '5k');
    key(editor()!, 'Enter');
    expect(onCommit.mock.calls[0][0]).toBeCloseTo(5000);
  });

  it('clamps typed values to the range', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, '999');
    key(editor()!, 'Enter');
    expect(onCommit).toHaveBeenCalledWith(100);
  });

  it('rejects text that is not a value: stays open, marked invalid, no commit', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, 'loud');
    key(editor()!, 'Enter');
    expect(onCommit).not.toHaveBeenCalled();
    expect(editor()).not.toBeNull();
    expect(editor()!.getAttribute('aria-invalid')).toBe('true');
  });

  it('Escape closes the editor without committing', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, '10');
    key(editor()!, 'Escape');
    expect(editor()).toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('blur commits a valid entry and drops an invalid one', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, '20');
    act(() => { editor()!.blur(); });
    expect(onCommit).toHaveBeenCalledWith(20);

    onCommit.mockClear();
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    typeInto(editor()!, 'nope');
    act(() => { editor()!.blur(); });
    expect(onCommit).not.toHaveBeenCalled();
    expect(editor()).toBeNull();
  });

  it('keys typed in the editor never reach the control (arrows move the caret)', () => {
    const onCommit = vi.fn();
    act(() => root.render(<Harness onCommit={onCommit} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    key(editor()!, 'ArrowUp');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Enter on the focused cell opens the editor (keyboard route to type-in)', () => {
    act(() => root.render(<Harness />));
    key(cell(), 'Enter');
    expect(editor()).not.toBeNull();
  });

  it('pointerdown inside the editor does not start a drag', () => {
    const onChange = vi.fn();
    act(() => root.render(<Harness onChange={onChange} />));
    fire(cell(), new MouseEvent('dblclick', { bubbles: true }));
    fire(editor()!, ptr('pointerdown', { clientY: 400 }));
    fire(editor()!, ptr('pointermove', { clientY: 300 }));
    flushFrame();
    expect(onChange).not.toHaveBeenCalled();
  });
});
