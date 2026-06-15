/* @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SampleSelectorDrawer,
  collapseSampleSelectorDrawer,
  openSampleSelectorDrawer,
} from '../components/SampleSelectorDrawer';
import {
  DEFAULT_SAMPLE_SELECTOR_DOCK_WIDTH,
  createInitialDockRegionSizes,
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

let originalMatchMedia: typeof window.matchMedia | undefined;

function resetRegistry() {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  usePanelRegistry.setState({
    panels: createInitialPanelStates(),
    dockRegionSizes: createInitialDockRegionSizes(),
    sampleSelectorDockWidth: DEFAULT_SAMPLE_SELECTOR_DOCK_WIDTH,
  });
}

function restoreMatchMedia() {
  if (originalMatchMedia) {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
    return;
  }

  delete (window as Window & { matchMedia?: typeof window.matchMedia }).matchMedia;
}

function installReducedMotionPreference(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

describe('SampleSelectorDrawer animation', () => {
  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetRegistry();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreMatchMedia();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    delete (globalThis as typeof globalThis & { React?: typeof React }).React;
  });

  it('keeps the expanded drawer mounted through the collapse tween', () => {
    openSampleSelectorDrawer();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      act(() => {
        root.render(<SampleSelectorDrawer />);
      });

      expect(container.querySelector('.xleth-sample-selector-drawer')).not.toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--expanded')).not.toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--collapsed')).toBeNull();

      act(() => {
        collapseSampleSelectorDrawer();
      });

      expect(
        container.querySelector('.xleth-sample-selector-drawer-host')?.getAttribute('data-drawer-state'),
      ).toBe('collapsing');
      expect(container.querySelector('.xleth-sample-selector-drawer')).not.toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--expanded')).not.toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--collapsed')).toBeNull();

      act(() => {
        vi.advanceTimersByTime(179);
      });

      expect(container.querySelector('.xleth-sample-selector-drawer')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(
        container.querySelector('.xleth-sample-selector-drawer-host')?.getAttribute('data-drawer-state'),
      ).toBe('collapsed');
      expect(container.querySelector('.xleth-sample-selector-drawer')).toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--collapsed')).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('collapses immediately when reduced motion is active', () => {
    installReducedMotionPreference(true);
    openSampleSelectorDrawer();

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      act(() => {
        root.render(<SampleSelectorDrawer />);
      });

      act(() => {
        collapseSampleSelectorDrawer();
      });

      expect(
        container.querySelector('.xleth-sample-selector-drawer-host')?.getAttribute('data-drawer-state'),
      ).toBe('collapsed');
      expect(container.querySelector('.xleth-sample-selector-drawer')).toBeNull();
      expect(container.querySelector('.xleth-sample-selector-drawer__edge-toggle--collapsed')).not.toBeNull();
    } finally {
      act(() => {
        root.unmount();
      });
      container.remove();
    }
  });
});
