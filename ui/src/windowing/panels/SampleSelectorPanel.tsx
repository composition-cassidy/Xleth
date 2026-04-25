import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SampleSelectorTab from '../../components/SampleSelectorTab.jsx';

const NOOP = () => {};

export default function SampleSelectorPanel() {
  return (
    <PanelFrame id="sampleSelector">
      <SampleSelectorTab
        onOpenPicker={NOOP}
        activeSampleId={null}
        setActiveSampleId={NOOP}
      />
    </PanelFrame>
  );
}
