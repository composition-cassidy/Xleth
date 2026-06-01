import React, { useCallback, useEffect, useMemo, useState } from 'react';
import useEffectChainStore from '../../../stores/effectChainStore.js';
import type { GraphStateDocument } from './GraphStatePreview';

// FXG.4-a — minimal, read-mostly inspector that proves the unified graph-owned
// parameter path end-to-end. It lists host-discovered / stock parameters for a
// selected graph-owned effect node and exposes a normalized [0,1] slider for
// writable parameters. This is intentionally not the final node-surface UI: no
// modulation, pinning, automation arm, or macro assignment lives here.

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

interface GraphParameterResult {
  ok?: boolean;
  reason?: string;
  effectKind?: string;
  pluginFormat?: string;
  pluginId?: string;
  parameters?: GraphEffectParameterDescriptor[];
}

interface EffectNodeOption {
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

// A parameter offers a writable control only when the engine reports it as
// automatable and not read-only. Read-only / non-automatable parameters are
// shown as values without an editable slider.
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

export interface GraphNodeParameterInspectorProps {
  trackId: number;
  graphState: GraphStateDocument | null;
}

export default function GraphNodeParameterInspector({
  trackId,
  graphState,
}: GraphNodeParameterInspectorProps) {
  const fetchGraphEffectParameters = useEffectChainStore(
    (state) => state.fetchGraphEffectParameters,
  );
  const setGraphEffectParameterNormalized = useEffectChainStore(
    (state) => state.setGraphEffectParameterNormalized,
  );

  const effectNodes = useMemo(() => collectEffectNodeOptions(graphState), [graphState]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>('');
  const [result, setResult] = useState<GraphParameterResult | null>(null);
  const [loading, setLoading] = useState(false);

  // Keep the selection valid as the graph changes underneath us.
  useEffect(() => {
    if (effectNodes.length === 0) {
      setSelectedInstanceId('');
      return;
    }
    setSelectedInstanceId((current) =>
      effectNodes.some((node) => node.effectInstanceId === current)
        ? current
        : effectNodes[0].effectInstanceId,
    );
  }, [effectNodes]);

  const loadParameters = useCallback(async (effectInstanceId: string) => {
    if (!effectInstanceId) {
      setResult(null);
      return;
    }
    setLoading(true);
    const next = (await fetchGraphEffectParameters(trackId, effectInstanceId)) as GraphParameterResult;
    setResult(next);
    setLoading(false);
  }, [fetchGraphEffectParameters, trackId]);

  useEffect(() => {
    void loadParameters(selectedInstanceId);
  }, [loadParameters, selectedInstanceId]);

  const handleSliderChange = useCallback(async (parameterId: string, rawValue: string) => {
    if (!selectedInstanceId) return;
    const normalizedValue = Number(rawValue);
    if (!Number.isFinite(normalizedValue)) return;
    const setResultPayload = await setGraphEffectParameterNormalized(
      trackId,
      selectedInstanceId,
      parameterId,
      normalizedValue,
    );
    if (setResultPayload && setResultPayload.ok === false) return;
    // Reflect the engine's clamped/applied value back into the descriptor list.
    await loadParameters(selectedInstanceId);
  }, [loadParameters, selectedInstanceId, setGraphEffectParameterNormalized, trackId]);

  if (effectNodes.length === 0) {
    return (
      <section className="xleth-fx-graph-params" aria-label="Graph effect parameters">
        <div className="xleth-fx-graph-params__title">Effect Parameters</div>
        <p className="xleth-fx-graph-params__empty">
          Add an effect node to inspect its parameters.
        </p>
      </section>
    );
  }

  const parameters = result?.ok ? result.parameters ?? [] : [];

  return (
    <section className="xleth-fx-graph-params" aria-label="Graph effect parameters">
      <div className="xleth-fx-graph-params__header">
        <div className="xleth-fx-graph-params__title">Effect Parameters</div>
        <select
          className="xleth-fx-graph-params__select"
          aria-label="Select effect node"
          value={selectedInstanceId}
          onChange={(event) => setSelectedInstanceId(event.target.value)}
        >
          {effectNodes.map((node) => (
            <option key={node.effectInstanceId} value={node.effectInstanceId}>
              {node.label}
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <p className="xleth-fx-graph-params__empty">Reading parameters…</p>
      )}

      {!loading && result && result.ok === false && (
        <p className="xleth-fx-graph-params__empty" role="alert">
          {describeParamFailure(result.reason)}
        </p>
      )}

      {!loading && result?.ok && parameters.length === 0 && (
        <p className="xleth-fx-graph-params__empty">
          This effect exposes no parameters.
        </p>
      )}

      {!loading && result?.ok && parameters.length > 0 && (
        <ul className="xleth-fx-graph-params__list">
          {parameters.map((param) => {
            const normalized = Number.isFinite(param.normalizedValue)
              ? (param.normalizedValue as number)
              : 0;
            const writable = isWritableParameter(param);
            const display = param.displayValue && param.displayValue.length > 0
              ? param.displayValue
              : normalized.toFixed(2);
            return (
              <li className="xleth-fx-graph-params__row" key={param.parameterId}>
                <div className="xleth-fx-graph-params__row-head">
                  <span className="xleth-fx-graph-params__name">
                    {param.name || param.parameterId}
                  </span>
                  <span className="xleth-fx-graph-params__value">
                    {display}{param.unit ? ` ${param.unit}` : ''}
                  </span>
                </div>
                {writable ? (
                  <input
                    className="xleth-fx-graph-params__slider"
                    type="range"
                    min={0}
                    max={1}
                    step={0.001}
                    value={normalized}
                    aria-label={`${param.name || param.parameterId} (normalized)`}
                    onChange={(event) => { void handleSliderChange(param.parameterId, event.target.value); }}
                  />
                ) : (
                  <div className="xleth-fx-graph-params__readonly" aria-label="read-only parameter">
                    Read-only
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
