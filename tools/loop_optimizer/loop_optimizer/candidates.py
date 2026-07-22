"""Loop candidate generation.

Per the phase brief:

  * pitch-track the selection and take the median period T over its steadiest
    part (:mod:`loop_optimizer.pitch`);
  * propose loop lengths of k*T for every viable k;
  * for each length, run a WSOLA-style start search that maximises the
    normalised cross-correlation between ``x[start .. start+W]`` and
    ``x[start+len .. start+len+W]`` — i.e. between the two ends that will be
    joined;
  * for each length, sweep crossfade widths of 0, T, 2T, 3T, ... up to
    ``floor(len/2)``, clamped by the engine's own rule, and let the metrics
    arbitrate.

This is a JOINT (len, xfade) search, not length search with a few crossfade
options bolted on. Both are quantised to whole periods for the same reason:
the engine's wrap skips the first ``effXfade`` samples of the loop region, so
the audible repeat period is ``advance = len - xfade``, not ``len``. Whenever
either factor is not a period multiple, ``advance`` isn't either, and the loop
detunes. See the ``metrics`` module docstring.

Capping the requested crossfade at ``floor(len/2)`` is not just a sanity bound
— it is what keeps the engine's own clamp (``effXfade <= (loopEnd -
loopStart) // 2``, ``Sampler.cpp:905``) from ever binding. A crossfade request
that survives unclamped is period-aligned by construction; one that gets cut
down mid-flight lands on whatever the clamp produces, which is a HALF-period
multiple exactly when the span is an odd number of periods
(``hard_tuned_vocal_0009``: a perfectly-in-tune 6-period request against an
11-period span clamps to 5.5 periods and plays 149 cents flat). Every
candidate below is verified against ``resolve()`` before being emitted, so
that trap cannot reach the output silently.

No ranking happens here. Every viable candidate is returned.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .constants import (
    ENGINE_SAMPLE_RATE,
    MAX_LOOP_DURATION_SEC,
    MAX_PERIOD_MULTIPLES,
    MAX_XFADE_PERIOD_MULTIPLES,
    MIN_SEAM_NCC,
    SEAM_CORRELATION_PERIODS,
)
from .engine_emu import LoopConfig, resolve


@dataclass(frozen=True)
class Candidate:
    """One proposed loop. Unranked."""

    loop_start: int
    loop_end: int
    #: REQUESTED crossfade, in whole periods. ``generate_candidates`` verifies
    #: this survives the engine's clamp unchanged before emitting the
    #: candidate, so ``resolve(...).eff_xfade == crossfade_samples`` always
    #: holds here — unlike the gold loop, which was hand-authored and may not.
    crossfade_samples: int
    #: Measured fundamental period, in samples, this candidate is quantised to.
    period: float
    #: k, where ``loop_end - loop_start == round(k * period)``.
    period_multiple: int
    #: NCC between the two joined ends at the chosen alignment, SOURCE domain.
    #: This is the search's own objective, reported because it is free — not a
    #: ranking key. The render-domain equivalent is ``metrics.seam_ncc``.
    search_ncc: float

    @property
    def length(self) -> int:
        return self.loop_end - self.loop_start

    def to_config(self, **overrides) -> LoopConfig:
        kwargs = dict(
            loop_start=self.loop_start,
            loop_end=self.loop_end,
            crossfade_samples=self.crossfade_samples,
        )
        kwargs.update(overrides)
        return LoopConfig(**kwargs)


def sliding_end_match_ncc(x: np.ndarray, length: int, w: int, lo: int, hi: int) -> np.ndarray:
    """NCC between ``x[s:s+w]`` and ``x[s+length:s+length+w]`` for every s in [lo, hi).

    Evaluated in closed form for all starts at once rather than by a coarse
    sweep with local refinement: the dot product is a sliding sum of the product
    signal ``x[i] * x[i+length]``, and both norms come from one cumulative sum of
    squares, so the exact optimum costs the same as an approximate one.

    Returns NaN at starts where either window is silent.
    """
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    if hi <= lo or w <= 0 or lo < 0 or hi + length + w > n:
        return np.zeros(0)

    prod = x[: n - length] * x[length:]
    prod_cum = np.concatenate(([0.0], np.cumsum(prod)))
    sq_cum = np.concatenate(([0.0], np.cumsum(x * x)))

    s = np.arange(lo, hi)
    dot = prod_cum[s + w] - prod_cum[s]
    norm_a = np.sqrt(np.maximum(sq_cum[s + w] - sq_cum[s], 0.0))
    norm_b = np.sqrt(np.maximum(sq_cum[s + length + w] - sq_cum[s + length], 0.0))

    denom = norm_a * norm_b
    with np.errstate(divide="ignore", invalid="ignore"):
        ncc = np.where(denom > 1e-12, dot / denom, np.nan)
    return ncc


def generate_candidates(
    x: np.ndarray,
    period: float,
    window_start: int,
    window_end: int,
    sample_rate: float = ENGINE_SAMPLE_RATE,
    min_seam_ncc: float = MIN_SEAM_NCC,
) -> list[Candidate]:
    """Generate every viable loop candidate inside ``[window_start, window_end)``."""
    x = np.asarray(x, dtype=np.float64)
    n = x.shape[0]
    window_end = min(window_end, n)
    if not np.isfinite(period) or period <= 1.0 or window_end - window_start < 4:
        return []

    w = max(2, int(round(SEAM_CORRELATION_PERIODS * period)))
    max_len = int(min(MAX_LOOP_DURATION_SEC * sample_rate, (window_end - window_start) - w))
    if max_len < period:
        return []

    k_max = min(int(max_len // period), MAX_PERIOD_MULTIPLES)
    out: list[Candidate] = []

    for k in range(1, k_max + 1):
        length = int(round(k * period))
        if length <= 0:
            continue
        lo = window_start
        hi = window_end - length - w
        if hi <= lo:
            continue

        ncc = sliding_end_match_ncc(x, length, w, lo, hi)
        if ncc.size == 0 or not np.any(np.isfinite(ncc)):
            continue
        best_offset = int(np.nanargmax(ncc))
        best_ncc = float(ncc[best_offset])
        if not np.isfinite(best_ncc) or best_ncc < min_seam_ncc:
            # A k whose best possible alignment still cannot correlate is not a
            # real option; returning it would push a known-bad answer downstream.
            continue

        loop_start = lo + best_offset
        loop_end = loop_start + length

        # Every requested xfade below is capped at floor(length/2), which is
        # exactly the engine's own half-loop clamp bound (Sampler.cpp:905). A
        # request built to satisfy that bound in advance either survives
        # resolve() unchanged, or gets cut further by one of the *other*
        # clamps (fade region vs. trim bounds) — in which case it is rejected
        # outright rather than emitted at whatever width the clamp produced.
        max_xfade_samples = length // 2
        j_max = min(int(max_xfade_samples // period), MAX_XFADE_PERIOD_MULTIPLES) if period > 0 else -1

        seen_requested: set[int] = set()
        for j in range(0, j_max + 1):
            requested = int(round(j * period))
            if requested > max_xfade_samples or requested in seen_requested:
                continue
            seen_requested.add(requested)

            cfg = LoopConfig(loop_start=loop_start, loop_end=loop_end, crossfade_samples=requested)
            eff = resolve(cfg, n, sample_rate)
            if eff.wrap_advance <= 0:
                # The engine's clamp already prevents this, but a degenerate loop
                # would render as a stuck position rather than as audio.
                continue
            if eff.eff_xfade != requested:
                # A clamp bound other than the half-loop one fired (fade region
                # vs. trim bounds). Emitting this would be the exact
                # hard_tuned_vocal_0009 trap: a request that was period-aligned
                # on paper, silently detuned by the engine. Reject rather than
                # emit at the clamped width.
                continue

            out.append(
                Candidate(
                    loop_start=loop_start,
                    loop_end=loop_end,
                    crossfade_samples=requested,
                    period=float(period),
                    period_multiple=k,
                    search_ncc=best_ncc,
                )
            )

    return out
