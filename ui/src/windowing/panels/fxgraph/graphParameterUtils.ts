import type { GraphStateDocument } from './GraphStatePreview';

export interface GraphEffectParameterDescriptor {
  parameterId: string;
  parameterIndex: number;
  parameterIdIsFallback?: boolean;
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
