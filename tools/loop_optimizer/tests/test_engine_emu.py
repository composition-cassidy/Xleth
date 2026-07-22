"""Proofs that the emulation matches the documented engine behaviour.

The synthetic-signal tests are the load-bearing ones. A pure sine whose period
divides the loop length exactly has a KNOWN correct answer, so these assert
against arithmetic rather than against a previous run of this same code — which
is the only way a reference implementation can be shown to be right rather than
merely self-consistent.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from loop_optimizer.constants import DECLICK_LUT_SIZE, ENGINE_SAMPLE_RATE
from loop_optimizer.engine_emu import (
    LoopConfig,
    declick_ms_to_samples,
    positions_for_range,
    render_reference,
    render_window,
    resolve,
    seam_output_index,
)
from loop_optimizer.metrics import measure

SR = ENGINE_SAMPLE_RATE


def sine(freq: float, n: int, sr: float = SR, amp: float = 0.5, phase: float = 0.0) -> np.ndarray:
    t = np.arange(n, dtype=np.float64)
    return (amp * np.sin(2.0 * np.pi * freq * t / sr + phase)).astype(np.float32)


# ── effXfade clamp (Sampler.cpp:898-910) ─────────────────────────────────────


def test_xfade_clamped_to_half_the_loop():
    """Bound 2: the two fade ends can never overlap inside the loop."""
    cfg = LoopConfig(loop_start=1000, loop_end=1101, crossfade_samples=10_000)
    eff = resolve(cfg, num_frames=5000)
    # (1101 - 1000) // 2 == 50, using the C++'s truncating integer division.
    assert eff.eff_xfade == 50


def test_xfade_clamped_by_trim_start():
    """Bound 3: the fade-out read must stay inside the trim region."""
    cfg = LoopConfig(loop_start=900, loop_end=1000, crossfade_samples=80, smp_start=950)
    eff = resolve(cfg, num_frames=5000)
    # effLoopEnd - smpStart_ == 50 is the binding constraint here.
    assert eff.eff_xfade == 50


def test_xfade_clamped_by_trim_end():
    """Bound 4: the fade-in source must stay inside the trim region."""
    cfg = LoopConfig(loop_start=900, loop_end=1000, crossfade_samples=90, smp_length=940)
    eff = resolve(cfg, num_frames=5000)
    # clampedEnd (0 + 940) - effLoopStart (900) == 40.
    assert eff.eff_xfade == 40


def test_xfade_zero_when_loop_disabled():
    """useLoop requires crossfade_enabled AND loop_enabled (Sampler.cpp:895-896)."""
    for kwargs in ({"loop_enabled": False}, {"crossfade_enabled": False}):
        eff = resolve(LoopConfig(loop_start=0, loop_end=1000, crossfade_samples=100, **kwargs), 5000)
        assert not eff.use_loop
        assert eff.eff_xfade == 0


def test_loop_end_zero_means_end_of_sample():
    """Sampler.cpp:890-893."""
    eff = resolve(LoopConfig(loop_start=100, loop_end=0), num_frames=4321)
    assert eff.eff_loop_end == 4321


def test_declick_ms_to_samples_rounds_then_clamps():
    """DeclickEnvelope.h:38-42 — the +0.5 is a round, and negatives clamp to 0."""
    assert declick_ms_to_samples(1.0, 48000.0) == 48
    assert declick_ms_to_samples(0.0, 48000.0) == 0
    assert declick_ms_to_samples(-5.0, 48000.0) == 0
    # 0.0104 ms * 48000 = 0.4992 -> rounds to 0; one tick more rounds to 1.
    assert declick_ms_to_samples(0.0104, 48000.0) == 0
    assert declick_ms_to_samples(0.0105, 48000.0) == 1


# ── loop wrap (Sampler.cpp:1020-1030) ────────────────────────────────────────


def test_wrap_skips_the_first_xfade_samples():
    """The FL-style wrap lands at loopStart + xfade, not at loopStart."""
    cfg = LoopConfig(loop_start=100, loop_end=200, crossfade_samples=20)
    eff = resolve(cfg, num_frames=1000)
    assert eff.eff_xfade == 20
    seam = seam_output_index(eff, cfg)
    pos = positions_for_range(cfg, eff, seam - 1, 3)
    assert pos[0] == pytest.approx(199.0)  # last sample before the wrap
    assert pos[1] == pytest.approx(120.0)  # loop_start + xfade, NOT loop_start
    assert pos[2] == pytest.approx(121.0)


def test_wrap_advance_is_shortened_by_the_crossfade():
    """The audible repeat period is loopEnd - loopStart - xfade.

    This is the behaviour most likely to be got wrong in the C++ port, because
    every other sampler this could be compared against uses loopEnd - loopStart.
    """
    eff = resolve(LoopConfig(loop_start=100, loop_end=1100, crossfade_samples=250), 5000)
    assert eff.wrap_advance == 1100 - 100 - 250 == 750

    # And the position sequence really does repeat on that period, not on 1000.
    cfg = LoopConfig(loop_start=100, loop_end=1100, crossfade_samples=250)
    pos = positions_for_range(cfg, eff, 0, 4000)
    seam = seam_output_index(eff, cfg)
    assert pos[seam] == pytest.approx(pos[seam + eff.wrap_advance])
    assert pos[seam] != pytest.approx(pos[seam + 1000])


def test_positions_never_leave_the_loop_region():
    cfg = LoopConfig(loop_start=300, loop_end=900, crossfade_samples=100)
    eff = resolve(cfg, num_frames=2000)
    pos = positions_for_range(cfg, eff, 0, 10_000)
    after_seam = pos[seam_output_index(eff, cfg) :]
    assert after_seam.min() >= eff.eff_loop_start + eff.eff_xfade
    assert after_seam.max() < eff.eff_loop_end


def test_degenerate_loop_is_refused_not_emulated():
    """A loop whose whole body is crossfade would stall the engine's position."""
    cfg = LoopConfig(loop_start=0, loop_end=100, crossfade_samples=50)
    eff = resolve(cfg, num_frames=500)
    assert eff.eff_xfade == 50 and eff.wrap_advance == 50
    # Force the degenerate case past the engine's own clamp to prove the guard.
    bad = type(eff)(
        clamped_end=eff.clamped_end,
        eff_declick=0,
        eff_loop_start=0,
        eff_loop_end=100,
        eff_xfade=100,
        xfade_start=0.0,
        use_loop=True,
    )
    with pytest.raises(ValueError, match="degenerate loop"):
        positions_for_range(cfg, bad, 0, 10)


# ── equal-power blend (Sampler.cpp:1090-1130) ────────────────────────────────


def test_blend_weights_are_equal_power_at_the_midpoint():
    """cos/sin at progress 0.5 both equal 1/sqrt(2), so power is preserved."""
    # A constant signal makes the blend weights directly readable off the output.
    x = np.ones(2000, dtype=np.float32)
    cfg = LoopConfig(loop_start=500, loop_end=1500, crossfade_samples=200)
    eff = resolve(cfg, num_frames=2000)
    seam = seam_output_index(eff, cfg)
    y = render_window(x, cfg, 0, seam + 10)
    mid = int(eff.xfade_start) + eff.eff_xfade // 2
    assert y[mid] == pytest.approx(math.cos(math.pi / 4) + math.sin(math.pi / 4), rel=1e-5)
    # At the start of the fade it is all fade-out source, i.e. unity.
    assert y[int(eff.xfade_start)] == pytest.approx(1.0, rel=1e-6)


def test_blend_cancels_for_antiphase_sources():
    """Equal-power preserves power only for UNcorrelated sources.

    Two anti-correlated sources subtract. This is the mechanism behind the
    cancellation dip that rms_ripple_db reports.
    """
    n = 4000
    period = 100
    x = sine(SR / period, n)
    # A loop whose length is a whole number of periods PLUS a half period puts
    # the fade-in source exactly in antiphase with the fade-out source.
    cfg = LoopConfig(loop_start=500, loop_end=500 + 10 * period + period // 2, crossfade_samples=2 * period)
    eff = resolve(cfg, num_frames=n)
    seam = seam_output_index(eff, cfg)
    y = render_window(x, cfg, 0, seam)
    fade = y[int(eff.xfade_start) : seam]
    outside = y[int(eff.xfade_start) - 4 * period : int(eff.xfade_start)]
    # The middle of the fade is markedly quieter than the material either side.
    assert np.sqrt(np.mean(fade**2)) < 0.6 * np.sqrt(np.mean(outside**2))


# ── declick (DeclickEnvelope.h) ──────────────────────────────────────────────


def test_declick_lut_endpoints_and_shape():
    x = np.ones(4000, dtype=np.float32)
    declick_samples = 480  # 10 ms at 48 kHz
    cfg = LoopConfig(
        loop_start=0, loop_end=0, loop_enabled=False, crossfade_enabled=False, declick_ms=10.0
    )
    y = render_reference(x, cfg, 4000)
    assert y[0] == pytest.approx(0.0)  # fadeIn(0, n) == 0
    assert y[declick_samples] == pytest.approx(1.0)  # reaches unity at rampLen
    # Hann half-way point is 0.5.
    assert y[declick_samples // 2] == pytest.approx(0.5, abs=2e-3)
    assert 0.0 < y[declick_samples // 4] < 0.5


def test_declick_lut_is_quantised_like_the_engine():
    """The engine indexes a 1024-entry table with truncating integer maths."""
    from loop_optimizer.engine_emu import _DECLICK_LUT

    assert _DECLICK_LUT.shape == (DECLICK_LUT_SIZE,)
    assert _DECLICK_LUT[0] == pytest.approx(0.0)
    assert _DECLICK_LUT[-1] == pytest.approx(1.0)
    assert _DECLICK_LUT[DECLICK_LUT_SIZE // 2] == pytest.approx(0.5, abs=1e-3)


# ── out-of-bounds freeze (Sampler.cpp:1045-1053) ─────────────────────────────


def test_out_of_bounds_position_freezes_the_voice():
    """`continue` skips the stride advance, so the voice stalls and stays silent."""
    x = np.ones(100, dtype=np.float32)
    cfg = LoopConfig(loop_start=0, loop_end=0, loop_enabled=False, crossfade_enabled=False, smp_start=150)
    y = render_reference(x, cfg, 50)
    assert np.all(y == 0.0)
    assert np.array_equal(y, render_window(x, cfg, 0, 50))


# ── reference vs vectorised equivalence ──────────────────────────────────────


@pytest.mark.parametrize("seed", range(12))
def test_reference_and_vectorised_renderers_agree_bit_for_bit(seed):
    rng = np.random.default_rng(seed)
    x = (rng.standard_normal(4000) * 0.3).astype(np.float32)
    loop_start = int(rng.integers(0, 2000))
    loop_end = loop_start + int(rng.integers(60, 1500))
    cfg = LoopConfig(
        loop_start=loop_start,
        loop_end=loop_end,
        crossfade_samples=int(rng.integers(0, 900)),
        smp_start=int(rng.integers(0, min(loop_start + 1, 64))),
        declick_ms=float(rng.choice([0.0, 1.0, 5.0])),
        fade_in_ms=float(rng.choice([0.0, 2.0])),
        fade_out_ms=float(rng.choice([0.0, 3.0])),
    )
    n = 3000
    assert np.array_equal(render_reference(x, cfg, n), render_window(x, cfg, 0, n))


@pytest.mark.parametrize("out_start", [0, 1, 137, 999, 2500])
def test_render_window_matches_the_reference_slice(out_start):
    """A windowed render must equal the same slice of a full render."""
    x = sine(440.0, 6000)
    cfg = LoopConfig(loop_start=800, loop_end=3000, crossfade_samples=300, declick_ms=2.0)
    full = render_reference(x, cfg, 4000)
    count = 400
    assert np.array_equal(full[out_start : out_start + count], render_window(x, cfg, out_start, count))


# ── end-to-end synthetic proofs (the ones stated in the brief) ───────────────


def test_aligned_sine_loop_has_a_near_zero_seam_step():
    """A loop of exactly k periods of a sine wraps seamlessly.

    Period 100 samples divides the loop length exactly, so the wrap lands on the
    identical phase and the render is indistinguishable from an unbroken sine.
    """
    period = 100
    x = sine(SR / period, 20_000)
    cfg = LoopConfig(loop_start=5000, loop_end=5000 + 40 * period, crossfade_samples=0)
    m = measure(x, cfg, float(period))

    assert m.seam_step < 0.01, f"aligned seam should be near-zero, got {m.seam_step}"
    assert m.seam_ncc > 0.999
    assert abs(m.cents_err_per_loop) < 0.5
    assert abs(m.rms_ripple_db) < 0.5


def test_half_period_misaligned_sine_loop_shows_a_large_seam_step():
    """Half a period off puts the wrap in antiphase: the worst possible seam."""
    period = 100
    x = sine(SR / period, 20_000)
    aligned = LoopConfig(loop_start=5000, loop_end=5000 + 40 * period, crossfade_samples=0)
    misaligned = LoopConfig(
        loop_start=5000, loop_end=5000 + 40 * period + period // 2, crossfade_samples=0
    )

    good = measure(x, aligned, float(period))
    bad = measure(x, misaligned, float(period))

    assert bad.seam_step > 50 * good.seam_step
    assert bad.seam_ncc < 0.0  # antiphase: the two sides anti-correlate
    # Half a period of error over one loop, expressed as detune.
    assert abs(bad.cents_err_per_loop) > 5.0


def test_half_period_misalignment_produces_a_cancellation_dip_under_crossfade():
    """The expected cancellation dip: anti-correlated sources subtract."""
    period = 100
    x = sine(SR / period, 20_000)
    cfg = LoopConfig(
        loop_start=5000,
        loop_end=5000 + 40 * period + period // 2,
        crossfade_samples=6 * period,
    )
    m = measure(x, cfg, float(period))

    assert m.zero_lag_corr < -0.9, "fade sources should be in antiphase"
    assert m.rms_ripple_db < -3.0, f"expected a level dip, got {m.rms_ripple_db} dB"


def test_crossfade_that_is_not_a_period_multiple_detunes_the_loop():
    """The finding the emulation exists to surface.

    The wrap skips the crossfade, so the audible period is len - xfade. A
    crossfade of half a period therefore shifts the loop's repeat period by half
    a period, and the loop plays flat even though its SPAN is a perfect multiple.
    """
    period = 100
    x = sine(SR / period, 20_000)
    half_period_off = 6 * period + period // 2

    long_span = 40 * period
    clean = measure(x, LoopConfig(5000, 5000 + long_span, crossfade_samples=6 * period), float(period))
    detuned = measure(x, LoopConfig(5000, 5000 + long_span, crossfade_samples=half_period_off), float(period))

    # A whole number of periods of crossfade leaves the loop in tune...
    assert abs(clean.cents_err_per_loop) < 0.5
    assert clean.wrap_advance == long_span - 6 * period
    # ...and half a period of crossfade error detunes it, even though the loop
    # SPAN is identical in both cases. Only the crossfade differs.
    assert detuned.wrap_advance == long_span - half_period_off
    expected = 1200.0 * math.log2(detuned.wrap_advance / (round(detuned.wrap_advance / period) * period))
    assert detuned.cents_err_per_loop == pytest.approx(expected, rel=1e-6)
    assert abs(detuned.cents_err_per_loop) > 20.0

def test_engine_crossfade_clamp_can_itself_detune_a_short_loop():
    """The clamp at Sampler.cpp:905 can create the detune, not just fail to fix it.

    Reproduces corpus sample hard_tuned_vocal_0009 exactly. Ask for a whole
    number of periods of crossfade on a loop spanning an ODD number of periods,
    and the ``(loopEnd - loopStart) / 2`` bound cuts the request down to half the
    span — which is a HALF period multiple. The advance becomes k.5 periods and
    the loop plays ~150 cents flat, from a crossfade request that was perfectly
    in tune and a loop span that was perfectly in tune.

    Nothing about this is visible without emulating the engine's clamp.
    """
    period = 100
    x = sine(SR / period, 20_000)
    span = 11 * period  # ODD multiple: span // 2 is a half-period boundary

    cfg = LoopConfig(5000, 5000 + span, crossfade_samples=6 * period)
    eff = resolve(cfg, num_frames=20_000)
    assert eff.eff_xfade == span // 2 == 550, "the half-the-loop clamp should bind here"

    m = measure(x, cfg, float(period))
    assert m.wrap_advance == 550  # 5.5 periods, not the 5 or 6 anyone intended
    assert m.wrap_advance / period == pytest.approx(5.5)
    assert m.cents_err_per_loop == pytest.approx(1200.0 * math.log2(550.0 / 600.0), rel=1e-6)
    assert abs(m.cents_err_per_loop) > 100.0

    # And the same loop with a crossfade that survives the clamp stays in tune.
    safe = measure(x, LoopConfig(5000, 5000 + span, crossfade_samples=5 * period), float(period))
    assert safe.wrap_advance == 6 * period
    assert abs(safe.cents_err_per_loop) < 0.5
