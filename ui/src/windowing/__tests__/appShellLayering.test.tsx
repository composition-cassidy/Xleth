import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import TitleBar, { TITLEBAR_MENUS } from '../../components/TitleBar.jsx';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

function readUiSource(relativePath: string) {
  return readFileSync(path.resolve(process.cwd(), 'src', relativePath), 'utf8');
}

function cssVarNumber(css: string, name: string) {
  const match = css.match(new RegExp(`${name}:\\s*([0-9]+)\\s*;`));
  return Number(match?.[1] ?? Number.NaN);
}

describe('App shell layer order', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { React?: typeof React }).React = React;
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
  });

  it('keeps the top menu mounted in the app titlebar', () => {
    const html = renderToStaticMarkup(<TitleBar projectName="Layer Test" onAction={() => {}} />);

    for (const menu of TITLEBAR_MENUS) {
      expect(html).toContain(`>${menu.label.toUpperCase()}<`);
    }
  });

  it('places panel chrome above the titlebar layer without unbounded z-index values', () => {
    const appCss = readUiSource('styles/app.css');
    const windowingCss = readUiSource('windowing/components/windowing.css');
    const snapGhostSource = readUiSource('windowing/components/SnapGhost.tsx');

    const titlebarLayer = cssVarNumber(appCss, '--xleth-z-titlebar');
    const dropdownLayer = cssVarNumber(appCss, '--xleth-z-titlebar-dropdown');
    const dockedLayer = cssVarNumber(appCss, '--xleth-z-window-docked');
    const drawerLayer = cssVarNumber(appCss, '--xleth-z-window-drawer');
    const floatingBaseLayer = cssVarNumber(appCss, '--xleth-z-window-floating-base');
    const snapGhostLayer = cssVarNumber(appCss, '--xleth-z-window-snap-ghost');

    expect(titlebarLayer).toBeLessThan(dropdownLayer);
    expect(dropdownLayer).toBeLessThan(dockedLayer);
    expect(dockedLayer).toBeLessThan(floatingBaseLayer);
    expect(floatingBaseLayer).toBeLessThan(drawerLayer);
    expect(floatingBaseLayer).toBeLessThan(snapGhostLayer);
    expect(drawerLayer).toBeLessThan(snapGhostLayer);

    expect(appCss).toMatch(/\.titlebar\s*{[\s\S]*z-index:\s*var\(--xleth-z-titlebar\)/);
    expect(appCss).toMatch(/\.titlebar-dropdown\s*{[\s\S]*z-index:\s*var\(--xleth-z-titlebar-dropdown\)/);
    expect(windowingCss).toMatch(/\.xleth-panel-frame\.is-docked\s*{[\s\S]*z-index:\s*var\(--xleth-z-window-docked\)/);
    expect(windowingCss).toMatch(/\.xleth-sample-selector-drawer-host\s*{[\s\S]*z-index:\s*var\(--xleth-z-window-drawer\)/);
    expect(windowingCss).toContain('var(--xleth-z-window-floating-base) + panel.zIndex');
    expect(windowingCss).toContain('z-index: var(--xleth-z-window-snap-ghost);');
    expect(snapGhostSource).not.toContain('9999');
  });
});
