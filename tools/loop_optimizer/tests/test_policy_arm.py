"""The round-3 policy arm: selection-first snapping, not metric ranking.

Round 1/2 tested full-auto candidate generation against gold and lost 43-3-3;
the strongest signal in those verdicts was "prefer the longer period-multiple
fade" (16-5-2), and the persistent complaint (timbre-jump) was about loop
PLACEMENT, not seam mechanics. The shipping product is selection-first — the
user drags a rough region and the machine snaps — so this arm is tested
directly against that shape rather than against the metric suite: it is a
closed-form policy (snap length to the dragged span, take the longest valid
period-multiple fade), not a search, and these tests prove the closed form
does what it claims on cases small enough to reason about by hand.
"""

from __future__ import annotations

import numpy as np
import pytest

from loop_optimizer.candidates import generate_candidates
from loop_optimizer.constants import ENGINE_SAMPLE_RATE as SR
from loop_optimizer.corpus import GoldLoop
from loop_optimizer.export import POLICY_SELECTION_MARGIN_FRAC, policy_loop


def sine(freq: float, n: int, sr: float = SR, amp: float = 0.5) -> np.ndarray:
    t = np.arange(n) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def _window_for(gold: GoldLoop, n: int) -> tuple[int, int]:
    """Reproduce policy_loop's own window math, for assertions."""
    region = gold.end - gold.start
    margin = int(round(POLICY_SELECTION_MARGIN_FRAC * region))
    return max(0, gold.start - margin), min(n, gold.end + margin)


# ── The general case: plenty of room, so the fade should never be zero ──────


def test_policy_arm_advance_is_integer_periods_and_never_zero_when_room_exists():
    period = 100.0
    x = sine(SR / period, 200_000)
    gold = GoldLoop(start=20_000, end=120_000, xfade=2_000)  # 1000 periods of room

    cand = policy_loop(x, gold, period, SR)
    assert cand is not None

    # Period-aligned by construction: length AND advance are whole multiples.
    assert cand.length == round(cand.period_multiple * period)
    advance = cand.length - cand.crossfade_samples
    in_periods = advance / period
    assert abs(in_periods - round(in_periods)) < 1e-6

    # The corpus's own strongest taste signal: with this much room, the
    # crossfade must not settle for zero.
    assert cand.crossfade_samples > 0


def test_policy_arm_picks_the_longest_valid_fade_at_its_chosen_length():
    """Not just "some" crossfade — the LONGEST one the engine clamp allows."""
    period = 100.0
    x = sine(SR / period, 200_000)
    gold = GoldLoop(start=20_000, end=120_000, xfade=2_000)

    cand = policy_loop(x, gold, period, SR)
    assert cand is not None

    window_start, window_end = _window_for(gold, x.shape[0])
    siblings = [
        c
        for c in generate_candidates(x, period, window_start, window_end, SR)
        if c.period_multiple == cand.period_multiple
    ]
    assert siblings, "the chosen candidate must come from the same search"
    assert cand.crossfade_samples == max(c.crossfade_samples for c in siblings)
    assert cand.crossfade_samples == max(cand.crossfade_samples for c in siblings)


def test_policy_arm_snaps_length_to_the_dragged_span_not_to_golds_own_span():
    """The window is gold +/- margin; the snap targets the FULL dragged span.

    Period is chosen large enough that the period multiple needed to reach
    the window span stays well under MAX_PERIOD_MULTIPLES (512) — otherwise
    the search's own runtime guard, not the snap logic, would decide the
    outcome and the test would be checking the wrong thing.
    """
    period = 100.0
    x = sine(SR / period, 100_000)
    gold = GoldLoop(start=10_000, end=40_000, xfade=1_000)

    cand = policy_loop(x, gold, period, SR)
    assert cand is not None

    window_start, window_end = _window_for(gold, x.shape[0])
    selection_span = window_end - window_start
    all_candidates = generate_candidates(x, period, window_start, window_end, SR)
    by_k: dict[int, int] = {}
    for c in all_candidates:
        by_k.setdefault(c.period_multiple, c.length)
    best_k = min(by_k, key=lambda k: abs(by_k[k] - selection_span))
    assert cand.period_multiple == best_k

    # gold's own span (30_000) is well short of the dragged window (span
    # includes the +/-15% margin); the chosen length should track the WINDOW,
    # not silently default back to gold's own span.
    gold_span = gold.end - gold.start
    assert selection_span > gold_span
    assert abs(cand.length - selection_span) < abs(cand.length - gold_span)


# ── The physically-impossible case: xfade=0 is the only honest answer ───────


def test_policy_arm_zero_crossfade_only_when_a_single_period_cannot_afford_one():
    """A single-period snap (k=1) can clamp at most half a period of fade, which
    is less than one whole period — so ``crossfade_samples == 0`` is the only
    value the engine's own clamp (``candidates.py``'s ``floor(len/2)`` cap)
    will ever allow there. That is "physically cannot fit", not the policy
    settling for a bad answer.
    """
    sr = 2_000.0
    period = 150.0
    x = sine(sr / period, 4_000, sr=sr)

    # Window sized so only k=1 is reachable: span must clear 2*period (the
    # k=1 correlation window plus the k=1 body) but not 3*period (which would
    # make k=2 reachable too).
    region = 238
    gold = GoldLoop(start=1_000, end=1_000 + region, xfade=0)
    window_start, window_end = _window_for(gold, x.shape[0])
    assert 2 * period <= window_end - window_start < 3 * period, "test setup must isolate k=1"

    cand = policy_loop(x, gold, period, sr)
    assert cand is not None
    assert cand.period_multiple == 1
    assert cand.length // 2 < period, "confirms a whole period of fade physically cannot fit"
    assert cand.crossfade_samples == 0


def test_policy_arm_returns_none_when_the_window_cannot_hold_any_candidate():
    """Better no arm than a degenerate one — mirrors naive_loop's own floor."""
    period = 150.0
    x = sine(SR / period, 20_000)
    tiny_gold = GoldLoop(start=1_000, end=1_050, xfade=0)  # far under 2 periods even with margin
    assert policy_loop(x, tiny_gold, period, SR) is None
    assert policy_loop(x, tiny_gold, float("nan"), SR) is None


# ── The metric invariant, exercised through a real degenerate candidate ─────


def test_no_zero_crossfade_arm_on_ample_material_across_a_range_of_periods():
    """Deliverable proof: across a spread of periods/regions typical of the
    stable_periodic corpus, the policy arm never emits xfade=0 unless a
    period-multiple fade is physically impossible at its chosen length.
    """
    for period in (60.0, 90.0, 133.0, 200.0):
        x = sine(SR / period, 300_000)
        gold = GoldLoop(start=30_000, end=200_000, xfade=1_000)
        cand = policy_loop(x, gold, period, SR)
        assert cand is not None, f"period={period}: expected a candidate with this much room"
        if cand.crossfade_samples == 0:
            assert cand.length // 2 < period, (
                f"period={period}: xfade=0 with length={cand.length} is only legitimate "
                "when a whole period of fade cannot fit"
            )
        else:
            assert cand.crossfade_samples > 0
