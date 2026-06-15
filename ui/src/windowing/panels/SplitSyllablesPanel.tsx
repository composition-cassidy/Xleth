import React, { useEffect, useState } from 'react';
import { PanelFrame } from '../components/PanelFrame';
import { usePanelRegistry } from '../registry/PanelRegistry';
import SyllableSplitter from '../../components/SyllableSplitter/SyllableSplitter.jsx';
import useSplitSyllablesPanelStore from '../../stores/splitSyllablesPanelStore.js';
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
  const region = useSplitSyllablesPanelStore((s) => s.region) as SplitRegion | null;
  const providedFilePath = useSplitSyllablesPanelStore((s) => s.sourceFilePath) as string | null;
  const providedSourceWaveform = useSplitSyllablesPanelStore((s) => s.sourceWaveform);

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
        // Resolve the source media path: prefer what the caller handed us,
        // else look it up from the region's sourceId.
        let filePath: string | null = providedFilePath ?? region.audioFilePath ?? null;
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
        let raw = region.id != null
          ? await window.xleth?.waveform?.getRegionPeaks?.(region.id, start, end, 1200, -1)
          : null;
        if ((!raw || !raw.peaks?.length) && filePath) {
          raw = await window.xleth?.waveform?.getFilePeaks?.(filePath, start, end, 1200, -1);
        }
        if (cancelled) return;
        if (raw && raw.peaks && raw.peaks.length > 0) {
          setRegionWaveform({ peaks: raw.peaks, duration: end - start, stride: 3 });
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
