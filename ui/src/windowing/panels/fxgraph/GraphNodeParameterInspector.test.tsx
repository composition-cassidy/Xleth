import { describe, it, expect } from 'vitest';
import {
  collectEffectNodeOptions,
  describeParamFailure,
  isWritableParameter,
} from './GraphNodeParameterInspector';
import type { GraphStateDocument } from './GraphStatePreview';

function graphWith(nodes: GraphStateDocument['nodes']): GraphStateDocument {
  return { schemaVersion: 1, trackId: '7', nodes, edges: [] };
}

describe('GraphNodeParameterInspector helpers', () => {
  it('lists only instantiable graph-owned effect nodes', () => {
    const graphState = graphWith([
      { id: 'input', type: 'trackInput', data: {} },
      {
        id: 'fx-1',
        type: 'effect',
        data: { effectInstanceId: 'inst-1', pluginId: 'delay', displayName: 'Delay' },
      },
      // placeholder pluginId — not yet engine-backed, excluded.
      { id: 'fx-2', type: 'effect', data: { effectInstanceId: 'inst-2', pluginId: 'placeholder' } },
      // missing plugin — excluded.
      { id: 'fx-3', type: 'effect', data: { effectInstanceId: 'inst-3', pluginId: 'vst:x', missing: true } },
      // no effectInstanceId — excluded.
      { id: 'fx-4', type: 'effect', data: { pluginId: 'reverb' } },
      { id: 'output', type: 'trackOutput', data: {} },
    ]);

    const options = collectEffectNodeOptions(graphState);
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      effectInstanceId: 'inst-1',
      graphNodeId: 'fx-1',
      label: 'Delay',
    });
  });

  it('returns an empty list for null/empty graph state', () => {
    expect(collectEffectNodeOptions(null)).toEqual([]);
    expect(collectEffectNodeOptions(graphWith([]))).toEqual([]);
  });

  it('treats automatable, non-read-only parameters as writable', () => {
    expect(isWritableParameter({
      parameterId: 'mix', parameterIndex: 0, automatable: true, readOnly: false,
    })).toBe(true);
    // Defaults (flags absent) are treated as writable.
    expect(isWritableParameter({ parameterId: 'a', parameterIndex: 0 })).toBe(true);
  });

  it('treats read-only or non-automatable parameters as not writable', () => {
    expect(isWritableParameter({
      parameterId: 'meter', parameterIndex: 1, automatable: false, readOnly: false,
    })).toBe(false);
    expect(isWritableParameter({
      parameterId: 'locked', parameterIndex: 2, automatable: true, readOnly: true,
    })).toBe(false);
  });

  it('maps failure reasons to friendly copy with a safe fallback', () => {
    expect(describeParamFailure('plugin_missing')).toMatch(/unavailable/i);
    expect(describeParamFailure('not_graph_mode')).toMatch(/FX Graph mode/i);
    expect(describeParamFailure('something_unknown')).toMatch(/unavailable/i);
    expect(describeParamFailure(undefined)).toMatch(/unavailable/i);
  });
});
