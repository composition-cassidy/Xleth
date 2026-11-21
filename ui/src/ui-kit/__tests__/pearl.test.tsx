/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { isHeard, pearlPlan } from '../pearlRules';
import { Pearl } from '../Pearl';

const T = (id: number, muted = false, soloed = false) => ({ id, muted, soloed });
const apply = (items: ReturnType<typeof T>[], changes: ReturnType<typeof pearlPlan<number>>) =>
  items.map((i) => {
    const c = changes.find((x) => x.id === i.id);
    return { ...i, muted: c?.muted ?? i.muted, soloed: c?.clearSolo ? false : i.soloed };
  });
const lit = (items: ReturnType<typeof T>[]) => items.filter((i) => isHeard(i, items)).map((i) => i.id);

describe('pearl rules (FL Studio style)', () => {
  it('click turns one output on and off', () => {
    let s = [T(1), T(2), T(3)];
    s = apply(s, pearlPlan(s, 2, 'toggle'));
    expect(lit(s)).toEqual([1, 3]);
    s = apply(s, pearlPlan(s, 2, 'toggle'));
    expect(lit(s)).toEqual([1, 2, 3]);
  });

  it('right-click solos: this one on, every other off', () => {
    let s = [T(1), T(2, true), T(3)];
    s = apply(s, pearlPlan(s, 2, 'solo'));
    expect(lit(s)).toEqual([2]);
  });

  it('right-clicking the only lit one turns everything back on', () => {
    let s = [T(1), T(2), T(3)];
    s = apply(s, pearlPlan(s, 3, 'solo'));
    s = apply(s, pearlPlan(s, 3, 'solo'));
    expect(lit(s)).toEqual([1, 2, 3]);
  });

  it('right-clicking another one moves the solo there', () => {
    let s = [T(1), T(2), T(3)];
    s = apply(s, pearlPlan(s, 1, 'solo'));
    s = apply(s, pearlPlan(s, 3, 'solo'));
    expect(lit(s)).toEqual([3]);
  });

  it('folds a legacy solo flag into mutes, so lit always equals heard', () => {
    const s0 = [T(1), T(2, false, true), T(3)];
    expect(lit(s0)).toEqual([2]);
    const s1 = apply(s0, pearlPlan(s0, 1, 'toggle'));
    expect(s1.every((i) => !i.soloed)).toBe(true);
    expect(lit(s1)).toEqual([1, 2]);
  });

  it('the control: click toggles, right-click and Shift+click and S solo, the row menu never opens', () => {
    const onToggle = vi.fn(); const onSolo = vi.fn(); const rowMenu = vi.fn();
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<div onContextMenu={rowMenu}><Pearl lit label="Insert 1" onToggle={onToggle} onSolo={onSolo} /></div>));
    const b = host.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('Insert 1 output');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    act(() => {
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      b.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 's' }));
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSolo).toHaveBeenCalledTimes(3);
    expect(rowMenu).not.toHaveBeenCalled();
    act(() => root.unmount()); host.remove();
  });
});
