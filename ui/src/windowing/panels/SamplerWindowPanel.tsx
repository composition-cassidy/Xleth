import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SamplerPanelContent from '../../components/sampler/SamplerPanelContent.jsx';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelProps } from '../registry/usePanelValue';
import { EmptyState } from '../../ui-kit';

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
          <EmptyState message="No sample selected. Open a pattern's sampler with Sampler settings in the Piano Roll." />
        )
      }
    </PanelFrame>
  );
}
