import { describe, expect, it } from 'vitest';
import {
  buildEnvelopeGraphModel,
  mapEnvelopeGraphDragToPatch,
  readEnvelopeNodeData,
  type EnvelopeGraphHandle,
  type EnvelopeNodeData,
  type PreviewPoint,
} from './EnvelopeEditor';

// EVC — regression coverage for the AHDSR drag-mapping rework. The bug this
// guards against: mapEnvelopeGraphDragToPatch used to be called with the
// *live, still-changing* AHDSR data on every pointermove. buildEnvelopeGraphModel
// derives totalMs from those same fields, so editing (say) attackMs rescaled the
// x-axis the cursor position was measured against on the very next move — a
// positive-feedback loop that either ran away or rubber-banded to zero,
// depending which side of a fixed point the cursor happened to sit on.
//
// The fix: the caller (EnvelopeAhdsrGraph) now captures a snapshot of the AHDSR
// fields once, at pointerdown, and maps every pointermove in that gesture
// against that same frozen snapshot. These tests exercise the pure mapping
// function the same way the component does: freeze a basis, then feed the same
// (fixed) cursor position through it repeatedly and confirm the result is
// stable — a pure function of cursor position, independent of the value
// actually being edited.

const W = 196;
const H = 54;

const fieldForHandle: Record<EnvelopeGraphHandle, keyof EnvelopeNodeData> = {
  attack: 'attackMs',
  hold: 'holdMs',
  decay: 'decayMs',
  sustain: 'sustain',
  release: 'releaseMs',
};

function baseData(overrides: Partial<EnvelopeNodeData> = {}) {
  return readEnvelopeNodeData({
    attackMs: 50,
    holdMs: 0,
    decayMs: 50,
    sustain: 0.5,
    releaseMs: 100,
    ...overrides,
  });
}

// Mirrors EnvelopeAhdsrGraph's drag loop: the basis is captured once and never
// recomputed from the value the gesture is producing.
function dragWithFrozenBasis(
  startData: EnvelopeNodeData,
  handle: EnvelopeGraphHandle,
  point: PreviewPoint,
  moves: number,
) {
  const basis = { ...startData };
  let current: EnvelopeNodeData = { ...startData };
  const history: number[] = [];
  for (let i = 0; i < moves; i += 1) {
    const patch = mapEnvelopeGraphDragToPatch(basis, handle, point, W, H);
    current = { ...current, ...patch } as EnvelopeNodeData;
    history.push(current[fieldForHandle[handle]] as number);
  }
  return { current, history };
}

describe('mapEnvelopeGraphDragToPatch — frozen-basis convergence', () => {
  const rightHeld = { x: Math.round(W * 0.9), y: 0 };
  const leftHeld = { x: Math.round(W * 0.1), y: 0 };

  for (const handle of ['attack', 'decay', 'release'] as const) {
    it(`${handle}: holding the cursor still settles immediately and never drifts, from several start values`, () => {
      for (const startValue of [10, 500, 4800]) {
        const data = baseData({ [fieldForHandle[handle]]: startValue } as Partial<EnvelopeNodeData>);
        const { history } = dragWithFrozenBasis(data, handle, rightHeld, 6);
        expect(history.every(Number.isFinite)).toBe(true);
        const settled = history[0];
        for (const value of history) expect(value).toBe(settled);
      }
    });

    it(`${handle}: works in both directions — a cursor held near the left settles low, held near the right settles high`, () => {
      const data = baseData();
      const { history: lowHistory } = dragWithFrozenBasis(data, handle, leftHeld, 4);
      const { history: highHistory } = dragWithFrozenBasis(data, handle, rightHeld, 4);
      expect(highHistory.at(-1)!).toBeGreaterThan(lowHistory.at(-1)!);
    });
  }

  it('regression: recomputing the basis from the evolving value (the old bug) diverges without bound', () => {
    // This intentionally does NOT freeze the basis — it recreates the pre-fix
    // behavior (model recomputed from `current` on every move) to document why
    // freezing the basis at pointerdown is required, not optional.
    let current = baseData({ attackMs: 10 });
    const point = { x: Math.round(W * 0.9), y: 0 };
    const values: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const patch = mapEnvelopeGraphDragToPatch(current, 'attack', point, W, H);
      current = { ...current, ...patch } as EnvelopeNodeData;
      values.push(current.attackMs);
    }
    expect(values.at(-1)!).toBeGreaterThan(values[0] * 5);
  });
});

describe('mapEnvelopeGraphDragToPatch — release can grow, not just shrink', () => {
  it('dragging toward the right edge increases releaseMs past its current value', () => {
    const data = baseData({ releaseMs: 100 });
    const patch = mapEnvelopeGraphDragToPatch(data, 'release', { x: W, y: H }, W, H);
    expect(patch.releaseMs).toBeGreaterThan(data.releaseMs);
  });

  it('dragging toward the left edge still collapses releaseMs down to 0', () => {
    const data = baseData({ releaseMs: 3000 });
    const patch = mapEnvelopeGraphDragToPatch(data, 'release', { x: 0, y: H }, W, H);
    expect(patch.releaseMs).toBe(0);
  });
});

describe('buildEnvelopeGraphModel — release headroom and handle separation', () => {
  it('never pins the release point to the right edge, leaving room to drag further right', () => {
    const data = baseData({ attackMs: 8000, holdMs: 3000, decayMs: 7000, sustain: 0.2, releaseMs: 9000 });
    const model = buildEnvelopeGraphModel(data, W, H);
    const releasePoint = model.points.at(-1)!;
    expect(releasePoint.x).toBeLessThan(W);
    expect(releasePoint.x).toBeGreaterThan(0);
  });

  it('gives attack and hold handles a minimum x separation when both would otherwise land on the same point', () => {
    // holdMs: 0 (the shipped default) puts attack and hold at the exact same
    // cumulative time — without a hit-test nudge, whichever renders on top wins
    // every pointer event and the other becomes permanently unreachable.
    const data = baseData({ attackMs: 200, holdMs: 0, decayMs: 200, sustain: 0.5, releaseMs: 200 });
    const model = buildEnvelopeGraphModel(data, W, H);
    const attackHandle = model.handles.find((handle) => handle.handle === 'attack')!;
    const holdHandle = model.handles.find((handle) => handle.handle === 'hold')!;
    expect(holdHandle.x).toBeGreaterThan(attackHandle.x);

    // The nudge is hit-testing only — it must not distort the drawn curve.
    const attackPoint = model.points[1];
    const holdPoint = model.points[2];
    expect(holdPoint.x).toBe(attackPoint.x);
  });
});
