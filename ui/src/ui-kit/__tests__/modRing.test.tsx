/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Knob from '../Knob';
import NumberBox from '../NumberBox';
import { MOD_AMOUNT_PX, modRangeNorm, stepAmount, type ControlMod } from '../modRing';
import { linearScale } from '../valueScale';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
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
function ptr(type: string, init: Record<string, unknown> = {}) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0, ...init });
  Object.defineProperty(ev, 'pointerId', { value: 1 });
  return ev;
}
const fire = (el: Element, ev: Event) => act(() => { el.dispatchEvent(ev); });

function makeMod(over: Partial<ControlMod> = {}): ControlMod {
  return {
    dropProps: { 'data-mod-target': '4:1:0' },
    active: true,
    amount: 0.25,
    bipolar: false,
    ringLo: 0,
    ringHi: 25,
    tooltip: 'LFO 1 → Slot 2 fine: +25 ct',
    onRingPreview: vi.fn(),
    onRingCommit: vi.fn(),
    onToggleBipolar: vi.fn(),
    ...over,
  };
}

describe('modRing maths', () => {
  it('moves the amount by one unit per MOD_AMOUNT_PX, fine is x0.1, clamped to -1..+1', () => {
    expect(stepAmount(0, MOD_AMOUNT_PX, false)).toBeCloseTo(1);
    expect(stepAmount(0, MOD_AMOUNT_PX, true)).toBeCloseTo(0.1);
    expect(stepAmount(0.9, MOD_AMOUNT_PX, false)).toBe(1);
    expect(stepAmount(-0.9, -MOD_AMOUNT_PX, false)).toBe(-1);
  });

  it('normalises the range on the control scale, clipped and ordered', () => {
    const s = linearScale(-100, 100);
    expect(modRangeNorm(s, 0, 50)).toEqual([0.5, 0.75]);
    expect(modRangeNorm(s, 50, 0)).toEqual([0.5, 0.75]);
    expect(modRangeNorm(s, -500, 500)).toEqual([0, 1]);
  });
});

describe('Knob with mod', () => {
  it('without mod: no ring, no drop target, no context-menu handling', () => {
    render(<Knob label="Fine" value={0} min={-100} max={100} />);
    const k = slider('Fine');
    expect(k.querySelector('[data-mod-ring]')).toBeNull();
    expect(k.hasAttribute('data-mod-target')).toBe(false);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fire(k, ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('routed: draws the inner ring, is a drop target, and the hint names the route', () => {
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={makeMod()} />);
    const k = slider('Fine');
    expect(k.getAttribute('data-mod-target')).toBe('4:1:0');
    expect(k.getAttribute('data-modulated')).toBe('true');
    expect(k.querySelector('[data-mod-ring]')).not.toBeNull();
    expect(k.getAttribute('data-hint')).toContain('LFO 1');
    expect(k.getAttribute('aria-description')).toContain('Slot 2 fine');
  });

  it('a registered but unrouted knob is still a drop target and draws no ring', () => {
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={makeMod({ active: false, highlight: true })} />);
    const k = slider('Fine');
    expect(k.getAttribute('data-mod-target')).toBe('4:1:0');
    expect(k.getAttribute('data-mod-highlight')).toBe('true');
    expect(k.querySelector('[data-mod-ring]')).toBeNull();
  });

  it('Alt+drag changes the amount (local preview), commits once on release, value untouched', () => {
    const mod = makeMod();
    const onCommit = vi.fn();
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={mod} onCommit={onCommit} />);
    const k = slider('Fine');
    fire(k, ptr('pointerdown', { clientY: 400, altKey: true }));
    fire(k, ptr('pointermove', { clientY: 400 - MOD_AMOUNT_PX / 4 }));
    fire(k, ptr('pointermove', { clientY: 400 - MOD_AMOUNT_PX / 2 }));
    expect(mod.onRingPreview).toHaveBeenLastCalledWith(0.75);
    expect(mod.onRingCommit).not.toHaveBeenCalled();
    fire(k, ptr('pointerup', { clientY: 400 - MOD_AMOUNT_PX / 2 }));
    expect(mod.onRingCommit).toHaveBeenCalledTimes(1);
    expect(mod.onRingCommit).toHaveBeenCalledWith(0.75);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Escape cancels an amount drag back to its start, without a commit', () => {
    const mod = makeMod();
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={mod} />);
    const k = slider('Fine');
    fire(k, ptr('pointerdown', { clientY: 400, altKey: true }));
    fire(k, ptr('pointermove', { clientY: 300 }));
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(mod.onRingPreview).toHaveBeenLastCalledWith(0.25);
    fire(k, ptr('pointerup', { clientY: 300 }));
    expect(mod.onRingCommit).not.toHaveBeenCalled();
  });

  it('right-click toggles bipolar on a routed knob', () => {
    const mod = makeMod();
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={mod} />);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fire(slider('Fine'), ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(mod.onToggleBipolar).toHaveBeenCalledTimes(1);
  });

  it('a plain drag on a routed knob still changes the VALUE, not the amount', () => {
    const mod = makeMod();
    const onCommit = vi.fn();
    render(<Knob label="Fine" value={0} min={-100} max={100} mod={mod} onCommit={onCommit} />);
    const k = slider('Fine');
    fire(k, ptr('pointerdown', { clientY: 400 }));
    fire(k, ptr('pointermove', { clientY: 310 }));
    fire(k, ptr('pointerup', { clientY: 310 }));
    expect(mod.onRingPreview).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });
});

describe('NumberBox with mod', () => {
  it('routed: top band, drop target, Alt+drag sideways = amount, right-click = bipolar', () => {
    const mod = makeMod();
    render(<NumberBox label="Semi" value={0} min={-12} max={12} mod={mod} />);
    const b = slider('Semi');
    expect(b.querySelector('[data-mod-ring]')).not.toBeNull();
    expect(b.getAttribute('data-mod-target')).toBe('4:1:0');
    fire(b, ptr('pointerdown', { clientX: 100, altKey: true }));
    fire(b, ptr('pointermove', { clientX: 100 - MOD_AMOUNT_PX / 2 }));
    fire(b, ptr('pointerup', { clientX: 100 - MOD_AMOUNT_PX / 2 }));
    expect(mod.onRingCommit).toHaveBeenCalledWith(-0.25);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fire(b, ev);
    expect(mod.onToggleBipolar).toHaveBeenCalledTimes(1);
  });

  it('without mod: no band', () => {
    render(<NumberBox label="Semi" value={0} min={-12} max={12} />);
    expect(slider('Semi').querySelector('[data-mod-ring]')).toBeNull();
  });
});
