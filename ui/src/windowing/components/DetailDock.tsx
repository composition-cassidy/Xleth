import React, { useEffect, useRef } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { useShellLayoutStore } from '../layout/shellLayoutStore';
import { toggleDockFocus } from '../layout/dockFocus';
import { formatCombo } from '../managers/shortcutCatalog';
import { resolveCombo } from '../managers/shortcutOverrides';
import { DockSlotProvider } from '../contexts/DockSlotContext';
import { getRegisteredWorkAreaRect } from '../managers/DragManager';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import {
  DETAIL_DOCK_TAB_IDS,
  PANEL_CATALOG,
  WINDOW_PANEL_IDS,
  isPanelId,
  opensFloating,
  type PanelId,
} from '../registry/panelCatalog';
import { usePanelRegistry, type PanelState, type PanelStateMap } from '../registry/PanelRegistry';
import { DockRegionResizer } from './DockRegionResizer';
import { MotionDiv, useAfterMount } from '../../ui-kit';
import styles from './DetailDock.module.css';
import { iconComponent } from '../../ui-kit/icons';

const IcArrowLineDown = iconComponent('arrow-line-down');
const IcCornersIn = iconComponent('corners-in');
const IcCornersOut = iconComponent('corners-out');
const IcPictureInPicture = iconComponent('picture-in-picture');

/**
 * Where a tab's panel is right now.
 * - open:    docked here and showing; the dock is expanded on it.
 * - docked:  lives in the dock, currently closed back to its tab.
 * - popped:  in its own floating (or maximized) window.
 * - stowed:  its pop-out window was closed; the tab brings it home. A tab that
 *            opens floating (the Sampler) reopens its window instead.
 */
export type DetailTabState = 'open' | 'docked' | 'popped' | 'stowed';

/** How long a click on the open tab waits for a second click before collapsing the dock. */
const DOUBLE_CLICK_MS = 250;

function inDock(panel: PanelState): boolean {
  return panel.mode === 'docked' && panel.docked.region === 'bottom';
}

export function detailTabState(panel: PanelState): DetailTabState {
  if (inDock(panel)) return panel.hidden ? 'docked' : 'open';
  return panel.hidden ? 'stowed' : 'popped';
}

/**
 * Flat string of the tab strip: "id:state" per tab. The catalog's dock tabs
 * always show; any other window docked at the bottom (dragged there) joins the
 * strip while it is open. A primitive key keeps the store subscription cheap.
 */
export function detailDockKey(panels: PanelStateMap): string {
  const extras = WINDOW_PANEL_IDS.filter((id) => (
    !DETAIL_DOCK_TAB_IDS.includes(id) && !panels[id].hidden && inDock(panels[id])
  ));
  return [...DETAIL_DOCK_TAB_IDS, ...extras]
    .map((id) => `${id}:${detailTabState(panels[id])}`)
    .join(',');
}

export function parseDetailDockKey(key: string): Array<{ id: PanelId; state: DetailTabState }> {
  if (key === '') return [];
  return key.split(',').flatMap((entry) => {
    const [id, state] = entry.split(':');
    return isPanelId(id) ? [{ id, state: state as DetailTabState }] : [];
  });
}

/** Tab click: open it, collapse the dock if it was the open one, or bring its window forward. */
export function activateDetailTab(id: PanelId): void {
  const registry = usePanelRegistry.getState();
  const state = detailTabState(registry.panels[id]);
  if (state === 'open') {
    registry.closePanel(id);
  } else if (state === 'docked') {
    registry.openPanel(id);
  } else if (state === 'popped') {
    registry.focusPanel(id);
  } else if (opensFloating(id)) {
    // Its window was closed (or never opened): the tab reopens the window. Docking
    // is the user's choice, made from the tab's own dock control.
    registry.openPanel(id);
  } else {
    registry.dockPanel(id, 'bottom');
  }
}

/** Pop a tab out into its own window, or bring a popped-out one back into the dock. */
export function togglePopOutDetailTab(id: PanelId): void {
  const registry = usePanelRegistry.getState();
  const panel = registry.panels[id];
  const state = detailTabState(panel);
  if (state === 'popped' || state === 'stowed') {
    registry.dockPanel(id, 'bottom');
    return;
  }
  const area = getRegisteredWorkAreaRect();
  const fits = Number.isFinite(area.width) && Number.isFinite(area.height) && area.width > 0 && area.height > 0;
  // Centred in the work area; AppShell clamps it to the work area afterwards.
  const x = fits ? Math.max(0, Math.round((area.width - panel.floating.width) / 2)) : panel.floating.x;
  const y = fits ? Math.max(0, Math.round((area.height - panel.floating.height) / 3)) : panel.floating.y;
  registry.undockPanel(id, x, y);
}

export interface DetailDockProps {
  renderPanel: (id: PanelId) => ReactNode;
  /** Open height computed by the shell layout; replaces the stored size for rendering. */
  sizeOverride?: number;
}

export function DetailDock({ renderPanel, sizeOverride }: DetailDockProps) {
  const reactiveKey = usePanelRegistry((state) => detailDockKey(state.panels));
  const reactiveSize = usePanelRegistry((state) => state.dockRegionSizes.bottom);
  const isSSR = typeof window === 'undefined';
  const key = isSSR ? detailDockKey(usePanelRegistry.getState().panels) : reactiveKey;
  const committedSize = isSSR ? usePanelRegistry.getState().dockRegionSizes.bottom : reactiveSize;
  const preview = useDockRegionResizePreview('bottom');
  const stripRef = useRef<HTMLDivElement>(null);
  // A panel that appears after the dock first drew was chosen by the user: it may enter.
  const afterMount = useAfterMount();
  const focus = useShellLayoutStore((s) => s.focus);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  const tabs = parseDetailDockKey(key);
  const openTab = tabs.find((tab) => tab.state === 'open') ?? null;
  const size = sizeOverride ?? preview?.size ?? committedSize;
  // In focus mode the dock is the column (CSS), so it carries no fixed height.
  const focused = focus && openTab !== null;
  const dockStyle: CSSProperties | undefined = openTab && !focused ? { height: `${size}px` } : undefined;

  // The open tab's single click collapses the dock; a double-click must not,
  // since collapsing unmounts the panel. The collapse waits out the double-click
  // window, and the second click of a double-click cancels it.
  const onTabClick = (tab: { id: PanelId; state: DetailTabState }, event: React.MouseEvent) => {
    if (tab.state !== 'open') {
      activateDetailTab(tab.id);
      return;
    }
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    if (event.detail >= 2) {
      collapseTimer.current = null;
      return;
    }
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = null;
      activateDetailTab(tab.id);
    }, DOUBLE_CLICK_MS);
  };
  const focusCombo = formatCombo(resolveCombo('view.dockFocus'));

  // Roving focus across the tabs, per the ARIA tabs pattern. Arrows move focus
  // only; Enter/Space (a click) opens, so browsing never mounts heavy panels.
  const onTabKeyDown = (index: number) => (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-detail-tab="${tabs[next].id}"]`)?.focus();
  };
  const focusableIndex = Math.max(0, tabs.findIndex((tab) => tab.state === 'open'));

  return (
    <section
      className={styles.dock}
      data-testid="xleth-detail-dock"
      data-dock-state={openTab ? 'open' : 'collapsed'}
      data-focus={focused ? 'true' : undefined}
      aria-label="Detail dock"
      style={dockStyle}
    >
      {openTab && !focused ? <DockRegionResizer region="bottom" currentSize={size} /> : null}
      <div className={styles.stripRow}>
        <div ref={stripRef} className={styles.strip} role="tablist" aria-label="Detail views">
          {tabs.map((tab, index) => {
            const entry = PANEL_CATALOG[tab.id];
            const away = tab.state === 'popped' || tab.state === 'stowed';
            const floatsFirst = opensFloating(tab.id);
            const popLabel = away
              ? (floatsFirst ? `Dock ${entry.title} here` : `Return ${entry.title} to the dock`)
              : `Pop out ${entry.title}`;
            const fKey = 'fKey' in entry && entry.fKey ? entry.fKey : null;
            const tabHint = tab.state === 'open'
              ? `${entry.title}: click to collapse the dock, double-click to ${focused ? 'restore the layout' : 'give it the whole centre column'}`
              : tab.state === 'popped'
                ? `${entry.title} is in its own window: click to bring it forward`
                : tab.state === 'stowed' && floatsFirst
                  ? `${entry.title}: click to open it in its own window`
                  : `${entry.title}: click to open in the dock`;
            return (
              <div key={tab.id} className={styles.tab} data-state={tab.state} role="presentation">
                <button
                  type="button"
                  className={styles.tabButton}
                  role="tab"
                  data-detail-tab={tab.id}
                  aria-selected={tab.state === 'open'}
                  aria-controls={tab.state === 'open' ? 'xleth-detail-dock-body' : undefined}
                  tabIndex={index === focusableIndex ? 0 : -1}
                  data-hint={tabHint}
                  data-hint-mods={fKey ? `${fKey} toggles` : undefined}
                  onClick={(event) => onTabClick(tab, event)}
                  onDoubleClick={tab.state === 'open' ? toggleDockFocus : undefined}
                  onKeyDown={onTabKeyDown(index)}
                >
                  <span>{entry.title}</span>
                </button>
                <button
                  type="button"
                  className={styles.popButton}
                  aria-label={popLabel}
                  data-hint={popLabel}
                  onClick={() => togglePopOutDetailTab(tab.id)}
                >
                  {away
                    ? <IcArrowLineDown aria-hidden="true" />
                    : <IcPictureInPicture aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
        {openTab ? (
          <button
            type="button"
            className={styles.focusButton}
            aria-label={focused ? 'Restore layout' : 'Focus the dock'}
            aria-pressed={focused}
            data-hint={focused
              ? 'Restore the layout: bring back the Preview row and the arrangement'
              : 'Focus the dock: give it the whole centre column, hiding the Preview row and the arrangement'}
            data-hint-mods={`${focusCombo}, or double-click the open tab`}
            onClick={toggleDockFocus}
          >
            {focused
              ? <IcCornersIn aria-hidden="true" />
              : <IcCornersOut aria-hidden="true" />}
          </button>
        ) : null}
      </div>
      {openTab ? (
        <MotionDiv
          // key: a different tab is a different panel, so the reveal replays (edit-loop channel:
          // it only moves in the lively tier, and never when the dock first draws).
          key={openTab.id}
          recipe="reveal"
          enter={afterMount}
          className={styles.body}
          id="xleth-detail-dock-body"
          role="tabpanel"
          aria-label={PANEL_CATALOG[openTab.id].title}
        >
          <DockSlotProvider region="bottom" tabIds={[openTab.id]} activeId={openTab.id}>
            {renderPanel(openTab.id)}
          </DockSlotProvider>
        </MotionDiv>
      ) : null}
    </section>
  );
}

export default DetailDock;
