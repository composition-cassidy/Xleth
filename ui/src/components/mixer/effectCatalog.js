// Shared add-effect catalog source.
//
// Single source of truth for the stock-effect categories and the scanned
// VST/plugin ordering used when ADDING an effect. The Mixer Chain
// (EffectChainPanel.jsx) and the FX Graph picker (FxGraphEffectPicker.tsx)
// both consume this module so the two add flows expose the exact same
// effects without a duplicate registry or a second plugin scanner.
//
// This module only describes WHAT can be added (pluginId + label). It is
// storage- and routing-agnostic: Mixer Chain turns a pluginId into a chain
// slot, FX Graph turns the same pluginId into a graph-owned effect node.

export const EFFECT_CATEGORIES = [
  {
    label: 'Dynamics',
    submenu: [
      { label: 'Compressor', id: 'compressor' },
      { label: 'Limiter', id: 'limiter' },
      { label: 'Overdone', id: 'overdone' },
      { label: 'Transient Proc', id: 'transientproc' },
      { label: 'Resonance Suppressor', id: 'resonancesuppressor' },
    ],
  },
  {
    label: 'EQ & Filter',
    submenu: [
      { label: 'Xleth EQ', id: 'xletheq' },
      { label: 'Xleth Filter', id: 'xlethfilter' },
    ],
  },
  {
    label: 'Distortion',
    submenu: [
      { label: 'Distortion', id: 'distortion' },
      { label: 'Waveshaper', id: 'waveshaper' },
    ],
  },
  {
    label: 'Modulation',
    submenu: [
      { label: 'UniFlange', id: 'uniflange' },
      { label: 'Chorus', id: 'chorus' },
      { label: 'Flanger', id: 'flanger' },
      { label: 'Phaser', id: 'phaser' },
      { label: 'Phanjer', id: 'phanjer' },
    ],
  },
  {
    label: 'Time',
    submenu: [
      { label: 'Delay', id: 'delay' },
      { label: 'Reverb', id: 'reverb' },
    ],
  },
  {
    label: 'Utility',
    submenu: [
      { label: 'Smart Balance', id: 'smartbalance' },
    ],
  },
]

// Stable label used when a scanned VST/plugin section has no entries.
export const NO_SCANNED_PLUGINS_LABEL = 'No plugins scanned - scan VST3 plugins in Settings'
export const VST_GROUP_LABEL = 'VST3 Plugins'

// Sort scanned plugins by name, then vendor (case-insensitive). Shared so the
// Mixer Chain submenu and the FX Graph picker present plugins in the same order.
export function sortRackVstPlugins(vstPlugins) {
  return [...vstPlugins].sort((a, b) => {
    const byName = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
    if (byName !== 0) return byName
    return (a.vendor || '').localeCompare(b.vendor || '', undefined, { sensitivity: 'base' })
  })
}

// Picker list label for a scanned plugin (name + optional vendor). Mirrors the
// Mixer Chain submenu label exactly.
export function formatVstPluginLabel(plugin) {
  const name = plugin?.name || plugin?.id || 'Plugin'
  return plugin?.vendor ? `${name} - ${plugin.vendor}` : name
}

// displayName stored on the created node — the bare effect/plugin name without
// the vendor suffix, so graph nodes read cleanly.
function vstDisplayName(plugin) {
  return plugin?.name || plugin?.id || 'Plugin'
}

// Build grouped picker options from the SAME source the Mixer Chain uses:
// the stock EFFECT_CATEGORIES and the scanned vstPlugins list. Each option
// carries the pluginId (engine identity) and the displayName to store on a
// graph node. The VST group is always present so the section header reads
// "VST3 Plugins (n)" exactly like the Mixer Chain submenu, and shows a
// disabled hint when nothing is scanned.
export function buildEffectPickerGroups({ vstPlugins = [] } = {}) {
  const stockGroups = EFFECT_CATEGORIES.map((category) => ({
    id: `stock:${category.label}`,
    label: category.label,
    kind: 'stock',
    options: category.submenu.map((effect) => ({
      pluginId: effect.id,
      label: effect.label,
      displayName: effect.label,
      kind: 'stock',
    })),
  }))

  const sortedVst = sortRackVstPlugins(vstPlugins)
  const vstGroup = {
    id: 'vst',
    label: VST_GROUP_LABEL,
    kind: 'vst',
    emptyLabel: NO_SCANNED_PLUGINS_LABEL,
    options: sortedVst.map((plugin) => ({
      pluginId: plugin.id,
      label: formatVstPluginLabel(plugin),
      displayName: vstDisplayName(plugin),
      kind: 'vst',
    })),
  }

  return [...stockGroups, vstGroup]
}

// Case-insensitive substring filter over option labels. Drops groups that have
// no surviving options (the empty VST hint is suppressed while filtering so a
// search only ever shows real matches).
export function filterEffectPickerGroups(groups, query) {
  const trimmed = (query ?? '').trim().toLowerCase()
  if (!trimmed) return groups
  return groups
    .map((group) => ({
      ...group,
      options: group.options.filter((option) => option.label.toLowerCase().includes(trimmed)),
    }))
    .filter((group) => group.options.length > 0)
}

// Total selectable options across all groups (used to detect "no matches").
export function countEffectPickerOptions(groups) {
  return groups.reduce((total, group) => total + group.options.length, 0)
}
