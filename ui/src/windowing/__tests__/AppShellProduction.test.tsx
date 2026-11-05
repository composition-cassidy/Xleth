import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell, floatingPanelKey } from '../AppShell';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';
import { ACTIVE_PANEL_IDS, PANEL_IDS, WINDOW_PANEL_IDS } from '../registry/panelCatalog';

const originalApplyPreset = usePanelRegistry.getState().applyPreset;

describe('AppShell boot', () => {
  beforeEach(() => {
    usePanelRegistry.setState({
      panels: createInitialPanelStates(),
      applyPreset: originalApplyPreset,
    });
    vi.restoreAllMocks();
  });

  // The shell used to carry seven demo modes, one of which applied a preset on
  // mount. Rendering must never rewrite the layout that was just restored from
  // disk — there is now no mount-time path that could, and this pins that.
  it('rendering the shell never mutates the restored layout', () => {
    const applyPresetSpy = vi.fn((presetId: string) => originalApplyPreset(presetId));
    const panels = createInitialPanelStates();
    panels.timeline.hidden = false;
    panels.timeline.mode = 'docked';
    usePanelRegistry.setState({ panels, applyPreset: applyPresetSpy });

    const before = JSON.stringify(usePanelRegistry.getState().panels);
    renderToStaticMarkup(<AppShell />);

    expect(applyPresetSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(usePanelRegistry.getState().panels)).toBe(before);
    expect(usePanelRegistry.getState().panels.timeline.mode).toBe('docked');
  });

  it('renders every active window panel that is open and floating', () => {
    const registry = usePanelRegistry.getState();
    for (const id of WINDOW_PANEL_IDS) registry.openPanel(id);

    const key = floatingPanelKey(usePanelRegistry.getState().panels);
    expect(key.split('|').sort()).toEqual([...WINDOW_PANEL_IDS].sort());
  });

  it('never renders a quarantined panel or a drawer panel in the floating layer', () => {
    const registry = usePanelRegistry.getState();
    for (const id of PANEL_IDS) registry.openPanel(id);

    const rendered = floatingPanelKey(usePanelRegistry.getState().panels).split('|');
    expect(rendered).not.toContain('nodeEditor');
    expect(rendered).not.toContain('sampleSelector');
    expect(ACTIVE_PANEL_IDS).not.toContain('nodeEditor');
  });
});
