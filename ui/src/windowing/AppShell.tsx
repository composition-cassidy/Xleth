import React from 'react';
import { useEffect, useRef } from 'react';
import { DockRegion } from './components/DockRegion';
import { SampleSelectorDrawer } from './components/SampleSelectorDrawer';
import { SnapGhost } from './components/SnapGhost';
import { useDockRegionResizePreview } from './managers/DockRegionResizeManager';
import { registerWorkAreaRect, type WorkAreaRect } from './managers/DragManager';
import * as KeyboardManager from './managers/KeyboardManager';
import {
  SAMPLE_SELECTOR_DOCK_HANDLE_WIDTH,
  usePanelRegistry,
} from './registry/PanelRegistry';
import type { PanelStateMap } from './registry/PanelRegistry';
import { useRegistryValue } from './registry/usePanelValue';
import {
  DRAWER_PANEL_IDS,
  WINDOW_PANEL_IDS,
  type PanelId,
} from './registry/panelCatalog';
import EffectEditorHost from '../components/mixer/EffectEditorHost.jsx';
import ClipFxEditorHost from '../components/timeline/ClipFxEditorHost.jsx';
import BackdropLayer from '../backdrop/BackdropLayer.jsx';
import './components/windowing.css';

const TimelinePanel = React.lazy(() => import('./panels/TimelinePanel'));
const MixerPanel = React.lazy(() => import('./panels/MixerPanel'));
const PianoRollPanel = React.lazy(() => import('./panels/PianoRollPanel'));
const SampleSelectorPanel = React.lazy(() => import('./panels/SampleSelectorPanel'));
const PreviewPanel = React.lazy(() => import('./panels/PreviewPanel'));
const FxGraphPanel = React.lazy(() => import('./panels/FxGraphPanel'));
const NodeEditorPanel = React.lazy(() => import('./panels/NodeEditorPanel'));
const SamplerWindowPanel = React.lazy(() => import('./panels/SamplerWindowPanel'));
const QuickNotationPanel = React.lazy(() => import('./panels/QuickNotationPanel'));
const SplitSyllablesPanel = React.lazy(() => import('./panels/SplitSyllablesPanel'));
const SampleSandboxPanel = React.lazy(() => import('./panels/SampleSandboxPanel'));

export interface WindowingAppShellProps {
  backdropImageUrl?: string;
}

// Exhaustive by construction: a panel added to the catalog without a body here
// is a type error rather than a panel that toggles in the top bar and never
// appears. Which of these actually render is decided by the catalog's
// quarantined/presentation flags, not by a second hand-kept list.
const PANEL_BODIES: Record<PanelId, React.LazyExoticComponent<React.FC>> = {
  timeline: TimelinePanel,
  mixer: MixerPanel,
  pianoRoll: PianoRollPanel,
  sampleSelector: SampleSelectorPanel,
  preview: PreviewPanel,
  fxGraph: FxGraphPanel,
  nodeEditor: NodeEditorPanel,
  sampler: SamplerWindowPanel,
  quickNotation: QuickNotationPanel,
  splitSyllables: SplitSyllablesPanel,
  sampleSandbox: SampleSandboxPanel,
};

function workAreaRectsEqual(a: WorkAreaRect | null, b: WorkAreaRect): boolean {
  return a !== null
    && a.left === b.left
    && a.top === b.top
    && a.right === b.right
    && a.bottom === b.bottom
    && a.width === b.width
    && a.height === b.height;
}

function plainWorkAreaRect(rect: DOMRectReadOnly): WorkAreaRect {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

/**
 * Ids of the panels the floating layer must mount, as a "|"-joined string.
 *
 * A string keeps the store subscription primitive; see usePanelValue for why
 * an array or object selector would re-render this on every registry write.
 */
export function floatingPanelKey(panels: PanelStateMap): string {
  return WINDOW_PANEL_IDS
    .filter((panelId) => panels[panelId].mode !== 'docked' || panels[panelId].hidden)
    .join('|');
}

export function AppShell({ backdropImageUrl = '' }: WindowingAppShellProps) {
  const hasDom = typeof window !== 'undefined';
  const workAreaRef = useRef<HTMLDivElement>(null);
  const lastWorkAreaRectRef = useRef<WorkAreaRect | null>(null);

  const floatingPanelIds = useRegistryValue((state) => floatingPanelKey(state.panels));
  const floatingPanelIdList = floatingPanelIds === ''
    ? []
    : floatingPanelIds.split('|') as PanelId[];

  const sampleSelectorHidden = useRegistryValue((state) => state.panels.sampleSelector.hidden);
  const sampleDockSide = useRegistryValue((state) => state.panels.sampleSelector.docked.region);
  const committedSampleDockRegionSize = useRegistryValue((state) => state.dockRegionSizes[sampleDockSide]);
  const sampleDockResizePreview = useDockRegionResizePreview(sampleDockSide);
  const sampleDockSize = sampleDockResizePreview?.size ?? committedSampleDockRegionSize;
  const sampleDockExpanded = !sampleSelectorHidden;

  const shellClassName = [
    'xleth-windowing-shell',
    sampleDockExpanded ? 'sample-dock-open' : 'sample-dock-collapsed',
  ].join(' ');
  const shellStyle = {
    '--xleth-sample-dock-width': `${sampleDockSize}px`,
    '--xleth-sample-dock-height': `${sampleDockSize}px`,
    '--xleth-sample-dock-handle-width': `${SAMPLE_SELECTOR_DOCK_HANDLE_WIDTH}px`,
    '--xleth-sample-dock-handle-height': `${SAMPLE_SELECTOR_DOCK_HANDLE_WIDTH}px`,
  } as React.CSSProperties;

  useEffect(() => {
    KeyboardManager.init();
    return KeyboardManager.destroy;
  }, []);

  useEffect(() => {
    const workArea = workAreaRef.current;
    if (!workArea) return undefined;

    const syncWorkAreaRect = () => {
      const nextRect = plainWorkAreaRect(workArea.getBoundingClientRect());
      if (workAreaRectsEqual(lastWorkAreaRectRef.current, nextRect)) return;
      lastWorkAreaRectRef.current = nextRect;
      registerWorkAreaRect(nextRect);
    };

    syncWorkAreaRect();

    const ResizeObserverCtor = typeof ResizeObserver === 'undefined' ? null : ResizeObserver;
    const observer = ResizeObserverCtor ? new ResizeObserverCtor(syncWorkAreaRect) : null;
    observer?.observe(workArea);
    window.addEventListener('resize', syncWorkAreaRect);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', syncWorkAreaRect);
    };
  }, []);

  const renderPanel = (panelId: PanelId) => {
    const PanelBody = PANEL_BODIES[panelId];
    return (
      <React.Suspense key={panelId} fallback={null}>
        <PanelBody />
      </React.Suspense>
    );
  };

  return (
    <div className="xleth-windowing-app">
      <div
        className={shellClassName}
        data-testid="xleth-windowing-shell"
        data-sample-dock-side={sampleDockSide}
        style={shellStyle}
      >
        <SampleSelectorDrawer />
        <div className="xleth-app-workarea" data-testid="xleth-app-workarea" ref={workAreaRef}>
          <BackdropLayer workAreaRef={workAreaRef} backdropImageUrl={backdropImageUrl} />
          <div className="xleth-docked-window-layer" data-testid="xleth-docked-window-layer">
            <DockRegion side="left" renderPanel={renderPanel} excludePanelIds={DRAWER_PANEL_IDS} />
            <div className="xleth-center-column">
              <DockRegion side="top" renderPanel={renderPanel} excludePanelIds={DRAWER_PANEL_IDS} />
              <div className="xleth-floating-work-area" data-backdrop-empty-surface="true" />
              <DockRegion side="bottom" renderPanel={renderPanel} excludePanelIds={DRAWER_PANEL_IDS} />
            </div>
            <DockRegion side="right" renderPanel={renderPanel} excludePanelIds={DRAWER_PANEL_IDS} />
          </div>
          <div className="xleth-floating-window-layer" data-testid="xleth-floating-window-layer">
            <SnapGhost />
            {floatingPanelIdList.map((panelId) => renderPanel(panelId))}
          </div>
        </div>
      </div>
      {/* Both editor hosts are runtime-only overlays: they contribute nothing
          to static markup and read window during render. Skipping them when
          there is no DOM keeps renderToStaticMarkup usable as a markup
          assertion. This used to fall out of the demo-mode flag by accident;
          it is now stated for the reason it is actually true. */}
      {/* Global stock-effect editor host. Lives at the windowing root — a
          transform-free container — and OUTSIDE every PanelFrame subtree, so
          stock effect editors (Parametric EQ, Compressor, …) float over the
          full workspace and are never clipped/trapped by a floating panel's
          `transform`. The Mixer Chain and FX Graph only *request* editors via
          their effect stores; this host owns the editors' mounting. */}
      {hasDom ? <EffectEditorHost /> : null}
      {/* Global per-clip FX editor host. Same containment rule as
          EffectEditorHost above: mounted at the transform-free windowing root and
          OUTSIDE every PanelFrame subtree, so a floating Timeline's `transform`
          can never trap or clip the per-clip Vibrato graph editor. The Timeline
          clip dropdown only *requests* editors; this host owns their mounting. */}
      {hasDom ? <ClipFxEditorHost /> : null}
    </div>
  );
}

export default AppShell;
