import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import DeviceChain from '../../components/devices/DeviceChain.jsx';
import VideoDeviceChain from '../../components/devices/video/VideoDeviceChain.jsx';
import useVideoDeviceStore from '../../components/devices/video/videoDeviceStore.js';

/**
 * The selected mixer track's chain as devices (ui/DESIGN.md "Device system").
 * The chain head's Audio | Video switch picks the insert chain or the track's
 * picture (visual effects). No track selected = the master chain.
 */
export default function DevicesPanel() {
  const view = useVideoDeviceStore((s) => s.view);
  return (
    <PanelFrame id="devices">
      {view === 'video' ? <VideoDeviceChain /> : <DeviceChain />}
    </PanelFrame>
  );
}
