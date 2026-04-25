import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import NodeEditor from '../../components/mixer/NodeEditor.jsx';

// Known pre-existing issue: ui/src/stores/nodeGraphStore.js
// line 144 registers window.xleth.onGraphChanged at module-
// import time without cleanup. ES module caching means the
// listener registers exactly once for the page lifetime - not
// per NodeEditor mount - so this is a one-time global, not a
// per-mount leak. Phase 6b does not address this; revisit
// separately.
export default function NodeEditorPanel() {
  return (
    <PanelFrame id="nodeEditor">
      <NodeEditor storeKey="main" />
    </PanelFrame>
  );
}
