import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeDetailDock,
  isDetailDockOpen,
  openDetailDock,
  toggleDetailDock,
  toggleDockFocus,
} from '../layout/dockFocus';
import { isRegionHiddenByShell, resetShellLayoutStore, useShellLayoutStore } from '../layout/shellLayoutStore';
import { getCommand } from '../managers/shortcutCatalog';
import { usePanelRegistry } from '../registry/PanelRegistry';

beforeEach(() => {
  usePanelRegistry.getState().resetLayout();
  resetShellLayoutStore();
});

describe('dock focus', () => {
  it('opens the dock on Devices when it is collapsed, hides the top row and arrangement, then restores', () => {
    expect(isDetailDockOpen()).toBe(false);
    toggleDockFocus();
    expect(isDetailDockOpen()).toBe(true);
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(false);
    const state = useShellLayoutStore.getState();
    expect(state.focus).toBe(true);
    expect(isRegionHiddenByShell(state, 'top')).toBe(true);
    expect(isRegionHiddenByShell(state, 'center')).toBe(true);
    expect(isRegionHiddenByShell(state, 'bottom')).toBe(false);
    toggleDockFocus();
    expect(useShellLayoutStore.getState().focus).toBe(false);
    expect(isDetailDockOpen()).toBe(true);
  });

  it('reopens the dock on the tab the user last had open', () => {
    usePanelRegistry.getState().openPanel('mixer');
    closeDetailDock();
    expect(isDetailDockOpen()).toBe(false);
    openDetailDock();
    expect(usePanelRegistry.getState().panels.mixer.hidden).toBe(false);
    expect(usePanelRegistry.getState().panels.devices.hidden).toBe(true);
    toggleDetailDock();
    expect(isDetailDockOpen()).toBe(false);
  });

  it('is a rebindable command on a combo nothing else in the catalog uses', () => {
    const command = getCommand('view.dockFocus');
    expect(command?.defaultCombo).toBe('Ctrl+Shift+d');
    expect(command?.scope).toBe('global');
  });
});
