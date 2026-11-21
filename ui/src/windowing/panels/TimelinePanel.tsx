import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import TimelineView from '../../components/TimelineView.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';
import styles from './TimelinePanel.module.css';

/**
 * The arrangement: one full-width timeline for audio and video tracks alike.
 * Video settings live in the Inspector (per track) and on the Preview (Edit
 * Grid); there is no Audio / Video split.
 */
export default function TimelinePanel() {
  const fallbackActiveCenterTab = usePianoRollStore((s) => s.activeCenterTab);
  const {
    activeSampleId,
    currentPatternIdByTrack,
    setCurrentPatternIdByTrack,
    activeCenterTab,
  } = useXlethRootContext();

  return (
    <PanelFrame id="timeline">
      <div className={styles.body}>
        <TimelineView
          activeSampleId={activeSampleId}
          currentPatternIdByTrack={currentPatternIdByTrack}
          setCurrentPatternIdByTrack={setCurrentPatternIdByTrack}
          activeCenterTab={activeCenterTab ?? fallbackActiveCenterTab}
        />
      </div>
    </PanelFrame>
  );
}
