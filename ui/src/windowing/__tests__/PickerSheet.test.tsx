/**
 * @vitest-environment jsdom
 */
import React, { act } from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import XlethRootContext from '../contexts/XlethRootContext.jsx';
import { PickerSheet, PICKER_SHEET_MIN_HEIGHT } from '../components/PickerSheet';
import { isSamplePickerKeyTarget, isSamplePickerOpen } from '../../stores/samplePickerGate.js';

const read = (rel: string) => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');

const SOURCE = { id: 7, name: 'clip.wav', filePath: 'C:/clip.wav', duration: 10, hasVideo: false };

function stubBridge() {
  const audio = {
    loadSource: vi.fn(() => Promise.resolve({ success: true, duration: 10 })),
    unloadSource: vi.fn(() => Promise.resolve()),
    stopSource: vi.fn(() => Promise.resolve()),
    playSource: vi.fn(() => Promise.resolve()),
    pauseSource: vi.fn(() => Promise.resolve()),
    seekSource: vi.fn(() => Promise.resolve()),
    getSourcePosition: vi.fn(() => Promise.resolve(0)),
    isSourcePlaying: vi.fn(() => Promise.resolve(true)),
  };
  (globalThis.window as unknown as { xleth: unknown }).xleth = {
    audio,
    waveform: { getFilePeaks: vi.fn(() => Promise.resolve(null)) },
    timeline: { getRegions: vi.fn(() => Promise.resolve([])) },
  };
  return audio;
}

// jsdom has no 2d canvas: the waveform draws into a recording stub.
const gradient = { addColorStop: () => {} };
function stubCtx() {
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: 1000, height: 132 };
      if (prop === 'measureText') return () => ({ width: 0 });
      return () => gradient;
    },
    set: () => true,
  });
}

describe('PickerSheet', () => {
  let container: HTMLDivElement;
  let root: Root;
  let outside: HTMLButtonElement;
  const onClose = vi.fn();

  const render = async (pickerSource: typeof SOURCE | null) => {
    await act(async () => {
      root.render(
        <XlethRootContext.Provider
          value={{ ...(XlethRootContextDefaults()), pickerSource, onClosePicker: onClose } as never}
        >
          <div className="xleth-center-column">
            <PickerSheet />
            <button id="outside" type="button">arrangement</button>
          </div>
        </XlethRootContext.Provider>,
      );
    });
  };

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onClose.mockClear();
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = stubCtx;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
    delete (globalThis.window as unknown as { xleth?: unknown }).xleth;
  });

  it('renders nothing while no source is being picked', async () => {
    stubBridge();
    await render(null);
    expect(container.querySelector('[data-testid="picker-sheet"]')).toBeNull();
    expect(isSamplePickerOpen()).toBe(false);
  });

  it('opens as a named region with a floor on its height, and leaves the arrangement mounted', async () => {
    stubBridge();
    await render(SOURCE);
    const sheet = container.querySelector<HTMLElement>('[data-testid="picker-sheet"]')!;
    expect(sheet.getAttribute('aria-label')).toBe('Sample picker: clip.wav');
    expect(sheet.style.getPropertyValue('--picker-sheet-h')).toBe(`${PICKER_SHEET_MIN_HEIGHT}px`);
    expect(container.querySelector('#outside')).not.toBeNull();
  });

  it('moves focus into the sheet on open and returns it to the opener on close', async () => {
    stubBridge();
    await render(null);
    outside = container.querySelector('#outside') as HTMLButtonElement;
    outside.focus();
    expect(document.activeElement).toBe(outside);

    await render(SOURCE);
    const sheet = container.querySelector<HTMLElement>('[data-testid="picker-sheet"]')!;
    expect(document.activeElement).toBe(sheet);

    await render(null);
    expect(document.activeElement).toBe(outside);
  });

  it('Escape closes the picker from inside the sheet, not from the arrangement', async () => {
    stubBridge();
    await render(SOURCE);
    outside = container.querySelector('#outside') as HTMLButtonElement;

    await act(async () => {
      outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    const sheet = container.querySelector<HTMLElement>('[data-testid="picker-sheet"]')!;
    await act(async () => {
      sheet.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Space previews inside the sheet but is left to the transport out in the arrangement', async () => {
    const audio = stubBridge();
    await render(SOURCE);
    outside = container.querySelector('#outside') as HTMLButtonElement;

    const outsideSpace = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    await act(async () => { outside.dispatchEvent(outsideSpace); });
    expect(audio.playSource).not.toHaveBeenCalled();
    expect(outsideSpace.defaultPrevented).toBe(false);
    expect(isSamplePickerKeyTarget({ target: outside })).toBe(false);

    const sheet = container.querySelector<HTMLElement>('[data-testid="picker-sheet"]')!;
    const insideSpace = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
    await act(async () => { sheet.dispatchEvent(insideSpace); });
    expect(audio.playSource).toHaveBeenCalledTimes(1);
    expect(insideSpace.defaultPrevented).toBe(true);
    expect(isSamplePickerKeyTarget({ target: sheet })).toBe(true);
  });

  it('a different source remounts the picker (the old one is unloaded)', async () => {
    const audio = stubBridge();
    await render(SOURCE);
    expect(audio.loadSource).toHaveBeenCalledTimes(1);
    await render({ ...SOURCE, id: 8, name: 'other.wav', filePath: 'C:/other.wav' });
    expect(audio.unloadSource).toHaveBeenCalled();
    expect(audio.loadSource).toHaveBeenCalledTimes(2);
  });

  it('the shell is never hidden to make room: no display:none takeover, and the sheet lives in the centre column', () => {
    const root = read('XlethRoot.jsx');
    expect(root).not.toMatch(/display:\s*pickerSource/);
    expect(root).not.toContain("SamplePicker from './components/SamplePicker/SamplePicker.jsx'");
    const shell = read('windowing/AppShell.tsx');
    expect(shell.indexOf('<PickerSheet />')).toBeGreaterThan(shell.indexOf('xleth-center-column'));
    expect(shell.indexOf('<PickerSheet />')).toBeLessThan(shell.indexOf('<DetailDock'));
  });
});

// The context's own defaults, so the test does not hand-copy the whole shape.
function XlethRootContextDefaults() {
  const noop = () => {};
  return {
    onOpenPicker: noop,
    activeSampleId: null,
    setActiveSampleId: noop,
    currentPatternIdByTrack: {},
    setCurrentPatternIdByTrack: noop,
    activeCenterTab: 'timeline',
    availablePatterns: [],
    onSwitchPattern: null,
    onNewPattern: noop,
    onOpenMidiImport: noop,
  };
}
