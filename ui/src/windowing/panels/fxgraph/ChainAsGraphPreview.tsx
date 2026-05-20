import React from 'react';

export interface ChainEffect {
  nodeId?: number;
  pluginId?: string;
  position?: number;
  name?: string;
  label?: string;
  displayName?: string;
  bypassed?: boolean;
  missing?: boolean;
  crashed?: boolean;
}

export interface VstPluginMeta {
  id?: string;
  name?: string;
  vendor?: string;
}

interface ChainAsGraphPreviewProps {
  chain?: ChainEffect[];
  vstPlugins?: VstPluginMeta[];
}

const STOCK_EFFECT_LABELS: Record<string, string> = {
  testgain: 'Test Gain',
  compressor: 'Compressor',
  limiter: 'Limiter',
  overdone: 'Overdone',
  transientproc: 'Transient Proc',
  xletheq: 'Xleth EQ',
  xlethfilter: 'Xleth Filter',
  distortion: 'Distortion',
  waveshaper: 'Waveshaper',
  uniflange: 'UniFlange',
  chorus: 'Chorus',
  flanger: 'Flanger',
  phaser: 'Phaser',
  phanjer: 'Phanjer',
  delay: 'Delay',
  reverb: 'Reverb',
  smartbalance: 'Smart Balance',
  resonancesuppressor: 'Resonance Suppressor',
};

export function resolvePreviewEffectLabel(
  effect: ChainEffect,
  vstPlugins: VstPluginMeta[] = [],
) {
  const explicitLabel = effect.displayName || effect.label || effect.name;
  if (explicitLabel) return explicitLabel;

  const pluginId = effect.pluginId ?? '';
  const stockLabel = STOCK_EFFECT_LABELS[pluginId];
  if (stockLabel) return stockLabel;

  const vstMeta = vstPlugins.find((plugin) => plugin.id === pluginId);
  return vstMeta?.name || pluginId || 'Effect';
}

function PreviewConnector() {
  return (
    <div className="xleth-chain-graph-preview__connector" aria-hidden="true">
      <span className="xleth-chain-graph-preview__line" />
      <span className="xleth-chain-graph-preview__arrow">-&gt;</span>
    </div>
  );
}

function PreviewNode({
  label,
  kind,
  effect,
}: {
  label: string;
  kind: 'io' | 'effect';
  effect?: ChainEffect;
}) {
  return (
    <div
      className={`xleth-chain-graph-preview__node xleth-chain-graph-preview__node--${kind}`}
      role="listitem"
      aria-label={label}
    >
      <span className="xleth-chain-graph-preview__node-label">{label}</span>
      {effect?.bypassed && (
        <span className="xleth-chain-graph-preview__badge">Bypassed</span>
      )}
      {effect?.missing && (
        <span className="xleth-chain-graph-preview__badge">Missing</span>
      )}
      {effect?.crashed && (
        <span className="xleth-chain-graph-preview__badge">Crashed</span>
      )}
    </div>
  );
}

export default function ChainAsGraphPreview({
  chain = [],
  vstPlugins = [],
}: ChainAsGraphPreviewProps) {
  return (
    <section
      className="xleth-chain-graph-preview"
      aria-label="Read-only Mixer Chain graph preview"
    >
      <p className="xleth-chain-graph-preview__notice">
        Preview only. Mixer Chain still owns routing.
      </p>
      <div className="xleth-chain-graph-preview__rail" role="list">
        <PreviewNode label="Track Input" kind="io" />
        {chain.map((effect, index) => {
          const label = resolvePreviewEffectLabel(effect, vstPlugins);
          const key = `${effect.nodeId ?? effect.pluginId ?? 'effect'}-${index}`;
          return (
            <React.Fragment key={key}>
              <PreviewConnector />
              <PreviewNode label={label} kind="effect" effect={effect} />
            </React.Fragment>
          );
        })}
        <PreviewConnector />
        <PreviewNode label="Track Output" kind="io" />
      </div>
    </section>
  );
}
