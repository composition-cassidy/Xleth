import React, { useEffect, useState } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import SyllableSplitter from '../../components/SyllableSplitter/SyllableSplitter.jsx';
import { usePanelProps } from '../registry/usePanelValue';
import { timelineEvents } from '../../timelineEvents.js';

declare const window: Window & {
  xleth?: {
    timeline?: {
      getSources?: () => Promise<Array<{ id: unknown; filePath?: string }>>;
      setSyllables?: (regionId: unknown, syllables: unknown[]) => Promise<unknown>;
    };
    waveform?: {
      getRegionPeaks?: (
        regionId: unknown, start: number, end: number, cols: number, ch: number,
      ) => Promise<{ peaks?: number[] } | null>;
      getFilePeaks?: (
        filePath: string, start: number, end: number, cols: number, ch: number,
      ) => Promise<{ peaks?: number[] } | null>;
    };
  };
};

interface SplitRegion {
  id?: unknown;
  name?: string;
  sourceId?: unknown;
  startTime?: number;
  endTime?: number;
  audioFilePath?: string;
  hasSwappedAudio?: boolean;
  swappedAudioPath?: string;
}

interface SplitSyllablesPanelProps {
  region?: SplitRegion | null;
  sourceFilePath?: string | null;
  sourceWaveform?: RegionWaveform | null;
}

interface RegionWaveform {
  peaks: number[];
  duration: number;
  stride: number;
}

// Body lives below PanelFrame so keepAliveWhenHidden keeps it (and the
// SyllableSplitter's marker state / module-level peak cache) mounted across
// close/reopen. Mirrors what the old SyllableSplitterModal did: the context
// menu only hands us a region, so we resolve the source file path + a fallback
// region waveform here before handing them to the splitter.
function SplitSyllablesPanelBody() {
  // Handed over by whoever opened the panel:
  //   openPanel('splitSyllables', { region, sourceFilePath, sourceWaveform })
  // sourceFilePath / sourceWaveform are optional — the context-menu entry point
  // only knows the region, so the panel resolves the rest from region.sourceId.
  const props = usePanelProps<SplitSyllablesPanelProps>('splitSyllables');
  const region = (props?.region ?? null) as SplitRegion | null;
  const providedFilePath = (props?.sourceFilePath ?? null) as string | null;
  const providedSourceWaveform = props?.sourceWaveform ?? null;

  const [sourceFilePath, setSourceFilePath] = useState<string | null>(providedFilePath ?? null);
  const [regionWaveform, setRegionWaveform] = useState<RegionWaveform | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!region) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRegionWaveform(null);
    setSourceFilePath(providedFilePath ?? null);

    (async () => {
      try {
        // Swap-aware: once a region's audio has been SWAP-IN'd, that's the file
        // that actually plays — resolve it first regardless of what the caller
        // passed, same priority order as sandboxStore.addSourceFromRegion.
        const swapped = !!(region.hasSwappedAudio && region.swappedAudioPath);

        // Resolve the source media path: prefer the swap, then what the caller
        // handed us, else look it up from the region's sourceId.
        let filePath: string | null = swapped
          ? (region.swappedAudioPath as string)
          : (providedFilePath ?? region.audioFilePath ?? null);
        if (!filePath && region.sourceId != null) {
          const sources = (await window.xleth?.timeline?.getSources?.()) ?? [];
          const src = sources.find((s) => s.id === region.sourceId);
          filePath = src?.filePath ?? null;
        }
        if (cancelled) return;
        setSourceFilePath(filePath);

        // When the caller already supplied a source waveform, the splitter
        // slices it itself — no need to fetch region peaks here.
        if (providedSourceWaveform) {
          setLoading(false);
          return;
        }

        const start = region.startTime ?? 0;
        const end = region.endTime ?? 0;
        const durSec = end - start;
        // getRegionPeaks reads the region's MAPPED sample, which is always a
        // zero-based sub-clip buffer (swapped or not) — never region.startTime.
        let raw = region.id != null
          ? await window.xleth?.waveform?.getRegionPeaks?.(region.id, 0, durSec, 1200, -1)
          : null;
        if ((!raw || !raw.peaks?.length) && filePath) {
          // getFilePeaks reads the file directly: the swap file's own timeline
          // starts at 0, while the original source file needs the absolute
          // region offset.
          const fileStart = swapped ? 0 : start;
          const fileEnd = swapped ? durSec : end;
          raw = await window.xleth?.waveform?.getFilePeaks?.(filePath, fileStart, fileEnd, 1200, -1);
        }
        if (cancelled) return;
        if (raw && raw.peaks && raw.peaks.length > 0) {
          setRegionWaveform({ peaks: raw.peaks, duration: durSec, stride: 3 });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error)?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [region, providedFilePath, providedSourceWaveform]);

  const handleSave = async (syllables: unknown[]) => {
    if (region?.id == null) return;
    try {
      await window.xleth?.timeline?.setSyllables?.(region.id, syllables);
      timelineEvents.dispatchEvent(new Event('timeline-regions-changed'));
      usePanelRegistry.getState().closePanel('splitSyllables');
    } catch (e) {
      console.error('[SplitSyllablesPanel] setSyllables failed:', e);
      setError((e as Error)?.message || String(e));
    }
  };

  if (!region) {
    return (
      <div
        style={{
          flex: '1 1 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--theme-text-muted)',
          fontSize: 12,
        }}
      >
        No sample selected
      </div>
    );
  }

  return (
    <div
      className="syllable-splitter-modal-body"
      style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'auto' }}
    >
      {loading && <div className="syllable-splitter-loading">Loading waveform…</div>}
      {error && <div className="syllable-splitter-error">{error}</div>}
      {!loading && !error && (
        <SyllableSplitter
          region={region}
          sourceFilePath={sourceFilePath}
          regionWaveform={regionWaveform}
          sourceWaveform={providedSourceWaveform}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

export default function SplitSyllablesPanel() {
  return (
    <PanelFrame id="splitSyllables">
      <SplitSyllablesPanelBody />
    </PanelFrame>
  );
}
