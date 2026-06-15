import React from 'react';
import {
  Music2,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  RotateCcw,
} from 'lucide-react';
import { loadPreset } from '../managers/PresetManager';
import { usePanelRegistry } from '../registry/PanelRegistry';
import type { DockRegion, PanelStateMap, PresetId } from '../registry/PanelRegistry';
import {
  PANEL_CATALOG_ORDER,
  panelTypeColorVar,
  type PanelId,
} from '../registry/panelCatalog';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';

interface LayoutPresetButton {
  id: PresetId;
  label: string;
  title: string;
}

const LAYOUT_PRESETS: LayoutPresetButton[] = [
  { id: 'fl-compose', label: 'FL', title: 'Reset to FL Compose layout' },
  { id: 'vegas-arrange', label: 'VG', title: 'Switch to Vegas Arrange layout' },
  { id: 'grid-edit', label: 'GR', title: 'Switch to Grid Edit layout' },
];

const DOCK_BUTTONS: Array<{
  region: DockRegion;
  title: string;
  Icon: typeof PanelLeft;
}> = [
  { region: 'left', title: 'Dock focused panel left', Icon: PanelLeft },
  { region: 'top', title: 'Dock focused panel top', Icon: PanelTop },
  { region: 'bottom', title: 'Dock focused panel bottom', Icon: PanelBottom },
  { region: 'right', title: 'Dock focused panel right', Icon: PanelRight },
];

function panelLayoutMatches(panels: PanelStateMap, presetId: PresetId): boolean {
  const preset = loadPreset(presetId);
  if (!preset) return false;

  return PANEL_CATALOG_ORDER.every(({ id }) => {
    const current = panels[id];
    const expected = preset.panels[id];
    return current.hidden === expected.hidden
      && current.mode === expected.mode
      && current.docked.region === expected.docked.region;
  });
}

function topBarPanelLayoutKey(panels: PanelStateMap): string {
  return PANEL_CATALOG_ORDER
    .map(({ id }) => {
      const panel = panels[id];
      return [
        id,
        panel.hidden ? '1' : '0',
        panel.focused ? '1' : '0',
        panel.mode,
        panel.docked.region,
      ].join(':');
    })
    .join('|');
}

function focusedPanelKey(panels: PanelStateMap): string {
  const focusedPanel = PANEL_CATALOG_ORDER.find(({ id }) => (
    panels[id].focused && !panels[id].hidden
  ));
  if (!focusedPanel) return '';
  const panel = panels[focusedPanel.id];
  return [focusedPanel.id, panel.mode, panel.docked.region].join(':');
}

function PanelToggleButton({ entry }: { entry: (typeof PANEL_CATALOG_ORDER)[number] }) {
  const hidden = usePanelRegistry((state) => state.panels[entry.id].hidden);
  const focused = usePanelRegistry((state) => state.panels[entry.id].focused);
  const { id } = entry;

  return (
    <button
      className="xleth-top-bar-toggle-btn"
      data-active={String(!hidden)}
      data-focused={String(focused)}
      style={{ '--xleth-windowing-panel-color': panelTypeColorVar(id) } as React.CSSProperties}
      onClick={() => usePanelRegistry.getState().togglePanel(id)}
      title={entry.fKey ? `${entry.title} (${entry.fKey})` : entry.title}
      aria-label={`Toggle ${entry.title}`}
      aria-pressed={!hidden}
    >
      <entry.icon />
    </button>
  );
}

export function TopBarToggles() {
  const layoutKey = usePanelRegistry((state) => topBarPanelLayoutKey(state.panels));
  const reactiveFocusedPanelKey = usePanelRegistry((state) => focusedPanelKey(state.panels));
  const panels = usePanelRegistry.getState().panels;
  const { onOpenMidiImport } = useXlethRootContext();
  void layoutKey;
  const focusedPanelId = reactiveFocusedPanelKey === ''
    ? undefined
    : reactiveFocusedPanelKey.split(':')[0] as PanelId;
  const focusedPanel = focusedPanelId
    ? PANEL_CATALOG_ORDER.find(({ id }) => id === focusedPanelId)
    : undefined;

  return (
    <div className="xleth-top-bar-toggles">
      <div className="xleth-top-bar-group" aria-label="Panel visibility">
        {PANEL_CATALOG_ORDER
          .filter((entry) => entry.id !== 'sampleSelector' && entry.id !== 'quickNotation')
          .map((entry) => <PanelToggleButton key={entry.id} entry={entry} />)}
      </div>
      <div className="xleth-top-bar-separator" aria-hidden="true" />
      <div className="xleth-top-bar-group" aria-label="Layout presets">
        {LAYOUT_PRESETS.map((preset) => {
          const active = panelLayoutMatches(panels, preset.id);
          return (
            <button
              key={preset.id}
              className="xleth-top-bar-preset-btn"
              data-active={String(active)}
              onClick={() => usePanelRegistry.getState().applyPreset(preset.id)}
              title={preset.title}
              aria-label={preset.title}
              aria-pressed={active}
            >
              {preset.id === 'fl-compose' ? <RotateCcw aria-hidden="true" /> : null}
              <span>{preset.label}</span>
            </button>
          );
        })}
      </div>
      <div className="xleth-top-bar-separator" aria-hidden="true" />
      <div className="xleth-top-bar-group" aria-label="Dock focused panel">
        {DOCK_BUTTONS.map(({ region, title, Icon }) => {
          const active = Boolean(
            focusedPanelId
              && panels[focusedPanelId].mode === 'docked'
              && panels[focusedPanelId].docked.region === region,
          );
          return (
            <button
              key={region}
              className="xleth-top-bar-dock-btn"
              data-active={String(active)}
              disabled={!focusedPanelId}
              onClick={() => {
                if (!focusedPanelId) return;
                usePanelRegistry.getState().dockPanel(focusedPanelId, region);
              }}
              title={focusedPanel ? `${title}: ${focusedPanel.title}` : title}
              aria-label={focusedPanel ? `${title}: ${focusedPanel.title}` : title}
              aria-pressed={active}
            >
              <Icon aria-hidden="true" />
            </button>
          );
        })}
      </div>
      <div className="xleth-top-bar-separator" aria-hidden="true" />
      <div className="xleth-top-bar-group" aria-label="Import">
        <button
          className="xleth-top-bar-toggle-btn"
          onClick={() => onOpenMidiImport()}
          title="Import MIDI"
          aria-label="Import MIDI"
        >
          <Music2 aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export default TopBarToggles;
