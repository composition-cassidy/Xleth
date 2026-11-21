/**
 * @vitest-environment jsdom
 */
// Motion tiers (ui/DESIGN.md section 27). Three things are guarded here:
//   1. the tier table in ui-kit/motion.css: flat is all zero, smooth stays inside the
//      sanctioned budget, lively stays under its cap, and no curve is an ease-in;
//   2. nothing in the kit or in a module stylesheet hard-codes a duration or a curve:
//      motion is a channel token or a recipe attribute, so the tier always decides;
//   3. the runtime: the tier in force, keyboard-opened surfaces, and exits that stand down
//      when the exit channel is 0.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_TIERS, MOTION_TIER_ATTR, __setLastInputWasKeyboard, currentMotionTier, ghostExit, isMotionTier,
  motionEnabled, motionForcedFlat, motionMs, parseCssTime, setRootMotionTier,
} from '../motion';
import { effectiveMotionTier, normalizeMotionSettings, MOTION_TIER_DEFAULT, MOTION_TIER_OPTIONS } from '../../stores/motionStore.js';

const SRC = path.resolve(__dirname, '..', '..');
const MOTION_CSS = fs.readFileSync(path.join(SRC, 'ui-kit', 'motion.css'), 'utf8');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The `--mo-*` declarations of the rule whose selector is exactly `selector`. */
function tokensOf(selector: string): Record<string, string> {
  const css = stripComments(MOTION_CSS);
  const at = css.indexOf(`${selector} {`);
  expect(at, `selector ${selector}`).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--mo-[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const FLAT = tokensOf(':root');
const SMOOTH = { ...FLAT, ...tokensOf(':root[data-motion-tier="smooth"]') };
const LIVELY = { ...FLAT, ...tokensOf(':root[data-motion-tier="lively"]') };

/** Duration channels: every token whose flat value is a time, except the loop periods. */
const CHANNELS = Object.keys(FLAT).filter((k) => /^\d+ms$/.test(FLAT[k]) && !k.startsWith('--mo-loop'));

describe('motion tier table (ui-kit/motion.css)', () => {
  it('defines the channels the app uses', () => {
    for (const name of ['--mo-hover-in', '--mo-hover-out', '--mo-state', '--mo-press', '--mo-popover', '--mo-context',
      '--mo-dialog', '--mo-toast', '--mo-page', '--mo-edit', '--mo-kbd', '--mo-exit', '--mo-focus', '--mo-item', '--mo-stagger']) {
      expect(CHANNELS, name).toContain(name);
    }
  });

  it('tier 1 (flat) is all zero: no duration, no travel, no scale, loops paused', () => {
    for (const name of CHANNELS) expect(FLAT[name], name).toBe('0ms');
    for (const name of ['--mo-rise', '--mo-shift', '--mo-item-rise', '--mo-focus-from']) expect(FLAT[name], name).toBe('0px');
    for (const name of ['--mo-pop-from', '--mo-dialog-from', '--mo-insert-from', '--mo-glyph-from', '--mo-exit-to']) expect(FLAT[name], name).toBe('1');
    expect(FLAT['--mo-press-scale']).toBe('none');
    expect(FLAT['--mo-ambient']).toBe('paused');
  });

  it('later tiers only override tokens the flat tier declares', () => {
    for (const tier of ['smooth', 'lively']) {
      for (const name of Object.keys(tokensOf(`:root[data-motion-tier="${tier}"]`))) expect(Object.keys(FLAT), `${tier} ${name}`).toContain(name);
    }
  });

  it('tier 2 (smooth) keeps the edit loop and the keyboard instant, and nothing exceeds 240 ms', () => {
    for (const name of ['--mo-state', '--mo-press', '--mo-context', '--mo-edit', '--mo-kbd', '--mo-focus', '--mo-item', '--mo-stagger', '--mo-hover-out']) {
      expect(SMOOTH[name], name).toBe('0ms');
    }
    for (const name of CHANNELS) expect(parseCssTime(SMOOTH[name]), name).toBeLessThanOrEqual(240);
    // Hover is a colour change of 120 ms or less.
    expect(parseCssTime(SMOOTH['--mo-hover-in'])).toBeLessThanOrEqual(120);
    // No overshoot, no travel beyond the toast's few pixels, no press, no scale(0)-like pops.
    expect(SMOOTH['--mo-ease-pop']).toBe('var(--mo-ease-out)');
    expect(SMOOTH['--mo-press-scale']).toBe('none');
    expect(Number(SMOOTH['--mo-pop-from'])).toBeGreaterThanOrEqual(0.95);
    expect(Number(SMOOTH['--mo-dialog-from'])).toBeGreaterThanOrEqual(0.98);
  });

  it('tier 3 (lively) moves every channel, under a 400 ms cap', () => {
    for (const name of CHANNELS) {
      const ms = parseCssTime(LIVELY[name]);
      expect(ms, name).toBeGreaterThan(0);
      expect(ms, name).toBeLessThanOrEqual(400);
    }
    // Never from nothing, never a big bounce.
    expect(Number(LIVELY['--mo-pop-from'])).toBeGreaterThanOrEqual(0.85);
    expect(Number(LIVELY['--mo-press-scale'])).toBeGreaterThanOrEqual(0.94);
    const pop = /cubic-bezier\(([^)]+)\)/.exec(LIVELY['--mo-ease-pop']);
    expect(pop).not.toBeNull();
    const [, y1, , y2] = pop![1].split(',').map(Number);
    expect(Math.max(y1, y2)).toBeLessThanOrEqual(1.6);
  });

  it('every exit is shorter than the enters it follows', () => {
    for (const tier of [SMOOTH, LIVELY]) {
      const exit = parseCssTime(tier['--mo-exit']);
      for (const name of ['--mo-popover', '--mo-dialog', '--mo-toast']) expect(exit, name).toBeLessThan(parseCssTime(tier[name]));
    }
  });

  it('uses no ease-in and no built-in ease anywhere', () => {
    const css = stripComments(MOTION_CSS);
    expect(css).not.toMatch(/\bease-in\b(?!-out)/);
    expect(css).not.toMatch(/[\s,]ease[\s,;]/);
    for (const curve of css.matchAll(/cubic-bezier\(([^)]+)\)/g)) {
      const [x1, y1] = curve[1].split(',').map(Number);
      // An ease-in starts slow: its first control point hugs the time axis.
      expect(y1 >= x1, `cubic-bezier(${curve[1]}) is not an ease-in`).toBe(true);
    }
  });

  it('animates only transform-like properties, opacity, colour and outline', () => {
    const css = stripComments(MOTION_CSS);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\})\s*\}/g)) {
      for (const decl of m[1].matchAll(/([\w-]+)\s*:/g)) {
        expect(['opacity', 'transform', 'translate', 'scale', 'rotate', 'outline-offset', 'from', 'to']).toContain(decl[1]);
      }
    }
    expect(css).not.toMatch(/transition(-property)?\s*:[^;]*\ball\b/);
    expect(css).not.toMatch(/scale\(0\)/);
  });

  it('flat also stops the pre-rebuild sheets, from the lowest layer', () => {
    const css = stripComments(MOTION_CSS);
    const reset = css.slice(css.indexOf('@layer reset'));
    expect(reset).toMatch(/:root\[data-motion-tier="flat"\] \*[\s\S]*?transition-duration:\s*0s\s*!important/);
    expect(reset).toMatch(/animation-duration:\s*0s\s*!important/);
  });
});

// ── 2. Nothing else hard-codes motion ────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const rel = (f: string) => path.relative(SRC, f).split(path.sep).join('/');

describe('no hard-coded motion outside ui-kit/motion.css', () => {
  // The guarded sheets are the ones `npm run lint:css` guards: the kit and every module sheet.
  const sheets = walk(SRC).filter((f) => f.endsWith('.css') && (rel(f).startsWith('ui-kit/') || f.endsWith('.module.css')) && rel(f) !== 'ui-kit/motion.css');
  const MOTION_DECL = /(^|[\s;{])(transition|transition-duration|transition-delay|transition-timing-function|animation|animation-duration|animation-delay|animation-timing-function)\s*:\s*([^;}]+)/g;
  const LITERAL_TIME = /(^|[\s,(])-?\d*\.?\d+m?s\b/;
  const LITERAL_CURVE = /\b(ease|ease-in|ease-out|ease-in-out|cubic-bezier|steps)\b/;

  it('finds stylesheets to check', () => {
    expect(sheets.length).toBeGreaterThan(80);
  });

  it('every transition and animation takes its time and curve from a --mo-* token', () => {
    const offenders: string[] = [];
    for (const file of sheets) {
      const css = stripComments(fs.readFileSync(file, 'utf8'));
      for (const m of css.matchAll(MOTION_DECL)) {
        const value = m[3].trim();
        if (value === 'none' || value === 'inherit' || value === 'initial' || value === 'unset') continue;
        // Token references are what we want; look at what is left once they are gone.
        const rest = value.replace(/var\(--mo-[\w-]+(?:,[^)]*)?\)/g, '');
        if (LITERAL_TIME.test(rest) || LITERAL_CURVE.test(rest)) offenders.push(`${rel(file)}: ${m[2]}: ${value}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no stylesheet gates motion on prefers-reduced-motion itself (the tier in force already follows it)', () => {
    const offenders = sheets.filter((f) => /prefers-reduced-motion/.test(stripComments(fs.readFileSync(f, 'utf8')))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('components name a recipe that exists', () => {
    const known = new Set([...stripComments(MOTION_CSS).matchAll(/\[data-mo="([\w-]+)"\]/g)].map((m) => m[1]));
    const offenders: string[] = [];
    for (const file of walk(SRC).filter((f) => /\.(jsx|tsx)$/.test(f) && !/\.test\./.test(f))) {
      const text = fs.readFileSync(file, 'utf8');
      for (const m of text.matchAll(/(?:data-mo|recipe)="([\w-]+)"/g)) if (!known.has(m[1])) offenders.push(`${rel(file)}: ${m[1]}`);
    }
    expect(offenders).toEqual([]);
    for (const recipe of ['pop', 'context', 'dialog', 'scrim', 'window', 'sheet', 'toast', 'page', 'reveal', 'insert', 'glyph']) expect(known, recipe).toContain(recipe);
  });
});

// ── 3. Runtime ───────────────────────────────────────────────────────────────

describe('motion runtime', () => {
  afterEach(() => {
    document.documentElement.removeAttribute(MOTION_TIER_ATTR);
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('no attribute is flat, and is not "forced" flat', () => {
    expect(currentMotionTier()).toBe('flat');
    expect(motionEnabled()).toBe(false);
    expect(motionForcedFlat()).toBe(false);
  });

  it('writes and reads the tier in force', () => {
    for (const tier of MOTION_TIERS) {
      setRootMotionTier(tier);
      expect(document.documentElement.getAttribute(MOTION_TIER_ATTR)).toBe(tier);
      expect(currentMotionTier()).toBe(tier);
    }
    setRootMotionTier('flat');
    expect(motionForcedFlat()).toBe(true);
    expect(isMotionTier('bouncy')).toBe(false);
  });

  it('parses CSS times', () => {
    expect(parseCssTime('150ms')).toBe(150);
    expect(parseCssTime('0.2s')).toBe(200);
    expect(parseCssTime('0ms')).toBe(0);
    expect(parseCssTime('')).toBe(0);
    expect(parseCssTime('paused')).toBe(0);
  });

  it('reads a channel as 0 when the stylesheet is not loaded (tests, harness)', () => {
    expect(motionMs('--mo-exit')).toBe(0);
  });

  it('an exit does nothing while the exit channel is 0', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const animate = vi.fn();
    (el as unknown as { animate: unknown }).animate = animate;
    ghostExit(el);
    el.remove();
    return Promise.resolve().then(() => {
      expect(animate).not.toHaveBeenCalled();
      expect(document.body.contains(el)).toBe(false);
    });
  });

  it('an exit puts the closed surface back, inert and scrubbed, then removes it', async () => {
    setRootMotionTier('lively');
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((node: Element, pseudo?: string | null) => {
      const style = real(node, pseudo);
      if (node !== document.documentElement) return style;
      return new Proxy(style, {
        get(target, prop) {
          if (prop === 'getPropertyValue') return (name: string) => (name === '--mo-exit' ? '190ms' : name === '--mo-exit-to' ? '0.95' : '');
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    setRootMotionTier('smooth'); // clears the token cache
    setRootMotionTier('lively');

    const el = document.createElement('div');
    el.id = 'menu-1';
    el.setAttribute('role', 'menu');
    el.setAttribute('data-mo', 'pop');
    el.innerHTML = '<button id="item-1" role="menuitem" tabindex="-1">Cut</button>';
    document.body.appendChild(el);

    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const animate = vi.fn(() => ({ finished }));
    (el as unknown as { animate: unknown }).animate = animate;

    ghostExit(el);
    el.remove(); // React detaches it right after the layout-effect cleanup
    await Promise.resolve();

    expect(document.body.contains(el)).toBe(true);
    expect(el.hasAttribute('data-mo-ghost')).toBe(true);
    expect(el.hasAttribute('inert')).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    expect(el.hasAttribute('data-mo')).toBe(false);
    expect(el.hasAttribute('role')).toBe(false);
    expect(el.id).toBe('');
    expect(el.querySelector('button')!.id).toBe('');
    expect(el.querySelector('button')!.hasAttribute('role')).toBe(false);
    expect(animate).toHaveBeenCalledTimes(2);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(frames[1].opacity).toBe(0);
    expect(timing.duration).toBe(190);

    finish();
    await finished;
    await Promise.resolve();
    expect(document.body.contains(el)).toBe(false);
  });

  it('an exit stands down when the element was not really unmounted (React StrictMode)', async () => {
    setRootMotionTier('lively');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    (el as unknown as { animate: unknown }).animate = animate;
    ghostExit(el); // cleanup ran, but the element stays in the document
    await Promise.resolve();
    expect(animate).not.toHaveBeenCalled();
    expect(el.hasAttribute('data-mo-ghost')).toBe(false);
  });

  it('remembers keyboard input (test seam)', async () => {
    const { lastInputWasKeyboard } = await import('../motion');
    __setLastInputWasKeyboard(true);
    expect(lastInputWasKeyboard()).toBe(true);
    window.dispatchEvent(new Event('pointerdown'));
    expect(lastInputWasKeyboard()).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control' }));
    expect(lastInputWasKeyboard()).toBe(false); // a held modifier is part of a click
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm' }));
    expect(lastInputWasKeyboard()).toBe(true);
  });
});

describe('motion setting (stores/motionStore.js)', () => {
  it('offers the three tiers, flat first, smooth by default', () => {
    expect(MOTION_TIER_OPTIONS.map((o) => o.value)).toEqual(['flat', 'smooth', 'lively']);
    expect(MOTION_TIER_DEFAULT).toBe('smooth');
    for (const option of MOTION_TIER_OPTIONS) expect(option.description.length).toBeGreaterThan(20);
  });

  it('the system setting forces flat only while it is followed', () => {
    expect(effectiveMotionTier({ tier: 'lively', followSystem: true, systemReduced: true })).toBe('flat');
    expect(effectiveMotionTier({ tier: 'lively', followSystem: false, systemReduced: true })).toBe('lively');
    expect(effectiveMotionTier({ tier: 'smooth', followSystem: true, systemReduced: false })).toBe('smooth');
    expect(effectiveMotionTier({ tier: 'flat', followSystem: false, systemReduced: false })).toBe('flat');
  });

  it('cleans stored values', () => {
    expect(normalizeMotionSettings(null)).toEqual({ tier: 'smooth', followSystem: true });
    expect(normalizeMotionSettings({ tier: 'lively', followSystem: false })).toEqual({ tier: 'lively', followSystem: false });
    expect(normalizeMotionSettings({ tier: 'wobbly', followSystem: 'yes' })).toEqual({ tier: 'smooth', followSystem: true });
  });
});
