import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import GridLayoutTab from '../../components/GridLayoutTab.jsx';

export default function GridSettingsPanel() {
  return (
    <PanelFrame id="gridSettings">
      <GridLayoutTab />
    </PanelFrame>
  );
}
