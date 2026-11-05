import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SamplerPanelContent from '../../components/sampler/SamplerPanelContent.jsx';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelProps } from '../registry/usePanelValue';

interface SamplerPanelProps {
  regionId?: unknown;
}

export default function SamplerWindowPanel() {
  // Handed over by whoever opened the panel:
  //   usePanelRegistry.getState().openPanel('sampler', { regionId })
  const regionId = usePanelProps<SamplerPanelProps>('sampler')?.regionId ?? null;

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
