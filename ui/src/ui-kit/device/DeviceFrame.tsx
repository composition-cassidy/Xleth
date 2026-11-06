import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, CornerDownLeft, ExternalLink, MoreHorizontal, Power, X } from 'lucide-react';
import { IconButton } from '../Button';
import SegmentedControl from '../SegmentedControl';
import Toggle from '../Toggle';
import type { DataAttrs } from '../valueProps';
import DeviceMenu, { type DeviceMenuItem } from './DeviceMenu';
import styles from './DeviceFrame.module.css';

export type DeviceSide = 'a' | 'b';

export interface DeviceCompare {
  side: DeviceSide;
  onSwitch: (side: DeviceSide) => void;
  disabled?: boolean;
}

export interface DeviceFrameProps extends DataAttrs {
  /** Sentence case, from the one device-name map. */
  name: string;
  /** The owning track's identity colour (a CSS colour). Drawn as the title stripe. */
  identityColor?: string;
  bypassed: boolean;
  /** Omit when bypass is not reachable from here: the activator then shows its state, disabled. */
  onBypassChange?: (bypassed: boolean) => void;
  /** Explains a disabled activator in the hint bar. */
  bypassHint?: string;
  folded?: boolean;
  onFoldChange?: (folded: boolean) => void;
  /** Docked in the chain, or popped out into its own window (the only place the offset shadow appears). */
  presentation?: 'docked' | 'floating';
  /** Device width in px. Omit to fit the body's sections. Height is always `--device-h`. */
  width?: number;
  /** The preset menu (title bar, after the name). */
  presetSlot?: ReactNode;
  /** A/B compare. Omitted = no A/B for this device. */
  compare?: DeviceCompare | null;
  moreItems?: readonly DeviceMenuItem[];
  /** Docked only: open the same device in a floating window. */
  onPopOut?: () => void;
  /** Floating only: close the window. */
  onClose?: () => void;
  /** Docked slot of a device that is open in a window: shown as a strip with a return button. */
  poppedOut?: boolean;
  onReturn?: () => void;
  /** Spread on the name area: chain reorder (docked) or window move (floating). */
  dragHandleProps?: HTMLAttributes<HTMLDivElement>;
  /** The recessed display well, first in the body. */
  display?: ReactNode;
  /** Sections, in signal order. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/**
 * One frame for every stock device (ui/DESIGN.md "Device system"). Fixed
 * height, one title bar: activator, fold, name, preset menu, A/B, more,
 * pop-out. A bypassed device dims its body AND shows the activator off AND
 * prints "Off" after the name, so the state is never colour alone.
 */
export default function DeviceFrame(props: DeviceFrameProps) {
  const {
    name, identityColor, bypassed, onBypassChange, bypassHint, folded = false, onFoldChange,
    presentation = 'docked', width, presetSlot, compare, moreItems, onPopOut, onClose, poppedOut = false,
    onReturn, dragHandleProps, display, children, className, style, ...rest
  } = props;

  const strip = folded || poppedOut;
  const frameStyle = {
    ...style,
    ...(width ? { '--device-w': `${width}px` } : null),
    ...(identityColor ? { '--device-id': identityColor } : null),
  } as CSSProperties;

  const activator = (
    <Toggle
      size="sm"
      className={styles.activator}
      on={!bypassed}
      onChange={onBypassChange ? (on) => onBypassChange(!on) : undefined}
      disabled={!onBypassChange}
      glyph={<Power aria-hidden="true" />}
      aria-label={`${name} on`}
      hint={bypassHint ?? (bypassed ? `${name} is off (bypassed). Click to turn it on.` : `${name} is on. Click to bypass it.`)}
    />
  );

  return (
    <section
      {...rest}
      className={`${styles.device}${className ? ` ${className}` : ''}`}
      style={frameStyle}
      data-presentation={presentation}
      data-bypassed={bypassed || undefined}
      data-folded={strip || undefined}
      data-popped={poppedOut || undefined}
      aria-label={`${name} device${bypassed ? ', off' : ''}`}
    >
      <header className={styles.title}>
        {activator}
        {poppedOut ? (
          <IconButton size="sm" label={`Return ${name} to the chain`} hint="Close the window and show this device here again" onClick={onReturn}>
            <CornerDownLeft aria-hidden="true" />
          </IconButton>
        ) : onFoldChange ? (
          <IconButton
            size="sm"
            label={folded ? `Unfold ${name}` : `Fold ${name}`}
            aria-expanded={!folded}
            onClick={() => onFoldChange(!folded)}
          >
            {folded ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
          </IconButton>
        ) : null}
        <div
          {...dragHandleProps}
          className={styles.name}
          data-draggable={dragHandleProps ? true : undefined}
          data-hint={dragHandleProps ? (presentation === 'floating' ? 'Drag to move the window' : 'Drag to reorder the chain') : undefined}
        >
          <h3 className={styles.nameText}>{name}</h3>
          {bypassed ? <span className={styles.off}>Off</span> : null}
          {poppedOut ? <span className={styles.off}>In window</span> : null}
        </div>
        {strip ? null : (
          <div className={styles.tools}>
            {presetSlot ? <div className={styles.preset}>{presetSlot}</div> : null}
            {compare ? (
              <SegmentedControl
                size="sm"
                label={`${name} A/B compare`}
                hint="A/B compare: switch between two settings of this device"
                value={compare.side}
                disabled={compare.disabled}
                onChange={compare.onSwitch}
                options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]}
              />
            ) : null}
            {moreItems && moreItems.length ? (
              <DeviceMenu label={`More for ${name}`} items={moreItems}>
                <MoreHorizontal aria-hidden="true" />
              </DeviceMenu>
            ) : null}
            {presentation === 'docked' && onPopOut ? (
              <IconButton size="sm" label={`Open ${name} in a window`} onClick={onPopOut}>
                <ExternalLink aria-hidden="true" />
              </IconButton>
            ) : null}
            {presentation === 'floating' && onClose ? (
              <IconButton size="sm" label={`Close ${name}`} onClick={onClose}>
                <X aria-hidden="true" />
              </IconButton>
            ) : null}
          </div>
        )}
      </header>
      {strip ? null : (
        <div className={styles.body}>
          {display}
          {children}
        </div>
      )}
    </section>
  );
}
