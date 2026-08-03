/* @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelFrame } from '../components/PanelFrame';
import {
  handleKeyEvent,
  register,
  resetBindingsForTest,
} from '../managers/KeyboardManager';
import {
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

describe('PanelFrame shortcut focus ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    resetBindingsForTest();
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
    usePanelRegistry.getState().openPanel('mixer');
    usePanelRegistry.getState().focusPanel('mixer');

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetBindingsForTest();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT;
  });

  it('claims the panel before a clip control stops mousedown propagation', () => {
    const copy = vi.fn();
    register({
      scope: 'panel:timeline',
      combo: 'Ctrl+c',
      handler: (event) => {
        event.preventDefault();
        copy();
        return 'handled';
      },
    });

    act(() => {
      root.render(
        <PanelFrame id="timeline">
          <button
            data-testid="clip-control"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            Clip control
          </button>
        </PanelFrame>,
      );
    });

    // Model the real intermittent case: an input in the previously focused
    // panel still owns DOM focus when a canvas clip control prevents default.
    const staleInput = document.createElement('input');
    document.body.appendChild(staleInput);
    staleInput.focus();
    expect(document.activeElement).toBe(staleInput);

    const clipControl = container.querySelector<HTMLButtonElement>('[data-testid="clip-control"]');
    expect(clipControl).not.toBeNull();
    act(() => {
      clipControl!.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(usePanelRegistry.getState().panels.timeline.focused).toBe(true);
    expect(document.activeElement).toBe(container.querySelector('[data-panel-id="timeline"]'));

    const shortcut = new KeyboardEvent('keydown', {
      key: 'c',
      ctrlKey: true,
      cancelable: true,
    });
    handleKeyEvent(shortcut);
    expect(copy).toHaveBeenCalledTimes(1);
    expect(shortcut.defaultPrevented).toBe(true);

    staleInput.remove();
  });
});
