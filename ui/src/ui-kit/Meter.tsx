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
  className?: string;
}

const BAR_W = 7;
const BAR_GAP = 1;
const SCALE_W = 22;
const MIN_LABEL_GAP = 12;

interface Palette { well: string; wellPanel: string; fill: string; clip: string; peak: string; tick: string; font: string }

// Read at draw/mount time and on theme change, never at module scope.
function readPalette(): Palette {
  return {
    well: tokenValue('--ui-g0'),
    wellPanel: tokenValue('--ui-g1'),
    fill: tokenValue('--ui-value'),
    clip: tokenValue('--ui-clip'),
    peak: tokenValue('--ui-ink'),
    tick: tokenValue('--ui-ink-3'),
    font: tokenValue('--ui-font'),
  };
}

/** Width the meter needs, so layouts can reserve it. */
export function meterWidth(channels: 1 | 2, showScale: boolean): number {
  return channels * BAR_W + (channels - 1) * BAR_GAP + (showScale ? SCALE_W : 0);
}

/**
 * Canvas level meter: continuous bars in dB, a printed dB scale, peak hold and a
 * clip indicator that latches until clicked. One canvas, never one DOM node per
 * segment. The draw loop sleeps when the meter is at rest.
 */
export default function Meter(props: MeterProps) {
  const {
    subscribe, label, channels = 1, min = -60, max = 0, scaleDb = DEFAULT_SCALE_DB, showScale = true,
    clipDb: clipDbProp = 0, fallDbPerSec, holdMs, onClipChange, direction = 'up', well = 'ground', hint, hintMods, className, ...rest
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
  const optsRef = useRef({ min, max, scaleDb, showScale, clipDb, fallDbPerSec, holdMs, channels, onClipChange, down, well });
  optsRef.current = { min, max, scaleDb, showScale, clipDb, fallDbPerSec, holdMs, channels, onClipChange, down, well };
  const [clipped, setClipped] = useState(false);

  const width = meterWidth(channels, showScale);

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
        ctx.fillStyle = st.level >= o.clipDb ? pal.clip : pal.fill;
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
      let lastY = -Infinity;
      for (const db of o.scaleDb) {
        if (db > o.max || db < o.min) continue;
        const y = yOf(db);
        if (Math.abs(y - lastY) < MIN_LABEL_GAP) continue;
        lastY = y;
        ctx.fillStyle = pal.tick;
        ctx.fillRect(barsW + 1, Math.round(y), 3, 1);
        const ty = Math.min(cssH - 5, Math.max(5, y));
        const shown = o.down && db > 0 ? -db : db;
        ctx.fillText(String(shown).replace('-', '−'), barsW + 6, ty);
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
  }, [channels, min, max, well, draw]);

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
      {down ? null : <button
        type="button"
        className={styles.clip}
        data-clipped={clipped}
        aria-label={clipped ? `${label}: clipped. Click to clear` : `${label}: no clipping`}
        data-hint={clipped ? 'Clipped. Click to clear the clip indicator.' : 'Clip indicator. Latches when the level reaches 0 dB.'}
        onClick={clearClip}
      />}
      <canvas ref={canvasRef} className={styles.canvas} aria-hidden="true" />
    </div>
  );
}
