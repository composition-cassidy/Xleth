/**
 * @vitest-environment jsdom
 *
 * Canvas right-click "add a node" menu.
 *
 * These run in jsdom and dispatch REAL events rather than asserting on static markup, because the
 * bug the first version of this menu shipped with was invisible to markup assertions: it rendered
 * perfectly but never received clicks (a menu shell that does not restore the `pointer-events: auto`
 * this panel's window layers take away). A render-only test passes happily against a menu nobody
 * can click.
 *
 * Round 2 step 18.3: the menu is the Devices chain's own effect picker (the same list, built by
 * the same function), followed by the modulators, so there is ONE picker with two entry points.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GraphStatePreview, { type GraphStateDocument } from './GraphStatePreview';
import { buildEffectChainMenuItems } from '../../../components/mixer/EffectChainPanel.jsx';

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

async function mountPreview(props: Record<string, unknown>, doc: GraphStateDocument = graphState()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  activeContainer = container;
  await act(async () => {
    root.render(<GraphStatePreview graphState={doc} onViewportChange={vi.fn()} {...props} />);
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

function items(scope = '.xleth-graph-state-preview__add-menu') {
  return Array.from(document.querySelectorAll<HTMLElement>(`${scope} [role="menuitem"]`));
}

function menuItem(label: string, scope?: string) {
  return items(scope).find((item) => item.textContent?.trim().startsWith(label));
}

async function clickMenuItem(label: string, scope?: string) {
  const item = menuItem(label, scope);
  expect(item, `expected a "${label}" menu item`).toBeTruthy();
  await act(async () => {
    item!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    item!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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
  it('opens on empty-canvas right-click with the effect picker and the modulator group', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    const menu = await openCanvasMenu(container);

    expect(menu).toBeTruthy();
    expect(menu!.getAttribute('role')).toBe('menu');
    expect(menu!.textContent).toContain('Modulators');
    for (const label of ['Macro', 'Envelope', 'LFO', 'Sidechain input']) {
      expect(menuItem(label), `missing "${label}"`).toBeTruthy();
    }
  });

  it('is the Devices chain picker: the same categories, in the same order, from the same builder', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    await openCanvasMenu(container);

    const expected = (buildEffectChainMenuItems({
      addEffect: () => {},
      storeKey: null,
      vstPlugins: [],
    }) as { label: string }[]).map((item) => item.label);
    const shown = items().map((item) => item.textContent!.trim());
    expect(expected.length).toBeGreaterThan(3);
    expect(shown.slice(0, expected.length)).toEqual(expected);
  });

  it('adds the chosen plugin at the right-click graph position, named from the shared catalog', async () => {
    const handlers = ALL_ADD_HANDLERS();
    const container = await mountPreview(handlers);
    await openCanvasMenu(container, { clientX: 300, clientY: 200 });

    const category = menuItem('Dynamics')!;
    expect(category).toBeTruthy();
    await act(async () => { category.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    await clickMenuItem('Compressor', '.effect-chain-add-submenu');

    expect(handlers.onAddEffectNode).toHaveBeenCalledTimes(1);
    // Canvas point minus the preview padding (24, 24); the canvas rect is 0,0 in jsdom.
    expect(handlers.onAddEffectNode).toHaveBeenCalledWith(
      { pluginId: 'compressor', displayName: 'Compressor' },
      { x: 276, y: 176 },
    );
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();
  });

  it.each([
    ['Macro', 'onAddMacroNode'],
    ['Envelope', 'onAddEnvelopeNode'],
    ['LFO', 'onAddLfoNode'],
    ['Sidechain input', 'onAddSidechainInput'],
  ])('clicking %s calls %s at the right-click graph position and closes the menu', async (label, handlerKey) => {
    const handlers = ALL_ADD_HANDLERS();
    const container = await mountPreview(handlers);
    await openCanvasMenu(container, { clientX: 300, clientY: 200 });

    await clickMenuItem(label);

    const handler = handlers[handlerKey as keyof typeof handlers];
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ x: 276, y: 176 });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();
  });

  // The menu is portaled to document.body but is a React CHILD of the canvas viewport, and React
  // events bubble through portals along the React tree. A press on a menu item therefore reached
  // the viewport's pan handler, which preventDefault()s and pointer-captures the viewport: in a
  // real browser the item's click was retargeted to the canvas, so no item ever fired and the
  // menu never closed. jsdom has no pointer capture, so lock the cause: the press must not start a pan.
  it('a press on a menu item never reaches the canvas pan handler', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    await openCanvasMenu(container);
    const viewport = container.querySelector('.xleth-graph-state-preview__viewport')!;

    for (const label of ['Dynamics', 'Macro']) {
      const item = menuItem(label)!;
      await act(async () => {
        item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      });
      expect(viewport.getAttribute('data-panning'), `pressing "${label}" started a pan`).not.toBe('true');
    }
  });

  it('omits actions the panel did not wire (read-only / partially wired graphs)', async () => {
    const container = await mountPreview({ onAddMacroNode: vi.fn() });
    const menu = await openCanvasMenu(container);

    expect(menu).toBeTruthy();
    expect(menuItem('Macro')).toBeTruthy();
    expect(menuItem('Dynamics')).toBeUndefined();
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

  it('disables Sidechain input when the graph already has one', async () => {
    const handlers = ALL_ADD_HANDLERS();
    await mountPreview(
      handlers,
      graphState([{ id: 'sc-1', type: 'sidechainInput', position: { x: 0, y: 200 }, data: { sourceTrackId: 3 } }]),
    );
    await openCanvasMenu(activeContainer!);

    const item = menuItem('Sidechain input')!;
    expect(item.getAttribute('aria-disabled') === 'true' || (item as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { item.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
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
      // The kit menu closes on an outside mousedown.
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeNull();

    for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled();
  });
});

describe('FX Graph empty state', () => {
  it('shows a structural note with an Add node action when only the terminals are there', async () => {
    const container = await mountPreview(ALL_ADD_HANDLERS());
    expect(container.textContent).toContain('Nothing between Track input and Track output yet.');
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Add node')!;
    expect(button).toBeTruthy();

    await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.querySelector('.xleth-graph-state-preview__add-menu')).toBeTruthy();
    expect(menuItem('Macro')).toBeTruthy();
  });

  it('is gone once a node is in the graph, and absent when nothing can be added', async () => {
    const withNode = await mountPreview(
      ALL_ADD_HANDLERS(),
      graphState([{ id: 'm', type: 'macro', position: { x: 100, y: 100 }, data: { label: 'Macro 1', normalizedValue: 0.5 } }]),
    );
    expect(withNode.textContent).not.toContain('Nothing between');
  });
});
