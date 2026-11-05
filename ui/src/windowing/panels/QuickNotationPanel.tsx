import React, { useState, useEffect, useCallback, useRef } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import { parseNotation } from '../../renderer/utils/notationParser.js';
import { parseChordNotation } from '../../renderer/utils/chordNotationParser';
import useGhostClipStore from '../../stores/ghostClipStore.js';
import useQuickNotationStore from '../../stores/quickNotationStore.js';
import useTimelineFocusStore from '../../stores/timelineFocusStore.js';
import { editCursor } from '../../services/EditCursor.js';
import { PPQ } from '../../constants/timeline.js';
import { timelineEvents } from '../../timelineEvents.js';

declare const window: Window & {
  xleth?: {
    timeline?: {
      addClipsBatch?: (clips: unknown[]) => Promise<number[]>;
      addNotesBatch?: (patternId: number, notes: unknown[]) => Promise<number[]>;
    };
  };
};

type SamplePlacement = { syllableIndex: number; startTick: number; lengthTicks: number; audioOffsetPercent: number };
type ChordPlacement = { pitch: number; startTick: number; lengthTicks: number };

function QuickNotationContent({ onClose }: { onClose: () => void }) {
  const mode = useQuickNotationStore((s) => s.mode);
  const regionId = useQuickNotationStore((s) => s.regionId);
  const syllableCount = useQuickNotationStore((s) => s.syllableCount);
  const regionDurationTicks = useQuickNotationStore((s) => s.regionDurationTicks);
  const patternId = useQuickNotationStore((s) => s.patternId);
  const cursorTick = useQuickNotationStore((s) => s.cursorTick);
  const clearQuickNotationContext = useQuickNotationStore((s) => s.clearContext);
  const setGhostClips = useGhostClipStore((s) => s.setGhostClips);
  const clearGhostClips = useGhostClipStore((s) => s.clearGhostClips);
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId);
  const isChordMode = mode === 'chord';

  const [notation, setNotation] = useState('');
  const [offsetPercent, setOffsetPercent] = useState(50);
  const [previewOn, setPreviewOn] = useState(true);
  const [symbolKeyOpen, setSymbolKeyOpen] = useState(false);
  const [parseResult, setParseResult] = useState<{
    placements: Array<SamplePlacement | ChordPlacement>;
    errors: Array<{ token?: string; char?: string; position: number; reason: string }>;
    totalTicks: number;
  }>({ placements: [], errors: [], totalTicks: 0 });

  const clearGhostClipsRef = useRef(clearGhostClips);
  const notationRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const symbolKeyRef = useRef<HTMLDivElement>(null);
  clearGhostClipsRef.current = clearGhostClips;

  useEffect(() => {
    const closeSymbolKey = (event: PointerEvent) => {
      if (!symbolKeyRef.current?.contains(event.target as Node)) setSymbolKeyOpen(false);
    };
    document.addEventListener('pointerdown', closeSymbolKey);
    return () => document.removeEventListener('pointerdown', closeSymbolKey);
  }, []);

  useEffect(() => {
    if (!notation.trim()) {
      setParseResult({ placements: [], errors: [], totalTicks: 0 });
      clearGhostClipsRef.current();
      return;
    }

    if (isChordMode) {
      const result = parseChordNotation(notation, cursorTick);
      setParseResult(result);
      // No ghost-note preview on the piano roll grid yet — chord mode never
      // touches the timeline's (clip-shaped) ghost overlay.
      clearGhostClipsRef.current();
      return;
    }

    const result = parseNotation(notation, syllableCount, 0, offsetPercent);
    setParseResult(result);
    if (previewOn && result.placements.length > 0) {
      const sampleCursorTick = Math.round(editCursor.getPosition() * PPQ);
      setGhostClips(result.placements.map((placement) => ({
        ...placement,
        startTick: placement.startTick + sampleCursorTick,
      })));
    } else {
      clearGhostClipsRef.current();
    }
  }, [notation, offsetPercent, syllableCount, previewOn, setGhostClips, isChordMode, cursorTick]);

  useEffect(() => () => { clearGhostClipsRef.current(); }, []);

  const handleInsertChord = useCallback(() => {
    if (patternId == null || parseResult.placements.length === 0) return;
    const notes = (parseResult.placements as ChordPlacement[]).map((placement) => ({
      positionTicks: placement.startTick,
      durationTicks: placement.lengthTicks,
      pitch: placement.pitch,
      velocity: 1.0,
    }));

    void window.xleth?.timeline?.addNotesBatch?.(patternId, notes).then(() => {
      timelineEvents.dispatchEvent(new CustomEvent('timeline-pattern-changed', { detail: { patternId } }));
      timelineEvents.dispatchEvent(new Event('timeline-patterns-changed'));
      clearQuickNotationContext();
      onClose();
    });
  }, [patternId, parseResult, clearQuickNotationContext, onClose]);

  const handleInsertSample = useCallback(() => {
    if (regionId == null || focusedTrackId == null || parseResult.placements.length === 0) return;
    const sampleCursorTick = Math.round(editCursor.getPosition() * PPQ);
    const clips = (parseResult.placements as SamplePlacement[]).map((placement) => ({
      trackId: focusedTrackId,
      regionId,
      positionTicks: placement.startTick + sampleCursorTick,
      durationTicks: placement.lengthTicks,
      regionOffsetTicks: Math.round(placement.audioOffsetPercent * regionDurationTicks / 100),
      syllableIndex: placement.syllableIndex,
    }));

    void window.xleth?.timeline?.addClipsBatch?.(clips).then(() => {
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'));
      clearGhostClipsRef.current();
      onClose();
    });
  }, [regionId, focusedTrackId, parseResult, regionDurationTicks, onClose]);

  const handleInsert = isChordMode ? handleInsertChord : handleInsertSample;

  const handleClear = () => {
    setNotation('');
    clearGhostClipsRef.current();
  };

  const insertSymbol = (symbol: string) => {
    const input = notationRef.current;
    const start = input?.selectionStart ?? notation.length;
    const end = input?.selectionEnd ?? start;
    setNotation(`${notation.slice(0, start)}${symbol}${notation.slice(end)}`);
    setSymbolKeyOpen(false);
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + symbol.length, start + symbol.length);
    });
  };

  const syncNotationScroll = () => {
    if (!notationRef.current || !highlightRef.current) return;
    highlightRef.current.scrollTop = notationRef.current.scrollTop;
    highlightRef.current.scrollLeft = notationRef.current.scrollLeft;
  };

  const canInsert = isChordMode
    ? patternId != null && parseResult.placements.length > 0
    : regionId != null && focusedTrackId != null && parseResult.placements.length > 0;

  return (
    <div className="qn-panel">
      <div className="qn-panel__symbol-key" ref={symbolKeyRef}>
        <button
          type="button"
          className={`qn-panel__symbol-trigger${symbolKeyOpen ? ' is-open' : ''}`}
          onClick={() => setSymbolKeyOpen((open) => !open)}
          aria-expanded={symbolKeyOpen}
        >
          <span>Symbol Key</span>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="6,9 12,15 18,9" />
          </svg>
        </button>
        {symbolKeyOpen && (
          <div className="qn-panel__symbol-popover">
            {isChordMode ? (
              <>
                <button type="button" onClick={() => insertSymbol('Cmaj7')}><b>Cmaj7</b><span><strong>Chord token</strong> - ROOT + quality (maj7, min, dim7, sus4...), stacked upward from C4.</span></button>
                <button type="button" onClick={() => insertSymbol('(b5)')}><b className="is-accent">(b5)</b><span><strong>Alteration</strong> - replaces or adds that scale degree, e.g. (#9) (#11) (b13).</span></button>
                <button type="button" onClick={() => insertSymbol('/E')}><b className="is-accent">/E</b><span><strong>Slash bass</strong> - rotates the voicing so that note is lowest.</span></button>
                <button type="button" onClick={() => insertSymbol('*')}><b className="is-accent">*</b><span><strong>Duration</strong> - each * doubles the length from a 16th note.</span></button>
                <div className="qn-panel__symbol-divider" />
                <button type="button" onClick={() => insertSymbol('CEGB')}><b>CEGB</b><span><strong>Literal notes</strong> - a letter sequence that isn't a chord places those exact notes.</span></button>
              </>
            ) : (
              <>
                <button type="button" onClick={() => insertSymbol('1')}><b>1</b><span><strong>Sample number</strong> - plays as a 16th note, the default step length.</span></button>
                <button type="button" onClick={() => insertSymbol("'")}><b className="is-accent">' #</b><span><strong>32nd note</strong> - half the default length. The symbols are interchangeable.</span></button>
                <button type="button" onClick={() => insertSymbol('*')}><b className="is-accent">*</b><span><strong>8th note</strong> - double the default length.</span></button>
                <button type="button" onClick={() => insertSymbol('x')}><b className="is-accent">x</b><span><strong>Repeated 32nd notes</strong> - a fast roll of the preceding sample.</span></button>
                <div className="qn-panel__symbol-divider" />
                <button type="button" onClick={() => insertSymbol('_')}><b className="is-rest">_</b><span><strong>16th-note rest</strong> - silence for one step and the standard separator.</span></button>
                <button type="button" onClick={() => insertSymbol('/')}><b className="is-rest">/</b><span><strong>32nd-note rest</strong> - a shorter silence.</span></button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="qn-panel__notation-wrap">
        <div className="qn-panel__notation-highlight" ref={highlightRef} aria-hidden="true">
          {[...notation].map((character, index) => {
            const className = character === '_' || character === '/'
              ? 'is-rest'
              : "'*#xX".includes(character) ? 'is-accent' : undefined;
            return <span className={className} key={index}>{character}</span>;
          })}
        </div>
        <textarea
          ref={notationRef}
          className="qn-panel__notation"
          value={notation}
          onChange={(event) => setNotation(event.target.value)}
          onScroll={syncNotationScroll}
          placeholder={isChordMode ? 'e.g. Dmin7*** D#maj7*** Cmin7*** D#maj7***' : 'e.g. 11_11_111_1_1_11'}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      {!isChordMode && (
        <div className="qn-panel__controls">
          <label className="qn-panel__label" htmlFor="qn-offset">32nd Offset</label>
          <div className="qn-panel__slider-wrap">
            {[0, 25, 50, 75, 100].map((tick) => <i key={tick} style={{ left: `${tick}%` }} />)}
            <input
              id="qn-offset"
              type="range"
              className="qn-panel__slider"
              min={0}
              max={100}
              step={1}
              value={offsetPercent}
              style={{ background: `linear-gradient(to right, var(--theme-accent) 0%, var(--theme-accent) ${offsetPercent}%, var(--theme-border-strong) ${offsetPercent}%, var(--theme-border-strong) 100%)` }}
              onChange={(event) => setOffsetPercent(Number(event.target.value))}
            />
          </div>
          <span className="qn-panel__slider-val">{offsetPercent}%</span>
        </div>
      )}

      {!isChordMode && (
      <div className="qn-panel__preview-row">
        <label className="qn-panel__check-label">
          <input type="checkbox" checked={previewOn} onChange={(event) => setPreviewOn(event.target.checked)} />
          <span className="qn-panel__check-box" aria-hidden="true">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="4,12 9,17 20,5" /></svg>
          </span>
          Preview
        </label>
      </div>
      )}

      <div className="qn-panel__actions">
        <button className="qn-panel__btn qn-panel__btn--clear" onClick={handleClear}>Clear</button>
        <button className="qn-panel__btn qn-panel__btn--insert" onClick={handleInsert} disabled={!canInsert}>Insert</button>
      </div>
    </div>
  );
}

export default function QuickNotationPanel() {
  const handleClose = () => usePanelRegistry.getState().closePanel('quickNotation');
  return <PanelFrame id="quickNotation"><QuickNotationContent onClose={handleClose} /></PanelFrame>;
}
