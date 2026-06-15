import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { parseNotation } from '../../renderer/utils/notationParser.js';
import useGhostClipStore from '../../stores/ghostClipStore.js';
import useQuickNotationStore from '../../stores/quickNotationStore.js';
import useTimelineFocusStore from '../../stores/timelineFocusStore.js';
import { editCursor } from '../../services/EditCursor.js';
import { PPQ, BEATS_PER_BAR } from '../../constants/timeline.js';
import { timelineEvents } from '../../timelineEvents.js';

const TICKS_PER_16TH = 240;

declare const window: Window & {
  xleth?: {
    timeline?: {
      addClipsBatch?: (clips: unknown[]) => Promise<number[]>;
    };
  };
};

function QuickNotationContent({ onClose }: { onClose: () => void }) {
  const regionId = useQuickNotationStore((s) => s.regionId);
  const regionName = useQuickNotationStore((s) => s.regionName);
  const syllableCount = useQuickNotationStore((s) => s.syllableCount);
  const regionDurationTicks = useQuickNotationStore((s) => s.regionDurationTicks);

  const setGhostClips = useGhostClipStore((s) => s.setGhostClips);
  const clearGhostClips = useGhostClipStore((s) => s.clearGhostClips);
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId);

  const [notation, setNotation] = useState('');
  const [offsetPercent, setOffsetPercent] = useState(50);
  const [previewOn, setPreviewOn] = useState(true);
  const [parseResult, setParseResult] = useState<{
    placements: Array<{ syllableIndex: number; startTick: number; audioOffsetPercent: number }>;
    errors: Array<{ char: string; position: number; reason: string }>;
    totalTicks: number;
  }>({ placements: [], errors: [], totalTicks: 0 });

  const clearGhostClipsRef = useRef(clearGhostClips);
  clearGhostClipsRef.current = clearGhostClips;

  // Reparse and update ghost preview whenever notation/offset/syllableCount changes
  useEffect(() => {
    if (!notation.trim()) {
      setParseResult({ placements: [], errors: [], totalTicks: 0 });
      clearGhostClipsRef.current();
      return;
    }
    const result = parseNotation(notation, syllableCount, 0, offsetPercent);
    setParseResult(result);
    if (previewOn && result.placements.length > 0) {
      const cursorTick = Math.round(editCursor.getPosition() * PPQ);
      setGhostClips(result.placements.map((p) => ({
        ...p,
        startTick: p.startTick + cursorTick,
      })));
    } else {
      clearGhostClipsRef.current();
    }
  }, [notation, offsetPercent, syllableCount, previewOn, setGhostClips]);

  // Clear ghosts on unmount
  useEffect(() => {
    return () => { clearGhostClipsRef.current(); };
  }, []);

  const handleInsert = useCallback(() => {
    if (regionId == null || focusedTrackId == null || parseResult.placements.length === 0) return;
    const cursorTick = Math.round(editCursor.getPosition() * PPQ);
    const clips = parseResult.placements.map((p) => ({
      trackId: focusedTrackId,
      regionId,
      positionTicks: p.startTick + cursorTick,
      durationTicks: TICKS_PER_16TH,
      regionOffsetTicks: Math.round(p.audioOffsetPercent * regionDurationTicks / 100),
      syllableIndex: p.syllableIndex,
    }));

    void window.xleth?.timeline?.addClipsBatch?.(clips).then(() => {
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'));
      clearGhostClipsRef.current();
      onClose();
    });
  }, [regionId, focusedTrackId, parseResult, regionDurationTicks, onClose]);

  const handleClear = () => {
    setNotation('');
    clearGhostClipsRef.current();
  };

  const { placements, errors, totalTicks } = parseResult;
  const beats = totalTicks / PPQ;
  const bars = Math.floor(beats / BEATS_PER_BAR);
  const remBeats = Math.round((beats % BEATS_PER_BAR) * 100) / 100;
  const feedbackText = !notation.trim()
    ? 'Enter notation above'
    : `${placements.length} clip${placements.length !== 1 ? 's' : ''} · ${bars} bar${bars !== 1 ? 's' : ''} ${remBeats} beat${remBeats !== 1 ? 's' : ''}${errors.length > 0 ? ` · ${errors.length} error${errors.length !== 1 ? 's' : ''}` : ''}`;
  const errorTitle = errors.length > 0
    ? errors.map((e) => `'${e.char}': ${e.reason}`).join('; ')
    : undefined;

  const canInsert = regionId != null && focusedTrackId != null && placements.length > 0;

  return (
    <div className="qn-panel">
      <div className="qn-panel__header">
        <span className="qn-panel__title">{regionName || 'Quick Notation'}</span>
        {syllableCount > 0 && (
          <span className="qn-panel__syllables">
            {syllableCount} syllable{syllableCount !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <textarea
        className="qn-panel__notation"
        value={notation}
        onChange={(e) => setNotation(e.target.value)}
        placeholder="e.g. 11_11_111_1_1_11"
        spellCheck={false}
        autoComplete="off"
      />

      <div
        className={`qn-panel__feedback${errors.length > 0 ? ' qn-panel__feedback--error' : ''}`}
        title={errorTitle}
      >
        {feedbackText}
      </div>

      <div className="qn-panel__controls">
        <label className="qn-panel__label">32nd offset</label>
        <input
          type="range"
          className="qn-panel__slider"
          min={0}
          max={100}
          step={1}
          value={offsetPercent}
          onChange={(e) => setOffsetPercent(Number(e.target.value))}
        />
        <span className="qn-panel__slider-val">{offsetPercent}%</span>
      </div>

      <div className="qn-panel__controls">
        <label className="qn-panel__check-label">
          <input
            type="checkbox"
            checked={previewOn}
            onChange={(e) => setPreviewOn(e.target.checked)}
          />
          Preview
        </label>
      </div>

      <div className="qn-panel__actions">
        <button
          className="qn-panel__btn qn-panel__btn--clear"
          onClick={handleClear}
        >
          CLEAR
        </button>
        <button
          className="qn-panel__btn qn-panel__btn--insert"
          onClick={handleInsert}
          disabled={!canInsert}
        >
          INSERT
        </button>
      </div>
    </div>
  );
}

export default function QuickNotationPanel() {
  const handleClose = () => {
    usePanelRegistry.getState().closePanel('quickNotation');
  };

  return (
    <PanelFrame id="quickNotation">
      <QuickNotationContent onClose={handleClose} />
    </PanelFrame>
  );
}
