import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import TimelineView from '../../components/TimelineView.jsx';
import VideoTab from '../../components/timeline/VideoTab.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';
import useVideoTabStore from '../../stores/useVideoTabStore.js';
import styles from './TimelinePanel.module.css';

export default function TimelinePanel() {
  const fallbackActiveCenterTab = usePianoRollStore((s) => s.activeCenterTab);
  const {
    activeSampleId,
    currentPatternIdByTrack,
    setCurrentPatternIdByTrack,
    activeCenterTab,
  } = useXlethRootContext();
  // activeTab lives in the store so the track right-click menu (built in
  // TimelineView, a child of the Audio tab) can switch to the Video tab and
  // open a specific track's detail view in one call.
  const activeTab = useVideoTabStore((s) => s.activeTab);
  const setActiveTab = useVideoTabStore((s) => s.setActiveTab);
  // Audio / Video: a roving-focus tab pair, the panel's first row.
  const onViewKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = activeTab === 'audio' ? 'video' : 'audio';
    setActiveTab(next);
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)
      ?.focus();
  };

  const viewButton = (view: 'audio' | 'video', label: string) => (
    <button
      type="button"
      className={styles.view}
      role="tab"
      data-view={view}
      aria-selected={activeTab === view}
      aria-controls="timeline-panel-view"
      tabIndex={activeTab === view ? 0 : -1}
      data-hint={`Show the ${label.toLowerCase()} arrangement`}
      onClick={() => setActiveTab(view)}
      onKeyDown={onViewKeyDown}
    >
      {label}
    </button>
  );

  return (
    <PanelFrame id="timeline">
      <div className={styles.body}>
        <div className={styles.viewRow}>
          <div className={styles.views} role="tablist" aria-label="Timeline view">
            {viewButton('audio', 'Audio')}
            {viewButton('video', 'Video')}
          </div>
        </div>
        <div className="timeline-panel-tab-content" id="timeline-panel-view" role="tabpanel">
          {activeTab === 'audio' ? (
            <TimelineView
              activeSampleId={activeSampleId}
              currentPatternIdByTrack={currentPatternIdByTrack}
              setCurrentPatternIdByTrack={setCurrentPatternIdByTrack}
              activeCenterTab={activeCenterTab ?? fallbackActiveCenterTab}
            />
          ) : (
            <VideoTab />
          )}
        </div>
      </div>
    </PanelFrame>
  );
}
