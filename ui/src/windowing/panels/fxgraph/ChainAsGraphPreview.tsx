import React from 'react';
import { resolveChainEffectDisplayName } from '../../../fxgraph/chainToGraphState.js';
import { DEVICE_NAMES } from '../../../components/devices/deviceNames.js';
import styles from './FxGraphPanel.module.css';

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

export function resolvePreviewEffectLabel(
  effect: ChainEffect,
  vstPlugins: VstPluginMeta[] = [],
) {
  return resolveChainEffectDisplayName(effect, vstPlugins);
}

function PreviewConnector() {
  return (
    <div className={`xleth-chain-graph-preview__connector ${styles.chainConnector}`} aria-hidden="true">
      <span className={`xleth-chain-graph-preview__line ${styles.chainLine}`} />
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
      className={`xleth-chain-graph-preview__node xleth-chain-graph-preview__node--${kind} ${styles.chainNode}`}
      data-kind={kind}
      role="listitem"
      aria-label={label}
    >
      <span className="xleth-chain-graph-preview__node-label">{label}</span>
      {effect?.bypassed && (
        <span className={`xleth-chain-graph-preview__badge ${styles.chainBadge}`}>Bypassed</span>
      )}
      {effect?.missing && (
        <span className={`xleth-chain-graph-preview__badge ${styles.chainBadge}`}>Missing</span>
      )}
      {effect?.crashed && (
        <span className={`xleth-chain-graph-preview__badge ${styles.chainBadge}`}>Crashed</span>
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
      className={`xleth-chain-graph-preview ${styles.chainPreview}`}
      aria-label="Read-only Mixer Chain graph preview"
    >
      <p className={`xleth-chain-graph-preview__notice ${styles.copy}`}>
        Preview only. Mixer Chain still owns routing.
      </p>
      <div className={styles.chainRail} role="list">
        <PreviewNode label="Track input" kind="io" />
        {chain.map((effect, index) => {
          const label = (effect.pluginId && DEVICE_NAMES[effect.pluginId]) || resolvePreviewEffectLabel(effect, vstPlugins);
          const key = `${effect.nodeId ?? effect.pluginId ?? 'effect'}-${index}`;
          return (
            <React.Fragment key={key}>
              <PreviewConnector />
              <PreviewNode label={label} kind="effect" effect={effect} />
            </React.Fragment>
          );
        })}
        <PreviewConnector />
        <PreviewNode label="Track output" kind="io" />
      </div>
    </section>
  );
}
