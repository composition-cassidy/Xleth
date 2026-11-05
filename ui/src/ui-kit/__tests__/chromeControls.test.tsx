/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, EmptyState, Fader, IconButton, Knob, Meter, NumberBox, PanelHeader, SectionHeader, SegmentedControl, Select, Tabs, Toggle, Toolbar, ToolbarSeparator } from '../index';

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
const key = (el: Element, k: string, init: Record<string, unknown> = {}) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })); });
const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

describe('hint plumbing: hint / hintMods become data-hint / data-hint-mods on every control', () => {
  const noop = () => {};
  const cases: Array<[string, React.ReactElement]> = [
    ['Knob', <Knob label="K" value={1} min={0} max={2} hint="H" hintMods="M" />],
    ['NumberBox', <NumberBox label="N" value={1} min={0} max={2} hint="H" hintMods="M" />],
    ['Fader', <Fader label="F" value={0} hint="H" hintMods="M" />],
    ['Meter', <Meter label="Me" subscribe={() => noop} hint="H" hintMods="M" />],
    ['Button', <Button hint="H" hintMods="M">B</Button>],
    ['IconButton', <IconButton label="I" hint="H" hintMods="M"><svg /></IconButton>],
    ['Toggle', <Toggle on={false} hint="H" hintMods="M">T</Toggle>],
    ['SegmentedControl', <SegmentedControl label="S" value="a" options={[{ value: 'a', label: 'A' }]} hint="H" hintMods="M" />],
    ['Tabs', <Tabs label="Ta" value="a" tabs={[{ id: 'a', label: 'A' }]} hint="H" hintMods="M" />],
    ['Toolbar', <Toolbar label="To" hint="H" hintMods="M"><Button>x</Button></Toolbar>],
    ['PanelHeader', <PanelHeader title="P" hint="H" hintMods="M" />],
    ['SectionHeader', <SectionHeader hint="H" hintMods="M">S</SectionHeader>],
    ['EmptyState', <EmptyState message="None" hint="H" hintMods="M" />],
    ['Select', <Select value="a" options={[{ value: 'a', label: 'A' }]} hint="H" hintMods="M" ariaLabel="Sel" />],
  ];
  it.each(cases)('%s', (_name, el) => {
    render(el);
    const host = container.querySelector('[data-hint="H"]') as HTMLElement;
    expect(host).not.toBeNull();
    expect(host.getAttribute('data-hint-mods')).toBe('M');
  });

  it('absent when not given (the hint bar falls back to aria-label)', () => {
    render(<Button>Plain</Button>);
    const b = container.querySelector('button')!;
    expect(b.hasAttribute('data-hint')).toBe(false);
    expect(b.hasAttribute('data-hint-mods')).toBe(false);
  });
});

describe('Button / IconButton / Toggle', () => {
  it('Button is a real button, type=button by default, sized and disabled', () => {
    const onClick = vi.fn();
    render(<Button size="sm" onClick={onClick}>Add track</Button>);
    const b = container.querySelector('button')!;
    expect(b.type).toBe('button');
    expect(b.dataset.size).toBe('sm');
    click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    render(<Button disabled onClick={onClick}>Add track</Button>);
    click(container.querySelector('button')!);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('IconButton needs a label (aria-label) and is aria-pressed when it is a toggle', () => {
    render(<IconButton label="Auto scroll" pressed={true}><svg /></IconButton>);
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-label')).toBe('Auto scroll');
    expect(b.getAttribute('aria-pressed')).toBe('true');
    render(<IconButton label="Stop"><svg /></IconButton>);
    expect(container.querySelector('button')!.hasAttribute('aria-pressed')).toBe(false);
  });

  it('Toggle: aria-pressed carries state, click flips it, glyph is decorative', () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} glyph={<b>M</b>}>Mute</Toggle>);
    const b = container.querySelector('button')!;
    expect(b.getAttribute('aria-pressed')).toBe('false');
    expect(b.querySelector('[aria-hidden="true"]')).not.toBeNull();
    click(b);
    expect(onChange).toHaveBeenLastCalledWith(true);
    render(<Toggle on={true} onChange={onChange}>Mute</Toggle>);
    const on = container.querySelector('button')!;
    expect(on.getAttribute('aria-pressed')).toBe('true');
    click(on);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('Toggle does not flip when the consumer prevents default', () => {
    const onChange = vi.fn();
    render(<Toggle on={false} onChange={onChange} onClick={(e) => e.preventDefault()}>X</Toggle>);
    click(container.querySelector('button')!);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'a', label: 'Play / stop' },
    { value: 'b', label: 'Play / pause' },
    { value: 'c', label: 'Third', disabled: true },
    { value: 'd', label: 'Fourth' },
  ];

  it('is a radiogroup; the selected segment is aria-checked and the only tab stop', () => {
    render(<SegmentedControl label="Spacebar" value="b" options={options} />);
    expect(container.querySelector('[role="radiogroup"]')!.getAttribute('aria-label')).toBe('Spacebar');
    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
  });

  it('click selects; arrows move focus AND select, skipping disabled segments', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Spacebar" value="b" options={options} onChange={onChange} />);
    const radios = Array.from(container.querySelectorAll<HTMLElement>('[role="radio"]'));
    click(radios[0]);
    expect(onChange).toHaveBeenLastCalledWith('a');
    act(() => radios[1].focus());
    key(radios[1], 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('d'); // skipped the disabled one
    expect(document.activeElement).toBe(radios[3]);
  });
});

describe('Tabs', () => {
  const tabs = [
    { id: 'devices', label: 'Devices' },
    { id: 'mixer', label: 'Mixer' },
    { id: 'roll', label: 'Piano roll' },
  ];

  it('tablist semantics: aria-selected, roving tab stop', () => {
    render(<Tabs label="Detail dock" value="mixer" tabs={tabs} />);
    const t = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    expect(t.map((x) => x.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(t.map((x) => x.tabIndex)).toEqual([-1, 0, -1]);
  });

  it('arrows wrap, Home/End jump, and move selection', () => {
    const onChange = vi.fn();
    render(<Tabs label="Detail dock" value="mixer" tabs={tabs} onChange={onChange} />);
    const t = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'));
    act(() => t[1].focus());
    key(t[1], 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('roll');
    key(t[2], 'ArrowRight');
    expect(onChange).toHaveBeenLastCalledWith('devices'); // wraps
    key(document.activeElement!, 'End');
    expect(onChange).toHaveBeenLastCalledWith('roll');
  });
});

describe('Toolbar', () => {
  it('roves focus among enabled buttons with the arrow keys', () => {
    render(
      <Toolbar label="Tools">
        <IconButton label="Draw"><svg /></IconButton>
        <IconButton label="Delete" disabled><svg /></IconButton>
        <ToolbarSeparator />
        <IconButton label="Slice"><svg /></IconButton>
      </Toolbar>,
    );
    const bar = container.querySelector('[role="toolbar"]')!;
    const [draw, , slice] = Array.from(container.querySelectorAll<HTMLElement>('button'));
    act(() => draw.focus());
    key(draw, 'ArrowRight');
    expect(document.activeElement).toBe(slice);
    key(slice, 'ArrowRight');
    expect(document.activeElement).toBe(draw);
    key(draw, 'End');
    expect(document.activeElement).toBe(slice);
    expect(bar.getAttribute('aria-label')).toBe('Tools');
  });
});

describe('Select (same keyboard behaviour as XlethSelect)', () => {
  const options = [
    { value: 'auto', label: 'Auto' },
    { value: 'sw', label: 'Software' },
    { value: 'off', label: 'Off', disabled: true },
    { value: 'hw', label: 'Hardware' },
  ];
  const trigger = () => container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement;
  const popup = () => document.querySelector('[role="listbox"]');
  const optionEls = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

  it('renders the selected label, aria-haspopup, never a native <select>', () => {
    render(<Select value="sw" options={options} ariaLabel="Decode" />);
    expect(trigger().textContent).toContain('Software');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('select')).toBeNull();
  });

  it('matches numeric values loosely, like XlethSelect', () => {
    render(<Select value="10" options={[{ value: 5, label: '5 min' }, { value: 10, label: '10 min' }]} ariaLabel="x" />);
    expect(trigger().textContent).toContain('10 min');
  });

  it('ArrowDown opens on the selected option; Down moves, skipping disabled; Enter selects and refocuses', () => {
    const onChange = vi.fn();
    render(<Select value="sw" options={options} onChange={onChange} ariaLabel="Decode" />);
    act(() => trigger().focus());
    key(trigger(), 'ArrowDown');
    expect(popup()).not.toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(optionEls()[1].getAttribute('data-highlighted')).toBe('true');
    key(trigger(), 'ArrowDown'); // 'off' is disabled -> lands on Hardware
    expect(optionEls()[3].getAttribute('data-highlighted')).toBe('true');
    key(trigger(), 'Enter');
    expect(onChange).toHaveBeenCalledWith('hw');
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Space and Enter open; ArrowUp wraps; Escape closes and keeps focus on the trigger', () => {
    render(<Select value="auto" options={options} ariaLabel="Decode" />);
    act(() => trigger().focus());
    key(trigger(), ' ');
    expect(popup()).not.toBeNull();
    key(trigger(), 'ArrowUp'); // wraps from Auto to the last enabled option
    expect(optionEls()[3].getAttribute('data-highlighted')).toBe('true');
    key(window as unknown as Element, 'Escape');
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Tab closes the list', () => {
    render(<Select value="auto" options={options} ariaLabel="Decode" />);
    act(() => trigger().focus());
    key(trigger(), 'Enter');
    expect(popup()).not.toBeNull();
    key(trigger(), 'Tab');
    expect(popup()).toBeNull();
  });

  it('clicking an option selects it; clicking a disabled one does nothing', () => {
    const onChange = vi.fn();
    render(<Select value="auto" options={options} onChange={onChange} ariaLabel="Decode" />);
    click(trigger());
    click(optionEls()[2]);
    expect(onChange).not.toHaveBeenCalled();
    click(optionEls()[1]);
    expect(onChange).toHaveBeenCalledWith('sw');
  });

  it('openSignal pops the list open without a click and focuses the trigger', () => {
    render(<Select value="auto" options={options} ariaLabel="Decode" openSignal={0} />);
    expect(popup()).toBeNull();
    render(<Select value="auto" options={options} ariaLabel="Decode" openSignal={1} />);
    expect(popup()).not.toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('disabled: cannot open, and the popup closes if it becomes disabled', () => {
    render(<Select value="auto" options={options} ariaLabel="Decode" disabled />);
    expect(trigger().disabled).toBe(true);
    click(trigger());
    expect(popup()).toBeNull();
    render(<Select value="auto" options={options} ariaLabel="Decode" />);
    click(trigger());
    expect(popup()).not.toBeNull();
    render(<Select value="auto" options={options} ariaLabel="Decode" disabled />);
    expect(popup()).toBeNull();
  });
});

describe('structure components', () => {
  it('PanelHeader is a 28px header element with a title and right-aligned actions', () => {
    render(<PanelHeader title="Mixer" meta="12 tracks"><IconButton label="Close"><svg /></IconButton></PanelHeader>);
    const h = container.querySelector('header')!;
    expect(h.querySelector('h2')!.textContent).toBe('Mixer');
    expect(h.textContent).toContain('12 tracks');
    expect(h.querySelector('button[aria-label="Close"]')).not.toBeNull();
  });

  it('SectionHeader names a device section', () => {
    render(<SectionHeader actions={<span>x</span>}>Feedback</SectionHeader>);
    const s = container.querySelector('[role="heading"]')!;
    expect(s.textContent).toContain('Feedback');
    expect(s.getAttribute('aria-level')).toBe('3');
  });

  it('EmptyState is direct copy plus at most one inline action, no icon', () => {
    const onAction = vi.fn();
    render(<EmptyState message="No tracks. Add a clip track or a pattern track." actionLabel="Add track" onAction={onAction} />);
    expect(container.textContent).toContain('No tracks. Add a clip track or a pattern track.');
    expect(container.querySelectorAll('button').length).toBe(1);
    expect(container.querySelector('svg')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    click(container.querySelector('button')!);
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('EmptyState with no action renders no button', () => {
    render(<EmptyState message="Nothing here." />);
    expect(container.querySelector('button')).toBeNull();
  });
});

// Stylesheet contract, asserted on the source (vitest does not process CSS modules).
describe('kit stylesheets', () => {
  const dir = path.resolve(__dirname, '..');
  const sheets = readdirSync(dir).filter((f) => f.endsWith('.module.css'));

  it('there is a CSS module per component group', () => {
    expect(sheets.length).toBeGreaterThanOrEqual(12);
  });

  it.each(sheets)('%s is wrapped in @layer kit and uses tokens only', (file) => {
    const css = readFileSync(path.join(dir, file), 'utf8');
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(stripped.startsWith('@layer kit')).toBe(true);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgba?|hsla?)\(/);
    expect(css).not.toMatch(/transition\s*:\s*all/);
    expect(css).not.toMatch(/(box-shadow|text-shadow)\s*:(?!\s*var\(--ui-shadow-float\)|\s*none)/);
    expect(css).not.toMatch(/(linear|radial|conic)-gradient/);
    expect(css).not.toMatch(/\bfilter\s*:\s*blur|drop-shadow|backdrop-filter/);
  });

  it('only the floating Select popup carries a shadow', () => {
    const withShadow = sheets.filter((f) => /box-shadow/.test(readFileSync(path.join(dir, f), 'utf8')));
    expect(withShadow).toEqual(['Select.module.css']);
  });

  // Every interactive control has a hover/focus-visible state and a disabled state.
  it.each(['Button', 'Toggle', 'SegmentedControl', 'Tabs', 'Select', 'Knob', 'NumberBox', 'Fader'])('%s styles focus-visible', (name) => {
    const css = readFileSync(path.join(dir, `${name === 'Toggle' ? 'Button' : name}.module.css`), 'utf8');
    expect(css).toMatch(/focus-visible/);
  });

  it.each(['Button', 'SegmentedControl', 'Tabs', 'Select', 'Knob', 'NumberBox', 'Fader'])('%s styles a disabled state at the shared mute opacity', (name) => {
    const css = readFileSync(path.join(dir, `${name}.module.css`), 'utf8');
    expect(css).toMatch(/--ui-mute-opacity/);
  });

  it.each(['Button', 'SegmentedControl', 'Tabs', 'Knob', 'Fader'])('%s guarantees a 24px hit area', (name) => {
    const css = readFileSync(path.join(dir, `${name}.module.css`), 'utf8');
    expect(css).toMatch(/--hit-min/);
  });
});
