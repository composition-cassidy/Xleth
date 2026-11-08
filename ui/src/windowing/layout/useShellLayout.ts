import { useEffect, useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';
import { dockedPanelKey } from '../components/DockRegion';
import { detailDockKey } from '../components/DetailDock';
import { useDockRegionResizePreview } from '../managers/DockRegionResizeManager';
import { DRAWER_PANEL_IDS } from '../registry/panelCatalog';
import { useRegistryValue } from '../registry/usePanelValue';
import {
  computeShellLayout,
  isDockUserSized,
  isTopUserSized,
  type ShellLayout,
} from './shellLayout';
import { useShellLayoutStore } from './shellLayoutStore';

/**
 * The centre column's height split (top row / arrangement / detail dock), kept
 * in step with the window. Returns null until the column has been measured, in
 * which case the regions fall back to their stored sizes (first paint, tests).
 */
export function useShellLayout(columnRef: RefObject<HTMLElement | null>): ShellLayout | null {
  const [columnH, setColumnH] = useState(0);

  useLayoutEffect(() => {
    const column = columnRef.current;
    if (!column) return undefined;
    const measure = () => setColumnH(Math.round(column.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, [columnRef]);

  const dockOpen = useRegistryValue((state) => detailDockKey(state.panels).includes(':open'));
  const bottomCommitted = useRegistryValue((state) => state.dockRegionSizes.bottom);
  const topCommitted = useRegistryValue((state) => state.dockRegionSizes.top);
  const topPresent = useRegistryValue(
    (state) => dockedPanelKey('top', DRAWER_PANEL_IDS, state.panels) !== '',
  );
  const bottomPreview = useDockRegionResizePreview('bottom');
  const topPreview = useDockRegionResizePreview('top');

  const dockStored = bottomPreview?.size ?? bottomCommitted;
  const topStored = topPreview?.size ?? topCommitted;
  const layout = columnH > 0
    ? computeShellLayout({
      columnH,
      dockOpen,
      dockStored,
      dockUserSized: bottomPreview !== null || isDockUserSized(bottomCommitted),
      topStored,
      topUserSized: topPreview !== null || isTopUserSized(topCommitted),
      topPresent,
    })
    : null;

  const topMode = layout?.topMode ?? 'full';
  const setTopMode = useShellLayoutStore((s) => s.setTopMode);
  useEffect(() => { setTopMode(topMode); }, [topMode, setTopMode]);

  return layout;
}
