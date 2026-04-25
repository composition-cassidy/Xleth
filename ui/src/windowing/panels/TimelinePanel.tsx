import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import TimelineView from '../../components/TimelineView.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';

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
      <TimelineView
        activeSampleId={activeSampleId}
        currentPatternIdByTrack={currentPatternIdByTrack}
        setCurrentPatternIdByTrack={setCurrentPatternIdByTrack}
        activeCenterTab={activeCenterTab ?? fallbackActiveCenterTab}
      />
    </PanelFrame>
  );
}
