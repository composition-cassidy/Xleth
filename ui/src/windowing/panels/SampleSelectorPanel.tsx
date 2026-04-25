import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import SampleSelectorTab from '../../components/SampleSelectorTab.jsx';

export default function SampleSelectorPanel() {
  const {
    onOpenPicker,
    activeSampleId,
    setActiveSampleId,
  } = useXlethRootContext();

  return (
    <PanelFrame id="sampleSelector">
      <SampleSelectorTab
        onOpenPicker={onOpenPicker}
        activeSampleId={activeSampleId}
        setActiveSampleId={setActiveSampleId}
      />
    </PanelFrame>
  );
}
