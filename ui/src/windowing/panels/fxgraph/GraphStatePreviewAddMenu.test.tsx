/**
 * @vitest-environment jsdom
 *
 * Canvas right-click "Add Plugin / Add Modulator" menu.
 *
 * These run in jsdom and dispatch REAL click events rather than asserting on
 * static markup, because the bug this menu shipped with was invisible to markup
 * assertions: the menu rendered perfectly but never received clicks (it was
 * built on the app-generic `.context-menu` shell, which does not restore the
 * `pointer-events: auto` that this panel's window layers take away). A
 * render-only test passes happily against a menu nobody can click.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GraphStatePreview, { type GraphStateDocument } from './GraphStatePreview';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function graphState(nodes: GraphStateDocument['nodes'] = []): GraphStateDocument {
  return {
    schemaVersion: 1,
    trackId: '7',
    nodes: [
      { id: 'input', type: 'trackInput', position: { x: 0, y: 0 }, data: {} },
      { id: 'output', type: 'trackOutput', position: { x: 260, y: 0 }, data: {} },
      ...nodes,
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;

afterEach(async () => {
  if (activeRoot) {
    const root = activeRoot;
    await act(async () => { root.unmount(); });
  }
  activeContainer?.remove();
  activeRoot = null;
  activeContainer = null;
});

async function mountPreview(props: Record<string, unknown>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;
  await act(async () => {
    root.render(<GraphStatePreview graphState={graphState()} onViewportChange={vi.fn()} {...props} />);
  });
  return container;
}

async function openCanvasMenu(container: HTMLElement, at = { clientX: 300, clientY: 200 }) {
  const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;
  await act(async () => {
    viewport.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at }));
  });
  return document.querySelector('.xleth-graph-state-preview__add-menu');
}

function menuItem(label: string) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('.xleth-graph-state-preview__add-menu button'))
    .find((button) => button.textContent === label);
}

async function clickMenuItem(label: string) {
  const button = menuItem(label);
  expect(button, `expected an enabled "${label}" menu item`).toBeTruthy();
  await act(async () => {
    // A real click is preceded by pointerdown — the same event the outside-click
    // handler listens on. If the menu ever stops stopping propagation, this
    // ordering is what catches it (menu closes before the click lands).
    button!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const ALL_ADD_HANDLERS = () => ({
  onAddEffectNode: vi.fn(),
  onAddMacroNode: vi.fn(),
  onAddEnvelopeNode: vi.fn(),
  onAddLfoNode: vi.fn(),
  onAddSidechainInput: vi.fn(),
});

describe('FX Graph canvas add menu', () => {
  it('opens on empty-canvas right-click with Add Plugin and the modulator group', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    const menu = await openCanvasMenu(container);

    expect(menu).toBeTruthy();
    expect(menuItem('Add Plugin')).toBeTruthy();
    expect(menu!.textContent).toContain('Add Modulator');
    for (const label of ['Macro', 'Envelope', 'LFO', 'Sidechain Input']) {
      expect(menuItem(label), `missing "${label}"`).toBeTruthy();
    }
  });

  it('uses this panel\'s own menu shell, not the app-generic .context-menu', async () => {
    // Regression lock for the pointer-events bug: the generic shell renders but
    // is unclickable inside the FX Graph panel's window layers.
    const container = await mountPreview(ALL_ADD_HANDLERS());
    const menu = await openCanvasMenu(container);

    expect(menu!.classList.contains('xleth-graph-state-preview__context-menu')).toBe(true);
    expect(menu!.classList.contains('context-menu')).toBe(false);
    expect(menu!.classList.contains('track-context-menu')).toBe(false);
  });

  it.each([
    ['Add Plugin', 'onAddEffectNode'],
    ['Macro', 'onAddMacroNode'],
    ['Envelope', 'onAddEnvelopeNode'],
    ['LFO', 'onAddLfoNode'],
    ['Sidechain Input', 'onAddSidechainInput'],
  ])('clicking %s calls %s at the right-click graph position and closes the menu', async (label, handlerKey) => {
    const handlers = ALL_ADD_HANDLERS();
    const container = await mountPreview(handlers);
    await openCanvasMenu(container, { clientX: 300, clientY: 200 });

    await clickMenuItem(label);

    const handler = handlers[handlerKey as keyof typeof handlers];
    expect(handler).toHaveBeenCalledTimes(1);
    // Canvas point minus the preview padding (24, 24); the canvas rect is 0,0 in jsdom.
    expect(handler).toHaveBeenCalledWith({ x: 276, y: 176 });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();
  });

  it('omits actions the panel did not wire (read-only / partially wired graphs)', async () => {
    const container = await mountPreview({ onAddMacroNode: vi.fn() });
    const menu = await openCanvasMenu(container);

    expect(menu).toBeTruthy();
    expect(menuItem('Macro')).toBeTruthy();
    expect(menuItem('Add Plugin')).toBeUndefined();
    expect(menuItem('Envelope')).toBeUndefined();
    expect(menuItem('LFO')).toBeUndefined();
  });

  it('does not open when no add action is wired at all', async () => {
    const container = await mountPreview({});
    expect(await openCanvasMenu(container)).toBeNull();
  });

  it('does not open when right-clicking a node (the node menu owns that)', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    const node = container.querySelector('[data-node-id="input"]')!;
    await act(async () => {
      node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }));
    });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();
  });

  it('disables Sidechain Input when the graph already has one', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    activeContainer = container;
    const handlers = ALL_ADD_HANDLERS();
    await act(async () => {
      root.render(
        <GraphStatePreview
          graphState={graphState([
            { id: 'sc-1', type: 'sidechainInput', position: { x: 0, y: 200 }, data: { sourceTrackId: 3 } },
          ])}
          onViewportChange={vi.fn()}
          {...handlers}
        />,
      );
    });
    await openCanvasMenu(container);

    const button = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.xleth-graph-state-preview__add-menu button'),
    ).find((b) => b.textContent === 'Sidechain Input')!;
    expect(button.disabled).toBe(true);

    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(handlers.onAddSidechainInput).not.toHaveBeenCalled();
  });

  it('closes on Escape and on an outside click without firing an action', async () => {
    const handlers = ALL_ADD_HANDLERS();
    const container = await mountPreview(handlers);

    await openCanvasMenu(container);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();

    await openCanvasMenu(container);
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();

    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });
});
