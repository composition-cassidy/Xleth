"""The LPC formant tracker.

Every test here drives the tracker with a signal whose formants are KNOWN
because they were synthesised — an impulse train through a cascade of two-pole
resonators, i.e. the source-filter model the LPC analysis assumes. That is
deliberately the friendly case: the claim under test is not "this tracker works
on any recording", it is "when a resonance is there, this finds it, and when it
moves, this measures the movement". The policy arm only ever asks it the second
question, and only ever about one sample compared against itself.

The NaN cases get as much attention as the working ones. A drift measure that
returns 0.0 where it cannot measure would make unmeasurable material look like
the calmest material in the window and would win every gate it was offered to —
the same class of bug db7e180 had to fix in the metric suite.
"""

from __future__ import annotations

import numpy as np
import pytest

from loop_optimizer.formants import (
    FORMANT_FRAME_MS,
    N_FORMANTS,
    FormantTrack,
    formant_distance_cents,
    frame_formants,
    levinson,
    track_formants,
)

SR = 48000.0

#: Two vowels far apart in F1/F2, with textbook-ish frequencies and bandwidths.
AH = ((700.0, 80.0), (1220.0, 90.0), (2600.0, 120.0))
EE = ((300.0, 70.0), (2300.0, 100.0), (3000.0, 130.0))


def resonator(x: np.ndarray, freq: float, bw: float, sr: float = SR) -> np.ndarray:
    """One two-pole resonance. Written out because scipy is not a dependency."""
    r = float(np.exp(-np.pi * bw / sr))
    c = 2.0 * r * float(np.cos(2.0 * np.pi * freq / sr))
    y = np.zeros_like(x)
    y1 = y2 = 0.0
    for i, v in enumerate(x):
        cur = v + c * y1 - r * r * y2
        y[i] = cur
        y2, y1 = y1, cur
    return y


def vowel(f0: float, formants, n: int, sr: float = SR) -> np.ndarray:
    """Impulse train at ``f0`` through the given resonances, peak-normalised."""
    src = np.zeros(n)
    src[:: max(1, int(round(sr / f0)))] = 1.0
    y = src
    for freq, bw in formants:
        y = resonator(y, freq, bw, sr)
    return y / (float(np.max(np.abs(y))) + 1e-12)


def morphing_vowel(f0: float, n: int, steps: int = 12, sr: float = SR) -> np.ndarray:
    """A vowel sliding from /a/ to /i/ across its whole length."""
    chunk = max(1, n // steps)
    out = []
    for t in np.linspace(0.0, 1.0, steps):
        formants = tuple(
            (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])) for a, b in zip(AH, EE)
        )
        out.append(vowel(f0, formants, chunk, sr))
    return np.concatenate(out)


# ── Does it find a formant that is actually there? ──────────────────────────


@pytest.mark.parametrize("formants", [AH, EE])
def test_frame_formants_recovers_synthesised_resonances(formants):
    """The frequencies out must be the frequencies that went in."""
    y = vowel(150.0, formants, 20_000)
    frame = int(FORMANT_FRAME_MS * 0.001 * SR)
    found = frame_formants(y[8_000 : 8_000 + frame], SR)

    assert found.shape == (N_FORMANTS,)
    assert np.all(np.isfinite(found))
    for got, (want, _bw) in zip(found, formants):
        # 5% covers the pre-emphasis tilt and the finite analysis bandwidth;
        # anything looser would not distinguish /a/ from /i/, which is the whole
        # discrimination the policy needs.
        assert abs(got - want) / want < 0.05, f"expected ~{want} Hz, got {got:.0f} Hz"


def test_formants_are_ordered_and_distinct_vowels_are_far_apart():
    frame = int(FORMANT_FRAME_MS * 0.001 * SR)
    ah = frame_formants(vowel(150.0, AH, 20_000)[8_000 : 8_000 + frame], SR)
    ee = frame_formants(vowel(150.0, EE, 20_000)[8_000 : 8_000 + frame], SR)

    assert np.all(np.diff(ah) > 0), "F1 < F2 < F3"
    assert np.all(np.diff(ee) > 0)
    # /a/ and /i/ are the two vowels furthest apart in the F1/F2 plane; if the
    # tracker cannot separate these it cannot separate anything.
    assert abs(ah[0] - ee[0]) > 300.0
    assert abs(ah[1] - ee[1]) > 800.0


# ── Does it measure MOVEMENT, which is what the policy actually asks? ───────


def test_a_held_vowel_drifts_far_less_than_a_moving_one():
    held = track_formants(vowel(150.0, AH, 40_000), SR, 2_000, 38_000)
    moving = track_formants(morphing_vowel(150.0, 40_000), SR, 2_000, 38_000)

    held_drift = held.span_drift_cents(4_000, 34_000)
    moving_drift = moving.span_drift_cents(4_000, 34_000)

    assert np.isfinite(held_drift) and np.isfinite(moving_drift)
    # Not a marginal separation: a held vowel's drift is measurement noise.
    assert held_drift < 20.0
    assert moving_drift > 200.0


def test_drift_localises_the_transition():
    """A span inside the held half must read calmer than one spanning the move.

    This is exactly the discrimination the placement gate is built on: same
    sample, same tracker, two spans, and the calm one has to win.
    """
    x = np.concatenate([vowel(150.0, AH, 30_000), morphing_vowel(150.0, 30_000)])
    track = track_formants(x, SR, 0, x.size)

    calm = track.span_drift_cents(2_000, 28_000)
    across = track.span_drift_cents(20_000, 46_000)

    assert np.isfinite(calm) and np.isfinite(across)
    assert calm < across / 4.0


def test_formant_distance_separates_vowels_and_ignores_a_repeat():
    ah = track_formants(vowel(150.0, AH, 30_000), SR, 2_000, 28_000)
    ee = track_formants(vowel(150.0, EE, 30_000), SR, 2_000, 28_000)

    same = formant_distance_cents(
        ah.span_formants_cents(4_000, 12_000), ah.span_formants_cents(16_000, 24_000)
    )
    different = formant_distance_cents(
        ah.span_formants_cents(4_000, 12_000), ee.span_formants_cents(4_000, 12_000)
    )

    assert same < 20.0, "the same held vowel compared with itself"
    assert different > 500.0, "/a/ against /i/"


# ── The NaN contract: unmeasurable must never read as calm ─────────────────


def test_silence_yields_no_formants_rather_than_zero():
    track = track_formants(np.zeros(20_000), SR, 0, 20_000)
    assert not np.any(np.isfinite(track.cents))
    assert math_isnan(track.span_drift_cents(0, 20_000))
    assert not np.any(np.isfinite(track.span_formants_cents(0, 20_000)))


def test_a_span_too_short_to_hold_a_frame_is_nan_not_zero():
    track = track_formants(vowel(150.0, AH, 30_000), SR, 0, 30_000)
    frame = track.frame_len
    assert math_isnan(track.span_drift_cents(5_000, 5_000 + frame // 2))
    # One whole frame fits, but a variance needs two.
    assert math_isnan(track.span_drift_cents(5_000, 5_000 + frame))


def test_frame_formants_is_nan_on_degenerate_input():
    assert not np.any(np.isfinite(frame_formants(np.zeros(1_440), SR)))
    assert not np.any(np.isfinite(frame_formants(np.zeros(2), SR)))
    assert not np.any(np.isfinite(frame_formants(np.full(1_440, np.nan), SR)))


def test_formant_distance_needs_both_sides():
    # CENTS, not Hz — see the function's own note on why it cannot tell.
    a = 1200.0 * np.log2(np.array([600.0, 1200.0, 2400.0]))
    nan = np.full(3, np.nan)
    assert math_isnan(formant_distance_cents(a, nan))
    assert math_isnan(formant_distance_cents(nan, nan))
    assert math_isnan(formant_distance_cents(a, np.array([1.0, 2.0])))
    # One resolved formant in common is enough to compare, on that formant.
    partial = np.array([1200.0 * np.log2(700.0), np.nan, np.nan])
    assert formant_distance_cents(a, partial) == pytest.approx(
        abs(1200.0 * np.log2(700.0 / 600.0)), rel=1e-9
    )


def test_levinson_refuses_a_degenerate_autocorrelation():
    assert levinson(np.zeros(16), 12) is None
    assert levinson(np.array([1.0, 2.0, 3.0]), 12) is None, "order exceeds the lag count"
    assert levinson(np.full(16, np.nan), 12) is None
    # A valid one returns a monic polynomial of the requested order.
    r = np.exp(-0.1 * np.arange(16)) * np.cos(0.3 * np.arange(16))
    a = levinson(r, 12)
    assert a is not None and a.shape == (13,) and a[0] == 1.0


# ── The O(1) span variance has to equal the slow, obvious computation ──────


def test_cumulative_span_drift_matches_the_direct_computation():
    """The cumsum trick is an optimisation; it must not be an approximation."""
    x = np.concatenate([vowel(150.0, AH, 20_000), morphing_vowel(150.0, 20_000)])
    track = track_formants(x, SR, 0, x.size)

    for lo, hi in [(1_000, 19_000), (12_000, 33_000), (25_000, 39_000)]:
        idx = [
            i
            for i, s in enumerate(track.frame_starts)
            if s >= lo and s + track.frame_len <= hi
        ]
        cols = []
        for f in range(N_FORMANTS):
            vals = np.array([track.cents[i, f] for i in idx])
            vals = vals[np.isfinite(vals)]
            if vals.size >= 2:
                cols.append(float(np.var(vals)))
        expected = float(np.sqrt(np.mean(cols))) if cols else float("nan")
        got = track.span_drift_cents(lo, hi)
        assert got == pytest.approx(expected, rel=1e-9, abs=1e-9)


def test_empty_track_is_usable_rather_than_a_crash():
    """A window shorter than one frame produces no frames at all."""
    track = track_formants(vowel(150.0, AH, 20_000), SR, 1_000, 1_100)
    assert track.n_frames == 0
    assert math_isnan(track.span_drift_cents(1_000, 1_100))
    assert not np.any(np.isfinite(track.span_formants_cents(1_000, 1_100)))


def test_track_is_a_pure_function_of_its_input():
    x = vowel(150.0, AH, 20_000)
    a = track_formants(x, SR, 1_000, 19_000)
    b = track_formants(x, SR, 1_000, 19_000)
    assert np.array_equal(a.frame_starts, b.frame_starts)
    assert np.array_equal(np.nan_to_num(a.cents, nan=-1.0), np.nan_to_num(b.cents, nan=-1.0))


def math_isnan(v: float) -> bool:
    """`np.isnan` on a plain float, spelled so a non-float would fail loudly."""
    assert isinstance(v, float)
    return bool(np.isnan(v))


def test_formant_track_accepts_a_hand_built_cents_array():
    """The dataclass is constructible directly — the policy tests rely on it."""
    cents = np.array([[100.0, 200.0, 300.0], [110.0, 200.0, np.nan]])
    track = FormantTrack(
        frame_starts=np.array([0, 10]),
        frame_len=10,
        hop=10,
        sample_rate=SR,
        cents=cents,
    )
    assert track.n_frames == 2
    # F1 varies by 10 cents (var 25), F2 not at all, F3 has one valid frame and
    # is therefore excluded rather than counted as perfectly stable.
    assert track.span_drift_cents(0, 20) == pytest.approx(float(np.sqrt((25.0 + 0.0) / 2)))
