/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuItem } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.defineProperty(window, 'innerWidth', { value: 1000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON() {} }) as DOMRect,
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

const leftOf = () => parseFloat((document.querySelector('[role="menu"]') as HTMLElement).style.left);

describe('Menu flipX (submenu near the right edge)', () => {
  it('opens to the right of x when it fits', () => {
    act(() => root.render(<Menu x={300} y={50} flipX={298} onClose={() => {}}><MenuItem>a</MenuItem></Menu>));
    expect(leftOf()).toBe(300);
  });

  it('opens to the LEFT of the parent when there is no room on the right', () => {
    // parent spans 780..~958; submenu would start at 958 and need 200px of 1000.
    act(() => root.render(<Menu x={958} y={50} flipX={780} onClose={() => {}}><MenuItem>a</MenuItem></Menu>));
    expect(leftOf()).toBe(780 - 200 + 2);
  });

  it('without flipX it is only clamped (unchanged behaviour)', () => {
    act(() => root.render(<Menu x={958} y={50} onClose={() => {}}><MenuItem>a</MenuItem></Menu>));
    expect(leftOf()).toBe(1000 - 200 - 4);
  });
});
