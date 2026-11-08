import React from 'react';
import { buildEffectChainMenuItems } from '../../../components/mixer/EffectChainPanel.jsx';
import { buildEffectPickerGroups } from '../../../components/mixer/effectCatalog.js';
import TrackContextMenu from '../../../components/timeline/TrackContextMenu.jsx';

// The FX Graph's "add a node" menu. There is ONE effect picker in the app: the Devices chain's
// (a category list of submenus, then the scanned VST3 plugins), and this menu embeds exactly that
// list, built by the same function. It chooses WHAT to add; the panel turns the selection into a
// graph-owned effect node. The modulators and the sidechain input follow under their own
// heading, since only a graph has them.

export interface GraphEffectSelection {
  pluginId: string;
  displayName: string;
}

export interface GraphModulatorAction {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect: () => void;
}

interface VstPluginMeta {
  id: string;
  name?: string;
  vendor?: string;
}

interface MenuItem {
  label?: string;
  type?: 'separator';
  disabled?: boolean;
  onClick?: () => void;
  submenu?: MenuItem[];
}

// The name a graph node is created with, from the same catalog the picker lists.
export function resolveEffectSelection(
  pluginId: string,
  vstPlugins: VstPluginMeta[],
): GraphEffectSelection {
  const groups = buildEffectPickerGroups({ vstPlugins }) as {
    options: { pluginId: string; displayName: string }[];
  }[];
  for (const group of groups) {
    const option = group.options.find((candidate) => candidate.pluginId === pluginId);
    if (option) return { pluginId: option.pluginId, displayName: option.displayName };
  }
  return { pluginId, displayName: pluginId };
}

export function buildGraphAddMenuItems({
  vstPlugins = [],
  onAddEffect,
  modulators = [],
}: {
  vstPlugins?: VstPluginMeta[];
  onAddEffect?: ((selection: GraphEffectSelection) => void) | null;
  modulators?: GraphModulatorAction[];
}): MenuItem[] {
  const items: MenuItem[] = [];
  if (onAddEffect) {
    items.push(...(buildEffectChainMenuItems({
      addEffect: (_storeKey: unknown, pluginId: string) => onAddEffect(resolveEffectSelection(pluginId, vstPlugins)),
      storeKey: null,
      vstPlugins,
    }) as MenuItem[]));
  }
  if (modulators.length > 0) {
    if (items.length > 0) items.push({ type: 'separator' });
    items.push({ label: 'Modulators', disabled: true });
    for (const action of modulators) {
      items.push({ label: action.label, disabled: action.disabled, onClick: action.onSelect });
    }
  }
  return items;
}

export default function GraphAddMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <TrackContextMenu
      x={x}
      y={y}
      items={items}
      onClose={onClose}
      menuClassName="xleth-graph-state-preview__add-menu effect-chain-add-menu"
      submenuClassName="effect-chain-add-submenu"
    />
  );
}
