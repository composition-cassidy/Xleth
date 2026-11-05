import React from 'react';
import { PictureInPicture2 } from 'lucide-react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelVisibility } from '../contexts/PanelVisibilityContext';
import { getRegisteredWorkAreaRect } from '../managers/DragManager';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { usePanelValue } from '../registry/usePanelValue';
import VideoPreview from '../../components/VideoPreview.jsx';
import styles from './PreviewPanel.module.css';

/**
 * Pop the docked Preview into its own window (for a second monitor). Its
 * floating titlebar has "Return to the dock" to bring it back.
 */
export function popOutPreview(): void {
  const registry = usePanelRegistry.getState();
  const panel = registry.panels.preview;
  const area = getRegisteredWorkAreaRect();
  const fits = Number.isFinite(area.width) && area.width > 0 && Number.isFinite(area.height) && area.height > 0;
  const x = fits ? Math.max(0, Math.round((area.width - panel.floating.width) / 2)) : panel.floating.x;
  const y = fits ? Math.max(0, Math.round((area.height - panel.floating.height) / 3)) : panel.floating.y;
  console.log('[Shell] pop out preview');
  registry.undockPanel('preview', x, y);
}

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

  const mode = usePanelValue('preview', (p) => p.mode);
  const popOut = mode === 'docked' ? (
    <button
      type="button"
      className={styles.popOut}
      aria-label="Pop out Preview"
      data-hint="Pop the Preview out into its own window, for example on a second monitor"
      onClick={popOutPreview}
    >
      <PictureInPicture2 aria-hidden="true" strokeWidth={2} />
    </button>
  ) : null;

  return <VideoPreview headerActions={popOut} />;
}

export default function PreviewPanel() {
  return (
    <PanelFrame id="preview">
      <PreviewPanelBody />
    </PanelFrame>
  );
}
