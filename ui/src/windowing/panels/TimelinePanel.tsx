import React from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { useXlethRootContext } from '../contexts/XlethRootContext.jsx';
import TimelineView from '../../components/TimelineView.jsx';
import VideoTab from '../../components/timeline/VideoTab.jsx';
import usePianoRollStore from '../../stores/usePianoRollStore.js';
import useVideoTabStore from '../../stores/useVideoTabStore.js';
import { XlethButton } from '../../components/common/XlethButton.jsx';

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
  const stopTitlebarDrag = (event: React.MouseEvent<HTMLDivElement>) => {
    event.stopPropagation();
  };

  const titlebarTabs = (
    <div
      className="timeline-titlebar-tabs"
      role="tablist"
      aria-label="Timeline view"
      onMouseDown={stopTitlebarDrag}
      onDoubleClick={stopTitlebarDrag}
    >
      <XlethButton
        className={`timeline-titlebar-tab${activeTab === 'audio' ? ' active' : ''}`}
        active={activeTab === 'audio'}
        role="tab"
        aria-selected={activeTab === 'audio'}
        onClick={() => setActiveTab('audio')}
        title="Audio"
        aria-label="Audio tab"
      >
        <span>Audio</span>
      </XlethButton>
      <XlethButton
        className={`timeline-titlebar-tab${activeTab === 'video' ? ' active' : ''}`}
        active={activeTab === 'video'}
        role="tab"
        aria-selected={activeTab === 'video'}
        onClick={() => setActiveTab('video')}
        title="Video"
        aria-label="Video tab"
      >
        <span>Video</span>
      </XlethButton>
    </div>
  );

  return (
    <PanelFrame id="timeline" titlebarContent={titlebarTabs}>
      <div className="timeline-panel-tab-content">
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
    </PanelFrame>
  );
}
