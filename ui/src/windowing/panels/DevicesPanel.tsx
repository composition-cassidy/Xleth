import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import DeviceChain from '../../components/devices/DeviceChain.jsx';

/**
 * The selected mixer track's insert chain as devices (ui/DESIGN.md "Device
 * system"). No track selected = the master chain.
 */
export default function DevicesPanel() {
  return (
    <PanelFrame id="devices">
      <DeviceChain />
    </PanelFrame>
  );
}
