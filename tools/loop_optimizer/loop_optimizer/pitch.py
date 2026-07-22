"""YIN pitch tracking and steady-state window detection.

Implemented in-tree from de Cheveigne & Kawahara (2002), "YIN, a fundamental
frequency estimator for speech and music", steps 1-5. No librosa, by
requirement and by preference: the C++ port needs a spec it can be read against,
and a library call is not one.

Relationship to the engine's own detector: ``engine/src/dsp/LoopAnalysis.h`` uses
NSDF/McLeod (``computeNSDF`` / ``detectPeriod``) rather than YIN. This is a
DOCUMENTED DIVERGENCE. The two disagree mainly in how they fail — NSDF is more
prone to picking a subharmonic, YIN to a harmonic — and the thing that actually
protects the result in both is the tonal-band gate in
:func:`detect_steady_state_window`, which rejects any hop whose period is not
within +/-20% of the file's fundamental. That gate is shared, and it is the same
mechanism that fixed the C5/525 Hz octave error recorded in LoopOptimizer.h.

Everything here is pure: arrays in, values out.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .constants import (
    ANALYSIS_FRAME,
    ANALYSIS_HOP,
    ATTACK_SKIP_FRAC,
    ENVELOPE_FRAME_MS,
    FUNDAMENTAL_PERIOD_TOLERANCE,
    MAX_PITCH_HZ,
    MIN_PITCH_HZ,
    MIN_VIABLE_PERIODS,
    MIN_VOICED_FRAC,
    SUSTAIN_THRESHOLD_FRAC,
    YIN_THRESHOLD,
)


@dataclass(frozen=True)
class PitchTrack:
    """Per-hop pitch analysis over a signal."""

    #: Sample index of each analysis hop's first sample.
    positions: np.ndarray
    #: Sub-sample period estimate per hop, in samples. NaN where unvoiced.
    periods: np.ndarray
    #: Voicing flag per hop (YIN CMND cleared the absolute threshold).
    voiced: np.ndarray
    #: Periodicity confidence per hop, ``1 - d'(tau)``, in roughly [0, 1].
    clarity: np.ndarray
    #: Short-window RMS level per hop; see ENVELOPE_FRAME_MS for why it is
    #: measured over its own frame rather than over the analysis frame.
    rms: np.ndarray
    sample_rate: float

    @property
    def voiced_fraction(self) -> float:
        if self.voiced.size == 0:
            return 0.0
        return float(np.count_nonzero(self.voiced) / self.voiced.size)

    def f0(self) -> np.ndarray:
        """Per-hop fundamental in Hz; NaN where unvoiced."""
        with np.errstate(divide="ignore", invalid="ignore"):
            return self.sample_rate / self.periods

    def median_period(self) -> float:
        """Median period over voiced hops, in samples. NaN if nothing voiced."""
        vals = self.periods[self.voiced]
        return float(np.median(vals)) if vals.size else float("nan")


def _difference_function(frame: np.ndarray, tau_max: int) -> np.ndarray:
    """YIN step 1: the squared-difference function d(tau), tau in [0, tau_max].

        d(tau) = sum_j (x[j] - x[j+tau])^2
               = sum_j x[j]^2  +  sum_j x[j+tau]^2  -  2 * sum_j x[j]*x[j+tau]

    The three terms are, in order: a constant, a windowed running power (from a
    cumulative sum of squares) and an autocorrelation (via FFT). Written out
    this way because the naive double loop is O(W * tau_max) and this is not.
    """
    w = frame.shape[0] - tau_max  # integration window length
    x = frame.astype(np.float64)

    power = np.concatenate(([0.0], np.cumsum(x * x)))
    term_first = power[w] - power[0]  # sum of x[0..w) squared, constant in tau
    term_lagged = power[w + np.arange(tau_max + 1)] - power[np.arange(tau_max + 1)]

    size = 1 << int(np.ceil(np.log2(frame.shape[0] + w)))
    spec = np.fft.rfft(x, size)
    spec_w = np.fft.rfft(x[:w][::-1], size)
    conv = np.fft.irfft(spec * spec_w, size)
    term_cross = conv[w - 1 : w + tau_max]

    d = term_first + term_lagged - 2.0 * term_cross
    # Numerically d(0) is exactly 0; clamp away tiny negatives from FFT round-off
    # so the CMND below cannot produce a NaN.
    return np.maximum(d, 0.0)


def _cumulative_mean_normalized(d: np.ndarray) -> np.ndarray:
    """YIN step 3: d'(tau) = d(tau) / ((1/tau) * sum_{j=1..tau} d(j)), d'(0) = 1."""
    out = np.ones_like(d)
    cumsum = np.cumsum(d[1:])
    taus = np.arange(1, d.shape[0])
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = d[1:] * taus / cumsum
    # A silent frame gives cumsum == 0; call it maximally aperiodic, not NaN.
    out[~np.isfinite(out)] = 1.0
    return out


def _absolute_threshold(cmnd: np.ndarray, tau_min: int, tau_max: int, threshold: float) -> int:
    """YIN step 4. First local minimum below the threshold; global min otherwise.

    Taking the FIRST qualifying dip rather than the global minimum is what makes
    YIN prefer the fundamental over its octave: the octave's dip is usually
    deeper, and choosing by depth alone lands on it.
    """
    tau = tau_min
    while tau < tau_max:
        if cmnd[tau] < threshold:
            while tau + 1 < tau_max and cmnd[tau + 1] < cmnd[tau]:
                tau += 1
            return tau
        tau += 1
    # Nothing cleared the threshold — report the best dip so the caller can see
    # how far off it was, and let the voicing flag say it was not good enough.
    return int(np.argmin(cmnd[tau_min:tau_max])) + tau_min


def _parabolic_refine(cmnd: np.ndarray, tau: int) -> float:
    """YIN step 5: parabolic interpolation of the dip, for sub-sample period.

    Sub-sample precision matters here well beyond cosmetics: ``cents_err_per_loop``
    divides the loop length by k*T, and a half-sample error in T at T=90 samples
    is already ~10 cents.
    """
    if tau <= 0 or tau + 1 >= cmnd.shape[0]:
        return float(tau)
    a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
    denom = 2.0 * (a - 2.0 * b + c)
    if abs(denom) < 1e-18:
        return float(tau)
    return float(tau + (a - c) / denom)


def track_pitch(
    x: np.ndarray,
    sample_rate: float,
    frame_length: int = ANALYSIS_FRAME,
    hop_length: int = ANALYSIS_HOP,
    threshold: float = YIN_THRESHOLD,
    min_hz: float = MIN_PITCH_HZ,
    max_hz: float = MAX_PITCH_HZ,
) -> PitchTrack:
    """Run YIN over ``x`` at ``hop_length`` intervals."""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]

    tau_min = max(2, int(np.floor(sample_rate / max_hz)))
    tau_max = min(int(np.ceil(sample_rate / min_hz)) + 1, frame_length // 2)
    if tau_max <= tau_min + 2 or n < frame_length:
        empty = np.zeros(0)
        return PitchTrack(empty, empty, empty.astype(bool), empty, empty, sample_rate)

    env_frame = max(1, int(ENVELOPE_FRAME_MS * 0.001 * sample_rate))

    starts = np.arange(0, n - frame_length + 1, hop_length, dtype=np.int64)
    periods = np.full(starts.shape[0], np.nan)
    voiced = np.zeros(starts.shape[0], dtype=bool)
    clarity = np.zeros(starts.shape[0])
    rms = np.zeros(starts.shape[0])

    for i, start in enumerate(starts):
        frame = x[start : start + frame_length]
        d = _difference_function(frame, tau_max)
        cmnd = _cumulative_mean_normalized(d)
        tau = _absolute_threshold(cmnd, tau_min, tau_max, threshold)
        periods[i] = _parabolic_refine(cmnd, tau)
        voiced[i] = bool(cmnd[tau] < threshold)
        clarity[i] = float(1.0 - cmnd[tau])

        # Level over its OWN short frame, read forward from the hop. Using the
        # analysis frame here would look ~43 ms ahead and fire the attack skip
        # early on swelling material (LoopOptimizer.h kEnvelopeFrameMs).
        seg = x[start : start + env_frame]
        rms[i] = float(np.sqrt(np.mean(seg * seg))) if seg.size else 0.0

    return PitchTrack(starts, periods, voiced, clarity, rms, sample_rate)


@dataclass(frozen=True)
class SteadyStateWindow:
    """Half-open sample range ``[start, end)`` plus why it was chosen."""

    start: int
    end: int
    #: Fundamental period, in samples, over the selected region. NaN if refused.
    period: float
    #: Whether a viable region was found at all.
    viable: bool
    reason: str = ""

    @property
    def length(self) -> int:
        return max(0, self.end - self.start)


def _contiguous_runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """Maximal runs of True in ``mask``, as half-open hop-index ranges."""
    runs: list[tuple[int, int]] = []
    start = None
    for i, flag in enumerate(mask):
        if flag and start is None:
            start = i
        elif not flag and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, len(mask)))
    return runs


def detect_steady_state_window(track: PitchTrack, num_samples: int) -> SteadyStateWindow:
    """Find the sustained, TONAL region to search for loops in.

    Mirrors the policy of ``detectSteadyStateWindow`` in
    ``engine/src/dsp/LoopOptimizer.h``:

      1. take the median voiced period as the file's fundamental;
      2. mark a hop TONAL when it is voiced AND within
         +/-``FUNDAMENTAL_PERIOD_TOLERANCE`` of that fundamental — this, not the
         level, is the primary signal, and it is what stops a loud region voiced
         at an OVERTONE from being mistaken for the sustain;
      3. among the maximal tonal runs long enough to loop, pick the LOUDEST by
         mean RMS;
      4. trim that run's attack (``ATTACK_SKIP_FRAC``) and trailing decay
         (``SUSTAIN_THRESHOLD_FRAC``) against the run's OWN peak RMS, never the
         file's global peak.

    Refusal is a legitimate answer. Material that fails the voicing gate returns
    ``viable=False`` rather than a correlation-only guess.

    KNOWN LIMITATION. The fundamental is a MEDIAN over voiced hops, which assumes
    one pitch dominates. On material whose voiced hops split roughly evenly
    between two unrelated pitches — a two-note phrase, say — the median can land
    between them, describing neither, and no hop then falls inside the tonal
    band. The result is a refusal. That is the safe failure (the alternative is
    confidently looping to a pitch that is not in the material), but a caller
    seeing ``viable=False`` should read it as "no single fundamental here", not
    as "this sample cannot be looped". Segmenting such a file into single-pitch
    regions is a separate problem this function does not attempt.
    """
    if track.positions.size == 0:
        return SteadyStateWindow(0, 0, float("nan"), False, "no analysis hops (sample shorter than one frame)")

    fundamental = track.median_period()
    if not np.isfinite(fundamental):
        return SteadyStateWindow(0, 0, float("nan"), False, "no voiced hops")

    tol = FUNDAMENTAL_PERIOD_TOLERANCE * fundamental
    tonal = track.voiced & (np.abs(track.periods - fundamental) <= tol)

    hop = int(track.positions[1] - track.positions[0]) if track.positions.size > 1 else ANALYSIS_HOP
    min_window_samples = int(np.ceil(MIN_VIABLE_PERIODS * track.sample_rate / MIN_PITCH_HZ))
    min_hops = max(1, int(np.ceil(min_window_samples / hop)))

    runs = [r for r in _contiguous_runs(tonal) if (r[1] - r[0]) >= min_hops]
    if not runs:
        return SteadyStateWindow(
            0,
            0,
            fundamental,
            False,
            f"no tonal run >= {min_hops} hops (voiced fraction {track.voiced_fraction:.2f})",
        )

    lo, hi = max(runs, key=lambda r: float(np.mean(track.rms[r[0] : r[1]])))

    run_rms = track.rms[lo:hi]
    peak = float(np.max(run_rms)) if run_rms.size else 0.0
    if peak <= 0.0:
        return SteadyStateWindow(0, 0, fundamental, False, "selected tonal run is silent")

    # Attack skip: advance to the first hop at ATTACK_SKIP_FRAC of the run peak.
    above_attack = np.nonzero(run_rms >= ATTACK_SKIP_FRAC * peak)[0]
    first = int(above_attack[0]) if above_attack.size else 0
    # Sustain trim: drop trailing hops that have decayed below the sustain floor.
    above_sustain = np.nonzero(run_rms >= SUSTAIN_THRESHOLD_FRAC * peak)[0]
    last = int(above_sustain[-1]) if above_sustain.size else int(run_rms.size - 1)
    if last < first:
        last = first

    start = int(track.positions[lo + first])
    # The last hop's analysis frame extends beyond its start; end the window at
    # the following hop position so the region stays inside measured material.
    end_hop_index = lo + last
    end = int(track.positions[end_hop_index]) + hop
    end = min(end, num_samples)

    # Re-derive the period from the surviving hops only: the fundamental above
    # was a whole-file median, and the window may have excluded material that
    # dragged it.
    window_periods = track.periods[lo + first : end_hop_index + 1]
    window_voiced = track.voiced[lo + first : end_hop_index + 1]
    sel = window_periods[window_voiced]
    period = float(np.median(sel)) if sel.size else fundamental

    if end - start < min_window_samples:
        return SteadyStateWindow(
            start,
            end,
            period,
            False,
            f"steady region {end - start} samples < {min_window_samples} required",
        )

    # Pitched-monophonic gate (LoopOptimizer.h kMinVoicedFrac), applied to the
    # SELECTED window rather than the whole file: an unvoiced lead-in or tail is
    # exactly what the window trimming just removed, and letting it veto the file
    # would refuse samples whose sustain is perfectly loopable.
    window_voiced_frac = float(np.count_nonzero(window_voiced) / max(1, window_voiced.size))
    if window_voiced_frac < MIN_VOICED_FRAC:
        return SteadyStateWindow(
            start,
            end,
            period,
            False,
            f"window voiced fraction {window_voiced_frac:.2f} < {MIN_VOICED_FRAC}",
        )

    return SteadyStateWindow(start, end, period, True, "")
