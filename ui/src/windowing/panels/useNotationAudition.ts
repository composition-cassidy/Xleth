import { useCallback, useEffect, useRef, useState } from 'react';

declare const window: Window & {
  xleth?: {
    timeline?: {
      getSources?: () => Promise<Array<{ id: unknown; filePath?: string }>>;
    };
    audio?: {
      loadSource?: (filePath: string) => Promise<{ success?: boolean } | undefined>;
      playRegionPreview?: (start: number, end: number) => Promise<{ started?: boolean } | undefined>;
      pauseSource?: () => Promise<unknown>;
    };
  };
};

export interface AuditionRegion {
  sourceId?: unknown;
  startTime?: number;
  audioFilePath?: string;
  hasSwappedAudio?: boolean;
  swappedAudioPath?: string;
}

/** One note of an audition: fire `start`..`end` (seconds into the loaded source) `atMs` after the run begins. */
export interface AuditionEvent {
  atMs: number;
  start: number;
  end: number;
}

/**
 * Source-file seconds where a region's own timeline begins. A SWAP-IN'd region
 * plays its swap file, whose timeline starts at 0; otherwise the region sits at
 * `startTime` inside the original source.
 */
export function auditionBase(region: AuditionRegion | null): number {
  if (!region) return 0;
  const swapped = !!(region.hasSwappedAudio && region.swappedAudioPath);
  return swapped ? 0 : (region.startTime ?? 0);
}

/**
 * Audition for Quick Notation: plays slices of the region's source audio through
 * the engine's source player (the same path the Syllable Splitter uses), either a
 * single slice or a timed sequence. The sequence is scheduled from the renderer
 * against one clock, so it is an audition of the rhythm and the offsets, not a
 * sample-accurate render: the clips you insert are exact.
 */
export function useNotationAudition(region: AuditionRegion | null) {
  const [ready, setReady] = useState(false);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runRef = useRef(0);

  const swappedPath = region?.hasSwappedAudio ? region?.swappedAudioPath ?? null : null;
  const sourceId = region?.sourceId;
  const audioFilePath = region?.audioFilePath ?? null;

  const stop = useCallback(() => {
    runRef.current += 1;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void window.xleth?.audio?.pauseSource?.()?.catch?.(() => {});
    setPlayingKey(null);
  }, []);

  // Resolve and load the source file; swap-aware, same priority as the splitter.
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    if (!region) return undefined;
    (async () => {
      try {
        let filePath: string | null = swappedPath ?? audioFilePath;
        if (!filePath && sourceId != null) {
          const sources = (await window.xleth?.timeline?.getSources?.()) ?? [];
          filePath = sources.find((src) => src.id === sourceId)?.filePath ?? null;
        }
        if (!filePath || cancelled) return;
        const result = await window.xleth?.audio?.loadSource?.(filePath);
        if (!cancelled) setReady(result?.success === true);
      } catch (e) {
        if (!cancelled) setReady(false);
        console.warn('[QuickNotation] audition source load failed:', (e as Error)?.message);
      }
    })();
    return () => { cancelled = true; };
  }, [swappedPath, sourceId, audioFilePath]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    runRef.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    void window.xleth?.audio?.pauseSource?.()?.catch?.(() => {});
  }, []);

  /** Play `events` (sorted by atMs) and call it done `totalMs` after the start. */
  const play = useCallback((key: string, events: AuditionEvent[], totalMs: number) => {
    if (!ready || events.length === 0) return;
    runRef.current += 1;
    const run = runRef.current;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setPlayingKey(key);

    const t0 = performance.now();
    const fire = (index: number) => {
      if (runRef.current !== run) return;
      const ev = events[index];
      void window.xleth?.audio?.playRegionPreview?.(ev.start, ev.end)?.catch?.(() => {});
      const next = events[index + 1];
      if (next) {
        // Aim at the absolute target, so one late timer does not shift the rest.
        const wait = Math.max(0, t0 + next.atMs - performance.now());
        timerRef.current = setTimeout(() => fire(index + 1), wait);
      } else {
        const wait = Math.max(0, t0 + totalMs - performance.now());
        timerRef.current = setTimeout(() => {
          if (runRef.current !== run) return;
          timerRef.current = null;
          setPlayingKey(null);
        }, wait);
      }
    };
    const firstWait = Math.max(0, events[0].atMs);
    timerRef.current = setTimeout(() => fire(0), firstWait);
  }, [ready]);

  return { ready, playingKey, play, stop };
}
