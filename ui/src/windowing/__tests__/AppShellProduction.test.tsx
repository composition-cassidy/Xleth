import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyDemoShellMode,
  configurePhase6bDemoPanels,
  shouldRenderRealPanels,
} from '../AppShell';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

const originalApplyPreset = usePanelRegistry.getState().applyPreset;

describe('AppShell production boot', () => {
  beforeEach(() => {
    usePanelRegistry.setState({
      panels: createInitialPanelStates(),
      applyPreset: originalApplyPreset,
    });
    vi.restoreAllMocks();
  });

  it('production uses the real wrapper render path without running demo configuration', async () => {
    const applyPresetSpy = vi.fn((presetId: string) => originalApplyPreset(presetId));
    usePanelRegistry.setState({ applyPreset: applyPresetSpy });

    applyDemoShellMode('production');

    expect(shouldRenderRealPanels('production')).toBe(true);
    expect(applyPresetSpy).not.toHaveBeenCalled();
  });

  it('production does not overwrite restored registry state with the demo preset', async () => {
    const applyPresetSpy = vi.fn((presetId: string) => originalApplyPreset(presetId));
    const panels = createInitialPanelStates();
    panels.timeline.hidden = false;
    panels.timeline.mode = 'docked';
    usePanelRegistry.setState({ panels, applyPreset: applyPresetSpy });

    applyDemoShellMode('production');

    expect(usePanelRegistry.getState().panels.timeline.mode).toBe('docked');
    expect(applyPresetSpy).not.toHaveBeenCalled();
  });

  it('phase-6b-demo still uses the demo preset path', async () => {
    const applyPresetSpy = vi.fn((presetId: string) => originalApplyPreset(presetId));
    usePanelRegistry.setState({ applyPreset: applyPresetSpy });

    expect(shouldRenderRealPanels('phase-6b-demo')).toBe(true);
    configurePhase6bDemoPanels();

    expect(applyPresetSpy).toHaveBeenCalledTimes(1);
    expect(applyPresetSpy).toHaveBeenCalledWith('fl-compose');
  });
});
