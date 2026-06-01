import type { GraphStateDocument } from './GraphStatePreview';

// FXG.4-c — stable identity shape for an exposed graph parameter port.
// Future macro, LFO, envelope, and automation sources bind to this contract.
// Raw engineNodeId is never stored here.
export interface GraphParameterTarget {
  kind: 'graph-parameter';
  graphNodeId: string;
  effectInstanceId: string;
  pluginId?: string;
  effectKind?: string;
  pluginFormat?: string;
  parameterId: string;
  parameterIndexFallback: number | null;
  parameterIdIsFallback: boolean;
  nameSnapshot: string;
  labelSnapshot: string | null;
  trackId?: string;
}

export interface GraphEffectParameterDescriptor {
  parameterId: string;
  parameterIndex: number;
  parameterIdIsFallback?: boolean;
  pluginId?: string;
  effectKind?: string;
  pluginFormat?: string;
  name?: string;
  unit?: string;
  normalizedValue?: number;
  defaultNormalizedValue?: number;
  automatable?: boolean;
  readOnly?: boolean;
  discrete?: boolean;
  boolean?: boolean;
  numSteps?: number;
  displayValue?: string;
}
export interface GraphParameterResult {
  ok?: boolean;
  reason?: string;
  effectKind?: string;
  pluginFormat?: string;
  pluginId?: string;
  parameters?: GraphEffectParameterDescriptor[];
}

export interface EffectNodeOption {
  effectInstanceId: string;
  graphNodeId: string;
  label: string;
}

export interface GraphParameterExposureContext {
  pluginId?: string | null;
  effectKind?: string | null;
  pluginFormat?: string | null;
  resultPluginId?: string | null;
}

export interface GraphExposeParameterMenuItem {
  parameter: GraphEffectParameterDescriptor;
  label: string;
}

export interface GraphExposeParameterMenuGroup {
  groupLabel: string | null;
  parameters: GraphExposeParameterMenuItem[];
}

const PARAM_FAILURE_MESSAGES: Record<string, string> = {
  not_graph_mode: 'Switch this track to FX Graph mode first.',
  missing_effect_instance_id: 'Select an effect node.',
  unknown_effect_instance: 'Effect is not active yet.',
  plugin_missing: 'This plugin is unavailable. Parameters cannot be read.',
  plugin_crashed: 'This plugin crashed. Parameters cannot be read.',
  plugin_unavailable: 'This plugin did not respond. Parameters cannot be read.',
  processor_unavailable: 'Effect is not active yet.',
  engine_unavailable: 'Audio engine is unavailable.',
  engine_error: 'Could not read parameters from the engine.',
  invalid_engine_response: 'The engine returned an unexpected response.',
};

export function describeParamFailure(reason: string | undefined): string {
  if (reason && PARAM_FAILURE_MESSAGES[reason]) return PARAM_FAILURE_MESSAGES[reason];
  return 'Parameters are unavailable for this effect.';
}

export function isWritableParameter(param: GraphEffectParameterDescriptor): boolean {
  return param.automatable !== false && param.readOnly !== true;
}

const STOCK_EQ_PLUGIN_IDS = new Set(['xletheq', 'stock:eq', 'eq']);
const EQ_EXPOSURE_CONTROLS = [
  { suffix: 'freq', label: 'Frequency' },
  { suffix: 'gain', label: 'Gain' },
  { suffix: 'q', label: 'Q' },
  { suffix: 'type', label: 'Type' },
  { suffix: 'enabled', label: 'Enabled' },
] as const;
const EQ_EXPOSURE_BANDS = [0, 1, 2] as const;

function normalizeIdentity(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().toLowerCase()
    : '';
}

export function isStockEqExposureContext(context: GraphParameterExposureContext = {}): boolean {
  const effectKind = normalizeIdentity(context.effectKind);
  const pluginFormat = normalizeIdentity(context.pluginFormat);
  if (effectKind === 'plugin' || (pluginFormat.length > 0 && pluginFormat !== 'stock')) {
    return false;
  }

  const pluginIds = [
    normalizeIdentity(context.pluginId),
    normalizeIdentity(context.resultPluginId),
  ];
  return pluginIds.some((pluginId) => STOCK_EQ_PLUGIN_IDS.has(pluginId));
}

function matchesExposureSearch(
  item: GraphExposeParameterMenuItem,
  groupLabel: string | null,
  search: string,
) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const parameter = item.parameter;
  return [
    groupLabel,
    item.label,
    parameter.name,
    parameter.parameterId,
  ].filter(Boolean).join(' ').toLowerCase().includes(needle);
}

export function buildExposeParameterMenuGroups(
  parameters: GraphEffectParameterDescriptor[],
  context: GraphParameterExposureContext = {},
  search = '',
): GraphExposeParameterMenuGroup[] {
  const source = Array.isArray(parameters) ? parameters : [];

  if (isStockEqExposureContext(context)) {
    const byParameterId = new Map(
      source
        .filter((parameter) => typeof parameter.parameterId === 'string' && parameter.parameterId.length > 0)
        .map((parameter) => [parameter.parameterId, parameter]),
    );

    return EQ_EXPOSURE_BANDS
      .map((bandIndex) => {
        const groupLabel = `Band ${bandIndex}`;
        const menuItems = EQ_EXPOSURE_CONTROLS
          .map(({ suffix, label }) => {
            const parameter = byParameterId.get(`b${bandIndex}_${suffix}`);
            return parameter ? { parameter, label } : null;
          })
          .filter((item): item is GraphExposeParameterMenuItem => item != null)
          .filter((item) => matchesExposureSearch(item, groupLabel, search));
        return { groupLabel, parameters: menuItems };
      })
      .filter((group) => group.parameters.length > 0);
  }

  const menuItems = source
    .map((parameter) => ({
      parameter,
      label: parameter.name || parameter.parameterId,
    }))
    .filter((item) => matchesExposureSearch(item, null, search));

  return menuItems.length > 0
    ? [{ groupLabel: null, parameters: menuItems }]
    : [];
}

export function collectEffectNodeOptions(graphState: GraphStateDocument | null): EffectNodeOption[] {
  const nodes = Array.isArray(graphState?.nodes) ? graphState!.nodes : [];
  const options: EffectNodeOption[] = [];
  for (const node of nodes) {
    if (!node || node.type !== 'effect') continue;
    const data = (node.data ?? {}) as {
      effectInstanceId?: unknown;
      pluginId?: unknown;
      displayName?: unknown;
      missing?: unknown;
    };
    const effectInstanceId = typeof data.effectInstanceId === 'string' ? data.effectInstanceId : '';
    const pluginId = typeof data.pluginId === 'string' ? data.pluginId : '';
    if (!effectInstanceId || !pluginId || pluginId === 'placeholder' || data.missing === true) {
      continue;
    }
    const displayName = typeof data.displayName === 'string' && data.displayName.length > 0
      ? data.displayName
      : pluginId;
    options.push({
      effectInstanceId,
      graphNodeId: typeof node.id === 'string' ? node.id : '',
      label: displayName,
    });
  }
  return options;
}
