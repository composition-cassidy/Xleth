import React from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from 'react';
import { armPanelDrag, useIsTabDropTarget } from '../managers/DragManager';
import { dockHomeOf, PANEL_CATALOG, panelTypeColorVar, type PanelId } from '../registry/panelCatalog';
import { isEdgeRegion, usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelValue } from '../registry/usePanelValue';
import { XlethIconButton } from '../../components/common/XlethButton.jsx';
import './windowing.css';
import chrome from './PanelChrome.module.css';
import { iconComponent } from '../../ui-kit/icons';

const IcArrowLineDown = iconComponent('arrow-line-down');
const IcCaretDown = iconComponent('caret-down');
const IcCaretUp = iconComponent('caret-up');
const IcCornersIn = iconComponent('corners-in');
const IcCornersOut = iconComponent('corners-out');
const IcX = iconComponent('x');

export interface TitlebarProps {
  id: PanelId;
  focused: boolean;
  children?: ReactNode;
  /** The content takes the free width instead of sizing to itself. */
  contentFill?: boolean;
}

/** Keyboard nudge per arrow press; Shift multiplies it. */
const KEYBOARD_MOVE_STEP = 8;
const KEYBOARD_MOVE_STEP_COARSE = 48;

export function isTitlebarControlTarget(target: EventTarget | null): boolean {
  return typeof HTMLElement !== 'undefined'
    && target instanceof HTMLElement
    && Boolean(target.closest('button'));
}

export function Titlebar({ id, focused, children, contentFill = false }: TitlebarProps) {
  const entry = PANEL_CATALOG[id];
  const mode = usePanelValue(id, (p) => p.mode);
  const collapsed = usePanelValue(id, (p) => p.collapsed);
  const floatingX = usePanelValue(id, (p) => p.floating.x);
  const floatingY = usePanelValue(id, (p) => p.floating.y);
  const closePanel = usePanelRegistry((state) => state.closePanel);
  const maximizePanel = usePanelRegistry((state) => state.maximizePanel);
  const restorePanel = usePanelRegistry((state) => state.restorePanel);
  const toggleCollapsePanel = usePanelRegistry((state) => state.toggleCollapsePanel);
  const moveFloatingPanel = usePanelRegistry((state) => state.moveFloatingPanel);
  const dockPanel = usePanelRegistry((state) => state.dockPanel);
  const isDropTarget = useIsTabDropTarget(id);

  const stopControlPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const hidePanel = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    closePanel(id);
  };

  // Minimize used to call the same handler as close, which made one of the two
  // buttons a lie. It now rolls the panel up to its titlebar and leaves it in
  // the layout — the panel is still open, still where the user put it, and one
  // click away from full size.
  const toggleCollapse = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    toggleCollapsePanel(id);
  };

  const toggleMaximize = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (mode === 'maximized') restorePanel(id);
    else maximizePanel(id);
  };

  const startTitlebarDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || mode === 'maximized') return;
    event.preventDefault();
    armPanelDrag(id, event.clientX, event.clientY, floatingX, floatingY, {
      target: event.currentTarget,
      pointerId: event.pointerId,
    });
  };

  // A fixed-size panel (resizable === false) never maximizes — no control, and
  // a double-click on its titlebar does nothing.
  const canMaximize = entry.resizable !== false;

  const toggleTitlebarMaximize = (event: MouseEvent<HTMLDivElement>) => {
    if (isTitlebarControlTarget(event.target)) return;
    if (!canMaximize) return;
    if (mode === 'maximized') restorePanel(id);
    else if (mode === 'floating') maximizePanel(id);
  };

  // Keyboard equivalent of dragging the titlebar. Without it a floating panel
  // can only be moved with a pointer, which leaves keyboard-only users unable
  // to reach a panel that opened over the one they need.
  const onTitlebarKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== 'floating') return;
    const step = event.shiftKey ? KEYBOARD_MOVE_STEP_COARSE : KEYBOARD_MOVE_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === 'ArrowLeft') dx = -step;
    else if (event.key === 'ArrowRight') dx = step;
    else if (event.key === 'ArrowUp') dy = -step;
    else if (event.key === 'ArrowDown') dy = step;
    else return;
    event.preventDefault();
    moveFloatingPanel(id, Math.max(0, floatingX + dx), Math.max(0, floatingY + dy));
  };

  const collapseLabel = collapsed ? `Expand ${entry.title}` : `Collapse ${entry.title}`;
  // A popped-out panel with a home region goes back in one click (dragging it
  // to that edge still works too). It returns to the slot it left: undocking
  // keeps the panel's docked order, so Preview lands left of the Inspector.
  // The catalog's home is the fallback; a panel that was docked somewhere else (Compose puts
  // Preview on the left and the Inspector on the right) goes back there, because undocking
  // keeps `docked.region`. Detail-dock tabs always return to the dock.
  const catalogHome = dockHomeOf(id);
  const lastRegion = usePanelRegistry((state) => state.panels[id].docked.region);
  const dockHome = catalogHome !== null && catalogHome !== 'bottom' && isEdgeRegion(lastRegion) && lastRegion !== 'bottom'
    ? lastRegion
    : catalogHome;
  const canReturnToDock = mode === 'floating' && dockHome !== null;
  const returnLabel = `Return ${entry.title} to the dock`;
  const returnToDock = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!dockHome) return;
    const panel = usePanelRegistry.getState().panels[id];
    const slot = dockHome !== 'bottom' && panel.docked.region === dockHome ? panel.docked.orderInRegion : undefined;
    dockPanel(id, dockHome, slot);
  };

  return (
    <div
      className={`xleth-windowing-titlebar ${chrome.titlebar}`}
      data-panel-id={id}
      data-focused={focused}
      // Marks the drop zone DragManager hit-tests when a dragged panel is over
      // an already-docked one. Tabbing onto a floating panel is not offered:
      // tab strips belong to dock slots.
      data-tab-drop-target={mode === 'docked' ? id : undefined}
      data-drop-target={isDropTarget ? 'true' : undefined}
      style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as CSSProperties}
      onPointerDown={startTitlebarDrag}
      onDoubleClick={toggleTitlebarMaximize}
      onKeyDown={onTitlebarKeyDown}
      role="toolbar"
      aria-label={`${entry.title} title bar`}
      data-hint={mode === 'floating'
        ? `${entry.title}: drag to move, drop on an edge to dock`
        : `${entry.title} title bar`}
      data-hint-mods={mode === 'floating' ? 'Arrows move 8 px, Shift+Arrows 48 px; double-click maximizes' : undefined}
      aria-orientation="horizontal"
      tabIndex={mode === 'floating' ? 0 : -1}
    >
      {/* Only floating and maximized panels have a titlebar now, so it names
          the window. Focus shows as an outline on the frame. */}
      <span className={chrome.title}>{entry.title}</span>
      {children ? <div className={`xleth-windowing-titlebar-content${contentFill ? ' is-fill' : ''}`}>{children}</div> : null}
      <span className="xleth-windowing-drag-zone" aria-hidden="true" />
      <div className={`xleth-windowing-controls ${chrome.controls}`} aria-label={`${entry.title} panel controls`}>
        {canReturnToDock ? (
          <XlethIconButton
            type="button"
            className={`xleth-windowing-control-button ${chrome.control}`}
            aria-label={returnLabel}
            title={returnLabel}
            data-hint={returnLabel}
            onPointerDown={stopControlPointerDown}
            onClick={returnToDock}
          >
            <IcArrowLineDown aria-hidden="true" />
          </XlethIconButton>
        ) : null}
        <XlethIconButton
          type="button"
          className={`xleth-windowing-control-button ${chrome.control}`}
          aria-label={collapseLabel}
          aria-expanded={!collapsed}
          title={collapseLabel}
          data-hint={collapseLabel}
          onPointerDown={stopControlPointerDown}
          onClick={toggleCollapse}
        >
          {collapsed
            ? <IcCaretDown aria-hidden="true" />
            : <IcCaretUp aria-hidden="true" />}
        </XlethIconButton>
        {canMaximize ? (
          <XlethIconButton
            type="button"
            className={`xleth-windowing-control-button ${chrome.control}`}
            aria-label={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
            title={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
            data-hint={mode === 'maximized' ? `Restore ${entry.title}` : `Maximize ${entry.title}`}
            data-hint-mods={mode === 'maximized' ? 'Esc restores' : undefined}
            onPointerDown={stopControlPointerDown}
            onClick={toggleMaximize}
          >
            {mode === 'maximized'
              ? <IcCornersIn aria-hidden="true" />
              : <IcCornersOut aria-hidden="true" />}
          </XlethIconButton>
        ) : null}
        <XlethIconButton
          type="button"
          className={`xleth-windowing-control-button ${chrome.control}`}
          aria-label={`Close ${entry.title}`}
          title={`Close ${entry.title}`}
          data-hint={`Close ${entry.title}`}
          data-hint-mods="Ctrl+Shift+T reopens the last closed panel"
          onPointerDown={stopControlPointerDown}
          onClick={hidePanel}
        >
          <IcX aria-hidden="true" />
        </XlethIconButton>
      </div>
    </div>
  );
}

export default Titlebar;
