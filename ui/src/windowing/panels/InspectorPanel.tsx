import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import styles from './InspectorPanel.module.css';

/**
 * Properties of the current selection. Phase 1 only reserves its place in the
 * shell; Phase 3 fills it. Until then it says so instead of showing fake fields.
 */
export default function InspectorPanel() {
  return (
    <PanelFrame id="inspector">
      <div className={styles.body} data-testid="xleth-inspector-empty">
        <p className={styles.empty}>Select a clip or track to edit its properties</p>
      </div>
    </PanelFrame>
  );
}
