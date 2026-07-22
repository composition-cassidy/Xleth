"""The six-metric suite, computed on the emulated render.

Every metric below is measured on the output of :mod:`loop_optimizer.engine_emu`
— what XLETH would actually play — not on idealised loop math. The distinction
is not academic. Two examples this suite exists to catch:

THE AUDIBLE LOOP PERIOD IS NOT ``loopEnd - loopStart``.
    The engine's wrap skips the first ``effXfade`` samples of the loop region
    (Sampler.cpp:1024-1028), so the position cycle is
    ``[loopStart + xfade, loopEnd)`` and the material repeats every
    ``loopEnd - loopStart - xfade`` samples. A crossfade therefore SHORTENS the
    loop's repeat period. A loop whose span is an exact multiple of the period
    goes out of tune the moment a crossfade that is not itself a period multiple
    is applied to it — which is why ``cents_err_per_loop`` is measured against
    ``wrap_advance`` and why the crossfade variants offered in ``candidates.py``
    are whole numbers of periods.

THE CROSSFADE CAN CANCEL.
    The blend is equal-power cos/sin (Sampler.cpp:1100-1101), which preserves
    power only for uncorrelated sources. Two strongly ANTI-correlated sources —
    exactly what a half-period-misaligned loop produces — subtract, and the
    render dips in the middle of the fade. ``zero_lag_corr`` predicts it and
    ``rms_ripple_db`` measures the damage.

No metric here is thresholded, weighted or combined into a score. They are
measurements. Deciding what to do with them is a later phase.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from .constants import ENGINE_SAMPLE_RATE, SEAM_CORRELATION_PERIODS
from .engine_emu import LoopConfig, render_window, resolve, seam_output_index

#: Floor for denominators that are RMS-like. Anything at or below this is
#: silence and the metric is reported as NaN rather than as a huge number.
_EPS = 1e-12


@dataclass(frozen=True)
class SeamMetrics:
    """One candidate's measurements. NaN means "not defined here", not "zero"."""

    #: Discontinuity at the seam: the larger of the sample-value and slope
    #: linear-prediction residuals, normalised by the render's local RMS.
    #: Dimensionless. ~0 for a seamless loop.
    seam_step: float
    #: Sample-value component of seam_step, kept separately because a loop can
    #: be continuous in value while kinking in slope.
    seam_step_value: float
    #: Slope component of seam_step.
    seam_step_slope: float
    #: Normalised cross-correlation across the seam in the RENDER, one period
    #: either side. 1.0 = the render continues as if nothing happened.
    seam_ncc: float
    #: Zero-lag correlation between the fade-out and fade-in SOURCE regions.
    #: NaN when there is no crossfade. Negative means the equal-power blend will
    #: partially cancel.
    zero_lag_corr: float
    #: Detune implied by the loop's audible repeat period, in cents:
    #: ``1200*log2(wrap_advance / (k*T))`` against the MEASURED period T.
    cents_err_per_loop: float
    #: Peak deviation of the RMS envelope near the seam from the loop interior's
    #: level, in dB. Signed toward the larger absolute deviation, so a
    #: cancellation dip reads negative.
    rms_ripple_db: float
    #: RMS log-spectral distance, in dB, between a frame centred on the seam and
    #: a frame from the loop interior.
    spectral_dist: float

    #: Context, not metrics — carried so the report can explain a number.
    wrap_advance: int = 0
    eff_xfade: int = 0
    period_multiple: int = 0

    def as_dict(self) -> dict:
        return asdict(self)


#: The six metrics in report order, with the direction that is "better". Used by
#: the report and by ranking; deliberately not weights.
METRIC_DIRECTION = {
    "seam_step": "lower",
    "seam_ncc": "higher",
    "zero_lag_corr": "higher",
    "cents_err_per_loop": "lower_abs",
    "rms_ripple_db": "lower_abs",
    "spectral_dist": "lower",
}


def normalized_cross_correlation(a: np.ndarray, b: np.ndarray) -> float:
    """Zero-lag NCC of two equal-length segments, in [-1, 1].

    Mirrors ``normalizedCrossCorrelation`` in engine/src/dsp/LoopAnalysis.h:
    dot product over the product of the two L2 norms, with a silent segment
    reported as undefined rather than as 0 or 1.
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size == 0 or a.size != b.size:
        return float("nan")
    na = float(np.sqrt(np.dot(a, a)))
    nb = float(np.sqrt(np.dot(b, b)))
    if na <= _EPS or nb <= _EPS:
        return float("nan")
    return float(np.dot(a, b) / (na * nb))


def sliding_rms(y: np.ndarray, window: int) -> np.ndarray:
    """RMS in a sliding window of ``window`` samples, one value per offset."""
    y = np.asarray(y, dtype=np.float64)
    if window <= 0 or y.size < window:
        return np.zeros(0)
    power = np.concatenate(([0.0], np.cumsum(y * y)))
    sums = power[window:] - power[:-window]
    return np.sqrt(np.maximum(sums, 0.0) / window)


def _next_pow2(n: int) -> int:
    return 1 << max(3, int(math.ceil(math.log2(max(2, n)))))


def log_spectral_distance(a: np.ndarray, b: np.ndarray) -> float:
    """RMS log-spectral distance between two equal-length frames, in dB.

    Hann-windowed magnitude spectra, compared bin by bin in dB. The floor keeps
    empty high-frequency bins from dominating: without it, two near-silent bins
    differing by a factor of 1000 in absolute terms contribute 60 dB of
    "distance" that nobody can hear.
    """
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.size == 0 or a.size != b.size:
        return float("nan")
    win = np.hanning(a.size)
    fa = np.abs(np.fft.rfft(a * win))
    fb = np.abs(np.fft.rfft(b * win))
    scale = max(float(fa.max()), float(fb.max()))
    if scale <= _EPS:
        return float("nan")
    # Relative floor at -80 dB of the louder frame's peak.
    floor = scale * 1e-4
    la = 20.0 * np.log10(np.maximum(fa, floor))
    lb = 20.0 * np.log10(np.maximum(fb, floor))
    return float(np.sqrt(np.mean((la - lb) ** 2)))


def measure(
    x: np.ndarray,
    cfg: LoopConfig,
    period: float,
    sample_rate: float = ENGINE_SAMPLE_RATE,
) -> SeamMetrics:
    """Measure one loop configuration on ``x``.

    ``period`` is the MEASURED fundamental period in samples, from
    :mod:`loop_optimizer.pitch`. The declared ``root_note`` is never used: a
    hard-tuned vocal is routinely a few cents off its label, and quantising a
    loop to the label instead of to the material is the exact error
    ``cents_err_per_loop`` exists to detect.
    """
    xf = np.asarray(x, dtype=np.float32)
    n_frames = xf.shape[0]
    eff = resolve(cfg, n_frames, sample_rate)
    nan = float("nan")

    if not eff.use_loop or eff.wrap_advance <= 0 or not np.isfinite(period) or period <= 1.0:
        return SeamMetrics(nan, nan, nan, nan, nan, nan, nan, nan, eff.wrap_advance, eff.eff_xfade, 0)

    advance = eff.wrap_advance
    seam = seam_output_index(eff, cfg)
    period_i = max(1, int(round(period)))

    # Render span either side of the seam. Sized from the PERIOD and the
    # CROSSFADE, never from the loop length: a one-period loop and a two-second
    # loop both need the same few periods of context around the seam, and tying
    # the span to the loop length leaves a short loop with nothing to measure
    # against. The crossfade term matters because a cancellation dip sits in the
    # middle of the fade, so the whole fade has to be inside the window.
    #
    # For a short loop this span crosses earlier seams. That is not a problem —
    # it is what the loop actually sounds like — and every mask below is
    # computed against the distance to the NEAREST seam rather than to this one.
    span = int(max(4 * period_i, 1024, eff.eff_xfade + 2 * period_i))
    lo = max(0, seam - span)
    count = (seam - lo) + span
    y = render_window(xf, cfg, lo, count, sample_rate=sample_rate).astype(np.float64)
    i = seam - lo  # index of the first post-wrap sample within y

    if i < 3 or i + 3 >= y.size:
        return SeamMetrics(nan, nan, nan, nan, nan, nan, nan, nan, advance, eff.eff_xfade, 0)

    rms_all = float(np.sqrt(np.mean(y * y)))
    if rms_all <= _EPS:
        return SeamMetrics(nan, nan, nan, nan, nan, nan, nan, nan, advance, eff.eff_xfade, 0)

    # ── 1. seam_step ────────────────────────────────────────────────────────
    # Linear-prediction residual across the seam. Extrapolating the two samples
    # before the seam to where the next one "should" land isolates the jump the
    # seam introduced from the motion the waveform was already making.
    #
    # Note the floor this implies: for a smooth tone the residual cannot reach
    # zero, because a sine has real curvature. That floor is ~(2*pi*f0/fs)^2
    # relative to amplitude — 5e-3 at 480 Hz / 48 kHz — which is two to three
    # orders of magnitude below a genuine click, so the separation is clean.
    predicted = 2.0 * y[i - 1] - y[i - 2]
    step_value = abs(float(y[i] - predicted)) / rms_all
    # Slope discontinuity: the derivative just after the seam against the
    # derivative just before it.
    slope_after = float(y[i + 1] - y[i])
    slope_before = float(y[i - 1] - y[i - 2])
    step_slope = abs(slope_after - slope_before) / rms_all
    # Combined with max(), NOT a weighted sum: weights would be tuning, and this
    # phase does no tuning. A loop is only as good as its worse discontinuity.
    seam_step = max(step_value, step_slope)

    # ── 2. seam_ncc ─────────────────────────────────────────────────────────
    # One period either side of the seam in the RENDER. For a correctly aligned
    # loop the two windows are exactly one period apart and therefore identical.
    w = max(2, int(round(SEAM_CORRELATION_PERIODS * period)))
    if i - w >= 0 and i + w <= y.size:
        seam_ncc = normalized_cross_correlation(y[i - w : i], y[i : i + w])
    else:
        seam_ncc = nan

    # ── 3. zero_lag_corr ────────────────────────────────────────────────────
    # SOURCE domain by definition: these are the two signals the engine's blend
    # mixes (Sampler.cpp:1122-1126), before it mixes them.
    if eff.eff_xfade > 0:
        fade_out_src = xf[eff.eff_loop_end - eff.eff_xfade : eff.eff_loop_end].astype(np.float64)
        fade_in_src = xf[eff.eff_loop_start : eff.eff_loop_start + eff.eff_xfade].astype(np.float64)
        zero_lag = normalized_cross_correlation(fade_out_src, fade_in_src)
    else:
        zero_lag = nan

    # ── 4. cents_err_per_loop ───────────────────────────────────────────────
    # Against wrap_advance — the audible repeat period — not the loop span. See
    # the module docstring.
    k = int(round(advance / period))
    if k >= 1:
        cents_err = 1200.0 * math.log2(advance / (k * period))
    else:
        cents_err = nan

    # Distance from every rendered sample to the NEAREST seam. Seams recur every
    # `advance` samples, so for a short loop the span contains several and the
    # naive distance-to-this-seam would mislabel the neighbours as interior.
    idx = np.arange(y.size, dtype=np.float64)
    seam_distance = np.abs(((idx - i) + advance / 2.0) % advance - advance / 2.0)

    # ── 5. rms_ripple_db ────────────────────────────────────────────────────
    # One-period sliding RMS across the render. "Near the seam" is two periods
    # either side plus the whole crossfade, since a cancellation dip sits in the
    # MIDDLE of the fade rather than at the seam itself.
    #
    # The reference level is the MEDIAN of the envelope over the span, not the
    # mean of an explicitly-carved interior. The median degrades gracefully: when
    # the loop is long it equals the interior level, because the seam
    # neighbourhood is then a small minority of the span; when the loop is so
    # short that every sample is near a seam — a loop whose body is entirely
    # crossfade is a real case in this corpus — it becomes the loop's own typical
    # level and the metric reports peak-to-median ripple, which is still exactly
    # what the name says. No regime switch, no undefined case.
    env_win = max(2, period_i)
    env = sliding_rms(y, env_win)
    if env.size > 8:
        centre_idx = np.arange(env.size) + env_win // 2
        env_seam_distance = seam_distance[np.clip(centre_idx, 0, y.size - 1)]
        near = env_seam_distance <= max(2.0 * period, float(eff.eff_xfade))
        ref = float(np.median(env))
        if np.count_nonzero(near) and ref > _EPS:
            dev_db = 20.0 * np.log10(np.maximum(env[near], _EPS) / ref)
            # Signed toward the largest excursion, so a cancellation dip stays
            # negative and a bump stays positive.
            rms_ripple_db = float(dev_db[int(np.argmax(np.abs(dev_db)))])
        else:
            rms_ripple_db = nan
    else:
        rms_ripple_db = nan

    # ── 6. spectral_dist ────────────────────────────────────────────────────
    # A frame CENTRED on the seam against the quietest-seam reference frame in
    # the same render. Centring on the seam is the whole point: a click sits
    # exactly at the boundary, so the obvious choice of two frames flanking it
    # would step around the very artefact being looked for.
    nfft = _next_pow2(int(2 * period_i))
    half = nfft // 2
    if i - half >= 0 and i + half <= y.size and y.size >= nfft + 2:
        # Reference: the admissible frame centre furthest from any seam.
        lo_c, hi_c = half, y.size - half
        centres = np.arange(lo_c, hi_c)
        ref_centre = int(centres[int(np.argmax(seam_distance[lo_c:hi_c]))])
        seam_frame = y[i - half : i + half]
        ref_frame = y[ref_centre - half : ref_centre + half]
        spectral_dist = log_spectral_distance(ref_frame, seam_frame)
    else:
        spectral_dist = nan

    return SeamMetrics(
        seam_step=seam_step,
        seam_step_value=step_value,
        seam_step_slope=step_slope,
        seam_ncc=seam_ncc,
        zero_lag_corr=zero_lag,
        cents_err_per_loop=cents_err,
        rms_ripple_db=rms_ripple_db,
        spectral_dist=spectral_dist,
        wrap_advance=advance,
        eff_xfade=eff.eff_xfade,
        period_multiple=k,
    )
