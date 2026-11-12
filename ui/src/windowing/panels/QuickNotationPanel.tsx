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
import { getTransportState } from '../../transportStore.js';
import { Button, Checkbox, NumberBox } from '../../ui-kit';
import { auditionBase, useNotationAudition, type AuditionEvent } from './useNotationAudition';
import styles from './QuickNotation.module.css';

declare const window: Window & {
  xleth?: {
    timeline?: {
      addClipsBatch?: (clips: unknown[]) => Promise<number[]>;
      addNotesBatch?: (patternId: number, notes: unknown[]) => Promise<number[]>;
      setSyllables?: (regionId: unknown, syllables: unknown[]) => Promise<unknown>;
    };
  };
};

type SamplePlacement = { syllableIndex: number; startTick: number; lengthTicks: number; audioOffsetPercent: number };
type ChordPlacement = { pitch: number; startTick: number; lengthTicks: number };
type QuickSyllable = { startTime: number; endTime: number; number?: number; text?: string; quickOffsetPercent?: number };

const DEFAULT_OFFSET_PERCENT = 50;
const SAVE_DEBOUNCE_MS = 400;
const offsetOf = (syllable: QuickSyllable | undefined) => syllable?.quickOffsetPercent ?? DEFAULT_OFFSET_PERCENT;

// The symbol key: what each symbol means, in the user's terms. Clicking one inserts it at the caret.
type LegendItem = { symbol: string; insert: string; title: string; text: string; tone?: 'accent' | 'rest' };

const SAMPLE_LEGEND: LegendItem[] = [
  { symbol: '1', insert: '1', title: 'Sample number.', text: 'Plays as a 16th note, the default step length.' },
  { symbol: "' #", insert: "'", title: '32nd note.', text: 'Half the default length. The two symbols are interchangeable.', tone: 'accent' },
  { symbol: '*', insert: '*', title: '8th note.', text: 'Double the default length.', tone: 'accent' },
  { symbol: 'x', insert: 'x', title: 'Repeated 32nd notes.', text: 'A fast roll of the preceding sample.', tone: 'accent' },
  { symbol: '_', insert: '_', title: '16th-note rest.', text: 'Silence for one step, and the standard separator.', tone: 'rest' },
  { symbol: '/', insert: '/', title: '32nd-note rest.', text: 'A shorter silence.', tone: 'rest' },
];

const CHORD_LEGEND: LegendItem[] = [
  { symbol: 'Cmaj7', insert: 'Cmaj7', title: 'Chord token.', text: 'Root plus quality (maj7, min, dim7, sus4…), stacked upward from C4.' },
  { symbol: '(b5)', insert: '(b5)', title: 'Alteration.', text: 'Replaces or adds that scale degree, for example (#9), (#11), (b13).', tone: 'accent' },
  { symbol: '/E', insert: '/E', title: 'Slash bass.', text: 'Rotates the voicing so that note is lowest.', tone: 'accent' },
  { symbol: '*', insert: '*', title: 'Duration.', text: 'Each * doubles the length from a 16th note.', tone: 'accent' },
  { symbol: 'CEGB', insert: 'CEGB', title: 'Literal notes.', text: 'A letter sequence that is not a chord places those exact notes.' },
];

function QuickNotationContent({ onClose }: { onClose: () => void }) {
  const mode = useQuickNotationStore((s) => s.mode);
  const regionId = useQuickNotationStore((s) => s.regionId);
  const syllableCount = useQuickNotationStore((s) => s.syllableCount);
  const regionDurationTicks = useQuickNotationStore((s) => s.regionDurationTicks);
  const patternId = useQuickNotationStore((s) => s.patternId);
  const cursorTick = useQuickNotationStore((s) => s.cursorTick);
  const region = useQuickNotationStore((s) => s.region);
  const syllables = useQuickNotationStore((s) => s.syllables) as QuickSyllable[];
  const setStoreSyllables = useQuickNotationStore((s) => s.setSyllables);
  const clearQuickNotationContext = useQuickNotationStore((s) => s.clearContext);
  const setGhostClips = useGhostClipStore((s) => s.setGhostClips);
  const clearGhostClips = useGhostClipStore((s) => s.clearGhostClips);
  const focusedTrackId = useTimelineFocusStore((s) => s.focusedTrackId);
  const isChordMode = mode === 'chord';

  const [notation, setNotation] = useState('');
  const [previewOn, setPreviewOn] = useState(true);
  const [parseResult, setParseResult] = useState<{
    placements: Array<SamplePlacement | ChordPlacement>;
    errors: Array<{ token?: string; char?: string; position: number; reason: string }>;
    totalTicks: number;
  }>({ placements: [], errors: [], totalTicks: 0 });

  const clearGhostClipsRef = useRef(clearGhostClips);
  const notationRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  clearGhostClipsRef.current = clearGhostClips;

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

    const result = parseNotation(notation, syllableCount, 0, (index: number) => offsetOf(syllables[index]));
    setParseResult(result);
    // The ghosts sit on the track the clips will be inserted on, nowhere else.
    if (previewOn && focusedTrackId != null && result.placements.length > 0) {
      const sampleCursorTick = Math.round(editCursor.getPosition() * PPQ);
      setGhostClips(result.placements.map((placement) => ({
        ...placement,
        startTick: placement.startTick + sampleCursorTick,
      })), focusedTrackId);
    } else {
      clearGhostClipsRef.current();
    }
  }, [notation, syllables, syllableCount, previewOn, focusedTrackId, setGhostClips, isChordMode, cursorTick]);

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
    const ticksPerSecond = (getTransportState().bpm / 60) * PPQ;
    const clips = (parseResult.placements as SamplePlacement[]).map((placement) => {
      // The offset is a share of THIS syllable, so it lands inside the syllable's own audio.
      const syllable = syllables[placement.syllableIndex];
      const syllableTicks = syllable ? (syllable.endTime - syllable.startTime) * ticksPerSecond : regionDurationTicks;
      return {
        trackId: focusedTrackId,
        regionId,
        positionTicks: placement.startTick + sampleCursorTick,
        durationTicks: placement.lengthTicks,
        regionOffsetTicks: Math.round(placement.audioOffsetPercent * syllableTicks / 100),
        syllableIndex: placement.syllableIndex,
      };
    });

    void window.xleth?.timeline?.addClipsBatch?.(clips).then(() => {
      timelineEvents.dispatchEvent(new Event('timeline-clips-changed'));
      clearGhostClipsRef.current();
      onClose();
    });
  }, [regionId, focusedTrackId, parseResult, regionDurationTicks, syllables, onClose]);

  const handleInsert = isChordMode ? handleInsertChord : handleInsertSample;

  // ── Audition ──────────────────────────────────────────────────────────────
  const audition = useNotationAudition(isChordMode ? null : region);

  const sourceSeconds = useCallback((syllableIndex: number, offsetPercent: number) => {
    const syllable = syllables[syllableIndex];
    if (!syllable) return null;
    const length = syllable.endTime - syllable.startTime;
    return { start: auditionBase(region) + syllable.startTime + (offsetPercent / 100) * length, length };
  }, [syllables, region]);

  const playNotation = () => {
    if (audition.playingKey === 'notation') { audition.stop(); return; }
    const secondsPerTick = 60 / (getTransportState().bpm * PPQ);
    const events: AuditionEvent[] = [];
    for (const placement of parseResult.placements as SamplePlacement[]) {
      const at = sourceSeconds(placement.syllableIndex, placement.audioOffsetPercent);
      if (!at) continue;
      events.push({
        atMs: placement.startTick * secondsPerTick * 1000,
        start: at.start,
        end: at.start + placement.lengthTicks * secondsPerTick,
      });
    }
    audition.play('notation', events, parseResult.totalTicks * secondsPerTick * 1000);
  };

  const playSyllable = (index: number, at32nd: boolean) => {
    const key = `${at32nd ? 'off' : 'full'}:${index}`;
    if (audition.playingKey === key) { audition.stop(); return; }
    const at = sourceSeconds(index, at32nd ? offsetOf(syllables[index]) : 0);
    if (!at) return;
    const length = at32nd ? 120 * (60 / (getTransportState().bpm * PPQ)) : at.length;
    audition.play(key, [{ atMs: 0, start: at.start, end: at.start + length }], length * 1000);
  };

  // 32nd offsets live on the syllables and are saved with the project: edit locally for an
  // instant result, then write the whole list back shortly after the last change.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ regionId: unknown; syllables: QuickSyllable[] } | null>(null);
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (!pending) return;
    void window.xleth?.timeline?.setSyllables?.(pending.regionId, pending.syllables).then(() => {
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'));
    });
  }, []);
  useEffect(() => flushSave, [flushSave]);

  const setSyllableOffset = (index: number, value: number) => {
    if (regionId == null) return;
    const next = syllables.map((syllable, i) => (i === index ? { ...syllable, quickOffsetPercent: value } : syllable));
    setStoreSyllables(next);
    pendingSaveRef.current = { regionId, syllables: next };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  };

  const handleClear = () => {
    setNotation('');
    clearGhostClipsRef.current();
  };

  const insertSymbol = (symbol: string) => {
    const input = notationRef.current;
    const start = input?.selectionStart ?? notation.length;
    const end = input?.selectionEnd ?? start;
    setNotation(`${notation.slice(0, start)}${symbol}${notation.slice(end)}`);
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

  const count = parseResult.placements.length;
  const canInsert = isChordMode
    ? patternId != null && count > 0
    : regionId != null && focusedTrackId != null && count > 0;
  const insertLabel = count === 0
    ? 'Insert'
    : isChordMode
      ? `Insert ${count} note${count === 1 ? '' : 's'}`
      : `Insert ${count} clip${count === 1 ? '' : 's'}`;
  const firstError = parseResult.errors[0];
  const legend = isChordMode ? CHORD_LEGEND : SAMPLE_LEGEND;

  return (
    <div className={styles.panel}>
      <div className={styles.notationWrap}>
        <div className={styles.highlight} ref={highlightRef} aria-hidden="true">
          {[...notation].map((character, index) => {
            const tone = character === '_' || character === '/'
              ? 'rest'
              : "'*#xX".includes(character) ? 'accent' : undefined;
            return <span data-tone={tone} key={index}>{character}</span>;
          })}
        </div>
        <textarea
          ref={notationRef}
          className={styles.notation}
          value={notation}
          aria-label={isChordMode ? 'Chord notation' : 'Sample notation'}
          onChange={(event) => setNotation(event.target.value)}
          onScroll={syncNotationScroll}
          placeholder={isChordMode ? 'e.g. Dmin7*** D#maj7*** Cmin7*** D#maj7***' : 'e.g. 11_11_111_1_1_11'}
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className={styles.status} role="status">
        {firstError
          ? `${firstError.reason}${firstError.token || firstError.char ? ` (“${firstError.token ?? firstError.char}” at ${firstError.position + 1})` : ''}`
          : count > 0
            ? `${count} ${isChordMode ? 'note' : 'clip'}${count === 1 ? '' : 's'} ready`
            : 'Type notation, or pick a symbol below.'}
      </div>

      {!isChordMode && (
        <>
          <div className={styles.controls}>
            <Button
              onClick={playNotation}
              disabled={!audition.ready || count === 0}
              hint={audition.ready ? 'Hear this notation without placing anything' : 'Loading the sample audio…'}
            >
              {audition.playingKey === 'notation' ? 'Stop' : 'Play'}
            </Button>
            <Checkbox checked={previewOn} onChange={setPreviewOn}>Show on the timeline</Checkbox>
            <span className={styles.target} data-missing={focusedTrackId == null ? '' : undefined}>
              {focusedTrackId == null
                ? 'Click a track to choose where the clips go.'
                : 'Clips go on the selected track, from the edit cursor.'}
            </span>
          </div>

          <section className={styles.syllables} aria-label="Syllables and 32nd offsets">
            <h3 className={styles.legendTitle}>Syllables</h3>
            <p className={styles.syllablesNote}>
              The 32nd offset is where inside each syllable its 32nd notes start. Each syllable keeps its own, saved with the project.
            </p>
            <ul className={styles.syllableList}>
              {syllables.map((syllable, index) => (
                <li className={styles.syllableRow} key={index}>
                  <span className={styles.syllableNumber}>{index + 1}</span>
                  <span className={styles.syllableText}>{syllable.text || ''}</span>
                  <NumberBox
                    label={`Syllable ${index + 1} 32nd offset`}
                    hideLabel
                    width={72}
                    min={0}
                    max={100}
                    step={1}
                    unit="%"
                    quantize={Math.round}
                    defaultValue={DEFAULT_OFFSET_PERCENT}
                    value={offsetOf(syllable)}
                    onChange={(value: number) => setSyllableOffset(index, value)}
                    hint="32nd offset"
                    hintMods="Where inside this syllable its 32nd notes start"
                  />
                  <Button
                    size="sm"
                    disabled={!audition.ready}
                    onClick={() => playSyllable(index, true)}
                    hint="Hear a 32nd note at this offset"
                  >
                    {audition.playingKey === `off:${index}` ? 'Stop' : '32nd'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!audition.ready}
                    onClick={() => playSyllable(index, false)}
                    hint="Hear the whole syllable"
                  >
                    {audition.playingKey === `full:${index}` ? 'Stop' : 'Whole'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <div className={styles.actions}>
        <Button onClick={handleClear}>Clear</Button>
        <Button variant="primary" onClick={handleInsert} disabled={!canInsert}>{insertLabel}</Button>
      </div>
      <section className={styles.legend} aria-label="Symbol key">
        <h3 className={styles.legendTitle}>Symbol key</h3>
        <ul className={styles.legendList}>
          {legend.map((item) => (
            <li key={item.insert}>
              <button type="button" className={styles.legendItem} onClick={() => insertSymbol(item.insert)}>
                <code className={styles.symbol} data-tone={item.tone}>{item.symbol}</code>
                <span className={styles.legendText}><strong>{item.title}</strong> {item.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

    </div>
  );
}

export default function QuickNotationPanel() {
  const handleClose = () => usePanelRegistry.getState().closePanel('quickNotation');
  return <PanelFrame id="quickNotation"><QuickNotationContent onClose={handleClose} /></PanelFrame>;
}
