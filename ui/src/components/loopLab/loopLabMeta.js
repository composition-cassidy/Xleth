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

// Instrument is required only when class === 'Instrument'.
export function metaIsComplete(meta) {
  if (meta.className === 'Instrument') return String(meta.instrumentName || '').trim().length > 0;
  return true;
}
