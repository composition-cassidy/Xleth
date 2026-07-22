"""The redesigned suite: geometry, each metric's own failure mode, and the
fast-path equivalence the corpus report's runtime depends on.

These are unit tests of the ruler. Whether the ruler agrees with ears is a
different question and is answered by ``python -m loop_optimizer validate``
against the recorded verdicts, not here — there is no way to assert a listening
result in a unit test, and pretending otherwise would be the same mistake the
first suite made.
"""

from __future__ import annotations

import numpy as np
import pytest

from loop_optimizer.constants import ENGINE_SAMPLE_RATE as SR
from loop_optimizer.engine_emu import LoopConfig, resolve
from loop_optimizer.perceptual import (
    METRIC_DIRECTION,
    METRIC_NAMES,
    PERCEPTUAL_REFERENCE,
    RANKING_METRICS,
    PerceptualMetrics,
    circular_rms,
    measure_click_only,
    measure_perceptual,
    mel_filterbank,
    perceptual_cost,
    render_cycles,
    source_reference,
    strongest_onset,
)


def sine(freq: float, n: int, sr: float = SR, amp: float = 0.5) -> np.ndarray:
    t = np.arange(n) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


# ── Geometry ────────────────────────────────────────────────────────────────


def test_rendered_cycle_geometry_matches_the_engine_wrap():
    """One audible cycle is loopEnd - loopStart - xfade, split body then fade."""
    x = sine(SR / 100.0, 40_000)
    cfg = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=1_000)
    rc = render_cycles(x, cfg)
    assert rc is not None
    assert rc.advance == 15_000 - 5_000 - 1_000
    assert rc.xfade == 1_000
    assert rc.body_len == rc.advance - rc.xfade
    assert rc.n_cycles >= 2
    assert rc.y.size == rc.n_cycles * rc.advance


def test_render_is_periodic_so_one_circular_cycle_is_the_whole_loop():
    """The claim every 'circular' shortcut in the module rests on."""
    x = sine(SR / 100.0, 40_000)
    cfg = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=800)
    rc = render_cycles(x, cfg)
    a = rc.y[: rc.advance]
    b = rc.y[rc.advance : 2 * rc.advance]
    assert np.allclose(a, b, atol=1e-6)


def test_a_half_loop_crossfade_leaves_no_body_at_all():
    """The degenerate case roughly half the gold arms in the corpus sit in."""
    x = sine(SR / 100.0, 40_000)
    cfg = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=5_000)
    rc = render_cycles(x, cfg)
    assert rc.body_len == 0
    # ...and the suite still returns numbers rather than NaN for it.
    m = measure_perceptual(x, cfg, 100.0)
    assert np.isfinite(m.click)
    assert np.isfinite(m.wobble)


# ── Primitives ──────────────────────────────────────────────────────────────


def test_circular_rms_preserves_length_and_wraps():
    y = np.ones(100)
    env = circular_rms(y, 9)
    assert env.size == 100
    # A constant signal has a constant envelope everywhere INCLUDING the edges,
    # which is exactly what a non-circular window would get wrong.
    assert np.allclose(env, 1.0)


def test_circular_rms_tracks_level():
    y = np.concatenate([np.ones(200), 2.0 * np.ones(200)])
    env = circular_rms(y, 21)
    assert env[100] == pytest.approx(1.0, abs=1e-6)
    assert env[300] == pytest.approx(2.0, abs=1e-6)


def test_strongest_onset_finds_a_step_and_ignores_a_flat_signal():
    sr = 48000.0
    flat = np.ones(4800)
    _, rise = strongest_onset(flat, sr)
    assert rise == pytest.approx(0.0, abs=1e-9)

    step = np.concatenate([np.full(2400, 0.01), np.full(2400, 1.0)])
    idx, rise_db = strongest_onset(step, sr)
    assert rise_db > 20.0
    assert 2000 < idx < 2900


def test_mel_filterbank_shape_and_coverage():
    fb = mel_filterbank(1024, SR)
    assert fb.shape == (24, 513)
    assert np.all(fb >= 0.0)
    assert fb.sum() > 0


# ── Individual metrics against their own failure mode ───────────────────────


def test_click_fires_when_the_BLEND_creates_motion_the_source_does_not_have():
    """The metric's actual claim, stated as a test.

    Deliberately NOT "inject a spike into the source and check the score rises".
    That test fails, and it should: `click` is normalised against the fastest
    move the source makes over the span the loop reads, so material that
    genuinely contains a transient raises its own reference and a loop that
    faithfully reproduces it is not clicking. Reproducing fast material is not
    an artefact; INVENTING fast material is.

    So: one sine, two loops differing only in whether the crossfade blends the
    two sources in phase or in antiphase. Antiphase cancels mid-fade, which is a
    level collapse present nowhere in the source.
    """
    n = 40_000
    period = 100.0
    x = sine(SR / period, n)
    xf = 1_000

    # (loop_end - xf) - loop_start in whole periods -> sources in phase.
    in_phase = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=xf)
    # ...and offset by half a period -> sources in antiphase, so they subtract.
    antiphase = LoopConfig(loop_start=5_000, loop_end=15_050, crossfade_samples=xf)

    m_in = measure_perceptual(x, in_phase, period)
    m_anti = measure_perceptual(x, antiphase, period)
    assert m_anti.click > m_in.click


def test_wobble_fires_on_a_loop_rate_amplitude_swing():
    """A level that pumps once per loop is what listeners called wobble."""
    n = 60_000
    base = sine(SR / 100.0, n).astype(np.float64)
    t = np.arange(n)
    # Modulate slowly enough that a 10k-sample loop sees a big swing across it.
    modulated = (base * (1.0 + 0.6 * np.sin(2 * np.pi * t / 9_000.0))).astype(np.float32)

    cfg = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=500)
    flat = measure_perceptual(base.astype(np.float32), cfg, 100.0)
    pumped = measure_perceptual(modulated, cfg, 100.0)
    assert pumped.wobble > flat.wobble


def test_cents_err_is_retained_and_still_measures_period_misalignment():
    """The one metric carried over unchanged from the first suite."""
    x = sine(SR / 100.0, 40_000)
    aligned = LoopConfig(loop_start=5_000, loop_end=15_000, crossfade_samples=0)
    assert abs(measure_perceptual(x, aligned, 100.0).cents_err_per_loop) < 1.0
    off = LoopConfig(loop_start=5_000, loop_end=15_050, crossfade_samples=0)
    assert abs(measure_perceptual(x, off, 100.0).cents_err_per_loop) > 5.0


def test_metrics_are_nan_not_zero_for_a_loop_that_cannot_play():
    """'Not defined here' must never be reported as 'perfect'."""
    x = sine(SR / 100.0, 40_000)
    dead = LoopConfig(loop_start=5_000, loop_end=5_000, crossfade_samples=0)
    m = measure_perceptual(x, dead, 100.0)
    for name in METRIC_NAMES:
        assert np.isnan(getattr(m, name))


# ── The fast path ───────────────────────────────────────────────────────────


def test_click_only_matches_the_full_measurement_exactly():
    """The corpus report's runtime rests on these being the SAME number.

    Ranking uses `click` alone, so the report measures only `click` for every
    candidate and the full suite for the head of the order. That is only
    legitimate if the cheap path is not an approximation.
    """
    x = sine(SR / 100.0, 40_000).astype(np.float64)
    x += 0.05 * np.sin(2 * np.pi * np.arange(x.size) / 777.0)
    x = x.astype(np.float32)
    ref = source_reference(x, 100.0, SR)

    for start, end, xf in [
        (5_000, 15_000, 0),
        (5_000, 15_000, 1_000),
        (5_000, 15_000, 5_000),
        (2_000, 9_000, 700),
        (10_000, 12_000, 400),
    ]:
        cfg = LoopConfig(loop_start=start, loop_end=end, crossfade_samples=xf)
        full = measure_perceptual(x, cfg, 100.0, SR, ref).click
        cheap = measure_click_only(x, cfg, 100.0, SR, ref)
        assert cheap == pytest.approx(full, rel=1e-12, nan_ok=True)


def test_source_reference_is_deterministic_and_shared():
    x = sine(SR / 100.0, 40_000)
    a = source_reference(x, 100.0, SR)
    b = source_reference(x, 100.0, SR)
    assert a.env_rate == b.env_rate
    assert np.array_equal(a.env_step, b.env_step)


# ── The composite ───────────────────────────────────────────────────────────


def _metrics(**kw) -> PerceptualMetrics:
    base = dict(click=0.0, hollow=0.0, wobble=0.0, chorusing=0.0, flam=0.0,
                timbre_jump=0.0, cents_err_per_loop=0.0)
    base.update(kw)
    return PerceptualMetrics(**base)


def test_cost_ranks_on_the_documented_subset_only():
    """Metrics outside RANKING_METRICS are measured but must not move a rank."""
    excluded = [n for n in METRIC_NAMES if n not in RANKING_METRICS]
    assert excluded, "the subset is supposed to be a strict subset"
    clean = _metrics()
    loud = _metrics(**{excluded[0]: 1e6})
    assert perceptual_cost(loud) == perceptual_cost(clean)


def test_cost_skips_nan_rather_than_scoring_it_as_perfect():
    """A candidate nothing could be measured on costs infinity, never zero."""
    all_nan = PerceptualMetrics(*([float("nan")] * 7))
    assert np.isinf(perceptual_cost(all_nan))
    # With the default single-metric subset, a NaN there leaves no term at all.
    assert np.isinf(perceptual_cost(_metrics(click=float("nan"))))
    # A NaN alongside a measurable term is skipped, not counted as 0.
    two = ("click", "wobble")
    assert perceptual_cost(
        _metrics(click=float("nan"), wobble=PERCEPTUAL_REFERENCE["wobble"]), metrics=two
    ) == pytest.approx(1.0)


def test_cost_is_scaled_by_the_audibility_reference():
    m = _metrics(click=PERCEPTUAL_REFERENCE["click"])
    assert perceptual_cost(m) == pytest.approx(1.0)


def test_cost_rules_agree_on_a_single_defect():
    m = _metrics(click=2 * PERCEPTUAL_REFERENCE["click"])
    assert perceptual_cost(m, "max") == pytest.approx(2.0)
    assert perceptual_cost(m, "sum") == pytest.approx(2.0)


def test_every_metric_declares_a_direction_and_a_reference():
    assert set(METRIC_NAMES) == set(METRIC_DIRECTION)
    assert set(METRIC_NAMES) == set(PERCEPTUAL_REFERENCE)
    assert set(RANKING_METRICS) <= set(METRIC_NAMES)
    assert len(METRIC_NAMES) == 7  # six perceptual + the retained cents_err


# ── The degenerate minimum ──────────────────────────────────────────────────


def test_generator_refuses_loops_shorter_than_the_minimum_duration():
    """A one-period loop is seamless by construction, so the ruler cannot reject it.

    With no crossfade there is no blend, so no invented motion, so `click` is 0
    and a 1.9 ms "loop" ranks first — the same degeneracy the first suite had
    with seam_ncc. It is a policy question (what counts as a loop) rather than a
    measurement one, so the bound lives in the generator.
    """
    from loop_optimizer.candidates import generate_candidates
    from loop_optimizer.constants import MIN_LOOP_DURATION_SEC

    period = 100.0
    x = sine(SR / period, 60_000)
    cands = generate_candidates(x, period, 1_000, 50_000, SR)
    assert cands, "the floor must not starve a window with plenty of room"
    floor = int(MIN_LOOP_DURATION_SEC * SR)
    assert min(c.length for c in cands) >= floor


def test_a_window_too_short_for_any_real_loop_yields_nothing_not_a_buzz():
    """Zero candidates with a note beats one degenerate candidate silently."""
    from loop_optimizer.candidates import generate_candidates

    period = 100.0
    x = sine(SR / period, 60_000)
    # 40 ms of room, less than MIN_LOOP_DURATION_SEC.
    assert generate_candidates(x, period, 1_000, 1_000 + int(0.04 * SR), SR) == []
