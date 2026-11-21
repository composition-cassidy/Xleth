import React, { useEffect, useRef, useState } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import DeviceChain from '../../components/devices/DeviceChain.jsx';
import VideoDeviceChain from '../../components/devices/video/VideoDeviceChain.jsx';
import useVideoDeviceStore from '../../components/devices/video/videoDeviceStore.js';
import styles from './DevicesPanel.module.css';

/**
 * The selected mixer track's chains as devices (ui/DESIGN.md "Device system").
 * Two stacked lanes: Audio (the insert chain) on top, Video (the track's picture,
 * visual effects) under it. Each lane has a folder tab on its top edge that stays
 * pinned at the left while the lanes scroll sideways, so the Audio | Video divide
 * is always visible. No track selected = the master chain (Master has no picture).
 */
export function DevicesLanes() {
  const focus = useVideoDeviceStore((s) => s.view);
  const focusNonce = useVideoDeviceStore((s) => s.viewNonce);
  const videoLane = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [audioOrderSlot, setAudioOrderSlot] = useState<HTMLElement | null>(null);

  // "Video effects" (Inspector) asks for the Video lane: scroll it into view. Audio is the top.
  useEffect(() => {
    if (focusNonce === 0) return;
    if (focus === 'video') {
      const el = scroller.current;
      const lane = videoLane.current;
      if (el && lane) el.scrollTo?.({ top: lane.offsetTop, behavior: 'auto' });
    } else {
      scroller.current?.scrollTo?.({ top: 0, behavior: 'auto' });
    }
  }, [focus, focusNonce]);

  return (
    <div className={styles.scroller} ref={scroller} data-testid="xleth-devices-lanes">
      <div className={styles.lanes}>
        <section className={styles.lane} data-lane="audio" aria-label="Audio effects">
          <div className={styles.tabRail}>
            <span className={styles.tab} data-testid="xleth-lane-tab-audio">Audio</span>
            <div className={styles.orderSlot} ref={setAudioOrderSlot} />
          </div>
          <div className={styles.laneBody}><DeviceChain orderSlot={audioOrderSlot} /></div>
        </section>
        <section className={styles.lane} data-lane="video" aria-label="Video effects" ref={videoLane}>
          <div className={styles.tabRail}>
            <span className={styles.tab} data-testid="xleth-lane-tab-video">Video</span>
          </div>
          <div className={styles.laneBody}><VideoDeviceChain /></div>
        </section>
      </div>
    </div>
  );
}

export default function DevicesPanel() {
  return (
  <PanelFrame id="devices">
    <DevicesLanes />
  </PanelFrame>
  );
}
