import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import styles from './PanelEmptyState.module.css';

/**
 * The selected track's device chain. Phase 4a builds it; until then the tab
 * says what exists today instead of drawing fake devices.
 */
export default function DevicesPanel() {
  return (
    <PanelFrame id="devices">
      <div className={styles.body} data-testid="xleth-devices-empty">
        <p className={styles.empty}>No device view yet. Track effects are in the Mixer tab.</p>
      </div>
    </PanelFrame>
  );
}
