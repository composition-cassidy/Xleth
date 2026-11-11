import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SamplerPanelContent from '../../components/sampler/SamplerPanelContent.jsx';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelProps } from '../registry/usePanelValue';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';
import { EmptyState } from '../../ui-kit';
import { fallbackSamplerRegionId, type PatternMap } from './dockTabFallback';

interface SamplerPanelProps {
  regionId?: unknown;
}

export default function SamplerWindowPanel() {
  // Handed over by whoever opened the panel:
  //   usePanelRegistry.getState().openPanel('sampler', { regionId })
  // With nothing handed over, the tab does not dead-end (ui/DESIGN.md 14): it follows the
  // Piano Roll, showing the open pattern's sampler, else the last open pattern's, else the
  // first pattern's. Derived in the renderer; no engine call decides it.
  const explicitRegionId = usePanelProps<SamplerPanelProps>('sampler')?.regionId ?? null;
  const { allPatterns } = useXlethRootContext() as { allPatterns?: PatternMap };
  const openPatternId = usePianoRollStore((s) => s.patternId);
  const lastPatternId = usePianoRollStore((s) => s.lastPatternId);
  const regionId = fallbackSamplerRegionId(explicitRegionId, allPatterns, openPatternId, lastPatternId);

  const handleClose = () => {
    usePanelRegistry.getState().closePanel('sampler');
  };

  return (
    <PanelFrame id="sampler">
      {regionId != null
        ? <SamplerPanelContent regionId={regionId} onClose={handleClose} />
        : (
          <EmptyState message="No pattern in this project plays a sample yet. A pattern's sampler opens here from Sampler settings in the Piano Roll." />
        )
      }
    </PanelFrame>
  );
}
