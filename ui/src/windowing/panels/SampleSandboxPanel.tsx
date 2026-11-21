import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import SandboxPanelContent from '../../components/sandbox/SandboxPanelContent.jsx';

export default function SampleSandboxPanel() {
  return (
    <PanelFrame id="sampleSandbox">
      <SandboxPanelContent />
    </PanelFrame>
  );
}
