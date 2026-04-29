import { beforeEach, describe, expect, it } from 'vitest';
import { loadPreset } from '../managers/PresetManager';
import {
  createInitialDockRegionSizes,
  createInitialPanelStates,
  usePanelRegistry,
} from '../registry/PanelRegistry';

describe('PresetManager', () => {
  beforeEach(() => {
    usePanelRegistry.setState({
      panels: createInitialPanelStates(),
      dockRegionSizes: createInitialDockRegionSizes(),
    });
  });

  it('loadPreset fl-compose returns non-null', () => {
    expect(loadPreset('fl-compose')).not.toBeNull();
  });

  it('fl-compose: timeline visible floating, mixer docked, sampleSelector docked, preview hidden', () => {
    const preset = loadPreset('fl-compose')!;
    expect(preset.panels.timeline.hidden).toBe(false);
    expect(preset.panels.timeline.mode).toBe('floating');
    expect(preset.panels.mixer.mode).toBe('docked');
    expect(preset.panels.sampleSelector.mode).toBe('docked');
    expect(preset.panels.preview.hidden).toBe(true);
    expect(preset.panels.timeline.focused).toBe(true);
  });

  it('fl-compose carries dockRegionSizes', () => {
    const preset = loadPreset('fl-compose')!;
    expect(preset.dockRegionSizes).toEqual({ left: 320, right: 280, top: 240, bottom: 320 });
  });

  it('vegas-arrange: preview visible floating top-right, timeline floating bottom, mixer hidden', () => {
    const preset = loadPreset('vegas-arrange')!;
    expect(preset.panels.preview.hidden).toBe(false);
    expect(preset.panels.preview.mode).toBe('floating');
    expect(preset.panels.timeline.mode).toBe('floating');
    expect(preset.panels.timeline.floating.y).toBe(480);
    expect(preset.panels.mixer.hidden).toBe(true);
    expect(preset.panels.preview.focused).toBe(true);
  });

  it('grid-edit: gridSettings focused floating, preview floating, timeline bottom, mixer hidden', () => {
    const preset = loadPreset('grid-edit')!;
    expect(preset.panels.gridSettings.hidden).toBe(false);
    expect(preset.panels.gridSettings.mode).toBe('floating');
    expect(preset.panels.preview.mode).toBe('floating');
    expect(preset.panels.timeline.floating.y).toBe(660);
    expect(preset.panels.mixer.hidden).toBe(true);
    expect(preset.panels.gridSettings.focused).toBe(true);
  });

  it('unknown preset returns null', () => {
    expect(loadPreset('nonexistent-preset')).toBeNull();
  });

  it('applyPreset fl-compose updates registry state end-to-end including dockRegionSizes', () => {
    usePanelRegistry.getState().applyPreset('fl-compose');
    const state = usePanelRegistry.getState();
    expect(state.panels.timeline.hidden).toBe(false);
    expect(state.panels.mixer.mode).toBe('docked');
    expect(state.panels.sampleSelector.mode).toBe('docked');
    expect(state.panels.preview.hidden).toBe(true);
    expect(state.dockRegionSizes).toEqual({ left: 320, right: 280, top: 240, bottom: 320 });
  });
});
