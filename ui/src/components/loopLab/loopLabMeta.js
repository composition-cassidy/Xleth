// Loop Lab — metadata vocabulary, behavior-family derivation, auto-naming, and
// sticky-metadata persistence. Pure helpers (no React, no engine calls) so they
// are trivially unit-testable and reusable by the export path.

export const LOOP_LAB_CLASSES = ['Hard-tuned vocal', 'Natural vocal', 'Instrument'];

export const BEHAVIOR_FAMILIES = ['stable_periodic', 'vibrato_sustained', 'decaying_struck'];

// Instrument name (lowercased) → behavior family. Names not listed fall back to
// stable_periodic (a safe, common default) but the user can override per sample.
const INSTRUMENT_FAMILY = {
  flute: 'stable_periodic',
  organ: 'stable_periodic',
  synth: 'stable_periodic',
  violin: 'vibrato_sustained',
  viola: 'vibrato_sustained',
  cello: 'vibrato_sustained',
  sax: 'vibrato_sustained',
  trumpet: 'vibrato_sustained',
  brass: 'vibrato_sustained',
  piano: 'decaying_struck',
  guitar: 'decaying_struck',
  mallets: 'decaying_struck',
};

// Derive the default behavior family from class + instrument. Callers apply this
// as the DEFAULT; a per-sample dropdown override always wins over this.
export function deriveBehaviorFamily(className, instrumentName) {
  if (className === 'Hard-tuned vocal') return 'stable_periodic';
  if (className === 'Natural vocal') return 'vibrato_sustained';
  if (className === 'Instrument') {
    const key = String(instrumentName || '').trim().toLowerCase();
    return INSTRUMENT_FAMILY[key] || 'stable_periodic';
  }
  return 'stable_periodic';
}

// lower_snake_case slug for a free-text token, safe for filenames and ids.
export function slug(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function zeroPad(n, width) {
  const s = String(Math.max(0, Math.floor(n)));
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

// Auto-generate a sample name from sticky metadata + a zero-padded index.
// Instrument class uses the instrument name as the leading token; vocal classes
// use the class slug. The source (episode/reference) is included when present.
// e.g. { class:'Hard-tuned vocal', source:'ep12' }, index 7 → hard_tuned_vocal_ep12_0007
export function autoName(meta, index) {
  const parts = [];
  if (meta.className === 'Instrument' && meta.instrumentName) parts.push(slug(meta.instrumentName));
  else parts.push(slug(meta.className) || 'sample');
  const srcSlug = slug(meta.source);
  if (srcSlug) parts.push(srcSlug);
  return `${parts.join('_')}_${zeroPad(index, 4)}`;
}

// ── Sticky metadata persistence (survives app restarts via localStorage) ──────
const STICKY_KEY = 'xleth.loopLab.stickyMeta.v1';

export const DEFAULT_STICKY_META = {
  className: 'Hard-tuned vocal',
  instrumentName: '',
  source: '',
};

export function loadStickyMeta() {
  try {
    const raw = localStorage.getItem(STICKY_KEY);
    if (!raw) return { ...DEFAULT_STICKY_META };
    const parsed = JSON.parse(raw);
    return {
      className: LOOP_LAB_CLASSES.includes(parsed.className) ? parsed.className : DEFAULT_STICKY_META.className,
      instrumentName: typeof parsed.instrumentName === 'string' ? parsed.instrumentName : '',
      source: typeof parsed.source === 'string' ? parsed.source : '',
    };
  } catch {
    return { ...DEFAULT_STICKY_META };
  }
}

export function saveStickyMeta(meta) {
  try {
    localStorage.setItem(STICKY_KEY, JSON.stringify({
      className: meta.className,
      instrumentName: meta.instrumentName || '',
      source: meta.source || '',
    }));
  } catch { /* localStorage unavailable — sticky meta simply won't persist */ }
}

// Mirrors the engine's per-voice crossfade clamp (engine/src/audio/Sampler.cpp:
// 898-909) so the panel's canonical xfade can never exceed what the engine
// actually plays. Loop Lab never sets a sample trim, so the engine's trim
// defaults are in force: smpStart_=0 and the trim end is the full buffer
// (numSamples) — the two terms below are those defaults folded in. Sibling
// implementation: electron-main/loopLabExport.js effectiveCrossfade (used at
// export time); duplicated rather than shared because this module is ESM
// (renderer bundle) and that one is CommonJS (electron main). `numSamples` is
// the ENGINE-domain buffer length; when absent, the buffer-bound term is
// skipped (the half-loop-length term below still applies and is the one that
// binds in practice).
export function clampCrossfade(loopStart, loopEnd, xfade, numSamples) {
  const start = Math.max(0, Number(loopStart) || 0)
  const end = Math.max(start, Number(loopEnd) || 0)
  let eff = Math.max(0, Math.round(Number(xfade) || 0))
  eff = Math.min(eff, Math.floor((end - start) / 2))
  eff = Math.min(eff, end) // effLoopEnd - smpStart_ (smpStart_ is always 0 here)
  if (Number(numSamples) > 0) eff = Math.min(eff, Number(numSamples) - start) // clampedEnd - loopStart
  return Math.max(0, eff)
}

// Convert a FILE-domain loop ({ start, end, xfade }) into the ENGINE-buffer
// domain the sampler indexes. The exact inverse of `convertGold` in
// electron-main/loopLabExport.js, which the Loop Lab export path uses to write
// dataset.json (and therefore candidates.json) in file-domain samples: that
// multiplies by fileRate/engineRate, so this multiplies by engineRate/fileRate,
// and both round. A loop authored here, exported, analysed and read back makes
// one round trip through the pair — worth at most a sample either way at
// 44.1k -> 48k. The two live in different modules because that one is CommonJS
// (electron main) and this is ESM (renderer bundle); they are inverses of each
// other and must be changed together.
//
// `end` is clamped into the buffer; `xfade` deliberately is NOT clamped here.
// The engine applies its own crossfade clamp (see clampCrossfade above) and the
// analysis that produced these numbers measured the REQUESTED width against
// that same clamp — pre-clamping would hand the engine a different request than
// the one that was measured.
export function fileToEngineLoop(loop, fileSampleRate, engineSampleRate, numSamples) {
  const fileRate = Number(fileSampleRate) > 0 ? Number(fileSampleRate) : 0
  const engRate = Number(engineSampleRate) > 0 ? Number(engineSampleRate) : 0
  const ratio = fileRate > 0 && engRate > 0 ? engRate / fileRate : 1
  const n = Number(numSamples) > 0 ? Number(numSamples) : Infinity
  const conv = (v) => Math.max(0, Math.min(n, Math.round((Number(v) || 0) * ratio)))
  return {
    loopStart: conv(loop && loop.start),
    loopEnd: conv(loop && loop.end),
    xfade: Math.max(0, Math.round(((loop && Number(loop.xfade)) || 0) * ratio)),
  }
}

// Derive the dataset `sample_id` a Loop Lab sample name would export as.
// Mirrors the id derivation in electron-main/loopLabExport.js buildDataset
// (sanitizeSegment -> lowercase -> non-alphanumerics to underscore), minus its
// uniquifying suffix, which only exists to break collisions within one export.
// Used to line a loaded candidates.json back up with the working set.
export function sampleIdFromName(name) {
  const seg = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '') || 'unnamed'
  return seg.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sample'
}

// Instrument is required only when class === 'Instrument'.
export function metaIsComplete(meta) {
  if (meta.className === 'Instrument') return String(meta.instrumentName || '').trim().length > 0;
  return true;
}
