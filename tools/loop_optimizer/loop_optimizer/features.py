"""Per-sample measured features, written back into a copy of ``dataset.json``.

These describe the MATERIAL, not any particular loop. They exist so the corpus
can be filtered and grouped by what a sample actually is rather than by what its
metadata claims — most importantly ``median_f0_hz``, which is repeatedly a few
cents away from the pitch ``root_note`` declares.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from .constants import FUNDAMENTAL_PERIOD_TOLERANCE
from .pitch import PitchTrack


@dataclass(frozen=True)
class MeasuredFeatures:
    """Material description, all measured — nothing taken from metadata."""

    #: Median fundamental over voiced hops, in Hz.
    median_f0_hz: float
    #: Median period over voiced hops, in samples at the ENGINE rate. Carried
    #: because every loop length in this tool is quantised to it.
    median_period_samples: float
    #: Standard deviation of the per-hop pitch about the median, in cents,
    #: measured over TONAL hops only — those within
    #: FUNDAMENTAL_PERIOD_TOLERANCE of the median period.
    #:
    #: The gate is not cosmetic. YIN octave-errors on a minority of hops in
    #: decaying tails and at region boundaries, and a single hop an octave out
    #: contributes 1200 cents to a standard deviation. Ungated, two samples in
    #: the current corpus report 500 and 380 cents of "jitter" while 86% of their
    #: hops sit within 6% of the median — a number that describes the tracker,
    #: not the material. The excluded hops are not swept away; they are counted
    #: in ``octave_outlier_fraction``.
    f0_cents_std: float
    #: Fraction of VOICED hops that fell outside the tonal band — i.e. the
    #: tracker's octave-error rate on this sample, plus any genuine pitch change.
    #: Read alongside f0_cents_std: low jitter with a high outlier fraction means
    #: a steady note whose tail confused the tracker, not a stable sample.
    octave_outlier_fraction: float
    #: Fraction of analysis hops YIN found voiced, over the whole file.
    voiced_fraction: float
    #: Slope of the level envelope over the voiced region, in dB/second.
    #: Negative is decaying. A steep decay means a loop will step in level at
    #: the seam no matter how well aligned it is.
    decay_slope_db_per_sec: float
    #: Median periodicity confidence over voiced hops, in [0, 1].
    median_clarity: float
    #: Cents from the nearest equal-tempered semitone (A440), signed. Says how
    #: "hard-tuned" the material really is.
    cents_from_equal_temperament: float

    def as_dict(self) -> dict:
        return asdict(self)


def _cents_from_equal_temperament(f0_hz: float) -> float:
    if not math.isfinite(f0_hz) or f0_hz <= 0.0:
        return float("nan")
    midi = 69.0 + 12.0 * math.log2(f0_hz / 440.0)
    return float((midi - round(midi)) * 100.0)


def measure_features(track: PitchTrack) -> MeasuredFeatures:
    """Derive :class:`MeasuredFeatures` from a completed pitch track."""
    nan = float("nan")
    if track.positions.size == 0 or not np.any(track.voiced):
        return MeasuredFeatures(nan, nan, nan, nan, track.voiced_fraction, nan, nan, nan)

    periods = track.periods[track.voiced]
    median_period = float(np.median(periods))
    median_f0 = float(track.sample_rate / median_period) if median_period > 0 else nan

    # Same tonal band the steady-state detector uses, for the same reason: a hop
    # an octave away is not a measurement of this note's pitch stability.
    tonal = np.abs(periods - median_period) <= FUNDAMENTAL_PERIOD_TOLERANCE * median_period
    outlier_fraction = float(1.0 - np.count_nonzero(tonal) / periods.size)

    with np.errstate(divide="ignore", invalid="ignore"):
        cents = 1200.0 * np.log2((track.sample_rate / periods[tonal]) / median_f0)
    cents = cents[np.isfinite(cents)]
    cents_std = float(np.std(cents)) if cents.size else nan

    # Decay slope over the voiced hops only. Fitting the whole file would put
    # the silent lead-in and tail into the regression and report a decay that
    # the tonal body does not have.
    rms_voiced = track.rms[track.voiced]
    pos_voiced = track.positions[track.voiced].astype(np.float64)
    usable = rms_voiced > 1e-9
    if np.count_nonzero(usable) >= 2:
        t = pos_voiced[usable] / track.sample_rate
        db = 20.0 * np.log10(rms_voiced[usable])
        if float(np.ptp(t)) > 1e-6:
            slope = float(np.polyfit(t, db, 1)[0])
        else:
            slope = nan
    else:
        slope = nan

    clarity = track.clarity[track.voiced]
    return MeasuredFeatures(
        median_f0_hz=median_f0,
        median_period_samples=median_period,
        f0_cents_std=cents_std,
        octave_outlier_fraction=outlier_fraction,
        voiced_fraction=track.voiced_fraction,
        decay_slope_db_per_sec=slope,
        median_clarity=float(np.median(clarity)) if clarity.size else nan,
        cents_from_equal_temperament=_cents_from_equal_temperament(median_f0),
    )
