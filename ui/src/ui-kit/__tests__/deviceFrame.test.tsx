/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceFrame, DeviceSection, DisplayWell, Meter } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

const render = (el: React.ReactElement) => act(() => root.render(el));
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });
const q = (sel: string) => container.querySelector(sel);

describe('DeviceFrame: one title bar on every device', () => {
  it('renders activator, fold, name, preset slot, A/B, more and pop-out in that order', () => {
    render(
      <DeviceFrame
        name="Compressor"
        width={400}
        bypassed={false}
        onBypassChange={() => {}}
        onFoldChange={() => {}}
        presetSlot={<span data-testid="preset">p</span>}
        compare={{ side: 'a', onSwitch: () => {} }}
        moreItems={[{ label: 'Delete', onSelect: () => {}, danger: true }]}
        onPopOut={() => {}}
      >
        <div>body</div>
      </DeviceFrame>,
    );
    const header = q('header')!;
    const names = Array.from(header.querySelectorAll('button, [data-testid], h3, [role="radiogroup"]'))
      .map((el) => el.getAttribute('aria-label') || el.getAttribute('data-testid') || el.textContent);
    expect(names).toEqual([
      'Compressor on', 'Fold Compressor', 'Compressor', 'preset',
      'Compressor A/B compare', 'A', 'B', 'More for Compressor', 'Open Compressor in a window',
    ]);
    expect(q('section')!.getAttribute('aria-label')).toBe('Compressor device');
  });

  it('bypassed: activator off, "Off" printed, body dimmed via data-bypassed (never colour alone)', () => {
    const onBypass = vi.fn();
    render(<DeviceFrame name="Compressor" width={300} bypassed onBypassChange={onBypass}><div>b</div></DeviceFrame>);
    const activator = q('button[aria-label="Compressor on"]')!;
    expect(activator.getAttribute('aria-pressed')).toBe('false');
    expect(q('section')!.getAttribute('data-bypassed')).toBe('true');
    expect(q('section')!.getAttribute('aria-label')).toBe('Compressor device, off');
    expect(container.textContent).toContain('Off');
    click(activator);
    expect(onBypass).toHaveBeenCalledWith(false);
  });

  it('without a bypass handler the activator still shows state, disabled', () => {
    render(<DeviceFrame name="Delay" width={200} bypassed={false} />);
    const activator = q('button[aria-label="Delay on"]') as HTMLButtonElement;
    expect(activator.disabled).toBe(true);
    expect(activator.getAttribute('aria-pressed')).toBe('true');
  });

  it('folded: a strip with activator and unfold only, no body', () => {
    const onFold = vi.fn();
    render(<DeviceFrame name="Compressor" width={300} bypassed={false} folded onFoldChange={onFold} onPopOut={() => {}}><div>body</div></DeviceFrame>);
    expect(q('section')!.getAttribute('data-folded')).toBe('true');
    expect(container.textContent).not.toContain('body');
    expect(q('button[aria-label="Open Compressor in a window"]')).toBeNull();
    click(q('button[aria-label="Unfold Compressor"]'));
    expect(onFold).toHaveBeenCalledWith(false);
  });

  it('popped out: the docked slot becomes a strip with a return button', () => {
    const onReturn = vi.fn();
    render(<DeviceFrame name="Compressor" width={300} bypassed={false} poppedOut onReturn={onReturn}><div>body</div></DeviceFrame>);
    expect(container.textContent).toContain('In window');
    click(q('button[aria-label="Return Compressor to the chain"]'));
    expect(onReturn).toHaveBeenCalled();
  });

  it('floating: close instead of pop-out', () => {
    const onClose = vi.fn();
    render(<DeviceFrame name="Compressor" width={300} bypassed={false} presentation="floating" onClose={onClose} onPopOut={() => {}} />);
    expect(q('button[aria-label="Open Compressor in a window"]')).toBeNull();
    click(q('button[aria-label="Close Compressor"]'));
    expect(onClose).toHaveBeenCalled();
    expect(q('section')!.getAttribute('data-presentation')).toBe('floating');
  });

  it('the more menu opens, runs an item and closes', () => {
    const onDelete = vi.fn();
    render(<DeviceFrame name="Compressor" width={300} bypassed={false} moreItems={[{ label: 'Delete', onSelect: onDelete, danger: true }]} />);
    click(q('button[aria-label="More for Compressor"]'));
    const item = document.body.querySelector('[role="menuitem"]');
    expect(item?.textContent).toContain('Delete');
    click(item);
    expect(onDelete).toHaveBeenCalled();
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('DeviceSection and DisplayWell', () => {
  it('a foldable section collapses to a vertical strip', () => {
    const onFold = vi.fn();
    render(<DeviceSection title="Sidechain" folded onFoldChange={onFold}><div>controls</div></DeviceSection>);
    expect(container.textContent).toContain('Sidechain');
    expect(container.textContent).not.toContain('controls');
    click(q('button[aria-label="Show Sidechain"]'));
    expect(onFold).toHaveBeenCalledWith(false);
  });

  it('the well shows its view switch only when there is more than one view', () => {
    const onView = vi.fn();
    render(
      <DisplayWell label="Compressor display" width={260} views={[{ value: 'a', label: 'Activity' }, { value: 'c', label: 'Curve' }]} view="a" onViewChange={onView}>
        <canvas />
      </DisplayWell>,
    );
    click(Array.from(container.querySelectorAll('[role="radio"]')).find((b) => b.textContent === 'Curve')!);
    expect(onView).toHaveBeenCalledWith('c');
  });
});

describe('Meter direction="down" (gain reduction)', () => {
  it('has no clip indicator', () => {
    render(<Meter label="Gain reduction" subscribe={() => () => {}} direction="down" min={0} max={24} />);
    expect(q('[data-direction="down"]')).not.toBeNull();
    expect(q('button')).toBeNull();
  });
});

describe('device tokens', () => {
  it('the device height and title bar are tokens, not per-device numbers', () => {
    const tokens = readFileSync(path.resolve(__dirname, '../tokens.css'), 'utf8');
    expect(tokens).toMatch(/--device-h:\s*256px/);
    expect(tokens).toMatch(/--device-title-h:\s*24px/);
    const css = readFileSync(path.resolve(__dirname, '../device/DeviceFrame.module.css'), 'utf8');
    expect(css).toMatch(/height:\s*var\(--device-h\)/);
    // The offset shadow is for the floating device only.
    expect(css.match(/--ui-shadow-float/g)?.length).toBe(1);
    expect(css).toMatch(/data-presentation="floating"\][^{]*\{[^}]*--ui-shadow-float/);
  });
});
