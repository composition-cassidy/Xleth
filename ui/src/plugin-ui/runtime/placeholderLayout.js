// Hardcoded fallback layout — constructed programmatically from the manifest.
// Used only when both the user override AND the shipped default fail validation.
// Ensures users can always open a stock plugin panel even in a broken state.

export function buildPlaceholderLayout(pluginId, manifest) {
  const continuousParams = manifest
    ? Object.entries(manifest.params).filter(([, m]) => m.kind === 'continuous')
    : []

  const knobNodes = continuousParams.map(([id, meta]) => ({
    id:   `fb-k-${id}`,
    type: 'knob',
    props: {
      param:  id,
      label:  (meta.label || id).toUpperCase(),
      size:   48,
      format: meta.format || 'raw',
    },
  }))

  return {
    schemaVersion: 1,
    pluginId,
    name: `Auto-generated fallback for ${pluginId}`,
    panel: { preferredSize: { width: 480, height: 180 } },
    root: {
      id: 'root',
      type: 'panel',
      children: [
        {
          id:    'fb-knob-row',
          type:  'row',
          style: { paddingPx: 12, gapPx: 8 },
          children: knobNodes,
        },
        {
          id:    'fb-notice',
          type:  'label',
          style: { paddingPx: [0, 12, 8, 12] },
          props: {
            text:    'Default layout failed to load; showing automatic fallback.',
            variant: 'muted',
          },
        },
      ],
    },
  }
}
