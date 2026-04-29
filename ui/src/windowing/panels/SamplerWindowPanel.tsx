import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SamplerPanelContent from '../../components/sampler/SamplerPanelContent.jsx';
import useSamplerPanelStore from '../../stores/samplerPanelStore.js';
import { usePanelRegistry } from '../registry/PanelRegistry';

export default function SamplerWindowPanel() {
  const regionId = useSamplerPanelStore((s) => s.regionId);

  const handleClose = () => {
    usePanelRegistry.getState().closePanel('sampler');
  };

  return (
    <PanelFrame id="sampler">
      {regionId != null
        ? <SamplerPanelContent regionId={regionId} onClose={handleClose} />
        : (
          <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--theme-text-muted)', fontSize: 12 }}>
            No sample selected
          </div>
        )
      }
    </PanelFrame>
  );
}
