import type { ReactNode } from 'react';
import { hintAttrs, type HintProps } from './hint';
import { rovingKeyHandler } from './roving';
import styles from './Tabs.module.css';
import type { DataAttrs } from './valueProps';

export interface TabItem extends HintProps {
  id: string;
  label: ReactNode;
  glyph?: ReactNode;
  disabled?: boolean;
  /** id of the panel this tab controls (aria-controls). */
  controls?: string;
  ariaLabel?: string;
}

export interface TabsProps extends HintProps, DataAttrs {
  /** Names the tab list ("Detail dock"). */
  label: string;
  tabs: readonly TabItem[];
  value: string;
  onChange?: (id: string) => void;
  className?: string;
}

const onKeyDown = rovingKeyHandler('[role="tab"]');

/**
 * Tab strip (28px). The selected tab is marked by an ink underline AND bold
 * ink text AND aria-selected, never by colour alone. Arrows move and select;
 * one tab stop for the strip.
 */
export default function Tabs({ label, tabs, value, onChange, hint, hintMods, className, ...rest }: TabsProps) {
  const selected = tabs.findIndex((t) => t.id === value);
  const stop = selected >= 0 ? selected : tabs.findIndex((t) => !t.disabled);
  return (
    <div
      {...rest}
      role="tablist"
      aria-label={label}
      className={`${styles.list}${className ? ` ${className}` : ''}`}
      {...hintAttrs({ hint, hintMods })}
      onKeyDown={(e) => {
        onKeyDown(e);
        const el = document.activeElement as HTMLElement | null;
        const i = el ? Array.from(e.currentTarget.querySelectorAll('[role="tab"]')).indexOf(el) : -1;
        if (i >= 0 && i !== selected && /^(ArrowLeft|ArrowRight|Home|End)$/.test(e.key) && !tabs[i].disabled) onChange?.(tabs[i].id);
      }}
    >
      {tabs.map((t, i) => {
        const on = i === selected;
        return (
          <button
            key={t.id}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={on}
            aria-controls={t.controls}
            aria-label={t.ariaLabel}
            tabIndex={i === stop ? 0 : -1}
            disabled={t.disabled}
            data-selected={on}
            {...hintAttrs({ hint: t.hint, hintMods: t.hintMods })}
            onClick={() => { if (!on) onChange?.(t.id); }}
          >
            {t.glyph ? <span className={styles.glyph} aria-hidden="true">{t.glyph}</span> : null}
            <span className={styles.text} data-text={typeof t.label === 'string' ? t.label : undefined}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
