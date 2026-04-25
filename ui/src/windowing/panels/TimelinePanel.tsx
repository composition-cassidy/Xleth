import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import TimelineView from '../../components/TimelineView.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';

const EMPTY_PATTERN_MAP = {};
const NOOP = () => {};

export default function TimelinePanel() {
  const activeCenterTab = usePianoRollStore((s) => s.activeCenterTab);

  return (
    <PanelFrame id="timeline">
      <TimelineView
        activeSampleId={null}
        currentPatternIdByTrack={EMPTY_PATTERN_MAP}
        setCurrentPatternIdByTrack={NOOP}
        activeCenterTab={activeCenterTab}
      />
    </PanelFrame>
  );
}
