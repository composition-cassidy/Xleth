"""LPC formant tracking — a SEARCH objective, not a ruler.

WHY THIS EXISTS AND WHY IT IS NEW. The phase-3 brief assumed the perceptual
suite already tracked formants. It does not: ``perceptual._timbre_jump``
compares 24-band MEL envelopes, which is a smoothed spectral-shape distance —
it never resolves a pole, never names an F1, and cannot say whether the second
formant moved 300 Hz or the whole spectrum tilted. That distinction is exactly
what the round-3 losses were about ("timbre-jump", 12 of 17), so this module
adds the real thing.

It is deliberately kept OUT of :mod:`loop_optimizer.perceptual`. Formant
distance under-discriminated as a RANKER — the metric suite already has one
timbre term and adding a second correlated one would not have changed an
ordering. Here it decides WHERE THE LOOP GOES and HOW LONG THE FADE IS, which
is a different job: a ranker has to be right about which of two finished loops
is better, while a search objective only has to be right about which region of
one sample is calmer than the rest of that same sample. The second is a much
weaker claim and this measurement can support it.

HOW THE POLES ARE FOUND. Standard autocorrelation LPC, with one wrinkle that
avoids pulling in a resampler:

  * pre-emphasise (+6 dB/oct) to flatten the glottal source slope, so the poles
    that survive are the vocal-tract resonances rather than the source spectrum;
  * window, FFT, ZERO every bin above :data:`FORMANT_BAND_HZ`, inverse-FFT the
    power spectrum. That yields the linear autocorrelation of a signal that is
    band-limited by construction;
  * a band-limited signal's autocorrelation at every ``D``-th lag IS the
    autocorrelation of the same signal decimated by ``D`` — exactly, not
    approximately — so taking ``r[::D]`` gives the low-rate autocorrelation
    without ever resampling the waveform. At 48 kHz, ``D = 5`` puts the analysis
    at 9.6 kHz, whose Nyquist (4800 Hz) clears the 4500 Hz band edge;
  * Levinson-Durbin at order 12 (2 poles per expected resonance in a 4.8 kHz
    band, plus 2 for spectral tilt), roots of ``A(z)``, keep the poles that are
    inside the formant band and narrow enough to be resonances rather than
    slope, sort by frequency, take the lowest three.

Everything is reported in CENTS (``1200 * log2(f)``), not Hz. F1 sits near
600 Hz and F3 near 2600; a 200 Hz move means something very different at each,
and averaging them in Hz would make the drift measure a proxy for "does this
sample have a high F3". Cents makes the three commensurate, and it is the unit
the audibility threshold in :mod:`loop_optimizer.export` is quoted in.

NaN IS A VALUE HERE. A frame with fewer than three qualifying poles, a span too
short to hold a frame, silence — all return NaN rather than 0.0, for the reason
db7e180 had to fix in the metric suite: a fake 0.0 reads as "perfectly stable"
and wins every gate it is offered to. Callers must treat NaN as "not measurable
here", never as "fine".
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

_EPS = 1e-12

#: Upper edge of the band the all-pole model is fitted over, in Hz. F3 tops out
#: around 3500 Hz in speech and rather lower in the sung/synth material this
#: corpus is made of; the extra headroom to 4500 gives the highest pole
#: somewhere to sit without being pinned against the band edge.
FORMANT_BAND_HZ = 4500.0

#: Analysis frame and hop, in ms. 30 ms is the classic formant frame: long
#: enough to hold 2+ periods at the corpus's lowest supported pitch (75 Hz,
#: 13.3 ms) so the autocorrelation sees the resonance rather than one glottal
#: pulse, short enough that a moving vowel is not averaged into a smear.
FORMANT_FRAME_MS = 30.0
FORMANT_HOP_MS = 10.0

#: All-pole order at the DECIMATED rate. Two poles per resonance across a
#: 4.8 kHz Nyquist (~5 resonances) plus two for overall tilt.
FORMANT_LPC_ORDER = 12

#: A pole must sit in this band, and be this narrow, to be called a formant.
#: The bandwidth test is what separates a resonance from the spectral slope: a
#: pole modelling tilt lands near DC or near Nyquist with a bandwidth of a
#: kilohertz or more.
FORMANT_MIN_HZ = 90.0
FORMANT_MAX_HZ = 4200.0
FORMANT_MAX_BANDWIDTH_HZ = 500.0

#: Pre-emphasis coefficient. The textbook 0.97.
PREEMPHASIS = 0.97

#: How many formants are tracked. F1-F3 carry vowel identity; F4+ is speaker
#: timbre and is not what "the loop landed on the wrong vowel moment" is about.
N_FORMANTS = 3


def _cents(hz: np.ndarray | float) -> np.ndarray | float:
    """Hz -> cents re 1 Hz. The absolute reference cancels in every use here."""
    return 1200.0 * np.log2(np.maximum(np.asarray(hz, dtype=np.float64), _EPS))


def levinson(r: np.ndarray, order: int) -> np.ndarray | None:
    """Levinson-Durbin recursion. Returns ``A(z)`` coefficients (``a[0] == 1``).

    ``None`` when the recursion leaves the unit circle or the residual energy
    collapses — both mean the autocorrelation was not that of a stable all-pole
    process (silence, a pure impulse, numerical ruin) and there is no formant to
    read out of it.
    """
    r = np.asarray(r, dtype=np.float64)
    if r.size <= order or not np.all(np.isfinite(r)) or r[0] <= _EPS:
        return None

    a = np.zeros(order + 1, dtype=np.float64)
    a[0] = 1.0
    err = float(r[0])

    for i in range(1, order + 1):
        acc = r[i] + float(np.dot(a[1:i], r[i - 1 : 0 : -1])) if i > 1 else float(r[i])
        k = -acc / err
        if not math.isfinite(k) or abs(k) >= 1.0:
            return None
        prev = a.copy()
        a[1:i] = prev[1:i] + k * prev[i - 1 : 0 : -1]
        a[i] = k
        err *= 1.0 - k * k
        if err <= _EPS:
            return None
    return a


def _band_limited_autocorrelation(
    frame: np.ndarray, sample_rate: float, band_hz: float, max_lag: int
) -> np.ndarray | None:
    """Linear autocorrelation of ``frame`` after everything above ``band_hz`` is removed."""
    n = frame.size
    if n < 4 or max_lag < 1:
        return None
    n_fft = 1 << int(math.ceil(math.log2(max(8, 2 * n))))
    spec = np.fft.rfft(frame, n_fft)
    power = spec.real**2 + spec.imag**2
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sample_rate)
    power[freqs > band_hz] = 0.0
    r = np.fft.irfft(power, n_fft)
    if r.size <= max_lag or not np.isfinite(r[0]) or r[0] <= _EPS:
        return None
    return r[: max_lag + 1]


def frame_formants(frame: np.ndarray, sample_rate: float) -> np.ndarray:
    """F1-F3 of one frame, in Hz. Shape ``(N_FORMANTS,)``, NaN where unresolved."""
    out = np.full(N_FORMANTS, np.nan)
    y = np.asarray(frame, dtype=np.float64)
    if y.size < 4 or not np.all(np.isfinite(y)):
        return out

    # Pre-emphasis before windowing: the window's taper would otherwise be
    # differentiated along with the signal.
    y = np.concatenate(([y[0]], y[1:] - PREEMPHASIS * y[:-1]))
    y = y * np.hamming(y.size)
    if float(np.max(np.abs(y))) <= _EPS:
        return out

    decim = max(1, int(sample_rate // (2.0 * FORMANT_BAND_HZ)))
    eff_rate = sample_rate / decim
    r_full = _band_limited_autocorrelation(
        y, sample_rate, FORMANT_BAND_HZ, FORMANT_LPC_ORDER * decim
    )
    if r_full is None:
        return out

    # `r[::D]` of a band-limited signal IS the decimated signal's own
    # autocorrelation, so the LPC below is fitted at `eff_rate` with no
    # resampling anywhere.
    a = levinson(r_full[::decim], FORMANT_LPC_ORDER)
    if a is None:
        return out

    roots = np.roots(a)
    roots = roots[np.imag(roots) > 0.0]
    if roots.size == 0:
        return out
    mag = np.abs(roots)
    with np.errstate(divide="ignore", invalid="ignore"):
        freq = np.angle(roots) * eff_rate / (2.0 * np.pi)
        bw = -np.log(np.maximum(mag, _EPS)) * eff_rate / np.pi
    keep = (
        np.isfinite(freq)
        & np.isfinite(bw)
        & (freq >= FORMANT_MIN_HZ)
        & (freq <= min(FORMANT_MAX_HZ, eff_rate / 2.0))
        & (bw <= FORMANT_MAX_BANDWIDTH_HZ)
    )
    picked = np.sort(freq[keep])[:N_FORMANTS]
    out[: picked.size] = picked
    return out


@dataclass
class FormantTrack:
    """F1-F3 sampled on a fixed grid, plus O(1) variance over any span.

    The cumulative sums exist because the placement search asks for the drift of
    thousands of overlapping spans out of one track. Summing a slice per span
    would make the search quadratic in the window length for no reason; the
    running sums make every span a constant-time subtraction, and because they
    carry a per-formant VALID COUNT alongside, a span whose frames failed to
    resolve reports NaN rather than silently averaging fewer samples.
    """

    frame_starts: np.ndarray
    frame_len: int
    hop: int
    sample_rate: float
    #: ``(n_frames, N_FORMANTS)`` in cents re 1 Hz. NaN where unresolved.
    cents: np.ndarray

    sum1: np.ndarray = field(init=False, repr=False)
    sum2: np.ndarray = field(init=False, repr=False)
    count: np.ndarray = field(init=False, repr=False)
    offset: np.ndarray = field(init=False, repr=False)

    def __post_init__(self) -> None:
        c = np.asarray(self.cents, dtype=np.float64).reshape(-1, N_FORMANTS)
        valid = np.isfinite(c)
        # Centre each formant before accumulating. The variance below is the
        # textbook E[x^2] - E[x]^2, which cancels catastrophically on raw cents:
        # F2 near 1200 Hz is ~12300 cents, so E[x^2] and E[x]^2 are both ~1.5e8
        # while their difference — the drift the whole search turns on — is
        # order 1. That throws away eight of the sixteen available digits.
        # Subtracting a per-formant constant first leaves the variance
        # unchanged mathematically and well-conditioned numerically.
        counts = valid.sum(axis=0)
        offset = np.zeros(N_FORMANTS)
        for f in range(N_FORMANTS):
            if counts[f] > 0:
                offset[f] = float(np.mean(c[valid[:, f], f]))
        filled = np.where(valid, c - offset, 0.0)

        zero = np.zeros((1, N_FORMANTS))
        self.cents = c
        self.offset = offset
        self.sum1 = np.vstack([zero, np.cumsum(filled, axis=0)])
        self.sum2 = np.vstack([zero, np.cumsum(filled * filled, axis=0)])
        self.count = np.vstack([zero, np.cumsum(valid.astype(np.float64), axis=0)])

    @property
    def n_frames(self) -> int:
        return int(self.cents.shape[0])

    def _frame_range(self, start: int, end: int) -> tuple[int, int]:
        """Frames lying WHOLLY inside ``[start, end)``, as a half-open index pair.

        Wholly, not partially: a frame straddling the span boundary reads
        material the span does not contain, and the whole point of the drift
        measure is that it describes what the loop itself will repeat.
        """
        if self.n_frames == 0:
            return 0, 0
        lo = int(np.searchsorted(self.frame_starts, start, side="left"))
        hi = int(np.searchsorted(self.frame_starts, end - self.frame_len, side="right"))
        return lo, max(lo, hi)

    def span_drift_cents(self, start: int, end: int) -> float:
        """RMS (over F1-F3) of each formant's standard deviation across the span.

        This is the search objective: how much the vowel MOVES while the loop
        plays. NaN when fewer than two frames resolved — one frame has no
        variance and zero frames have nothing at all, and reporting 0.0 for
        either would make an unmeasurable span the calmest one in the pool.
        """
        lo, hi = self._frame_range(start, end)
        n = self.count[hi] - self.count[lo]
        ok = n >= 2.0
        if not np.any(ok):
            return float("nan")
        s1 = (self.sum1[hi] - self.sum1[lo])[ok]
        s2 = (self.sum2[hi] - self.sum2[lo])[ok]
        cnt = n[ok]
        var = np.maximum(s2 / cnt - (s1 / cnt) ** 2, 0.0)
        return float(np.sqrt(float(np.mean(var))))

    def span_formants_cents(self, start: int, end: int) -> np.ndarray:
        """Mean F1-F3 over the span, in cents. NaN per formant where unresolved."""
        lo, hi = self._frame_range(start, end)
        n = self.count[hi] - self.count[lo]
        out = np.full(N_FORMANTS, np.nan)
        ok = n >= 1.0
        if np.any(ok):
            # `sum1` is accumulated centred (see __post_init__); the offset goes
            # back on here so callers see absolute cents.
            out[ok] = (self.sum1[hi] - self.sum1[lo])[ok] / n[ok] + self.offset[ok]
        return out


def track_formants(
    x: np.ndarray,
    sample_rate: float,
    start: int = 0,
    end: int | None = None,
) -> FormantTrack:
    """Track F1-F3 across ``[start, end)`` on a fixed frame grid.

    Computed ONCE per sample over the whole search window and sliced per span:
    a per-span analysis would cost thousands of root-findings and, worse, would
    let each span choose its own frame phase, so two overlapping spans could
    disagree about the same material.
    """
    y = np.asarray(x, dtype=np.float64)
    n = y.shape[0]
    end = n if end is None else min(int(end), n)
    start = max(0, int(start))

    frame_len = max(8, int(round(FORMANT_FRAME_MS * 0.001 * sample_rate)))
    hop = max(1, int(round(FORMANT_HOP_MS * 0.001 * sample_rate)))

    starts: list[int] = []
    rows: list[np.ndarray] = []
    s = start
    while s + frame_len <= end:
        starts.append(s)
        rows.append(frame_formants(y[s : s + frame_len], sample_rate))
        s += hop

    cents = (
        _cents(np.vstack(rows)) if rows else np.zeros((0, N_FORMANTS), dtype=np.float64)
    )
    return FormantTrack(
        frame_starts=np.asarray(starts, dtype=np.int64),
        frame_len=frame_len,
        hop=hop,
        sample_rate=float(sample_rate),
        cents=np.asarray(cents, dtype=np.float64).reshape(-1, N_FORMANTS),
    )


def formant_distance_cents(a_cents: np.ndarray, b_cents: np.ndarray) -> float:
    """RMS distance between two formant vectors. NaN if nothing pairs up.

    BOTH ARGUMENTS ARE IN CENTS, as :meth:`FormantTrack.span_formants_cents`
    returns them — not in Hz. The parameter names say so because the function
    cannot tell: a vector of plausible Hz values is also a vector of plausible
    cents values, and the mistake produces a small, wrong number rather than an
    error.

    Only formants resolved on BOTH sides contribute. A vowel whose F3 vanishes
    on one side of the fade cannot be compared on F3, and substituting anything
    for the missing value would invent a distance.
    """
    a = np.asarray(a_cents, dtype=np.float64)
    b = np.asarray(b_cents, dtype=np.float64)
    if a.shape != b.shape:
        return float("nan")
    both = np.isfinite(a) & np.isfinite(b)
    if not np.any(both):
        return float("nan")
    d = a[both] - b[both]
    return float(np.sqrt(float(np.mean(d * d))))
