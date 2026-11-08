import React, { useRef } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { PanelVisibilityProvider } from '../contexts/PanelVisibilityContext';
import { useDockSlot } from '../contexts/DockSlotContext';
import { PanelTabStrip } from './PanelTabStrip';
import { isRegionHiddenByShell, useShellLayoutStore } from '../layout/shellLayoutStore';
import { useDragOffset, useIsDragging } from '../managers/DragManager';
import { useResizePreview } from '../managers/ResizeManager';
import { PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState } from '../registry/PanelRegistry';
import { usePanelValue } from '../registry/usePanelValue';
import { ResizeHandles } from './ResizeHandles';
import { Titlebar } from './Titlebar';
import './windowing.css';
import chrome from './PanelChrome.module.css';

export interface PanelFrameProps {
  id: PanelId;
  children: ReactNode;
  titlebarContent?: ReactNode;
  /** Rendered above the titlebar when the panel shares a slot with others. */
  tabStrip?: ReactNode;
  /** A docked panel that is not the active tab of its slot renders nothing. */
  inactiveTab?: boolean;
}

export type PanelFrameRenderPath = 'hidden' | 'docked' | 'maximized' | 'floating';

export function getPanelFrameRenderPath(panel: PanelState | null | undefined): PanelFrameRenderPath {
  if (!panel || panel.hidden) return 'hidden';
  return panel.mode;
}

export function PanelFrame({
  id,
  children,
  titlebarContent,
  tabStrip: tabStripOverride,
  inactiveTab: inactiveTabOverride,
}: PanelFrameProps) {
  // Slot membership arrives by context because panel wrappers own the
  // <PanelFrame> call site; see DockSlotContext.
  const slot = useDockSlot();
  const inSlot = slot?.tabIds.includes(id) ?? false;
  const inactiveTab = inactiveTabOverride ?? (inSlot && slot!.activeId !== id);
  const tabStrip = tabStripOverride ?? (inSlot && slot!.tabIds.length > 1
    ? <PanelTabStrip region={slot!.region} tabIds={slot!.tabIds} activeId={slot!.activeId} />
    : null);

  const hidden = usePanelValue(id, (p) => p.hidden);
  const collapsed = usePanelValue(id, (p) => p.collapsed);
  const mode = usePanelValue(id, (p) => p.mode);
  const focused = usePanelValue(id, (p) => p.focused);
  const zIndex = usePanelValue(id, (p) => p.zIndex);
  const floatX = usePanelValue(id, (p) => p.floating.x);
  const floatY = usePanelValue(id, (p) => p.floating.y);
  const floatW = usePanelValue(id, (p) => p.floating.width);
  const floatH = usePanelValue(id, (p) => p.floating.height);
  const focusPanel = usePanelRegistry((s) => s.focusPanel);
  // The shell can fold a whole region (the top row on a short window). Its panels
  // stay mounted but must not render or decode into a box nobody can see.
  const regionHidden = useShellLayoutStore((s) => (slot ? isRegionHiddenByShell(s, slot.region) : false));

  const panelRef = useRef<HTMLElement>(null);
  const dragOffset = useDragOffset(id);
  const dragging = useIsDragging(id);
  const resizePreview = useResizePreview(id);
  const renderPath: PanelFrameRenderPath = hidden ? 'hidden' : mode as PanelFrameRenderPath;
  const entry = PANEL_CATALOG[id];

  if (renderPath === 'hidden') {
    if (!entry.keepAliveWhenHidden) return null;

    return (
      <PanelVisibilityProvider isVisible={false}>
        <div style={{ display: 'none' }} data-panel-id={id} data-panel-mode="hidden-alive">
          {children}
        </div>
      </PanelVisibilityProvider>
    );
  }

  // A background tab stays mounted but unpainted, exactly like a hidden
  // keep-alive panel: its state, caches and subscriptions survive a tab switch.
  if (inactiveTab) {
    return (
      <PanelVisibilityProvider isVisible={false}>
        <div style={{ display: 'none' }} data-panel-id={id} data-panel-mode="inactive-tab">
          {children}
        </div>
      </PanelVisibilityProvider>
    );
  }

  // Claim panel ownership before child controls can stop the bubble phase.
  // Canvas clip handles and portaled menus intentionally stop mousedown;
  // leaving this in bubble phase makes panel-scoped shortcuts depend on
  // whichever panel happened to be focused previously.
  const claimFocus = () => { focusPanel(id); panelRef.current?.focus(); };

  const accessibility = {
    role: 'region' as const,
    'aria-label': entry.title,
  };

  if (renderPath === 'docked') {
    return (
      <PanelVisibilityProvider isVisible={!collapsed && !regionHidden}>
        <section
          ref={panelRef}
          tabIndex={-1}
          className={`xleth-panel-frame is-docked${collapsed ? ' is-collapsed' : ''}`}
          data-panel-id={id}
          data-panel-mode="docked"
          data-collapsed={collapsed ? 'true' : 'false'}
          style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
          onMouseDownCapture={claimFocus}
          {...accessibility}
        >
          {/* Docked panels draw no titlebar: the region names them (the detail
              dock's tab, the layout itself). A shared slot keeps its tab strip.
              Anything a titlebar carried moves into the panel's own toolbar. */}
          {tabStrip}
          {collapsed ? null : <div className="xleth-panel-body" id={`xleth-panel-body-${id}`}>{children}</div>}
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
    // A collapsed floating panel is its titlebar. Height comes from the frame's
    // own chrome rather than a computed number so the two cannot drift.
    height: collapsed ? 'auto' : `${floatingBounds.height}px`,
  } as CSSProperties;

  const className = [
    'xleth-panel-frame',
    chrome.frame,
    focused ? 'is-focused' : '',
    collapsed ? 'is-collapsed' : '',
    // Lifts the dragged frame out of hit-testing so DragManager's
    // elementFromPoint() can see the dock tab strip underneath the cursor.
    dragging ? 'is-dragging' : '',
  ].filter(Boolean).join(' ');

  return (
    <PanelVisibilityProvider isVisible={!collapsed}>
      <section
        ref={panelRef}
        tabIndex={-1}
        className={className}
        data-panel-id={id}
        data-panel-mode={mode}
        data-focused={focused}
        data-collapsed={collapsed ? 'true' : 'false'}
        style={frameStyle}
        onMouseDownCapture={claimFocus}
        {...accessibility}
      >
        <Titlebar id={id} focused={focused}>{titlebarContent}</Titlebar>
        {collapsed ? null : <div className="xleth-panel-body" id={`xleth-panel-body-${id}`}>{children}</div>}
        {renderPath === 'floating' && !collapsed && entry.resizable !== false
          ? <ResizeHandles id={id} />
          : null}
      </section>
    </PanelVisibilityProvider>
  );
}

export default PanelFrame;
