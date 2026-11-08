import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Icon, IconButton, type GlyphName } from '../../../ui-kit';
import styles from './ModulatorEditors.module.css';

// The floating editor for an envelope, an LFO or a cable's mapping: a title bar (glyph, name,
// close) over the editor's own controls. SheetFrame is the frame alone; ModulatorSheet portals
// one to document.body, because a floating panel's frame is a CSS transform and would be the
// containing block of a fixed element. Escape closes it; its title bar drags it. Nothing in it
// reaches the canvas: pointer, wheel, context-menu and double-click events stop at the sheet (a
// portal still bubbles through the React tree to the node that owns it).

const SHEET_WIDTH = 336;
const SHEET_EST_HEIGHT = 420;
const EDGE = 8;

export interface SheetAnchor {
  left: number;
  right: number;
  top: number;
}

export function placeSheet(
  anchor: SheetAnchor | null,
  viewport: { width: number; height: number },
): { x: number; y: number } {
  if (!anchor) {
    return {
      x: Math.max(EDGE, Math.round(viewport.width / 2 - SHEET_WIDTH / 2)),
      y: Math.max(EDGE, Math.round(viewport.height / 2 - SHEET_EST_HEIGHT / 2)),
    };
  }
  // To the right of the node when there is room, else to its left.
  const rightX = anchor.right + EDGE;
  const x = rightX + SHEET_WIDTH <= viewport.width - EDGE
    ? rightX
    : Math.max(EDGE, anchor.left - EDGE - SHEET_WIDTH);
  const y = Math.max(EDGE, Math.min(anchor.top, viewport.height - EDGE - SHEET_EST_HEIGHT));
  return { x, y };
}

// A point near the pointer, moved inside the window.
export function clampSheetPoint(
  point: { x: number; y: number },
  viewport: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.max(EDGE, Math.min(point.x, viewport.width - SHEET_WIDTH - EDGE)),
    y: Math.max(EDGE, Math.min(point.y, viewport.height - SHEET_EST_HEIGHT)),
  };
}

interface SheetFrameProps {
  title: string;
  glyph: GlyphName;
  initialPosition: { x: number; y: number };
  onClose: () => void;
  testId?: string;
  ariaLabel?: string;
  closeClassName?: string;
  dataAttributes?: Record<string, string>;
  children: React.ReactNode;
}

export function SheetFrame({
  title,
  glyph,
  initialPosition,
  onClose,
  testId,
  ariaLabel,
  closeClassName,
  dataAttributes,
  children,
}: SheetFrameProps) {
  const [pos, setPos] = React.useState(initialPosition);
  const dragRef = React.useRef<{ x: number; y: number; mx: number; my: number } | null>(null);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onMove = React.useCallback((event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPos({
      x: Math.max(-SHEET_WIDTH + 80, Math.min(window.innerWidth - 80, drag.x + event.clientX - drag.mx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, drag.y + event.clientY - drag.my)),
    });
  }, []);
  const onUp = React.useCallback(() => {
    dragRef.current = null;
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
  }, [onMove]);
  React.useEffect(() => onUp, [onUp]);

  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <div
      {...dataAttributes}
      className={styles.sheet}
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={ariaLabel ?? title}
      data-testid={testId}
      onPointerDown={stop}
      onPointerUp={stop}
      onWheel={stop}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onDoubleClick={stop}
      onClick={stop}
    >
      <div
        className={styles.sheetTitle}
        onPointerDown={(event) => {
          if (event.button !== 0 || (event.target as Element).closest('button')) return;
          event.preventDefault();
          dragRef.current = { x: pos.x, y: pos.y, mx: event.clientX, my: event.clientY };
          document.addEventListener('pointermove', onMove);
          document.addEventListener('pointerup', onUp);
        }}
      >
        <Icon name={glyph} size={16} className={styles.sheetGlyph} />
        <span className={styles.sheetTitleText} title={title}>{title}</span>
        <IconButton label={`Close ${title}`} size="sm" className={closeClassName} onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      </div>
      <div className={styles.sheetBody}>{children}</div>
    </div>
  );
}

interface ModulatorSheetProps {
  title: string;
  glyph: GlyphName;
  anchor: SheetAnchor | null;
  onClose: () => void;
  testId?: string;
  children: React.ReactNode;
}

export default function ModulatorSheet({ title, glyph, anchor, onClose, testId, children }: ModulatorSheetProps) {
  const [initial] = React.useState(() => (
    typeof window === 'undefined'
      ? { x: EDGE, y: EDGE }
      : placeSheet(anchor, { width: window.innerWidth, height: window.innerHeight })
  ));
  if (typeof document === 'undefined') return null;
  return createPortal(
    <SheetFrame title={title} glyph={glyph} initialPosition={initial} onClose={onClose} testId={testId}>
      {children}
    </SheetFrame>,
    document.body,
  );
}
