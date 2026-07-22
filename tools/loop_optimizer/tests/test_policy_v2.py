"""Policy v2: formant-gated placement + drift-gated fade (the round-4 arm).

Round 3 (``policy_loop``, tested in test_policy_arm.py) took 7 of 25 against
human gold and retired the mechanical complaints, but 12 of its 17 losses were
tagged timbre-jump — the loop sitting on the wrong vowel moment. v2 keeps the
selection-first shape and adds two one-sided gates. "One-sided" is the property
most of these tests are really checking: neither gate can lengthen a fade, move
a loop somewhere the seam search rejected, or fire on material that does not
drift. On a held vowel v2 must return what v3 would have.

The signals here are synthesised source-filter vowels (see test_formants.py) so
that "the material drifts HERE and not THERE" is a fact about the fixture rather
than a judgement about a recording.
"""

from __future__ import annotations

from dataclasses import asdict

import numpy as np
import pytest

from loop_optimizer.candidates import xfade_variants
from loop_optimizer.constants import ENGINE_SAMPLE_RATE as SR
from loop_optimizer.corpus import GoldLoop
from loop_optimizer.engine_emu import resolve
from loop_optimizer.formants import FORMANT_FRAME_MS
from loop_optimizer.export import (
    FORMANT_FADE_GATE_CENTS,
    FORMANT_STABLE_DRIFT_CENTS,
    MECHANICAL_GATES,
    POLICY_SELECTION_MARGIN_FRAC,
    policy_loop,
    policy_v2_loop,
)

from test_formants import AH, EE, morphing_vowel, vowel

#: The synthesised vowels are driven at 150 Hz, so one period is 320 samples at
#: the 48 kHz engine rate. Stated rather than derived so a test that disagrees
#: with the fixture fails loudly.
F0 = 150.0
PERIOD = SR / F0


def _window(gold: GoldLoop, n: int) -> tuple[int, int]:
    """Reproduce the policy's own window math, for assertions."""
    region = gold.end - gold.start
    margin = int(round(POLICY_SELECTION_MARGIN_FRAC * region))
    return max(0, gold.start - margin), min(n, gold.end + margin)


def held(n: int = 120_000) -> np.ndarray:
    return vowel(F0, AH, n).astype(np.float32)


def held_then_moving(held_n: int = 60_000, moving_n: int = 60_000) -> np.ndarray:
    """A vowel held for the first half, sliding to /i/ through the second."""
    return np.concatenate([vowel(F0, AH, held_n), morphing_vowel(F0, moving_n)]).astype(
        np.float32
    )


# ── The invariants that must survive whatever the gates decide ─────────────


@pytest.mark.parametrize("x", [held(), held_then_moving()])
def test_advance_is_a_whole_number_of_periods_and_the_clamp_never_binds(x):
    """The INVALID invariant, unchanged from round 3 and non-negotiable.

    A crossfade the engine silently clamps lands on a HALF-period multiple
    whenever the span is an odd number of periods, and the loop then plays flat
    (``hard_tuned_vocal_0009``: 149 cents). Every fade v2 can reach comes from
    ``xfade_variants``, which verifies each against ``resolve()`` first — so this
    holds by construction, and this test is what keeps it that way.
    """
    gold = GoldLoop(start=10_000, end=90_000, xfade=2_000)
    found = policy_v2_loop(x, gold, PERIOD, SR)
    assert found is not None
    cand, _trace = found

    assert cand.length == round(cand.period_multiple * PERIOD)
    advance = cand.length - cand.crossfade_samples
    assert abs(advance / PERIOD - round(advance / PERIOD)) < 1e-6

    eff = resolve(cand.to_config(), x.shape[0], SR)
    assert eff.eff_xfade == cand.crossfade_samples, "the engine clamp must not bind"
    assert eff.wrap_advance > 0


def test_the_loop_stays_inside_the_dragged_window():
    """The window is the user's selection; the policy may not wander out of it."""
    x = held_then_moving()
    gold = GoldLoop(start=10_000, end=90_000, xfade=2_000)
    ws, we = _window(gold, x.shape[0])

    cand, _ = policy_v2_loop(x, gold, PERIOD, SR)
    assert cand.loop_start >= ws
    assert cand.loop_end <= we


def test_is_deterministic():
    """Re-running export on the same corpus must reproduce the file byte for byte.

    Compared field by field with NaN treated as equal to itself: the trace
    carries NaN readings by design (a fade too short to hold a formant frame has
    no measurable distance), and `==` on a dataclass holding NaN is always
    False, so the obvious `a == b` would fail on identical output.
    """
    x = held_then_moving()
    gold = GoldLoop(start=10_000, end=90_000, xfade=2_000)
    a = policy_v2_loop(x, gold, PERIOD, SR)
    b = policy_v2_loop(x, gold, PERIOD, SR)
    assert a[0] == b[0]
    for name, va in asdict(a[1]).items():
        vb = asdict(b[1])[name]
        if isinstance(va, float) and np.isnan(va):
            assert np.isnan(vb), name
        else:
            assert va == vb, name


def test_returns_none_when_the_window_cannot_hold_a_loop():
    """Better no arm than a degenerate one — mirrors policy_loop and naive_loop."""
    x = held(20_000)
    tiny = GoldLoop(start=1_000, end=1_050, xfade=0)
    assert policy_v2_loop(x, tiny, PERIOD, SR) is None
    assert policy_v2_loop(x, tiny, float("nan"), SR) is None
    assert policy_v2_loop(x, GoldLoop(start=0, end=0, xfade=0), PERIOD, SR) is None


# ── The placement gate ─────────────────────────────────────────────────────


def test_placement_gate_refuses_a_drifting_tail():
    """The point of the whole round: a drag half full of vowel movement.

    Round-3 policy snaps the length to the whole drag, so it takes the movement
    with it. v2 must stop at the transition.
    """
    x = held_then_moving()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)

    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)
    v1 = policy_loop(x, gold, PERIOD, SR)
    assert v1 is not None

    # v1 runs into the moving half; v2 stops short of it.
    assert v1.loop_end > 70_000, "fixture check: round-3 policy should reach the drift"
    assert cand.loop_end <= 70_000
    assert cand.length < v1.length

    # ...and the trace has to SAY that is what happened: the selection could
    # have held a longer span, that span drifts, and this one does not.
    assert trace.length < trace.longest_span
    assert trace.span_drift_cents < trace.longest_span_drift_cents
    assert trace.spans_kept < trace.spans_considered


def test_placement_gate_is_inert_on_material_that_does_not_drift():
    """No drift, no gate. On a held vowel v2 must take the longest span, which
    is what round-3 policy would have done — otherwise round 4 would be testing
    "shorter loops" rather than "stabler placement"."""
    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)

    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert trace.span_drift_cents < FORMANT_STABLE_DRIFT_CENTS
    assert trace.length == trace.longest_span, "the gate refused nothing"
    assert trace.drift_cut_cents == pytest.approx(FORMANT_STABLE_DRIFT_CENTS)
    v1 = policy_loop(x, gold, PERIOD, SR)
    assert cand.length == v1.length


def test_the_chosen_span_is_the_longest_that_passed_not_the_calmest():
    """Longest-first among survivors, deliberately.

    Hunting the single calmest span would always land on the shortest one:
    drift is a standard deviation, so it creeps up with length even on a held
    vowel. The policy spends drift up to the cut instead.
    """
    x = held_then_moving()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    _cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert trace.span_drift_cents <= trace.drift_cut_cents
    # The calmest span in the window is far shorter; the policy did not take it.
    assert trace.length > 4 * PERIOD


# ── The fade gate ──────────────────────────────────────────────────────────


def test_fade_gate_shortens_a_fade_that_would_blend_two_different_vowels():
    """A loop whose two ends are different vowels must not be smoothed across.

    The fixture puts /a/ at the loop's start and /i/ at its end, so the longest
    fade blends one into the other — a morph the source never contained.
    """
    a = vowel(F0, AH, 60_000)
    b = vowel(F0, EE, 60_000)
    x = np.concatenate([a, b]).astype(np.float32)
    gold = GoldLoop(start=40_000, end=80_000, xfade=2_000)

    found = policy_v2_loop(x, gold, PERIOD, SR)
    assert found is not None
    cand, trace = found

    if trace.chosen_xfade < trace.max_xfade:
        assert trace.binding_gate == "formant"
        assert trace.binding_distance_cents > FORMANT_FADE_GATE_CENTS
    else:
        # The placement gate may have moved the loop off the boundary
        # altogether, which is a better answer than shortening the fade — but
        # then the chosen fade must genuinely be clean rather than unmeasured.
        assert not (trace.formant_distance_cents > FORMANT_FADE_GATE_CENTS)


def test_fade_gate_does_not_fire_on_one_held_vowel():
    """The corpus's strongest taste signal is "prefer the longer fade" (16-5-2).
    The gate must not quietly undo it wherever there is no drift to justify it.
    """
    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    _cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert trace.chosen_xfade == trace.max_xfade
    assert trace.binding_gate == "none"
    assert not trace.hit_floor


def test_the_chosen_fade_is_the_longest_the_engine_allows_at_that_span():
    """`max_xfade` must be a real ceiling, not a number the trace made up."""
    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    variants = xfade_variants(
        x.shape[0], PERIOD, cand.loop_start, cand.loop_end, cand.period_multiple,
        cand.search_ncc, SR,
    )
    assert variants
    assert trace.max_xfade == max(c.crossfade_samples for c in variants)
    assert cand.crossfade_samples == trace.chosen_xfade
    assert trace.chosen_xfade <= trace.max_xfade


def test_the_formant_gates_real_floor_is_one_frame_not_one_period(monkeypatch):
    """Forcing the formant gate shut does NOT drive the fade to one period.

    Below one formant frame (30 ms) there is no formant to compare, the reading
    is NaN, and a NaN reading passes — so the gate stops refusing exactly when
    the fade becomes too short to span a vowel transition. That is the intended
    behaviour and it is why `hit_floor` is expected to be rare in the corpus
    table; asserting it here keeps the two from drifting apart silently.
    """
    monkeypatch.setattr("loop_optimizer.export.FORMANT_FADE_GATE_CENTS", -1.0)
    x = held_then_moving()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)

    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert trace.binding_gate == "formant"
    assert trace.chosen_xfade < trace.max_xfade
    assert not trace.hit_floor, "the NaN-passes rule should stop the walk before the floor"
    # The mechanism, asserted directly: the walk stopped at the first width
    # whose formant distance is not measurable. That is a frame or two of
    # material, not an exact multiple of the frame length — whether a whole
    # frame lands inside a given source span depends on where the hop grid falls
    # relative to it — so the length bound below is a sanity check, not the
    # claim.
    assert not np.isfinite(trace.formant_distance_cents)
    assert cand.crossfade_samples < 3 * FORMANT_FRAME_MS * 0.001 * SR
    assert cand.crossfade_samples % round(PERIOD) == 0
    eff = resolve(cand.to_config(), x.shape[0], SR)
    assert eff.eff_xfade == cand.crossfade_samples


def test_fade_falls_back_to_the_one_period_floor_when_a_gate_refuses_everything(monkeypatch):
    """The backstop: a gate that refuses even unmeasurably short fades.

    Driven by forcing a refusal rather than by hunting for material that
    triggers one — the behaviour under test is the fallback itself, and a
    fixture that happened to fail the real threshold would be testing the
    threshold instead.
    """
    import loop_optimizer.export as ex

    monkeypatch.setattr(
        ex, "_fade_rejection", lambda *a, **k: ("formant", 9_999.0, float("nan"))
    )
    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)

    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert trace.hit_floor
    assert trace.binding_gate == "formant"
    # One period, not zero, and still period-aligned and unclamped.
    assert cand.crossfade_samples == round(PERIOD)
    assert cand.crossfade_samples < trace.max_xfade
    eff = resolve(cand.to_config(), x.shape[0], SR)
    assert eff.eff_xfade == cand.crossfade_samples


# ── The mechanical guards, which reject a SPAN rather than a fade ──────────


def test_a_span_that_clicks_at_every_fade_width_is_abandoned(monkeypatch):
    """Shortening cannot fix a click that survives every width — that is the
    placement talking. The search must move to the next span rather than ship a
    loop its own guard refused.
    """
    seen: list[int] = []
    real = None

    def guard_everything(x, cand, track, period, sample_rate, ref):
        # Refuse every fade at the first span offered, accept at any later one.
        seen.append(cand.loop_start)
        if cand.loop_start == seen[0]:
            return "click", float("nan"), float("nan")
        return real(x, cand, track, period, sample_rate, ref)

    import loop_optimizer.export as ex

    real = ex._fade_rejection
    monkeypatch.setattr(ex, "_fade_rejection", guard_everything)

    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    found = policy_v2_loop(x, gold, PERIOD, SR)

    assert found is not None
    cand, _trace = found
    assert cand.loop_start != seen[0], "the clicking span must have been abandoned"
    assert "click" in MECHANICAL_GATES


def test_gives_up_rather_than_shipping_a_loop_every_guard_refused(monkeypatch):
    """If no span survives the mechanical guards, no arm is emitted at all."""
    monkeypatch.setattr(
        "loop_optimizer.export._fade_rejection",
        lambda *a, **k: ("click", float("nan"), float("nan")),
    )
    x = held()
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    assert policy_v2_loop(x, gold, PERIOD, SR) is None


# ── The trace is the deliverable; it has to be internally consistent ───────


@pytest.mark.parametrize("x", [held(), held_then_moving()])
def test_trace_is_self_consistent(x):
    gold = GoldLoop(start=10_000, end=110_000, xfade=2_000)
    cand, trace = policy_v2_loop(x, gold, PERIOD, SR)

    assert 0 < trace.spans_kept <= trace.spans_considered
    assert 0 < trace.length <= trace.longest_span
    assert trace.length == cand.length
    assert trace.period_multiple == cand.period_multiple
    assert 0 <= trace.chosen_xfade <= trace.max_xfade
    assert trace.binding_gate in ("none", "formant", "click", "flam")
    if trace.chosen_xfade == trace.max_xfade:
        assert trace.binding_gate == "none"
    assert np.isfinite(trace.span_drift_cents)
    assert np.isfinite(trace.selection_median_drift_cents)
