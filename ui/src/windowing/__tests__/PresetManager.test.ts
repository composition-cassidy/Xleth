import { beforeEach, describe, expect, it } from 'vitest';
import { loadPreset } from '../managers/PresetManager';
import { createInitialPanelStates, usePanelRegistry } from '../registry/PanelRegistry';

describe('PresetManager', () => {
  beforeEach(() => {
    usePanelRegistry.setState({ panels: createInitialPanelStates() });
  });

  it('loadPreset fl-compose returns non-null', () => {
    expect(loadPreset('fl-compose')).not.toBeNull();
  });

  it('fl-compose: timeline visible floating, mixer docked, sampleSelector docked, preview hidden', () => {
    const preset = loadPreset('fl-compose')!;
    expect(preset.timeline.hidden).toBe(false);
    expect(preset.timeline.mode).toBe('floating');
    expect(preset.mixer.mode).toBe('docked');
    expect(preset.sampleSelector.mode).toBe('docked');
    expect(preset.preview.hidden).toBe(true);
    expect(preset.timeline.focused).toBe(true);
  });

  it('vegas-arrange: preview visible floating top-right, timeline floating bottom, mixer hidden', () => {
    const preset = loadPreset('vegas-arrange')!;
    expect(preset.preview.hidden).toBe(false);
    expect(preset.preview.mode).toBe('floating');
    expect(preset.timeline.mode).toBe('floating');
    expect(preset.timeline.floating.y).toBe(480);
    expect(preset.mixer.hidden).toBe(true);
    expect(preset.preview.focused).toBe(true);
  });

  it('grid-edit: gridSettings focused floating, preview floating, timeline bottom, mixer hidden', () => {
    const preset = loadPreset('grid-edit')!;
    expect(preset.gridSettings.hidden).toBe(false);
    expect(preset.gridSettings.mode).toBe('floating');
    expect(preset.preview.mode).toBe('floating');
    expect(preset.timeline.floating.y).toBe(660);
    expect(preset.mixer.hidden).toBe(true);
    expect(preset.gridSettings.focused).toBe(true);
  });

  it('unknown preset returns null', () => {
    expect(loadPreset('nonexistent-preset')).toBeNull();
  });

  it('applyPreset fl-compose updates registry state end-to-end', () => {
    usePanelRegistry.getState().applyPreset('fl-compose');
    const panels = usePanelRegistry.getState().panels;
    expect(panels.timeline.hidden).toBe(false);
    expect(panels.mixer.mode).toBe('docked');
    expect(panels.sampleSelector.mode).toBe('docked');
    expect(panels.preview.hidden).toBe(true);
  });
});
