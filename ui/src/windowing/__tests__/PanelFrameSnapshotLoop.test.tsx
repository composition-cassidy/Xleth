/* @vitest-environment jsdom */
import React, { act, useEffect, useMemo, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TitleBar from '../../components/TitleBar.jsx';
import TimelinePanel from '../panels/TimelinePanel';
import XlethRootContext from '../contexts/XlethRootContext.jsx';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

vi.mock('../../components/TimelineView.jsx', async () => {
  const ReactModule = await import('react');
  return {
    default: function MockTimelineView() {
      return ReactModule.createElement('div', { 'data-testid': 'mock-timeline-view' }, 'Timeline');
    },
  };
});

function installXlethStub() {
  Object.defineProperty(window, 'xleth', {
    configurable: true,
    value: {
      settings: {
        get: vi.fn(async () => null),
        set: vi.fn(async () => undefined),
      },
      window: {
        minimize: vi.fn(),
        maximize: vi.fn(),
        close: vi.fn(),
      },
    },
  });
}

function MenuRerenderHarness() {
  const [menuClicks, setMenuClicks] = useState(0);
  const contextValue = useMemo(() => ({
    onOpenPicker: vi.fn(),
    activeSampleId: null,
    setActiveSampleId: vi.fn(),
    currentPatternIdByTrack: {},
    setCurrentPatternIdByTrack: vi.fn(),
    activeCenterTab: 'timeline',
    availablePatterns: [],
    onSwitchPattern: vi.fn(),
    onNewPattern: vi.fn(),
    onOpenMidiImport: vi.fn(),
  }), []);

  useEffect(() => {
    if (menuClicks === 0) return;
    usePanelRegistry.getState().focusPanel('timeline');
  });

  return (
    <div onClick={() => setMenuClicks((count) => count + 1)}>
      <TitleBar projectName="Snapshot Loop Test" onAction={() => {}} />
      <XlethRootContext.Provider value={contextValue}>
        <TimelinePanel />
      </XlethRootContext.Provider>
    </div>
  );
}

describe('windowing external-store snapshot stability', () => {
  let container: HTMLDivElement;
  let root: Root;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as typeof globalThis & { React?: typeof React }).React = React;
    installXlethStub();
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    logSpy.mockRestore();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as typeof globalThis & { React?: typeof React }).React;
  });

  it('does not warn or crash when top menu clicks rerender a mounted Timeline PanelFrame', () => {
    act(() => {
      root.render(<MenuRerenderHarness />);
    });

    const menuTriggers = Array.from(
      container.querySelectorAll<HTMLButtonElement>('.titlebar-menu-trigger'),
    );
    expect(menuTriggers.map((button) => button.textContent?.trim())).toEqual([
      'FILE',
      'EDIT',
      'VIEW',
      'SETTINGS',
      'THEME',
    ]);

    for (let i = 0; i < 3; i += 1) {
      for (const trigger of menuTriggers) {
        act(() => {
          trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          vi.runOnlyPendingTimers();
        });
      }
    }

    const messages = [...errorSpy.mock.calls, ...warnSpy.mock.calls]
      .map((args) => args.join(' '))
      .join('\n');

    expect(messages).not.toMatch(/getSnapshot should be cached/i);
    expect(messages).not.toMatch(/Maximum update depth exceeded/i);
  });
});
