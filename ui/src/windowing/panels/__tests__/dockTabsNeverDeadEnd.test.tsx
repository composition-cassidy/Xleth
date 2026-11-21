/**
 * @vitest-environment jsdom
 */
// Round 3 (ui/DESIGN.md 14, 15): shown with nothing chosen, the Piano Roll opens a pattern and
// the Sampler shows a sampler. Neither switches a dock tab, moves focus or calls the engine to
// decide; closing the Piano Roll still closes it.
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../components/pianoRoll/PianoRoll.jsx', () => ({
  default: (props: { patternId: number | null; projectHasPatterns?: boolean }) => (
    <div data-testid="piano-roll" data-pattern={String(props.patternId)} data-has-patterns={String(props.projectHasPatterns)} />
  ),
}));
vi.mock('../../../components/sampler/SamplerPanelContent.jsx', () => ({
  default: (props: { regionId: number }) => <div data-testid="sampler" data-region={String(props.regionId)} />,
}));

import PianoRollPanel from '../PianoRollPanel';
import SamplerWindowPanel from '../SamplerWindowPanel';
import XlethRootContext from '../../contexts/XlethRootContext.jsx';
import usePianoRollStore from '../../../stores/usePianoRollStore.js';
import { usePanelRegistry } from '../../registry/PanelRegistry';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PATTERNS = { 3: { id: 3, name: 'A', regionId: 40 }, 7: { id: 7, name: 'B', regionId: 41 } };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function mount(node: React.ReactNode, allPatterns: Record<number, unknown> = PATTERNS) {
  const value = { availablePatterns: [], allPatterns, onSwitchPattern: null, onNewPattern: () => {} };
  return act(async () => {
    root.render(<XlethRootContext.Provider value={value as never}>{node}</XlethRootContext.Provider>);
  });
}

beforeEach(() => {
  usePanelRegistry.getState().resetLayout();
  usePianoRollStore.setState({ patternId: null, lastPatternId: null, detached: false, activeCenterTab: 'timeline' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('Piano Roll tab', () => {
  it('shown with no pattern open, it opens the first pattern, without an event and without touching the dock', async () => {
    const dispatched = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    usePanelRegistry.getState().openPanel('pianoRoll');
    const focusedBefore = document.activeElement;
    await mount(<PianoRollPanel />);

    expect(usePianoRollStore.getState().patternId).toBe(3);
    expect(container.querySelector('[data-testid="piano-roll"]')?.getAttribute('data-pattern')).toBe('3');
    // No "open-piano-roll" (that event switches tabs and focus).
    expect(dispatched.mock.calls.some(([e]) => (e as Event).type === 'open-piano-roll')).toBe(false);
    expect(document.activeElement).toBe(focusedBefore);
    expect(usePianoRollStore.getState().activeCenterTab).toBe('timeline');
    dispatched.mockRestore();
  });

  it('prefers the pattern that was last open, and replaces one that no longer exists', async () => {
    usePianoRollStore.setState({ patternId: null, lastPatternId: 7 });
    usePanelRegistry.getState().openPanel('pianoRoll');
    await mount(<PianoRollPanel />);
    expect(usePianoRollStore.getState().patternId).toBe(7);

    // The open pattern is deleted from the project: the tab moves to one that exists.
    await mount(<PianoRollPanel />, { 3: PATTERNS[3] });
    expect(usePianoRollStore.getState().patternId).toBe(3);
  });

  it('does nothing while the panel is hidden, so a closed Piano Roll stays closed', async () => {
    expect(usePanelRegistry.getState().panels.pianoRoll.hidden).toBe(true);
    await mount(<PianoRollPanel />);
    expect(usePianoRollStore.getState().patternId).toBeNull();
  });

  it('leaves an open pattern alone', async () => {
    usePianoRollStore.setState({ patternId: 7, lastPatternId: 3 });
    usePanelRegistry.getState().openPanel('pianoRoll');
    await mount(<PianoRollPanel />);
    expect(usePianoRollStore.getState().patternId).toBe(7);
  });

  it('with no patterns in the project it opens nothing and tells the Piano Roll so', async () => {
    usePanelRegistry.getState().openPanel('pianoRoll');
    await mount(<PianoRollPanel />, {});
    expect(usePianoRollStore.getState().patternId).toBeNull();
    expect(container.querySelector('[data-testid="piano-roll"]')?.getAttribute('data-has-patterns')).toBe('false');
  });
});

describe('Sampler tab', () => {
  it('opened with nothing handed over, it shows the open pattern\'s sampler', async () => {
    usePianoRollStore.setState({ patternId: 7, lastPatternId: 7 });
    usePanelRegistry.getState().openPanel('sampler');
    await mount(<SamplerWindowPanel />);
    expect(container.querySelector('[data-testid="sampler"]')?.getAttribute('data-region')).toBe('41');
  });

  it('with no pattern open it shows the last one\'s, else the first\'s', async () => {
    usePanelRegistry.getState().openPanel('sampler');
    usePianoRollStore.setState({ patternId: null, lastPatternId: 7 });
    await mount(<SamplerWindowPanel />);
    expect(container.querySelector('[data-testid="sampler"]')?.getAttribute('data-region')).toBe('41');

    usePianoRollStore.setState({ patternId: null, lastPatternId: null });
    await mount(<SamplerWindowPanel />);
    expect(container.querySelector('[data-testid="sampler"]')?.getAttribute('data-region')).toBe('40');
  });

  it('a region handed over by whoever opened it wins', async () => {
    usePianoRollStore.setState({ patternId: 7, lastPatternId: 7 });
    usePanelRegistry.getState().openPanel('sampler', { regionId: 99 });
    await mount(<SamplerWindowPanel />);
    expect(container.querySelector('[data-testid="sampler"]')?.getAttribute('data-region')).toBe('99');
  });

  it('the empty state is left for a project where no pattern plays a sample', async () => {
    usePanelRegistry.getState().openPanel('sampler');
    await mount(<SamplerWindowPanel />, {});
    expect(container.querySelector('[data-testid="sampler"]')).toBeNull();
    expect(container.textContent).toContain('No pattern in this project plays a sample yet');
  });
});
