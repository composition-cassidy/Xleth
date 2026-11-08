import React, { useEffect } from 'react';
import { Toggle } from '../../ui-kit';
import { PANEL_CATALOG, type PanelId } from '../registry/panelCatalog';
import { useShellLayoutStore } from './shellLayoutStore';
import styles from './TopRowStrip.module.css';

export interface TopRowStripProps {
  /** Panels docked in the folded top row, in slot order. */
  panelIds: readonly PanelId[];
}

const TOP_REGION = '[data-testid="xleth-dock-region-top"]';

/**
 * The top row folded to a 28px strip. The window is too short to dock Preview
 * and Inspector beside a 4-row arrangement and the detail dock, so the row is
 * never squeezed: it folds, and these buttons open it as a 200px sheet over the
 * arrangement. Esc, a press outside, or the button again closes the sheet.
 */
export function TopRowStrip({ panelIds }: TopRowStripProps) {
  const peek = useShellLayoutStore((s) => s.peek);
  const setPeek = useShellLayoutStore((s) => s.setPeek);

  useEffect(() => {
    if (!peek) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPeek(false); };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(`${TOP_REGION}, [data-top-row-strip], [data-xleth-menu]`)) return;
      setPeek(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [peek, setPeek]);

  return (
    <div className={styles.strip} data-top-row-strip data-testid="top-row-strip" role="toolbar" aria-label="Preview and Inspector">
      {panelIds.map((id) => {
        const entry = PANEL_CATALOG[id];
        const Icon = entry.icon;
        return (
          <Toggle
            key={id}
            size="sm"
            on={peek}
            onChange={setPeek}
            glyph={<Icon aria-hidden="true" />}
            hint={`${entry.title}: the window is too short to dock it, so it opens as a sheet over the arrangement`}
            hintMods="Esc closes"
          >
            {entry.title}
          </Toggle>
        );
      })}
    </div>
  );
}

export default TopRowStrip;
