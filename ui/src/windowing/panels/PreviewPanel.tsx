import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelVisibility } from '../contexts/PanelVisibilityContext';
import VideoPreview from '../../components/VideoPreview.jsx';

function PreviewPanelBody() {
  const { useOnVisibilityChange } = usePanelVisibility();

  useOnVisibilityChange((isVisible) => {
    void isVisible;
    // Phase 6b skeleton; Phase 7 fills in the IPC line.
    // PHASE 7 SEAM: a single line goes here:
    //   window.xleth?.preview?.setEnabled?.(isVisible)
    // Do not split engine-side enable across multiple effects.
    // VideoPreview internally handles its own rAF suspension.
  });

  return <VideoPreview />;
}

export default function PreviewPanel() {
  return (
    <PanelFrame id="preview">
      <PreviewPanelBody />
    </PanelFrame>
  );
}
