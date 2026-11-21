import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import InspectorBody from '../../components/inspector/InspectorBody.jsx';

/**
 * Properties of the arrangement's current selection (a track or a clip). The
 * arrangement publishes its selection to useInspectorStore; nothing selected
 * shows an honest empty state.
 */
export default function InspectorPanel() {
  return (
    <PanelFrame id="inspector">
      <InspectorBody />
    </PanelFrame>
  );
}
