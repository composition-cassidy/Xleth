import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import LeftPanel from '../../components/LeftPanel.jsx';

export default function SampleSelectorPanel() {
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  return (
    <PanelFrame id="sampleSelector">
      <LeftPanel
        onOpenPicker={onOpenPicker}
        activeSampleId={activeSampleId}
        setActiveSampleId={setActiveSampleId}
      />
    </PanelFrame>
  );
}
