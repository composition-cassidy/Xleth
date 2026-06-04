import React, { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PanelVisibilityProvider } from '../contexts/PanelVisibilityContext';
import { useDragOffset } from '../managers/DragManager';
import { useResizePreview } from '../managers/ResizeManager';
import { PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState } from '../registry/PanelRegistry';
import { ResizeHandles } from './ResizeHandles';
import { Titlebar } from './Titlebar';
import './windowing.css';

export interface PanelFrameProps {
  id: PanelId;
  children: ReactNode;
}

export type PanelFrameRenderPath = 'hidden' | 'docked' | 'maximized' | 'floating';

export function getPanelFrameRenderPath(panel: PanelState | null | undefined): PanelFrameRenderPath {
  if (!panel || panel.hidden) return 'hidden';
  return panel.mode;
}

export function PanelFrame({ id, children }: PanelFrameProps) {
  // ── Primitive selectors ──────────────────────────────────────────────────────
  // Zustand v5 wraps each selector in React.useCallback([api, selector]).  When
  // the selector is an inline arrow function it gets a new reference every render,
  // so useCallback creates a new getSnapshot function every render.  React 18's
  // useSyncExternalStore then calls the new getSnapshot and compares its return
  // value with the cached snapshot via Object.is.
  //
  // If the selector returns an object (state.panels[id]) the comparison will
  // always fail after commitPanels clones the whole panel map — even for panels
  // whose data did not change — triggering the "getSnapshot should be cached"
  // warning and eventually "Maximum update depth exceeded".
  //
  // Primitives (boolean, string, number) compare by VALUE, so Object.is returns
  // true whenever the underlying data is unchanged, even though the panel object
  // itself is a new reference.  Each selector below selects exactly one scalar.
  const reactiveHidden  = usePanelRegistry((s) => s.panels[id].hidden);
  const reactiveMode    = usePanelRegistry((s) => s.panels[id].mode);
  const reactiveFocused = usePanelRegistry((s) => s.panels[id].focused);
  const reactiveZIndex  = usePanelRegistry((s) => s.panels[id].zIndex);
  const reactiveFloatX  = usePanelRegistry((s) => s.panels[id].floating.x);
  const reactiveFloatY  = usePanelRegistry((s) => s.panels[id].floating.y);
  const reactiveFloatW  = usePanelRegistry((s) => s.panels[id].floating.width);
  const reactiveFloatH  = usePanelRegistry((s) => s.panels[id].floating.height);
  const focusPanel      = usePanelRegistry((s) => s.focusPanel);

  // SSR / test-env fallback: renderToStaticMarkup calls useSyncExternalStore
  // with getInitialState() (not the mutated getState()), so test mutations would
  // be invisible.  Read getState() directly when window is absent.
  const ssrPanel = typeof window === 'undefined'
    ? usePanelRegistry.getState().panels[id]
    : null;

  const hidden  = ssrPanel !== null ? ssrPanel.hidden           : reactiveHidden;
  const mode    = ssrPanel !== null ? ssrPanel.mode             : reactiveMode;
  const focused = ssrPanel !== null ? ssrPanel.focused          : reactiveFocused;
  const zIndex  = ssrPanel !== null ? ssrPanel.zIndex           : reactiveZIndex;
  const floatX  = ssrPanel !== null ? ssrPanel.floating.x       : reactiveFloatX;
  const floatY  = ssrPanel !== null ? ssrPanel.floating.y       : reactiveFloatY;
  const floatW  = ssrPanel !== null ? ssrPanel.floating.width   : reactiveFloatW;
  const floatH  = ssrPanel !== null ? ssrPanel.floating.height  : reactiveFloatH;

  const panelRef = useRef<HTMLElement>(null);
  const dragOffset = useDragOffset(id);
  const resizePreview = useResizePreview(id);
  const renderPath: PanelFrameRenderPath = hidden ? 'hidden' : mode as PanelFrameRenderPath;

  if (renderPath === 'hidden') {
    const entry = PANEL_CATALOG[id];
    if (!entry.keepAliveWhenHidden) return null;

    return (
      <PanelVisibilityProvider isVisible={false}>
        <div style={{ display: 'none' }} data-panel-id={id} data-panel-mode="hidden-alive">
          {children}
        </div>
      </PanelVisibilityProvider>
    );
  }

  if (renderPath === 'docked') {
    return (
      <PanelVisibilityProvider isVisible={true}>
        <section
          ref={panelRef}
          tabIndex={-1}
          className="xleth-panel-frame is-docked"
          data-panel-id={id}
          data-panel-mode="docked"
          style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
          onMouseDown={() => { focusPanel(id); panelRef.current?.focus(); }}
        >
          <Titlebar id={id} focused={focused} />
          <div className="xleth-panel-body">{children}</div>
        </section>
      </PanelVisibilityProvider>
    );
  }

  const baseFrameStyle = {
    '--xleth-windowing-panel-color': panelTypeColorVar(id),
    zIndex: `calc(var(--xleth-z-window-floating-base) + ${zIndex})`,
  } as CSSProperties;

  const floatingBounds = resizePreview ?? {
    x: floatX + (dragOffset?.dx ?? 0),
    y: floatY + (dragOffset?.dy ?? 0),
    width: floatW,
    height: floatH,
  };

  const frameStyle = renderPath === 'maximized' ? baseFrameStyle : {
    ...baseFrameStyle,
    transform: `translate3d(${floatingBounds.x}px, ${floatingBounds.y}px, 0)`,
    width: `${floatingBounds.width}px`,
    height: `${floatingBounds.height}px`,
  } as CSSProperties;

  return (
    <PanelVisibilityProvider isVisible={true}>
      <section
        ref={panelRef}
        tabIndex={-1}
        className={`xleth-panel-frame${focused ? ' is-focused' : ''}`}
        data-panel-id={id}
        data-panel-mode={mode}
        data-focused={focused}
        style={frameStyle}
        onMouseDown={() => { focusPanel(id); panelRef.current?.focus(); }}
      >
        <Titlebar id={id} focused={focused} />
        <div className="xleth-panel-body">{children}</div>
        {renderPath === 'floating' ? <ResizeHandles id={id} /> : null}
      </section>
    </PanelVisibilityProvider>
  );
}

export default PanelFrame;
