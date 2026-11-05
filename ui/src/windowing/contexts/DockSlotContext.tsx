import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { DockArea } from '../registry/PanelRegistry';
import type { PanelId } from '../registry/panelCatalog';

export interface DockSlotContextValue {
  region: DockArea;
  /** Every panel sharing this slot, in tab order. One entry = no tab strip. */
  tabIds: readonly PanelId[];
  activeId: PanelId;
  /**
   * The host draws this panel's chrome (the detail dock's tab IS its title), so
   * PanelFrame renders no titlebar of its own.
   */
  chromeless?: boolean;
}

// Panel wrappers render `<PanelFrame id="…">` themselves, so a dock slot cannot
// hand its tab strip down as a prop without every wrapper forwarding it. The
// slot publishes its membership here instead and PanelFrame picks it up.
const DockSlotContext = createContext<DockSlotContextValue | null>(null);

export function DockSlotProvider({
  region,
  tabIds,
  activeId,
  chromeless = false,
  children,
}: DockSlotContextValue & { children: ReactNode }) {
  const key = tabIds.join('|');
  const value = useMemo<DockSlotContextValue>(
    () => ({ region, tabIds, activeId, chromeless }),
    // tabIds is rebuilt every render by the region; the joined key is what
    // actually changes, so memoize on that rather than on array identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [region, key, activeId, chromeless],
  );
  return <DockSlotContext.Provider value={value}>{children}</DockSlotContext.Provider>;
}

export function useDockSlot(): DockSlotContextValue | null {
  return useContext(DockSlotContext);
}

export default DockSlotContext;
