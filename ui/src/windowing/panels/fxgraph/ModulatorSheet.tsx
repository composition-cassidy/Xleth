import React from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Icon, IconButton, type GlyphName } from '../../../ui-kit';
import styles from './ModulatorEditors.module.css';

// The floating editor for an envelope or LFO node: a title bar (glyph, name, close) over the
// editor's own controls. Portaled to document.body, because a floating panel's frame is a CSS
// transform and would be the containing block of a fixed element. Escape closes it; its title
// bar drags it. Nothing in it reaches the canvas: pointer, wheel, context-menu and
// double-click events stop at the sheet (a portal still bubbles through the React tree to the
// node that owns it).

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

interface ModulatorSheetProps {
  title: string;
  glyph: GlyphName;
  anchor: SheetAnchor | null;
  onClose: () => void;
  testId?: string;
  children: React.ReactNode;
}

export default function ModulatorSheet({ title, glyph, anchor, onClose, testId, children }: ModulatorSheetProps) {
  const [pos, setPos] = React.useState(() => (
    typeof window === 'undefined'
      ? { x: EDGE, y: EDGE }
      : placeSheet(anchor, { width: window.innerWidth, height: window.innerHeight })
  ));
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

  if (typeof document === 'undefined') return null;
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return createPortal(
    <div
      className={styles.sheet}
      style={{ left: pos.x, top: pos.y }}
      role="dialog"
      aria-label={title}
      data-testid={testId}
      onPointerDown={stop}
      onPointerUp={stop}
      onWheel={stop}
      onContextMenu={stop}
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
        <span className={styles.sheetTitleText}>{title}</span>
        <IconButton label={`Close ${title}`} size="sm" onClick={onClose}>
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </IconButton>
      </div>
      <div className={styles.sheetBody}>{children}</div>
    </div>,
    document.body,
  );
}
