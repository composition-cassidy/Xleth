import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { hintAttrs, type HintProps } from './hint';
import styles from './Meter.module.css';
import {
  initialMeterState,
  isSettled,
  stepMeter,
  type BallisticsOptions,
  type MeterState,
} from './meterBallistics';
import { tokenValue } from '../theming/tokenValue';
import { useThemeEpoch } from '../theming/useThemeEpoch';
import type { DataAttrs } from './valueProps';

export const DEFAULT_SCALE_DB = [0, -6, -12, -24, -36, -48, -60] as const;

/** A caller-supplied feed. The kit does not know where levels come from. */
export type MeterSubscribe = (push: (levelsDb: number | readonly number[]) => void) => () => void;

/** 'labels': ticks and printed numerals (default). 'ticks': the ticks alone, for a meter whose numerals are printed once elsewhere (MeterScale). */
export type MeterScaleMode = 'labels' | 'ticks';

export interface MeterProps extends HintProps, DataAttrs {
  /** Called once on mount with `push(dB per channel)`; return the unsubscribe. */
  subscribe: MeterSubscribe;
  /** Accessible name, e.g. "Track 3". */
  label: string;
  channels?: 1 | 2;
  /** Bottom of the display, dB. Default -60. */
  min?: number;
  /** Top of the display, dB. Default 0. */
  max?: number;
  scaleDb?: readonly number[];
  showScale?: boolean;
  /** What the scale prints when `showScale` is on. Default 'labels'. */
  scale?: MeterScaleMode;
  /** Input at or above this latches the clip indicator. Default 0 dB. */
  clipDb?: number;
  fallDbPerSec?: number;
  holdMs?: number;
  onClipChange?: (clipped: boolean) => void;
  /**
   * 'up' (default): a level meter, filling from `min` at the bottom.
   * 'down': a gain-reduction meter. Values are dB of reduction (0 = none), the
   * bar hangs from the top and the scale prints as negative dB. No clip LED.
   */
  direction?: 'up' | 'down';
  /**
   * Tone of the empty slot. 'ground' (default, g0) for a meter on panel chrome or in a display
   * well; 'panel' (g1) for a meter that sits on a g0 body (a mixer strip), where a g0 slot
   * would disappear.
   */
  well?: 'ground' | 'panel';
  /**
   * Colour of the bar. 'value' (default): the accent, for a value display such as gain
   * reduction. 'audio': the audio signal hue (DESIGN.md 3.3), for a meter that shows a
   * signal's level (mixer strips, the master).
   */
  tone?: 'value' | 'audio';
  /**
   * 'always' (default): the clip indicator is an outlined box until it latches.
   * 'latched': nothing is drawn (its space is kept) until the meter clips, so a row of
   * meters is not a row of empty boxes. Latched, it is the same filled, clickable box.
   */
  clipLatch?: 'always' | 'latched';
  className?: string;
}

const BAR_W = 7;
const BAR_GAP = 1;
const SCALE_W = 22;
/** Ticks alone: 1px gap, a 3px tick, 1px of air. */
const TICKS_W = 5;
const MIN_LABEL_GAP = 12;
/** A standalone scale column (MeterScale): the widest numeral ("−60") right-aligned, then the tick. */
const SCALE_COLUMN_W = 26;

interface Palette { well: string; wellPanel: string; fill: string; fillAudio: string; clip: string; peak: string; tick: string; font: string }

// Read at draw/mount time and on theme change, never at module scope.
function readPalette(): Palette {
  return {
    well: tokenValue('--ui-g0'),
    wellPanel: tokenValue('--ui-g1'),
    fill: tokenValue('--ui-value'),
    fillAudio: tokenValue('--ui-signal-audio'),
    clip: tokenValue('--ui-clip'),
    peak: tokenValue('--ui-ink'),
    tick: tokenValue('--ui-ink-3'),
    font: tokenValue('--ui-font'),
  };
}

/** Width the meter needs, so layouts can reserve it. */
export function meterWidth(channels: 1 | 2, showScale: boolean, scale: MeterScaleMode = 'labels'): number {
  return channels * BAR_W + (channels - 1) * BAR_GAP + (showScale ? (scale === 'ticks' ? TICKS_W : SCALE_W) : 0);
}

export interface ScaleMark { db: number; y: number }

/**
 * The marks a meter of this height shows: every scale value inside the range whose label
 * would sit at least MIN_LABEL_GAP below the previous one. One rule for a meter's own
 * numerals, a meter's bare ticks and the standalone MeterScale, so meters of equal height
 * always carry the same marks at the same y.
 */
export function visibleScaleMarks(
  scaleDb: readonly number[], min: number, max: number, cssH: number, down = false,
): ScaleMark[] {
  const span = max - min || 1;
  const frac = (db: number) => (Math.min(max, Math.max(min, db)) - min) / span;
  const yOf = (db: number) => (down ? frac(db) * cssH : cssH - frac(db) * cssH);
  const marks: ScaleMark[] = [];
  let lastY = -Infinity;
  for (const db of scaleDb) {
    if (db > max || db < min) continue;
    const y = yOf(db);
    if (Math.abs(y - lastY) < MIN_LABEL_GAP) continue;
    lastY = y;
    marks.push({ db, y });
  }
  return marks;
}

const numeral = (db: number, down: boolean) => String(down && db > 0 ? -db : db).replace('-', '−');

/**
 * Canvas level meter: continuous bars in dB, a printed dB scale, peak hold and a
 * clip indicator that latches until clicked. One canvas, never one DOM node per
 * segment. The draw loop sleeps when the meter is at rest.
 */
export default function Meter(props: MeterProps) {
  const {
    subscribe, label, channels = 1, min = -60, max = 0, scaleDb = DEFAULT_SCALE_DB, showScale = true, scale = 'labels',
    clipDb: clipDbProp = 0, fallDbPerSec, holdMs, onClipChange, direction = 'up', well = 'ground', tone = 'value',
    clipLatch = 'always', hint, hintMods, className, ...rest
  } = props;
  const down = direction === 'down';
  const clipDb = down ? Number.POSITIVE_INFINITY : clipDbProp;

  const epoch = useThemeEpoch();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<number[]>(Array.from({ length: channels }, () => min));
  const statesRef = useRef<MeterState[]>(Array.from({ length: channels }, () => initialMeterState(min)));
  const rafRef = useRef(0);
  const lastTsRef = useRef(0);
  const paletteRef = useRef<Palette | null>(null);
  const clippedRef = useRef(false);
  const optsRef = useRef({ min, max, scaleDb, showScale, scale, clipDb, fallDbPerSec, holdMs, channels, onClipChange, down, well, tone });
  optsRef.current = { min, max, scaleDb, showScale, scale, clipDb, fallDbPerSec, holdMs, channels, onClipChange, down, well, tone };
  const [clipped, setClipped] = useState(false);

  const width = meterWidth(channels, showScale, scale);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    const o = optsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    const pal = paletteRef.current ?? (paletteRef.current = readPalette());
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const span = o.max - o.min || 1;
    const frac = (db: number) => (Math.min(o.max, Math.max(o.min, db)) - o.min) / span;
    // Up: min at the bottom. Down (gain reduction): 0 dB of reduction at the top.
    const yOf = (db: number) => (o.down ? frac(db) * cssH : cssH - frac(db) * cssH);

    const barsW = o.channels * BAR_W + (o.channels - 1) * BAR_GAP;
    for (let c = 0; c < o.channels; c += 1) {
      const x = c * (BAR_W + BAR_GAP);
      const st = statesRef.current[c];
      ctx.fillStyle = o.well === 'panel' ? pal.wellPanel : pal.well;
      ctx.fillRect(x, 0, BAR_W, cssH);
      if (st.level > o.min) {
        const y = yOf(st.level);
        ctx.fillStyle = st.level >= o.clipDb ? pal.clip : (o.tone === 'audio' ? pal.fillAudio : pal.fill);
        if (o.down) ctx.fillRect(x, 0, BAR_W, y);
        else ctx.fillRect(x, y, BAR_W, cssH - y);
      }
      if (st.peak > o.min) {
        ctx.fillStyle = pal.peak;
        const py = Math.min(cssH - 2, Math.max(0, yOf(st.peak) - 1));
        ctx.fillRect(x, py, BAR_W, 2);
      }
    }

    if (o.showScale) {
      ctx.font = `10px ${pal.font}`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillStyle = pal.tick;
      for (const { db, y } of visibleScaleMarks(o.scaleDb, o.min, o.max, cssH, o.down)) {
        ctx.fillRect(barsW + 1, Math.min(cssH - 1, Math.round(y)), 3, 1);
        if (o.scale === 'ticks') continue;
        const ty = Math.min(cssH - 5, Math.max(5, y));
        ctx.fillText(numeral(db, o.down), barsW + 6, ty);
      }
    }
  }, []);

  const frame = useCallback((ts: number) => {
    rafRef.current = 0;
    const o = optsRef.current;
    const dt = lastTsRef.current ? Math.min(100, ts - lastTsRef.current) : 16;
    lastTsRef.current = ts;
    let settled = true;
    for (let c = 0; c < o.channels; c += 1) {
      const r = stepMeter(statesRef.current[c], inputRef.current[c] ?? o.min, dt, {
        min: o.min, clipDb: o.clipDb, fallDbPerSec: o.fallDbPerSec, holdMs: o.holdMs,
      });
      statesRef.current[c] = r.state;
      if (r.clipped && !clippedRef.current) {
        clippedRef.current = true;
        setClipped(true);
        o.onClipChange?.(true);
      }
      if (!isSettled(r.state, o.min)) settled = false;
    }
    draw();
    if (settled) { lastTsRef.current = 0; return; }
    rafRef.current = requestAnimationFrame(frame);
  }, [draw]);

  const kick = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(frame);
  }, [frame]);

  // Feed.
  useEffect(() => {
    const push = (levels: number | readonly number[]) => {
      const arr = typeof levels === 'number' ? [levels] : levels;
      for (let c = 0; c < optsRef.current.channels; c += 1) {
        inputRef.current[c] = arr[c] ?? arr[0] ?? optsRef.current.min;
      }
      kick();
    };
    const unsubscribe = subscribe(push);
    return () => {
      unsubscribe?.();
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [subscribe, kick]);

  // Channel count or range CHANGED (not merely mounted): restart the states. Comparing
  // against the previous values keeps a first push from the feed (which runs in an
  // earlier effect, and twice under StrictMode) from being wiped.
  const shapeRef = useRef({ channels, min });
  useEffect(() => {
    const prev = shapeRef.current;
    if (prev.channels !== channels || prev.min !== min) {
      shapeRef.current = { channels, min };
      inputRef.current = Array.from({ length: channels }, () => min);
      statesRef.current = Array.from({ length: channels }, () => initialMeterState(min));
    }
    draw();
  }, [channels, min, max, well, tone, scale, draw]);

  // Theme change: re-read the palette and repaint.
  useEffect(() => {
    paletteRef.current = null;
    draw();
  }, [epoch, draw]);

  // Resize: repaint at the new size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  const clearClip = useCallback(() => {
    clippedRef.current = false;
    setClipped(false);
    statesRef.current = statesRef.current.map(() => initialMeterState(optsRef.current.min));
    optsRef.current.onClipChange?.(false);
    draw();
  }, [draw]);

  const latchOnly = clipLatch === 'latched';

  return (
    <div
      {...rest}
      className={`${styles.meter}${className ? ` ${className}` : ''}`}
      data-direction={direction}
      style={{ '--meter-w': `${width}px`, '--bars-w': `${meterWidth(channels, false)}px` } as CSSProperties}
      role="group"
      aria-label={`${label} meter`}
      {...hintAttrs({ hint, hintMods })}
    >
      {down ? null : (latchOnly && !clipped
        // The latch keeps its space so the bars never move; it is only drawn once latched.
        ? <span className={styles.clipSpace} aria-hidden="true" data-clip-space="" />
        : <button
          type="button"
          className={styles.clip}
          data-clipped={clipped}
          aria-label={clipped ? `${label}: clipped. Click to clear` : `${label}: no clipping`}
          data-hint={clipped ? 'Clipped. Click to clear the clip indicator.' : 'Clip indicator. Latches when the level reaches 0 dB.'}
          onClick={clearClip}
        />)}
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    </div>
  );
}

export interface MeterScaleProps {
  /** Bottom of the display, dB. Default -60. Match the meters this scale stands beside. */
  min?: number;
  max?: number;
  scaleDb?: readonly number[];
  className?: string;
}

/**
 * The printed dB numerals of a row of meters, drawn once. It has a meter's own
 * geometry (the same latch space on top, then a canvas of the same height), so
 * given the same box it puts every numeral at the y of the meters' ticks. It
 * carries no level: it is a scale, not a meter.
 */
export function MeterScale({ min = -60, max = 0, scaleDb = DEFAULT_SCALE_DB, className }: MeterScaleProps) {
  const epoch = useThemeEpoch();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const optsRef = useRef({ min, max, scaleDb });
  optsRef.current = { min, max, scaleDb };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext?.('2d');
    if (!canvas || !ctx) return;
    const o = optsRef.current;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = `10px ${tokenValue('--ui-font')}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillStyle = tokenValue('--ui-ink-3');
    for (const { db, y } of visibleScaleMarks(o.scaleDb, o.min, o.max, cssH)) {
      ctx.fillRect(cssW - 3, Math.min(cssH - 1, Math.round(y)), 3, 1);
      ctx.fillText(numeral(db, false), cssW - 5, Math.min(cssH - 5, Math.max(5, y)));
    }
  }, []);

  useEffect(() => { draw(); }, [epoch, min, max, scaleDb, draw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [draw]);

  return (
    <div
      className={`${styles.meter}${className ? ` ${className}` : ''}`}
      style={{ '--meter-w': `${SCALE_COLUMN_W}px`, '--bars-w': `${SCALE_COLUMN_W}px` } as CSSProperties}
      role="img"
      aria-label={`Level scale, ${numeral(max, false)} to ${numeral(min, false)} dB`}
    >
      <span className={styles.clipSpace} aria-hidden="true" />
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    </div>
  );
}

