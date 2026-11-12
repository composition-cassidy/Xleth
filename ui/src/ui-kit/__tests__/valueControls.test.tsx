/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fader from '../Fader';
import FaderMeter from '../FaderMeter';
import Knob from '../Knob';
import Meter from '../Meter';
import NumberBox from '../NumberBox';
import { syncCodec } from '../parse';
import { MINUS, THIN_SPACE } from '../format';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let frames: Array<(ts: number) => void> = [];
let clock = 0;

function runFrames(n = 1, step = 16) {
  for (let i = 0; i < n; i += 1) {
    const run = frames;
    frames = [];
    clock += step;
    act(() => run.forEach((fn) => fn(clock)));
  }
}

beforeEach(() => {
  frames = [];
  clock = 1000;
  vi.stubGlobal('requestAnimationFrame', (cb: (ts: number) => void) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => { frames = []; });
  // jsdom has no canvas; record what the meter draws instead of logging "not implemented".
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
const slider = (name: string) => container.querySelector(`[role="slider"][aria-label="${name}"]`) as HTMLElement;
const dblclick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });

describe('Knob', () => {
  it('is a labelled slider that reads value and unit through formatValue', () => {
    render(<Knob label="Attack" value={10} min={0.1} max={100} unit="ms" />);
    const k = slider('Attack');
    expect(k).not.toBeNull();
    expect(k.getAttribute('aria-valuetext')).toBe(`Attack, 10.0${THIN_SPACE}ms`);
    expect(k.getAttribute('aria-valuenow')).toBe('10');
    expect(k.getAttribute('aria-valuemin')).toBe('0.1');
    expect(k.textContent).toContain(`10.0${THIN_SPACE}ms`);
    expect(k.textContent).toContain('Attack'); // label is part of the draggable cell
  });

  it('uses a true minus sign and ratio format', () => {
    render(<Knob label="Threshold" value={-20} min={-60} max={0} unit="dB" />);
    expect(slider('Threshold').textContent).toContain(`${MINUS}20.0${THIN_SPACE}dB`);
    render(<Knob label="Ratio" value={4} min={1} max={20} unit="ratio" />);
    expect(slider('Ratio').textContent).toContain('4.0 : 1');
  });

  it('is focusable, and carries hint + modifier help for the hint bar', () => {
    render(<Knob label="Mix" value={50} min={0} max={100} unit="%" hint="Dry/wet balance" />);
    const k = slider('Mix');
    expect(k.tabIndex).toBe(0);
    expect(k.getAttribute('data-hint')).toBe('Dry/wet balance');
    expect(k.getAttribute('data-hint-mods')).toContain('Shift: fine');
    expect(k.getAttribute('data-hint-mods')).toContain('Ctrl+click: reset');
  });

  it('draws the value arc from the centre when bipolar, from the minimum otherwise', () => {
    render(
      <>
        <Knob label="Pan" value={0.5} min={-1} max={1} bipolar unit="%" format={(v) => String(v)} />
        <Knob label="Level" value={0.5} min={-1} max={1} format={(v) => String(v)} />
      </>,
    );
    expect(slider('Pan').getAttribute('data-bipolar')).toBe('true');
    expect(slider('Level').getAttribute('data-bipolar')).toBeNull();
    // At the centre a bipolar knob has no arc at all; a unipolar one at 0 of -1..1 has one.
    render(
      <>
        <Knob label="Pan" value={0} min={-1} max={1} bipolar format={(v) => String(v)} />
        <Knob label="Level" value={0} min={-1} max={1} format={(v) => String(v)} />
      </>,
    );
    expect(slider('Pan').querySelectorAll('path').length).toBe(1); // track only
    expect(slider('Level').querySelectorAll('path').length).toBe(2); // track + value arc
  });

  it('disabled: not focusable, aria-disabled, ignores keys', () => {
    const onCommit = vi.fn();
    render(<Knob label="Mix" value={50} min={0} max={100} disabled onCommit={onCommit} />);
    const k = slider('Mix');
    expect(k.tabIndex).toBe(-1);
    expect(k.getAttribute('aria-disabled')).toBe('true');
    key(k, 'ArrowUp');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('double-click types a dB value with units and commits it', () => {
    const onCommit = vi.fn();
    render(<Knob label="Threshold" value={-20} min={-60} max={0} unit="dB" defaultValue={-20} onCommit={onCommit} />);
    dblclick(slider('Threshold'));
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe(`${MINUS}20.0${THIN_SPACE}dB`); // the formatted value, selected for overtyping
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, '-6 dB'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    key(input, 'Enter');
    expect(onCommit).toHaveBeenCalledWith(-6);
  });

  it('types Hz shorthand against a log-style scale-free range: "5k"', () => {
    const onCommit = vi.fn();
    render(<Knob label="Cutoff" value={455} min={20} max={20000} unit="Hz" onCommit={onCommit} />);
    dblclick(slider('Cutoff'));
    const input = container.querySelector('input') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, '5k'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    key(input, 'Enter');
    expect(onCommit).toHaveBeenCalledWith(5000);
  });

  it('tempo-synced knob: codec supplies the labels, the step and the parser', () => {
    const onCommit = vi.fn();
    const codec = syncCodec(['1/16', '1/8T', '1/8', '1/8D', '1/4']);
    render(<Knob label="Time" value={2} codec={codec} onCommit={onCommit} />);
    const k = slider('Time');
    expect(k.getAttribute('aria-valuetext')).toBe('Time, 1/8');
    key(k, 'ArrowUp');
    expect(onCommit).toHaveBeenLastCalledWith(3); // one step is one division
    dblclick(k);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('1/8');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, '1/8d'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    key(input, 'Enter');
    expect(onCommit).toHaveBeenLastCalledWith(3);
  });

  it('hideValue prints no readout but keeps the value text, and double-click still types one over the dial', () => {
    const onCommit = vi.fn();
    render(<Knob label="Pan" hideLabel hideValue value={0.3} min={-1} max={1} bipolar defaultValue={0} format={(v) => `R ${Math.round(v * 100)}`} onCommit={onCommit} />);
    const k = slider('Pan');
    expect(k.textContent).toBe('');
    expect(k.getAttribute('data-no-value')).toBe('true');
    expect(k.getAttribute('aria-valuetext')).toBe('Pan, R 30');
    dblclick(k);
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('R 30');
  });

  it('minimal is a disc and one pointer: no track, value arc or centre tick, straight up at the middle', () => {
    render(
      <>
        <Knob label="Pan" minimal size={20} value={0} min={-1} max={1} bipolar format={(v) => String(v)} />
        <Knob label="Pan off" minimal size={20} value={-1} min={-1} max={1} bipolar format={(v) => String(v)} />
      </>,
    );
    const k = slider('Pan');
    expect(k.getAttribute('data-minimal')).toBe('true');
    expect(k.querySelectorAll('path').length).toBe(0);
    expect(k.querySelectorAll('circle').length).toBe(1);
    const spokes = k.querySelectorAll('line');
    expect(spokes.length).toBe(1);
    const x1 = Number(spokes[0].getAttribute('x1'));
    const x2 = Number(spokes[0].getAttribute('x2'));
    const y1 = Number(spokes[0].getAttribute('y1'));
    const y2 = Number(spokes[0].getAttribute('y2'));
    expect(x1).toBeCloseTo(10, 6); // the middle of the range points straight up
    expect(x2).toBeCloseTo(10, 6);
    expect(y2).toBeLessThan(y1);
    // The minimum is the bottom-left end of the usual 270 degree sweep.
    const low = slider('Pan off').querySelector('line')!;
    expect(Number(low.getAttribute('x2'))).toBeLessThan(10);
    expect(Number(low.getAttribute('y2'))).toBeGreaterThan(10);
  });

  it('long labels truncate instead of widening the cell', () => {
    render(<Knob label="An extraordinarily long parameter label" value={1} min={0} max={2} format={() => '1'} width={56} />);
    const k = slider('An extraordinarily long parameter label');
    expect(k.style.getPropertyValue('--knob-w')).toBe('56px');
  });
});

describe('NumberBox', () => {
  it('is a horizontal slider showing value and unit', () => {
    render(<NumberBox label="Mix" value={70} min={0} max={100} unit="%" />);
    const b = slider('Mix');
    expect(b.getAttribute('aria-orientation')).toBe('horizontal');
    expect(b.getAttribute('aria-valuetext')).toBe(`Mix, 70${THIN_SPACE}%`);
    expect(b.textContent).toContain(`70${THIN_SPACE}%`);
  });

  it('sets the bottom-rule fill from the minimum, and from the centre when bipolar', () => {
    render(<NumberBox label="Trim" value={50} min={0} max={100} unit="%" />);
    expect(slider('Trim').style.getPropertyValue('--fill-a')).toBe('0');
    expect(slider('Trim').style.getPropertyValue('--fill-b')).toBe('0.5');
    render(<NumberBox label="Trim" value={-50} min={-100} max={100} unit="%" bipolar />);
    expect(slider('Trim').style.getPropertyValue('--fill-a')).toBe('0.25');
    expect(slider('Trim').style.getPropertyValue('--fill-b')).toBe('0.5');
  });

  it('same gestures: arrows nudge, Shift x10', () => {
    const onCommit = vi.fn();
    render(<NumberBox label="Mix" value={70} min={0} max={100} unit="%" onCommit={onCommit} />);
    key(slider('Mix'), 'ArrowUp');
    expect(onCommit).toHaveBeenLastCalledWith(71);
    key(slider('Mix'), 'ArrowDown', { shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith(60);
  });
});

describe('Fader', () => {
  it('defaults to the dB taper: 0 dB at 75% travel, -inf at the floor', () => {
    render(<Fader label="Track 1 level" value={0} />);
    const f = slider('Track 1 level');
    expect(f.style.getPropertyValue('--norm')).toBe('0.75');
    expect(f.getAttribute('aria-valuetext')).toBe(`Track 1 level, 0.0${THIN_SPACE}dB`);
    render(<Fader label="Track 1 level" value={-Infinity} />);
    expect(slider('Track 1 level').getAttribute('aria-valuetext')).toBe(`Track 1 level, ${MINUS}inf${THIN_SPACE}dB`);
    expect(Number(slider('Track 1 level').getAttribute('aria-valuenow'))).toBeLessThan(0); // finite floor, not -Infinity
  });

  it('Ctrl+click resets to 0 dB', () => {
    const onCommit = vi.fn();
    render(<Fader label="L" value={-12} onCommit={onCommit} />);
    const ev = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
    Object.defineProperty(ev, 'pointerId', { value: 1 });
    act(() => { slider('L').dispatchEvent(ev); });
    expect(onCommit).toHaveBeenCalledWith(0);
  });

  it('keys step along the taper', () => {
    const onCommit = vi.fn();
    render(<Fader label="L" value={0} onCommit={onCommit} />);
    key(slider('L'), 'ArrowUp');
    expect(onCommit.mock.calls[0][0]).toBeGreaterThan(0);
    key(slider('L'), 'PageDown');
    expect(onCommit.mock.calls.at(-1)![0]).toBeLessThan(0);
  });
});

describe('Meter', () => {
  it('is fed by the caller subscription and unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    render(<Meter label="Master" subscribe={subscribe} channels={2} />);
    expect(subscribe).toHaveBeenCalledTimes(1);
    act(() => root.render(<div />));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('latches the clip indicator until it is clicked, and clearing is not automatic', () => {
    let push: (v: number | readonly number[]) => void = () => {};
    const onClipChange = vi.fn();
    render(<Meter label="Master" subscribe={(p) => { push = p; return () => {}; }} channels={2} onClipChange={onClipChange} />);
    const clip = () => container.querySelector('button') as HTMLButtonElement;
    expect(clip().getAttribute('data-clipped')).toBe('false');
    act(() => push([-12, 0.5]));
    runFrames(1);
    expect(clip().getAttribute('data-clipped')).toBe('true');
    expect(onClipChange).toHaveBeenLastCalledWith(true);
    // The level falls away; the latch stays.
    act(() => push([-60, -60]));
    runFrames(200);
    expect(clip().getAttribute('data-clipped')).toBe('true');
    expect(clip().getAttribute('aria-label')).toMatch(/clipped/i);
    act(() => { clip().click(); });
    expect(clip().getAttribute('data-clipped')).toBe('false');
    expect(onClipChange).toHaveBeenLastCalledWith(false);
  });

  it('the draw loop sleeps once the meter is at rest', () => {
    let push: (v: number | readonly number[]) => void = () => {};
    render(<Meter label="Bus" subscribe={(p) => { push = p; return () => {}; }} />);
    act(() => push(-20));
    runFrames(1);
    expect(frames.length).toBe(1); // still falling
    act(() => push(-60));
    runFrames(200, 50);
    expect(frames.length).toBe(0); // settled: no more scheduled frames
  });

  it('has no per-tick DOM: one canvas and one button, whatever the scale', () => {
    render(<Meter label="Bus" subscribe={() => () => {}} channels={2} />);
    expect(container.querySelectorAll('canvas').length).toBe(1);
    expect(container.querySelectorAll('button').length).toBe(1);
    expect(container.querySelectorAll('*').length).toBeLessThan(5);
  });
});

describe('FaderMeter', () => {
  it('pairs a numeric field, the fader and the meter on one value', () => {
    const onCommit = vi.fn();
    render(<FaderMeter label="Track 2" value={-6} subscribe={() => () => {}} onCommit={onCommit} />);
    expect(slider('Track 2 level')).not.toBeNull(); // the numeric field above
    expect(slider('Track 2')).not.toBeNull(); // the fader
    expect(container.querySelector('canvas')).not.toBeNull(); // the meter
    expect(slider('Track 2 level').textContent).toContain(`${MINUS}6.0${THIN_SPACE}dB`);
    dblclick(slider('Track 2 level'));
    const input = container.querySelector('input') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => { set.call(input, '-inf'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    key(input, 'Enter');
    expect(onCommit).toHaveBeenCalledWith(-Infinity);
  });
});
