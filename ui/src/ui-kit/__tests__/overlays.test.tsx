/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, Dialog, DialogList, DialogListItem, DialogText, Menu, MenuCustom, MenuItem, MenuSeparator } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const keyOn = (el: Element | Window, k: string, init: Record<string, unknown> = {}) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role^="menuitem"]'));

describe('Menu', () => {
  it('is a labelled menu of real buttons, rows at the 24px hit-area floor', () => {
    render(
      <Menu x={10} y={10} onClose={() => {}} label="Clip menu">
        <MenuItem>Cut</MenuItem>
        <MenuSeparator />
        <MenuItem danger>Delete</MenuItem>
      </Menu>,
    );
    const menu = document.querySelector('[role="menu"]')!;
    expect(menu.getAttribute('aria-label')).toBe('Clip menu');
    expect(items().map((b) => b.tagName)).toEqual(['BUTTON', 'BUTTON']);
    expect(document.querySelector('[role="separator"]')).not.toBeNull();
    const css = readFileSync(path.resolve(__dirname, '..', 'Menu.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/min-height:\s*var\(--row-h\)/);
    // A menu is a floating surface: the hard offset shadow, never a blur.
    expect(css).toMatch(/box-shadow:\s*var\(--ui-shadow-float\)/);
    expect(css).not.toMatch(/blur|filter/);
  });

  it('runs the item, then closes; a disabled item does neither', () => {
    const onClose = vi.fn();
    const run = vi.fn();
    const skipped = vi.fn();
    render(
      <Menu x={0} y={0} onClose={onClose}>
        <MenuItem onSelect={run}>Run</MenuItem>
        <MenuItem disabled onSelect={skipped}>Nope</MenuItem>
      </Menu>,
    );
    click(items()[1]);
    expect(skipped).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(items()[1].getAttribute('aria-disabled')).toBe('true');
    click(items()[0]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and on a press outside, but not on a press inside any menu surface', () => {
    const onClose = vi.fn();
    render(
      <Menu x={0} y={0} onClose={onClose}>
        <MenuItem>One</MenuItem>
        <MenuCustom><input aria-label="Amount" /></MenuCustom>
      </Menu>,
    );
    act(() => { items()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    act(() => { document.querySelector('input')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    keyOn(window, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('moves focus with the arrow keys, wraps, and Home / End jump; disabled items are skipped', () => {
    render(
      <Menu x={0} y={0} onClose={() => {}}>
        <MenuItem>A</MenuItem>
        <MenuItem disabled>B</MenuItem>
        <MenuItem>C</MenuItem>
      </Menu>,
    );
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    keyOn(menu, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('A');
    keyOn(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('C');
    keyOn(document.activeElement!, 'ArrowDown');
    expect(document.activeElement?.textContent).toBe('A');
    keyOn(document.activeElement!, 'ArrowUp');
    expect(document.activeElement?.textContent).toBe('C');
    keyOn(document.activeElement!, 'Home');
    expect(document.activeElement?.textContent).toBe('A');
    keyOn(document.activeElement!, 'End');
    expect(document.activeElement?.textContent).toBe('C');
  });

  it('a checkbox row exposes aria-checked and a checked glyph that is not colour alone', () => {
    render(
      <Menu x={0} y={0} onClose={() => {}}>
        <MenuItem checked>On</MenuItem>
        <MenuItem checked={false}>Off</MenuItem>
      </Menu>,
    );
    const [on, off] = items();
    expect(on.getAttribute('role')).toBe('menuitemcheckbox');
    expect(on.getAttribute('aria-checked')).toBe('true');
    expect(off.getAttribute('aria-checked')).toBe('false');
    expect(on.querySelector('svg')).not.toBeNull();
    expect(off.querySelector('svg')).toBeNull();
  });

  it('returns focus to where it was when it closes', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(<Menu x={0} y={0} onClose={() => {}}><MenuItem>One</MenuItem></Menu>);
    expect(document.activeElement).not.toBe(opener);
    act(() => root.render(<div />));
    expect(document.activeElement).toBe(opener);
  });
});

describe('Dialog', () => {
  it('is a modal named by its title, and prose is 16px under a hard offset shadow', () => {
    render(
      <Dialog title="Clean up project" onClose={() => {}} actions={<Button>OK</Button>}>
        <DialogText>Body</DialogText>
      </Dialog>,
    );
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dlg.getAttribute('aria-labelledby')!)!;
    expect(title.textContent).toBe('Clean up project');
    const css = readFileSync(path.resolve(__dirname, '..', 'Dialog.module.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toMatch(/\.body\s*\{[^}]*font-size:\s*var\(--type-16\)/);
    expect(css).toMatch(/box-shadow:\s*var\(--ui-shadow-float\)/);
    expect(css).not.toMatch(/blur|filter|gradient/);
  });

  it('Escape and a backdrop press ask to close; a press inside the panel does not', () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose}>x</Dialog>);
    const panel = document.querySelector('[role="dialog"]')!;
    act(() => { panel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    act(() => { panel.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).toHaveBeenCalledTimes(1);
    keyOn(window, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('a dialog that must be answered ignores Escape and the backdrop and shows no close button', () => {
    const onClose = vi.fn();
    render(<Dialog title="T" onClose={onClose} dismissable={false}>x</Dialog>);
    keyOn(window, 'Escape');
    act(() => { document.querySelector('[role="dialog"]')!.parentElement!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[aria-label="Close"]')).toBeNull();
  });

  it('Enter runs onEnter only when focus is not on a button or field', () => {
    const onEnter = vi.fn();
    render(
      <Dialog title="T" onEnter={onEnter} actions={<Button data-autofocus>Go</Button>}>
        <input aria-label="Name" />
      </Dialog>,
    );
    expect(document.activeElement?.textContent).toBe('Go');
    keyOn(document.activeElement!, 'Enter');
    keyOn(document.querySelector('input')!, 'Enter');
    expect(onEnter).not.toHaveBeenCalled();
    keyOn(document.querySelector('[role="dialog"]')!, 'Enter');
    expect(onEnter).toHaveBeenCalledTimes(1);
  });

  it('focuses the data-autofocus control, traps Tab inside, and restores focus on close', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    render(
      <Dialog title="T" onClose={() => {}} actions={<><Button>Cancel</Button><Button data-autofocus>Save</Button></>}>
        x
      </Dialog>,
    );
    expect(document.activeElement?.textContent).toBe('Save');
    const focusables = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button'));
    const last = focusables[focusables.length - 1];
    last.focus();
    keyOn(last, 'Tab');
    expect(document.activeElement).toBe(focusables[0]);
    keyOn(focusables[0], 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    act(() => root.render(<div />));
    expect(document.activeElement).toBe(opener);
  });

  it('DialogList renders a labelled list of rows with an optional value and actions', () => {
    render(
      <Dialog title="T">
        <DialogList label="Files">
          <DialogListItem label="Proxies" detail="a.mov" value="2 files · 1.0 GB"><Button size="sm">Go</Button></DialogListItem>
        </DialogList>
      </Dialog>,
    );
    const list = document.querySelector('ul[aria-label="Files"]')!;
    expect(list.textContent).toContain('Proxies');
    expect(list.textContent).toContain('2 files · 1.0 GB');
    expect(list.querySelector('button')).not.toBeNull();
  });
});
