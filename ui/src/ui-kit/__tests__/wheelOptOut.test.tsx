/**
 * @vitest-environment jsdom
 */
// `wheel={false}`: a value control inside a scrolling list (Motion view's property
// tree) leaves the wheel to the list. Default stays: the wheel steps the value.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fader from '../Fader';
import Knob from '../Knob';
import NumberBox from '../NumberBox';
import Slider from '../Slider';
import { VALUE_HINT_MODS, VALUE_HINT_MODS_NO_WHEEL, valueHintMods } from '../hint';
import { useValueDrag } from '../useValueDrag';
import { linearScale } from '../valueScale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const slider = () => container.querySelector('[role="slider"]') as HTMLElement;
const wheel = (el: Element, deltaY = -120) => {
  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true });
  act(() => { el.dispatchEvent(ev); });
  return ev;
};

function Harness(props: { wheel?: boolean; onCommit: (v: number) => void }) {
  const drag = useValueDrag({ value: 50, scale: linearScale(0, 100), wheel: props.wheel, onCommit: props.onCommit });
  return <div ref={drag.ref} data-testid="cell" role="slider" tabIndex={0} {...drag.handlers} />;
}

describe('useValueDrag wheel option', () => {
  it('default: the wheel steps and is consumed', () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const ev = wheel(slider());
    expect(ev.defaultPrevented).toBe(true);
    expect(onCommit).toHaveBeenCalledWith(51);
  });

  it('wheel: false: no step, the event is left to the scrolling container', () => {
    const onCommit = vi.fn();
    const onListWheel = vi.fn();
    container.addEventListener('wheel', onListWheel);
    render(<Harness wheel={false} onCommit={onCommit} />);
    const ev = wheel(slider());
    expect(ev.defaultPrevented).toBe(false);
    expect(onCommit).not.toHaveBeenCalled();
    expect(onListWheel).toHaveBeenCalledTimes(1);
  });

  it('switching the option at runtime takes effect without re-binding', () => {
    const onCommit = vi.fn();
    render(<Harness wheel={false} onCommit={onCommit} />);
    wheel(slider());
    render(<Harness wheel onCommit={onCommit} />);
    wheel(slider());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('value controls pass the option through', () => {
  const cases: Array<[string, (w: boolean | undefined, c: (v: number) => void) => React.ReactElement]> = [
    ['NumberBox', (w, c) => <NumberBox label="Offset" value={0} min={-8} max={8} wheel={w} onCommit={c} />],
    ['Knob', (w, c) => <Knob label="Gain" value={0} min={-8} max={8} wheel={w} onCommit={c} />],
    ['Fader', (w, c) => <Fader label="Level" value={0} wheel={w} onCommit={c} />],
    ['Slider', (w, c) => <Slider label="Amount" value={0} min={-8} max={8} wheel={w} onCommit={c} />],
  ];

  for (const [name, make] of cases) {
    it(`${name}: wheel={false} ignores the wheel, keeps keys, drops "Wheel: step" from its help, adds no DOM attribute`, () => {
      const onCommit = vi.fn();
      render(make(false, onCommit));
      expect(wheel(slider()).defaultPrevented).toBe(false);
      expect(onCommit).not.toHaveBeenCalled();
      expect(slider().getAttribute('data-hint-mods')).toBe(VALUE_HINT_MODS_NO_WHEEL);
      expect(slider().hasAttribute('wheel')).toBe(false);
      act(() => { slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); });
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it(`${name}: default still steps on the wheel and documents it`, () => {
      const onCommit = vi.fn();
      render(make(undefined, onCommit));
      expect(wheel(slider()).defaultPrevented).toBe(true);
      expect(onCommit).toHaveBeenCalledTimes(1);
      expect(slider().getAttribute('data-hint-mods')).toBe(VALUE_HINT_MODS);
    });
  }

  it('valueHintMods', () => {
    expect(valueHintMods()).toBe(VALUE_HINT_MODS);
    expect(valueHintMods(false)).toBe(VALUE_HINT_MODS_NO_WHEEL);
    expect(VALUE_HINT_MODS_NO_WHEEL).not.toMatch(/Wheel/);
  });
});
