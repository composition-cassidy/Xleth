// Tests for tokenValue() and useTokenValue().
//
// tokenValue() is a thin DOM wrapper — tests mock document + getComputedStyle
// on globalThis. The node vitest environment has neither by default.
// useTokenValue() structural contract verified via module shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tokenValue } from '../tokenValue';

// ── DOM stubs ─────────────────────────────────────────────────────────────────

type MockCSS = { getPropertyValue: (n: string) => string };

function stubDOM(props: Record<string, string>): { restore: () => void } {
  const cssObj: MockCSS = { getPropertyValue: (n) => props[n] ?? '' };
  const origDoc = (globalThis as Record<string, unknown>).document;
  const origGCS = (globalThis as Record<string, unknown>).getComputedStyle;
  (globalThis as Record<string, unknown>).document = { documentElement: {} };
  (globalThis as Record<string, unknown>).getComputedStyle = vi.fn().mockReturnValue(cssObj);
  return {
    restore() {
      (globalThis as Record<string, unknown>).document = origDoc;
      (globalThis as Record<string, unknown>).getComputedStyle = origGCS;
    },
  };
}

// ── tokenValue ────────────────────────────────────────────────────────────────

describe('tokenValue', () => {
  it('returns the trimmed CSS property value from :root', () => {
    const { restore } = stubDOM({ '--theme-accent': ' #33CED6 ' });
    try {
      expect(tokenValue('--theme-accent')).toBe('#33CED6');
    } finally {
      restore();
    }
  });

  it('returns empty string for unknown tokens', () => {
    const { restore } = stubDOM({});
    try {
      expect(tokenValue('--theme-does-not-exist')).toBe('');
    } finally {
      restore();
    }
  });

  it('returns empty string when document is undefined (SSR / node)', () => {
    // Do not stub document — relies on node environment having no document.
    const origDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = undefined;
    try {
      expect(tokenValue('--theme-accent')).toBe('');
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
    }
  });
});

// ── pure-pass-through contract ────────────────────────────────────────────────

describe('tokenValue — no internal caching', () => {
  it('reflects DOM changes between calls without needing a re-import', () => {
    let stored = '#33CED6';
    const cssObj: MockCSS = { getPropertyValue: (n) => n === '--theme-accent' ? stored : '' };
    const origDoc = (globalThis as Record<string, unknown>).document;
    const origGCS = (globalThis as Record<string, unknown>).getComputedStyle;
    (globalThis as Record<string, unknown>).document = { documentElement: {} };
    (globalThis as Record<string, unknown>).getComputedStyle = vi.fn().mockReturnValue(cssObj);

    try {
      expect(tokenValue('--theme-accent')).toBe('#33CED6');
      stored = '#FF6B6B';  // simulate theme swap
      expect(tokenValue('--theme-accent')).toBe('#FF6B6B');
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
      (globalThis as Record<string, unknown>).getComputedStyle = origGCS;
    }
  });
});

// ── useTokenValue module shape ────────────────────────────────────────────────

describe('useTokenValue', () => {
  it('is exported from tokenValue module', async () => {
    const mod = await import('../tokenValue');
    expect(typeof mod.useTokenValue).toBe('function');
  });

  it('tokenValue falls back to empty when document absent (same path as useTokenValue outside provider)', () => {
    const origDoc = (globalThis as Record<string, unknown>).document;
    (globalThis as Record<string, unknown>).document = undefined;
    try {
      // useTokenValue outside a provider calls tokenValue() as fallback.
      // With no document, both return ''.
      expect(tokenValue('--theme-bg-primary')).toBe('');
    } finally {
      (globalThis as Record<string, unknown>).document = origDoc;
    }
  });
});
