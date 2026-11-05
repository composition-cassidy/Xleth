// Type-in parsing for kit controls: the inverse of format.ts.
//
// Accepts what a person types: true minus or hyphen, thin space or none, bare
// numbers, unit suffixes in any case ("-6 dB", "5k", "1.2 kHz", "250ms", "0.5 s",
// "70%", "4:1", "inf"). Returns null when the text is not a value, so the caller
// keeps the old value instead of guessing.

import type { Unit } from './format';

const NUM = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)`;

function normalise(text: string): string {
  return text
    .replace(/[−‒–—]/g, '-') // true minus, dashes
    .replace(/[   ]/g, ' ') // thin / no-break spaces
    .replace(/∞/g, 'inf')
    .trim()
    .toLowerCase();
}

function infinity(s: string): number | null {
  const m = /^([+-]?)\s*inf(?:inity)?$/.exec(s);
  if (!m) return null;
  return m[1] === '-' ? -Infinity : Infinity;
}

export function parseValue(text: string, unit: Unit): number | null {
  if (typeof text !== 'string') return null;
  const s = normalise(text);
  if (!s) return null;

  switch (unit) {
    case 'dB': {
      const inf = infinity(s.replace(/\s*db$/, ''));
      if (inf !== null) return inf === Infinity ? null : inf; // +inf dB is not a level
      const m = new RegExp(String.raw`^(${NUM})\s*(db)?$`).exec(s);
      return m ? Number(m[1]) : null;
    }
    case 'Hz': {
      const m = new RegExp(String.raw`^(${NUM})\s*(khz|hz|k)?$`).exec(s);
      if (!m) return null;
      const n = Number(m[1]);
      return m[2] === 'khz' || m[2] === 'k' ? n * 1000 : n;
    }
    case 'ms': {
      const m = new RegExp(String.raw`^(${NUM})\s*(ms|s|sec)?$`).exec(s);
      if (!m) return null;
      const n = Number(m[1]);
      return m[2] === 's' || m[2] === 'sec' ? n * 1000 : n;
    }
    case '%': {
      const m = new RegExp(String.raw`^(${NUM})\s*%?$`).exec(s);
      return m ? Number(m[1]) : null;
    }
    case 'ratio': {
      const inf = infinity(s.replace(/\s*:\s*1$/, ''));
      if (inf !== null) return inf;
      // "4", "4:1", "4 : 1", and "8:2" meaning 4.
      const m = new RegExp(String.raw`^(${NUM})\s*(?::\s*(${NUM}))?$`).exec(s);
      if (!m) return null;
      const num = Number(m[1]);
      if (m[2] === undefined) return num;
      const den = Number(m[2]);
      return den === 0 ? null : num / den;
    }
  }
}

// ── Tempo-synced values ─────────────────────────────────────────────────────
// A synced control's value is an INDEX into a list of division labels such as
// ['1/16', '1/8T', '1/8', '1/8D', '1/4']. The user types "1/8d", "1/8 dotted",
// "1/8t", "1/8 triplet" or "1/8." and gets the matching index.

export interface SyncDivision {
  numerator: number;
  denominator: number;
  modifier: '' | 'D' | 'T';
}

export function parseSyncDivision(text: string): SyncDivision | null {
  const s = normalise(text).replace(/\s+/g, '');
  const m = /^(\d+)\/(\d+)(d|dotted|\.|t|triplet|trip)?$/.exec(s);
  if (!m) return null;
  const numerator = Number(m[1]);
  const denominator = Number(m[2]);
  if (!numerator || !denominator) return null;
  const mod = m[3];
  const modifier = mod === undefined ? '' : mod === 't' || mod === 'triplet' || mod === 'trip' ? 'T' : 'D';
  return { numerator, denominator, modifier };
}

export function syncLabel(d: SyncDivision): string {
  return `${d.numerator}/${d.denominator}${d.modifier}`;
}

/** Length in quarter-note beats: 1/4 = 1, 1/8 = 0.5, 1/8D = 0.75, 1/8T = 1/3. */
export function syncBeats(d: SyncDivision): number {
  const base = (d.numerator / d.denominator) * 4;
  return d.modifier === 'D' ? base * 1.5 : d.modifier === 'T' ? (base * 2) / 3 : base;
}

export interface Codec {
  min: number;
  max: number;
  step: number;
  parse(text: string): number | null;
  format(value: number): string;
}

/** Index <-> label codec for a tempo-sync control (value = index into `labels`). */
export function syncCodec(labels: readonly string[]): Codec {
  const canonical = labels.map((l) => {
    const d = parseSyncDivision(l);
    return d ? syncLabel(d) : l;
  });
  return {
    min: 0,
    max: Math.max(0, labels.length - 1),
    step: 1,
    parse(text) {
      const d = parseSyncDivision(text);
      if (!d) return null;
      const i = canonical.indexOf(syncLabel(d));
      return i >= 0 ? i : null;
    },
    format(value) {
      const i = Math.round(value);
      return labels[Math.max(0, Math.min(labels.length - 1, i))] ?? '';
    },
  };
}
