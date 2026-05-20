import React from 'react';
import { PanelFrame } from '../components/PanelFrame';

export default function NodeEditorPanel() {
  return (
    <PanelFrame id="nodeEditor">
      <div className="xleth-windowing-quarantine-panel" role="note">
        <div className="xleth-windowing-quarantine-panel__title">
          Legacy Node Editor Disabled
        </div>
        <div className="xleth-windowing-quarantine-panel__body">
          FX Graph will return in a separate workspace after renderer and routing safety work is complete.
        </div>
      </div>
    </PanelFrame>
  );
}
