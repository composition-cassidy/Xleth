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

describe('Workspace bounds layout contract', () => {
  it('titlebar has no negative margin-bottom that would pull the workspace up into the chrome zone', () => {
    const appCss = readUiSource('styles/app.css');
    const match = appCss.match(/\.titlebar\s*\{([^}]*)\}/s);
    const titlebarBlock = match?.[1] ?? '';
    expect(titlebarBlock).not.toMatch(/margin-bottom:\s*-\d/);
  });

  it('drawer top-offset is 0 so it aligns with the workspace top, not the viewport top', () => {
    const appCss = readUiSource('styles/app.css');
    expect(appCss).toMatch(/--xleth-windowing-drawer-top-offset:\s*0(px)?;/);
  });

  it('maximized panel uses position:absolute and inset:0, not position:fixed', () => {
    const windowingCss = readUiSource('windowing/components/windowing.css');
    const maximizedBlock = windowingCss.match(/\[data-panel-mode="maximized"\]\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(maximizedBlock).toContain('position: absolute');
    expect(maximizedBlock).not.toContain('position: fixed');
    expect(maximizedBlock).toContain('inset: 0');
  });
});

describe('App shell grid layout contract', () => {
  it('defines --xleth-top-chrome-height and --xleth-bottom-chrome-height tokens', () => {
    const appCss = readUiSource('styles/app.css');
    expect(appCss).toMatch(/--xleth-top-chrome-height:\s*\d+px/);
    expect(appCss).toMatch(/--xleth-bottom-chrome-height:\s*\d+px/);
  });

  it('app shell uses CSS grid so chrome row heights are explicitly bounded', () => {
    const appCss = readUiSource('styles/app.css');
    const appBlock = appCss.match(/\.app\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(appBlock).toContain('display: grid');
    expect(appBlock).toContain('var(--xleth-top-chrome-height)');
    expect(appBlock).toContain('var(--xleth-bottom-chrome-height)');
    expect(appBlock).toContain('minmax(0, 1fr)');
    expect(appBlock).not.toContain('display: flex');
  });

  it('app-body does not use flex sizing that could allow titlebar to encroach on workspace', () => {
    const appCss = readUiSource('styles/app.css');
    const bodyBlock = appCss.match(/\.app-body\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(bodyBlock).not.toMatch(/flex:\s*1/);
    expect(bodyBlock).toContain('position: relative');
    expect(bodyBlock).toContain('overflow: hidden');
  });

  it('drag manager clamps panel positions to workspace right and bottom edges', () => {
    const dragManagerSource = readUiSource('windowing/managers/DragManager.ts');
    // Both getDragOffsetSnapshot (preview) and endDrag (commit) must use workspace dimensions.
    const occurrences = (dragManagerSource.match(/workAreaRect\.right\s*-.*workAreaRect\.left/g) ?? []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('drag manager undock spawn uses workspace-local origin, not viewport origin', () => {
    const dragManagerSource = readUiSource('windowing/managers/DragManager.ts');
    expect(dragManagerSource).toContain('Number.isFinite(registeredWorkAreaRect.left)');
    expect(dragManagerSource).toContain('Number.isFinite(registeredWorkAreaRect.top)');
    expect(dragManagerSource).toMatch(/mouseX\s*-\s*wLeft\s*-\s*panel\.floating\.width/);
    expect(dragManagerSource).toMatch(/mouseY\s*-\s*wTop\s*-\s*TITLEBAR_HEIGHT/);
  });

  it('top chrome buttons and menu triggers carry no-drag so pointer events reach them', () => {
    const appCss = readUiSource('styles/app.css');
    expect(appCss).toMatch(/\.titlebar-menu-trigger[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(appCss).toMatch(/\.titlebar-btn[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s);
    expect(appCss).toMatch(/\.titlebar-launcher-btn[^{]*\{[^}]*-webkit-app-region:\s*no-drag/s);
  });
});
