import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelVisibility } from '../contexts/PanelVisibilityContext';
import VideoPreview from '../../components/VideoPreview.jsx';

function PreviewPanelBody() {
  const { useOnVisibilityChange } = usePanelVisibility();

  useOnVisibilityChange((isVisible) => {
    void isVisible;
    // Phase 7 landed inside VideoPreview.jsx itself: it already calls
    // usePanelVisibility() for its own rAF suspension, so the
    // window.xleth.preview.setEnabled(...) call (combined with document
    // visibility + window focus) lives there as one effect rather than
    // being split across this callback and VideoPreview's internals.
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
