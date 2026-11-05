import React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TitleBar, { TITLEBAR_MENUS } from '../../components/TitleBar.jsx';
import { PanelFrame } from '../components/PanelFrame';
import {
  beginDrag,
  cancelDrag,
  getDragState,
  registerWorkAreaRect,
} from '../managers/DragManager';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

// TitleBar renders the toast status line, which requires a ToastProvider these
// tests never mount. Stub the module rather than wrapping every render.
vi.mock('../../components/Toast.jsx', () => ({
  ToastProvider: ({ children }: { children: unknown }) => children,
  ToastStatusText: () => null,
  useToast: () => ({ dismiss: () => {}, showToast: () => undefined, toasts: [] }),
}));


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
      expect(html).toContain(`>${menu.label}<`);
    }
  });

  it('places titlebar chrome above panel frames without unbounded z-index values', () => {
    const appCss = readUiSource('styles/app.css');
    const windowingCss = readUiSource('windowing/components/windowing.css');
    const snapGhostSource = readUiSource('windowing/components/SnapGhost.tsx');

    const titlebarLayer = cssVarNumber(appCss, '--xleth-z-titlebar');
    const dropdownLayer = cssVarNumber(appCss, '--xleth-z-titlebar-dropdown');
    const dockedLayer = cssVarNumber(appCss, '--xleth-z-window-docked');
    const dockResizerLayer = cssVarNumber(appCss, '--xleth-z-window-dock-resizer');
    const dockSplitterLayer = cssVarNumber(appCss, '--xleth-z-window-dock-splitter');
    const floatingBaseLayer = cssVarNumber(appCss, '--xleth-z-window-floating-base');
    const snapGhostLayer = cssVarNumber(appCss, '--xleth-z-window-snap-ghost');

    expect(dockedLayer).toBeLessThan(floatingBaseLayer);
    expect(floatingBaseLayer).toBeLessThan(snapGhostLayer);
    expect(snapGhostLayer).toBeLessThan(titlebarLayer);
    expect(titlebarLayer).toBeLessThan(dropdownLayer);

    // Dock resize gutters must sit ABOVE docked panel content (otherwise the
    // docked panel frame paints over them and they cannot be grabbed) but BELOW
    // floating panels and app chrome. The splitter is one notch above the region
    // resizer so it wins their small corner overlap.
    expect(dockedLayer).toBeLessThan(dockResizerLayer);
    expect(dockResizerLayer).toBeLessThan(dockSplitterLayer);
    expect(dockSplitterLayer).toBeLessThan(floatingBaseLayer);
    expect(windowingCss).toMatch(/\.xleth-dock-region-resizer\s*{[\s\S]*z-index:\s*var\(--xleth-z-window-dock-resizer\)/);
    expect(windowingCss).toMatch(/\.xleth-dock-splitter\s*{[\s\S]*z-index:\s*var\(--xleth-z-window-dock-splitter\)/);

    // Regression: the top menu bar must not render behind floating/maximized panels.
    expect(titlebarLayer).toBeGreaterThan(floatingBaseLayer);

    expect(appCss).toMatch(/\.titlebar\s*{[\s\S]*z-index:\s*var\(--xleth-z-titlebar\)/);
    expect(appCss).toMatch(/\.titlebar-dropdown\s*{[\s\S]*z-index:\s*var\(--xleth-z-titlebar-dropdown\)/);
    expect(windowingCss).toMatch(/\.xleth-panel-frame\.is-docked\s*{[\s\S]*z-index:\s*var\(--xleth-z-window-docked\)/);
    const drawerHostBlock = windowingCss.match(/\.xleth-sample-selector-drawer-host\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(drawerHostBlock).not.toContain('z-index');
    expect(windowingCss).toContain('var(--xleth-z-window-floating-base) + panel.zIndex');
    expect(windowingCss).toContain('z-index: var(--xleth-z-window-snap-ghost);');
    expect(snapGhostSource).not.toContain('9999');
  });

  it('keeps the floating-editor hosts free of a stacking context', () => {
    const appCss = readUiSource('styles/app.css');

    // Both hosts wrap `position: fixed` editor windows that carry their own
    // z-index (200) and must be compared against the workspace panel layers in
    // the ROOT stacking context. Giving a host `position` + `z-index` makes it a
    // stacking context, which caps every window inside it at the host's own
    // level — the Vibrato/Scratch host briefly had `position: relative;
    // z-index: 0`, which painted both editors BELOW
    // --xleth-z-workspace-panel-layer and made them invisible and click-through.
    const workspacePanelLayer = cssVarNumber(appCss, '--xleth-z-workspace-panel-layer');
    expect(workspacePanelLayer).toBeGreaterThan(0);

    for (const host of ['.clip-fx-editor-host', '.effect-editor-host']) {
      const block = appCss.match(new RegExp(`\\${host}\\s*\\{([^}]*)\\}`, 's'))?.[1] ?? '';
      expect(block).not.toMatch(/position:\s*(relative|absolute|fixed|sticky)/);
      expect(block).not.toMatch(/z-index:\s*-?\d/);
      // A transform/filter/contain would create one just as surely.
      expect(block).not.toMatch(/(transform|filter|backdrop-filter|contain|will-change):/);
    }
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

  it('sample drawer size comes from the panel\'s own dock region, not a fixed drawer width', () => {
    const appShellSource = readUiSource('windowing/AppShell.tsx');
    const drawerSource = readUiSource('windowing/components/SampleSelectorDrawer.tsx');
    const windowingCss = readUiSource('windowing/components/windowing.css');

    expect(appShellSource).toContain('state.dockRegionSizes[sampleDockSide]');
    expect(appShellSource).toContain('useDockRegionResizePreview(sampleDockSide)');
    expect(appShellSource).toContain('useDockRegionResizePreview(sampleDockSide)');
    expect(appShellSource).toContain("'--xleth-sample-dock-width'");
    expect(appShellSource).not.toContain('sampleSelectorDockWidth');
    expect(drawerSource).not.toContain('sampleSelectorDockWidth');
    const drawerBlock = windowingCss.match(/(?:^|\n)\.xleth-sample-selector-drawer\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(drawerBlock).toContain('width: 100%');
    expect(drawerBlock).not.toContain('width: 258px');
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

describe('PanelFrame selector stability', () => {
  beforeEach(() => {
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
  });

  // ── Source-level verification ────────────────────────────────────────────

  it('PanelFrame selects primitives, not the panel object, to prevent getSnapshot reference churn', () => {
    // The rule now lives in usePanelValue, which every windowing component
    // goes through; PanelFrame must not reach past it into the raw store.
    const panelFrameSource = readUiSource('windowing/components/PanelFrame.tsx');
    const usePanelValueSource = readUiSource('windowing/registry/usePanelValue.ts');

    expect(panelFrameSource).toContain("usePanelValue(id, (p) => p.hidden)");
    expect(panelFrameSource).not.toMatch(/usePanelRegistry\(\s*\(s(tate)?\)\s*=>\s*s(tate)?\.panels\[id\]\s*\)/);
    expect(usePanelValueSource).toContain('string | number | boolean | null | undefined');
  });

  it('registerWorkAreaRect is guarded against identical writes', () => {
    const src = readUiSource('windowing/managers/DragManager.ts');
    // Guard must compare all four coordinates before writing
    expect(src).toMatch(/rect\.left\s*===\s*registeredWorkAreaRect\.left/);
    expect(src).toMatch(/rect\.top\s*===\s*registeredWorkAreaRect\.top/);
    expect(src).toMatch(/rect\.right\s*===\s*registeredWorkAreaRect\.right/);
    expect(src).toMatch(/rect\.bottom\s*===\s*registeredWorkAreaRect\.bottom/);
    expect(src).toMatch(/rect\.width\s*===\s*registeredWorkAreaRect\.width/);
    expect(src).toMatch(/rect\.height\s*===\s*registeredWorkAreaRect\.height/);
  });

  // ── Functional: store-level primitive stability ──────────────────────────

  it('panel hidden and mode remain the same primitive values after an unrelated panel is focused', () => {
    const reg = usePanelRegistry.getState();
    reg.openPanel('preview');
    reg.openPanel('mixer');

    const mixerHiddenBefore = usePanelRegistry.getState().panels.mixer.hidden;
    const mixerModeBefore   = usePanelRegistry.getState().panels.mixer.mode;

    // Focus timeline — changes timeline's focused/zIndex but should not change
    // mixer's hidden or mode values.
    reg.focusPanel('preview');

    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(mixerHiddenBefore);
    expect(usePanelRegistry.getState().panels.mixer.mode).toBe(mixerModeBefore);
  });

  it('registerWorkAreaRect skips the write when values are unchanged, accepts a new object with different values', () => {
    // Reset to default unbounded rect first
    cancelDrag();
    registerWorkAreaRect({ left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity, width: Infinity, height: Infinity });

    // Register an explicit rect
    registerWorkAreaRect({ left: 100, top: 200, right: 900, bottom: 700, width: 800, height: 500 });

    // Register the exact same values (new object) — the guard should treat this
    // as a no-op.  Verify by checking the workAreaRect captured at drag-start.
    registerWorkAreaRect({ left: 100, top: 200, right: 900, bottom: 700, width: 800, height: 500 });

    usePanelRegistry.getState().openPanel('preview');
    beginDrag('preview', 500, 400, 100, 100);
    const state1 = getDragState();
    expect(state1.state).toBe('dragging');
    if (state1.state === 'dragging') {
      expect(state1.workAreaRect.left).toBe(100);
    }
    cancelDrag();

    // Now register a rect with a changed left coordinate — this must NOT be a
    // no-op; the new value should be picked up by the next drag.
    registerWorkAreaRect({ left: 50, top: 200, right: 900, bottom: 700, width: 850, height: 500 });
    beginDrag('preview', 500, 400, 100, 100);
    const state2 = getDragState();
    expect(state2.state).toBe('dragging');
    if (state2.state === 'dragging') {
      expect(state2.workAreaRect.left).toBe(50);
    }
    cancelDrag();
  });

  // ── Render stability: no max-update-depth from repeated SSR renders ──────

  it('PanelFrame renders consistent HTML on consecutive calls without intervening mutations', () => {
    const reg = usePanelRegistry.getState();
    reg.openPanel('preview');

    const render = () => renderToStaticMarkup(
      <PanelFrame id="preview"><div>content</div></PanelFrame>
    );
    const html1 = render();
    const html2 = render();

    expect(html1).toContain('data-panel-mode="floating"');
    expect(html1).toBe(html2);
  });

  it('PanelFrame renders correctly after an unrelated store mutation (simulates top-level rerender)', () => {
    const reg = usePanelRegistry.getState();
    reg.openPanel('preview');
    // Explicitly focus timeline so we can observe the focused→unfocused transition
    reg.focusPanel('preview');

    const htmlBefore = renderToStaticMarkup(
      <PanelFrame id="preview"><div>x</div></PanelFrame>
    );
    expect(htmlBefore).toContain('data-panel-mode="floating"');
    expect(htmlBefore).toContain('data-focused="true"');

    // Simulate what "clicking Edit menu causes AppShell rerender" does:
    // an unrelated store mutation (opening mixer) triggers Zustand listeners;
    // PanelFrame must NOT diverge into a getSnapshot loop.
    reg.openPanel('mixer');

    const htmlAfter = renderToStaticMarkup(
      <PanelFrame id="preview"><div>x</div></PanelFrame>
    );
    // Both renders must produce valid markup — a throw here would indicate a
    // maximum-update-depth or getSnapshot-cache failure.
    expect(htmlAfter).toContain('data-panel-mode="floating"');
    // Timeline lost focus when mixer was opened
    expect(htmlAfter).toContain('data-focused="false"');
  });
});
