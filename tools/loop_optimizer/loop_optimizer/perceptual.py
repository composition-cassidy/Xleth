"""The perceptual metric suite — the redesigned ruler.

The first suite (:mod:`loop_optimizer.metrics`) was structurally blind, and a
36-trial blind A/B round proved it: gold won 23 of 26 optimizer-vs-gold trials
while ``seam_step`` scored the optimizer's candidate better than gold on all 26.
Two reasons, both structural:

THE WRAP IS CONTINUOUS BY CONSTRUCTION.
    At the end of the fade the blend is ``src_A*cos(pi/2) + src_B*sin(pi/2)``,
    i.e. pure ``src_B`` read at ``loopStart + xfade`` — which is exactly the
    position the playhead jumps to on wrap. The render therefore hands off to
    itself, and any seam metric evaluated AT the wrap measures approximately
    zero for every candidate. It was not ranking loops, it was ranking
    round-off. The perceptual boundary is the CROSSFADE ZONE, where the render
    stops being one source and becomes a blend of two.

THE WINDOWS WERE TOO SHORT.
    Every old metric looked a few periods either side of the wrap. The human
    complaints do not live there: timbre-jump (18 tags), the most common by
    far, is formant drift over 100-300 ms, and click / wobble / flam sit INSIDE
    the fade zone rather than at the wrap.

So every metric here is computed on at least two full rendered cycles, with the
fade zone — not the wrap — as the reference boundary. The renderer is untouched;
this module changes only what is measured.

GEOMETRY, once, since all six depend on it. Starting from the first post-wrap
output sample, the play position walks ``loopStart + xfade -> loopEnd`` and
wraps, so one audible cycle is ``advance = loopEnd - loopStart - xfade`` samples
and splits into

    body  [0, advance - xfade)     one source, unmodified
    fade  [advance - xfade, advance)   the equal-power blend of two sources

Note ``body_len = advance - xfade`` can be ZERO: a crossfade at the engine's
half-loop clamp leaves no unblended material at all, and roughly half the gold
arms in this corpus are exactly that — a continuous morph between two halves of
a long region. Any metric phrased as "body versus fade" is undefined for them,
which is to say undefined for the arms humans preferred. Every metric below
either avoids that framing or carries an explicit fallback for it.

Naming follows the rater's failure tags on purpose. A metric called ``hollow``
that does not fire when listeners tag "hollow" is a metric that has been caught,
which is the point.

WHAT THIS SUITE HAS AND HAS NOT EARNED. Against the 33 decided trials it agrees
with the listeners 26 times where the old suite managed 7 (p=0.0013), and the
old suite's 7 is not merely weak but significantly ANTI-correlated — it was
reliably picking the arm people rejected. That much is a real fix.

It is NOT established that this suite knows anything a trivial rule does not.
"Prefer the longer crossfade" scores 27/33 on the same trials, slightly better
than the suite, and on the 6 trials where that rule is WRONG the suite splits
3-3. So the honest summary is: the ruler has stopped pointing the wrong way, and
whether it points at anything beyond crossfade duration is unresolved. A second
blind round on arms chosen by this ruler is what would settle it, which is why
the task ends by regenerating candidates.json.

No metric's DEFINITION is fitted to the verdicts; each is derived from what the
corresponding complaint physically is, and the reference scales in
:data:`PERCEPTUAL_REFERENCE` are a priori judgements about audibility. The
choice of WHICH metrics rank (:data:`RANKING_METRICS`) did use the verdicts, and
is flagged as such there.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import numpy as np

from .constants import ENGINE_SAMPLE_RATE, YIN_THRESHOLD
from .engine_emu import LoopConfig, render_window, resolve, seam_output_index
from .metrics import normalized_cross_correlation
from .pitch import (
    _absolute_threshold,
    _cumulative_mean_normalized,
    _difference_function,
    _parabolic_refine,
)

_EPS = 1e-12

# ── Analysis policy (documented judgements, not fitted values) ───────────────

#: Cycles rendered per candidate. Two is the task minimum and the minimum that
#: gives the wrap boundary context on both sides; more only costs time, because
#: the render is exactly periodic and every metric below exploits that.
ANALYSIS_CYCLES = 2

#: Longest render analysed, in seconds. A 2 s loop times two cycles is 4 s of
#: audio per candidate and there are thousands of candidates; past this the
#: metrics are averaging over material the ear has long since stopped comparing.
MAX_ANALYSIS_SEC = 1.2

#: Envelope window for click/hollow/wobble, in ms. Short enough to resolve a
#: click, long enough not to track the waveform itself at 75 Hz.
ENVELOPE_WIN_MS = 2.0

#: Two onsets closer than this fuse into one attack; beyond it they are heard as
#: a flam. The classic figure from the echo-threshold literature, and the
#: threshold the task brief names.
FLAM_FUSION_MS = 20.0

#: Beyond this the two attacks are heard as separate events rather than one
#: thickened one, so it is no longer a flam and the metric stands down.
FLAM_MAX_MS = 120.0

#: An onset peak must stand this many times above the median flux of its own
#: source to count as an onset at all. Without it, smooth sustained material
#: produces a "strongest peak" that is pure noise and every loop reads as a flam.
ONSET_PROMINENCE = 3.0

#: Shortest window for the formant comparison, in ms. The timescale the
#: timbre-jump complaints live on.
TIMBRE_WINDOW_MS = 100.0

#: Mel bands for the formant-aware comparison. Enough to resolve F1-F3 spacing,
#: few enough that a single noisy bin cannot dominate the distance.
MEL_BANDS = 24
MEL_FMIN = 80.0
MEL_FMAX = 8000.0

#: A fade shorter than this many periods cannot sustain audible beating, so
#: `chorusing` reports 0 rather than a pitch estimate from too little material.
MIN_CHORUS_PERIODS = 2.0

#: An onset is a level rise of at least this many dB within
#: :data:`ONSET_RISE_MS`. A ratio-to-median prominence test was tried first and
#: is unusable: positive flux is zero for most of a sustained tone, so the median
#: is ~0 and every candidate reads as having an infinitely prominent onset.
ONSET_RISE_DB = 6.0
ONSET_RISE_MS = 5.0


@dataclass(frozen=True)
class PerceptualMetrics:
    """One candidate, measured the way the complaints were phrased.

    Every field is "lower is better" except ``cents_err_per_loop``, which is
    signed and judged on its absolute value. NaN means "not defined here".
    """

    #: Click index, dimensionless. Worst of: a linear-prediction residual at
    #: either perceptual boundary, a transient spike inside the fade zone, and
    #: the two fade sources' energy-flux peaks landing at different offsets.
    #: ~1.0 means a discontinuity comparable to the signal's own RMS.
    click: float
    #: Level lost in the fade, in dB. Worst of the measured envelope dip at the
    #: fade midpoint and the dip predicted by the worst short-window correlation
    #: between the two blended sources.
    hollow: float
    #: Envelope modulation index at the loop repetition rate and its first two
    #: harmonics. 0.1 = the level swings +/-10% once per loop.
    wobble: float
    #: Largest pitch excursion inside the fade zone away from the loop's own
    #: body pitch, in cents, measured on the RENDER.
    chorusing: float
    #: Onset misalignment between the two fade sources beyond the 20 ms fusion
    #: threshold, in ms. 0 when neither source has a prominent onset.
    flam: float
    #: Formant-band distance, in dB. Worst of the body-versus-fade comparison
    #: and the render-versus-source deviation (see the module docstring).
    timbre_jump: float
    #: Retained unchanged from the first suite: detune implied by the audible
    #: repeat period, in cents. It measured tuning and tuning was never the
    #: problem — ``wobble`` and ``chorusing`` are what the old suite lacked.
    cents_err_per_loop: float

    #: Sub-terms, kept for diagnosis exactly as seam_step_value/slope were.
    click_boundary: float = float("nan")
    click_fade_spike: float = float("nan")
    click_flux_offset: float = float("nan")
    hollow_dip_db: float = float("nan")
    hollow_corr_db: float = float("nan")
    timbre_body_fade: float = float("nan")
    timbre_source_dev: float = float("nan")

    #: Context, not metrics.
    wrap_advance: int = 0
    eff_xfade: int = 0
    body_len: int = 0
    period_multiple: int = 0
    loop_rate_hz: float = float("nan")
    fade_fraction: float = float("nan")

    def as_dict(self) -> dict:
        return asdict(self)


#: The six perceptual metrics plus the retained tuning one, in report order.
METRIC_DIRECTION = {
    "click": "lower",
    "hollow": "lower",
    "wobble": "lower",
    "chorusing": "lower",
    "flam": "lower",
    "timbre_jump": "lower",
    "cents_err_per_loop": "lower_abs",
}

METRIC_NAMES = tuple(METRIC_DIRECTION.keys())

#: Value of each metric taken to be "clearly audible", used ONLY to put the
#: seven on a common axis in :func:`perceptual_cost`. These are judgements about
#: hearing, made before any concordance was computed:
#:
#:   click        2.0  — the loop's fastest level move is twice the fastest the
#:                       source material makes on its own (95th percentile)
#:   hollow       3.0  — 3 dB of band energy lost to comb notching
#:   wobble       0.1  — 10% level swing once per loop, plainly audible as pumping
#:   chorusing   20.0  — 20 cents, around the pitch JND for a sustained tone
#:   flam        20.0  — 20 ms BEYOND fusion, i.e. a clearly doubled attack
#:   timbre_jump  2.0  — formant bands moving twice as fast as the material does
#:   cents_err   10.0  — 10 cents of loop detune
#:
#: They are not weights fitted to the verdicts. The two that changed after the
#: first validation run changed because the METRIC's normalisation was wrong
#: (peak divided by median, giving values in the hundreds), not because 2.0
#: scored better than 1.0 — the fix was to the denominator, and the reference
#: then followed from what the ratio means.
PERCEPTUAL_REFERENCE = {
    "click": 2.0,
    "hollow": 3.0,
    "wobble": 0.10,
    "chorusing": 20.0,
    "flam": 20.0,
    "timbre_jump": 2.0,
    "cents_err_per_loop": 10.0,
}

#: The subset :func:`perceptual_cost` actually ranks on. ALL SEVEN are measured
#: and reported; these are the ones allowed to decide an ordering.
#:
#: THIS SELECTION USED THE VERDICT DATA and the reported concordance is
#: therefore optimistic. One metric is held out:
#:
#:   hollow      AUC 0.26 (p=0.005) overall, and splitting by trial kind does
#:               not rescue it — 0.22 on the optimizer trials, 0.38 on the
#:               anchors, so it is not a confound, it simply does not predict.
#:               It measures real comb notching; the arms listeners preferred
#:               have long crossfades over similar material, which is precisely
#:               the configuration that notches, and evidently they did not mind.
#:               Only 7 trials carried the "hollow" tag, far too few to redesign
#:               against. Measured, reported, not ranked on, unresolved.
#:
#: ``cents_err_per_loop`` is RETAINED despite scoring 0.30 overall, because the
#: split shows that number to be an artefact rather than a finding: 0.16 on the
#: optimizer trials but 0.75 on the anchors. In the optimizer trials low cents
#: error is perfectly confounded with "is an optimizer candidate" — candidates.py
#: quantises every candidate's loop AND crossfade to whole periods by
#: construction — and those are the arms that lost. On the anchor trials neither
#: arm is optimizer-generated, the confound is absent, and the metric does the
#: job it was built for: it is the only thing in the suite that reliably catches
#: a period-misaligned loop, which is exactly what the naive anchor is.
#: Dropping it would leave nothing guarding against naive-like candidates.
#:
#: A selection made on the same 33 trials it is then scored against cannot also
#: be evidence about those trials. The second blind round is the held-out test,
#: which is exactly why the task ends by regenerating candidates.json.
#: ...and after all that, the default ranking is ONE metric. That is a finding,
#: not a shortcut, and the honest version of it is uncomfortable: the six-metric
#: composite scores WORSE than its own best term (20/33 against 26/33). The
#: reason is structural. ``max()`` is decided by whichever metric happens to
#: have the largest value after division by an a-priori reference, and those
#: references are guesses about audibility, not calibrated weights — so the
#: ordering ends up driven by whichever guess was smallest rather than by
#: whichever metric is most informative. With `click` correctly normalised its
#: scaled value sits near 0.5 and `wobble` (AUC 0.64) takes over the max from
#: `click` (AUC 0.79), and concordance falls.
#:
#: Calibrating six references against 33 trials would be fitting six parameters
#: to 33 one-bit observations. That is not a calibration, it is memorisation, so
#: it is not done here. The full comparison is printed by ``validate`` and the
#: choice is a one-line change once a second round of verdicts exists.
#:
#:   click alone               26/33   optimizer 22/25   anchors 4/8
#:   max(click, cents)         21/33   optimizer 15/25   anchors 6/8
#:   max(click, cents, timbre) 23/33   optimizer 16/25   anchors 7/8
#:   all six                   20/33   optimizer 15/25   anchors 5/8
#:
#: `click` is the default because optimizer-vs-gold is the comparison this whole
#: exercise exists to settle and it is far the best there. Its weakness is real
#: and is stated rather than averaged away: on the naive anchors it is at chance,
#: so it does NOT reliably reject a period-misaligned loop. In the candidate pool
#: that gap is covered structurally rather than by the ruler — candidates.py
#: quantises every loop and crossfade to whole periods and rejects any candidate
#: whose crossfade the engine's clamp would alter, so a naive-like candidate
#: cannot be generated in the first place. It is a gap in the METRIC, not in the
#: pipeline, and closing it is the first job for round two.
#: A note on the degenerate minimum, because it was nearly solved in the wrong
#: place. Ranking on `click` alone put 2 ms single-period loops first on 3 of 26
#: samples and sub-20 ms loops on 9: with no crossfade there is no blend, so no
#: invented motion, so `click` is 0 by construction — structurally the same trap
#: the first suite had with seam_ncc. Adding `timbre_jump` to the ranking does
#: detect it (its render-versus-source term measures the motion a frozen loop
#: FAILS to reproduce) but costs 6 of the 33 verdicts, because under an
#: uncalibrated max() it then dominates and penalises the heavy crossfades
#: listeners preferred. The fix belongs in the GENERATOR, not here: an 85-sample
#: loop is not a badly-ranked loop, it is not a loop, and candidates.py already
#: carried a maximum duration with no minimum. See MIN_LOOP_DURATION_SEC.
RANKING_METRICS = ("click",)


# ── Rendered-cycle harness ──────────────────────────────────────────────────


@dataclass(frozen=True)
class RenderedCycles:
    """At least two full audible cycles, starting at the first post-wrap sample.

    ``y`` is exactly periodic with period :attr:`advance` by construction, and
    several metrics below use that: the envelope of one cycle taken CIRCULARLY
    is the envelope of the infinitely repeated loop, so a spectrum over M cycles
    carries no information a single circular cycle does not.
    """

    y: np.ndarray
    advance: int
    xfade: int
    n_cycles: int
    sample_rate: float
    #: Source positions for each rendered sample, for the render-versus-source
    #: comparison in :func:`_timbre_jump`.
    positions: np.ndarray = field(default_factory=lambda: np.zeros(0))

    @property
    def body_len(self) -> int:
        """Unblended samples per cycle. ZERO for a fade at the half-loop clamp."""
        return self.advance - self.xfade

    @property
    def cycle(self) -> np.ndarray:
        return self.y[: self.advance]


def render_cycles(
    x: np.ndarray,
    cfg: LoopConfig,
    sample_rate: float = ENGINE_SAMPLE_RATE,
    n_cycles: int = ANALYSIS_CYCLES,
    min_cycles: int = 2,
) -> RenderedCycles | None:
    """Render ``n_cycles`` audible cycles, or ``None`` if the loop cannot play.

    ``min_cycles`` is 2 for the full suite, which needs signal on both sides of
    the wrap. It may be 1 for metrics that read only ``rc.cycle`` circularly:
    the render is exactly periodic, so one cycle indexed circularly IS the
    infinitely repeated loop and the second cycle is a verbatim copy. Halving
    that copy away changes no measured value, only the time spent producing it.
    """
    xf = np.asarray(x, dtype=np.float32)
    eff = resolve(cfg, xf.shape[0], sample_rate)
    if not eff.use_loop or eff.wrap_advance <= 0:
        return None
    advance = eff.wrap_advance

    max_total = int(MAX_ANALYSIS_SEC * sample_rate)
    floor = max(1, min_cycles)
    cycles = max(floor, min(n_cycles, max(floor, max_total // max(1, advance))))
    total = cycles * advance
    seam = seam_output_index(eff, cfg)
    if seam < 0:
        return None

    y = render_window(xf, cfg, seam, total, sample_rate=sample_rate).astype(np.float64)
    if y.size < total or float(np.sqrt(np.mean(y * y))) <= _EPS:
        return None
    return RenderedCycles(
        y=y, advance=advance, xfade=eff.eff_xfade, n_cycles=cycles, sample_rate=sample_rate
    )


# ── Small shared primitives ─────────────────────────────────────────────────


def circular_rms(y: np.ndarray, window: int) -> np.ndarray:
    """Sliding RMS over a PERIODIC signal, same length as the input.

    Circular because ``y`` is one or more exact copies of the loop: an ordinary
    sliding window would shorten the result and, worse, treat the loop's own
    boundary as an edge to be tapered — which is precisely the region being
    measured.
    """
    y = np.asarray(y, dtype=np.float64)
    n = y.size
    w = int(max(1, min(window, n)))
    padded = np.concatenate([y[-w:], y, y[:w]])
    power = np.concatenate(([0.0], np.cumsum(padded * padded)))
    sums = power[w:] - power[:-w]
    rms = np.sqrt(np.maximum(sums, 0.0) / w)
    start = w - w // 2
    return rms[start : start + n]


def positive_flux(env: np.ndarray) -> np.ndarray:
    """Half-wave-rectified envelope derivative — the onset-strength signal."""
    if env.size < 2:
        return np.zeros(0)
    return np.maximum(np.diff(env, prepend=env[:1]), 0.0)


def strongest_onset(env: np.ndarray, sample_rate: float) -> tuple[int, float]:
    """Index and size (in dB) of the largest level rise in ``env``.

    An onset is defined as a rise over :data:`ONSET_RISE_MS`, in dB, which is
    both what an attack physically is and a scale that means something. The
    obvious alternative — the largest positive flux relative to the median flux
    — is unusable here: positive flux is exactly zero across most of a sustained
    vowel, so the median is ~0 and every arm reports an infinitely prominent
    onset, which is what the first version of ``flam`` did (it never fired
    because both arms always tied at the ceiling).
    """
    k = max(1, int(ONSET_RISE_MS * 0.001 * sample_rate))
    if env.size < 2 * k + 1:
        return -1, 0.0
    before = np.maximum(env[: env.size - 2 * k], _EPS)
    after = np.maximum(env[2 * k :], _EPS)
    rise = 20.0 * np.log10(after / before)
    i = int(np.argmax(rise))
    return i + k, float(rise[i])


@dataclass(frozen=True)
class SourceReference:
    """How fast the SOURCE material changes on its own, per sample.

    This is the reference every rate-based metric below is quoted against, and
    it is what keeps those metrics from collapsing into "prefer a longer
    crossfade". The listeners did prefer longer crossfades — that rule alone
    matches 27 of 33 verdicts — but a rule is not a mechanism. The mechanism is
    that a loop is heard when it makes the sound change FASTER THAN THE MATERIAL
    EVER DOES BY ITSELF. A long crossfade over two very different vowels still
    changes fast and should still score badly; a short one over homogeneous
    material changes slowly and should not.

    Computed once per sample over the whole file, never per candidate: a
    per-candidate reference would let a candidate lower its own bar by choosing
    a region where nothing happens.
    """

    #: Per-sample absolute envelope step of the WHOLE file, kept as an array so
    #: each candidate can take its own reference from the span it actually
    #: reads. Computing it once and slicing is what keeps a per-region reference
    #: affordable across thousands of candidates.
    env_step: np.ndarray
    #: 95th percentile of the above, over the whole file. Fallback only, for a
    #: region too short to have a reference of its own.
    env_rate: float
    #: 95th percentile of the mel-band distance between adjacent frames, in dB.
    mel_rate: float
    #: Median absolute level, for scaling.
    env_level: float


def source_reference(
    x: np.ndarray,
    period: float,
    sample_rate: float = ENGINE_SAMPLE_RATE,
    fb: np.ndarray | None = None,
    n_fft: int = 1024,
) -> SourceReference:
    """Measure the material's own natural rate of change. Once per sample."""
    y = np.asarray(x, dtype=np.float64)
    # The SAME window `_click` uses on the render. Both sides of that ratio have
    # to be smoothed identically or the quotient carries a systematic offset
    # that has nothing to do with the loop: measuring the source over a period
    # (~122 samples here) and the render over 2 ms (~96) inflated every click
    # score by roughly 5x, purely from the difference in smoothing.
    win = max(2, int(ENVELOPE_WIN_MS * 0.001 * sample_rate))
    env = circular_rms(y, win)
    level = float(np.median(env)) if env.size else 0.0
    # Only where there is signal: silence has a zero rate and would drag the
    # median to zero, making every candidate's ratio infinite.
    all_steps = np.abs(np.diff(env, append=env[-1:] if env.size else np.zeros(1)))
    voiced = env > max(level * 0.1, _EPS)
    steps = all_steps[voiced] if voiced.size == all_steps.size else all_steps
    env_rate = float(np.percentile(steps, 95)) if steps.size else 0.0

    mel_rate = 0.0
    if fb is not None and y.size >= 2 * n_fft:
        hop = max(1, n_fft // 2)
        window = np.hanning(n_fft)
        prev = None
        dists = []
        for s in range(0, y.size - n_fft + 1, hop):
            frame = y[s : s + n_fft]
            mag = fb @ np.abs(np.fft.rfft(frame * window))
            peak = float(mag.max())
            if peak <= _EPS:
                prev = None
                continue
            cur = 20.0 * np.log10(np.maximum(mag, peak * 1e-3))
            if prev is not None:
                dists.append(_mel_distance(prev, cur))
            prev = cur
        finite = [d for d in dists if np.isfinite(d)]
        mel_rate = float(np.percentile(finite, 95)) if finite else 0.0

    return SourceReference(env_step=all_steps, env_rate=env_rate, mel_rate=mel_rate, env_level=level)


def mel_filterbank(n_fft: int, sample_rate: float, n_bands: int = MEL_BANDS) -> np.ndarray:
    """Triangular mel filterbank, shape ``(n_bands, n_fft // 2 + 1)``.

    Written out rather than pulled from a library: numpy is the only dependency
    this tool is allowed, and the filterbank is fifteen lines.
    """
    def to_mel(f):
        return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)

    def from_mel(m):
        return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)

    fmax = min(MEL_FMAX, sample_rate / 2.0)
    edges = from_mel(np.linspace(to_mel(MEL_FMIN), to_mel(fmax), n_bands + 2))
    bins = np.floor((n_fft + 1) * edges / sample_rate).astype(int)
    bins = np.clip(bins, 0, n_fft // 2)

    fb = np.zeros((n_bands, n_fft // 2 + 1))
    for b in range(n_bands):
        lo, mid, hi = bins[b], bins[b + 1], bins[b + 2]
        if mid > lo:
            fb[b, lo:mid] = (np.arange(lo, mid) - lo) / float(mid - lo)
        if hi > mid:
            fb[b, mid:hi] = (hi - np.arange(mid, hi)) / float(hi - mid)
    return fb


def mel_log_envelope(seg: np.ndarray, fb: np.ndarray, n_fft: int) -> np.ndarray:
    """Mean log mel-band magnitude of ``seg``, in dB. Shape ``(n_bands,)``."""
    if seg.size == 0:
        return np.full(fb.shape[0], np.nan)
    if seg.size < n_fft:
        seg = np.pad(seg, (0, n_fft - seg.size))
    win = np.hanning(n_fft)
    hop = max(1, n_fft // 2)
    starts = range(0, max(1, seg.size - n_fft + 1), hop)
    acc = np.zeros(fb.shape[0])
    count = 0
    for s in starts:
        frame = seg[s : s + n_fft]
        if frame.size < n_fft:
            break
        mag = np.abs(np.fft.rfft(frame * win))
        acc += fb @ mag
        count += 1
    if count == 0:
        return np.full(fb.shape[0], np.nan)
    band = acc / count
    peak = float(band.max())
    if peak <= _EPS:
        return np.full(fb.shape[0], np.nan)
    # Floor at -60 dB of the band peak, so empty top bands cannot dominate.
    return 20.0 * np.log10(np.maximum(band, peak * 1e-3))


def _mel_distance(a: np.ndarray, b: np.ndarray) -> float:
    """RMS difference of two mel log envelopes, in dB, gain-normalised.

    The mean is removed from each first: a level difference between the two
    windows is loudness, not timbre, and ``hollow`` already measures it.
    """
    if a.size == 0 or a.size != b.size or not np.all(np.isfinite(a)) or not np.all(np.isfinite(b)):
        return float("nan")
    return float(np.sqrt(np.mean(((a - a.mean()) - (b - b.mean())) ** 2)))


def _circular_take(y: np.ndarray, start: int, count: int) -> np.ndarray:
    """``count`` samples from a periodic signal starting at ``start``."""
    if count <= 0 or y.size == 0:
        return np.zeros(0)
    idx = (np.arange(start, start + count) % y.size).astype(np.int64)
    return y[idx]


def _local_period(seg: np.ndarray, sample_rate: float, period_hint: float) -> float:
    """YIN period of one short frame, in samples, or NaN.

    Reuses the tracker's own steps rather than a second pitch algorithm, so a
    pitch measured on the render is comparable with the one measured on the
    source. The search range is pinned around the known period: inside a
    crossfade the signal is two tones at once and an unconstrained search will
    happily lock an octave down onto the beat rate, reporting a 1200-cent
    "deviation" that is an artefact of the search, not of the loop.
    """
    if not np.isfinite(period_hint) or period_hint <= 1.0:
        return float("nan")
    # +/- a major third around the known period, NOT +/- an octave. The question
    # is how far the pitch moves inside the fade, and a search wide enough to
    # reach the octave will take it when the blend beats: an arm in this corpus
    # reported 1201.4 cents of "chorusing", which is the tracker halving the
    # period, not the loop shifting by an octave.
    tau_min = max(2, int(period_hint * 0.75))
    tau_max = int(period_hint * 1.33) + 2
    need = tau_max * 2 + 4
    if seg.size < need:
        return float("nan")
    d = _difference_function(seg.astype(np.float64), tau_max)
    cmnd = _cumulative_mean_normalized(d)
    if tau_max <= tau_min + 2:
        return float("nan")
    tau = _absolute_threshold(cmnd, tau_min, tau_max, YIN_THRESHOLD)
    return _parabolic_refine(cmnd, tau)


# ── The six ─────────────────────────────────────────────────────────────────


def _click(
    rc: RenderedCycles,
    src_a: np.ndarray,
    src_b: np.ndarray,
    period: float,
    ref: SourceReference,
    src_lo: int,
    src_hi: int,
) -> tuple:
    """A change the render makes faster than the material ever makes by itself.

    The first version normalised the in-fade transient against the BODY's flux.
    That failed twice over: the body's median flux is ~0 for sustained material
    so the ratio exploded, and gold arms routinely have no body at all. Both are
    fixed by quoting the rate against the SOURCE's own natural rate
    (:class:`SourceReference`), which is defined for every arm and identical
    across the arms of one trial — so it compares them rather than their
    denominators.
    """
    y, advance = rc.y, rc.advance
    rms = float(np.sqrt(np.mean(y * y)))
    if rms <= _EPS:
        return float("nan"), float("nan"), float("nan"), float("nan")

    # (a) Linear-prediction residual at the two perceptual boundaries of the
    #     SECOND cycle, so both have real signal before them. The wrap is
    #     included even though it is continuous by construction — if that ever
    #     stops being true the metric should say so rather than assume it.
    def residual(i: int) -> float:
        if i < 2 or i + 1 >= y.size:
            return 0.0
        predicted = 2.0 * y[i - 1] - y[i - 2]
        value = abs(float(y[i] - predicted))
        slope = abs(float((y[i + 1] - y[i]) - (y[i - 1] - y[i - 2])))
        return max(value, slope) / rms

    boundary = max(residual(advance), residual(advance + rc.body_len))

    # (b) The fastest level change anywhere in the rendered cycle, against the
    #     fastest the SOURCE makes over the span this loop actually reads.
    #     Peak against peak, and region against the same region, so 1.0 means
    #     "no faster than the material does here" and >1 means the loop has
    #     introduced motion that is not in the sample. Both halves of that
    #     matter: quoting a maximum against a whole-file percentile (the first
    #     version) produced scores in the tens against a reference of 2, so
    #     `click` swamped every other metric in the max() and the composite was
    #     silently univariate.
    #
    #     A per-region reference cannot be gamed by choosing a busy region: a
    #     candidate that picks material with a real transient must also RENDER
    #     that transient, so the ratio stays near 1, which is the right answer —
    #     faithfully reproducing fast material is not a click.
    win = max(2, int(ENVELOPE_WIN_MS * 0.001 * rc.sample_rate))
    env = circular_rms(rc.cycle, win)
    fade_spike = float("nan")
    if env.size > 4:
        local = ref.env_step[src_lo:src_hi]
        scale = float(np.max(local)) if local.size else 0.0
        if scale <= _EPS:
            scale = ref.env_rate
        if scale > _EPS:
            fade_spike = float(np.max(np.abs(np.diff(env))) / scale)

    # (c) The two blended sources' onsets landing at different offsets: the
    #     blend then plays one transient twice, smeared.
    flux_offset = 0.0
    if src_a.size > 8 and src_b.size == src_a.size:
        ia, ra = strongest_onset(circular_rms(src_a, win), rc.sample_rate)
        ib, rb = strongest_onset(circular_rms(src_b, win), rc.sample_rate)
        if ia >= 0 and ib >= 0 and min(ra, rb) >= ONSET_RISE_DB:
            per = period if np.isfinite(period) and period > 1.0 else float(src_a.size)
            flux_offset = abs(ia - ib) / per

    # The brief names three sub-terms for `click`; all three are computed and
    # reported, and only the rate term ranks. Both exclusions are on structural
    # grounds, checked against the verdicts afterwards rather than chosen by
    # them:
    #
    #   `boundary`      root cause 1 says the wrap is continuous BY
    #                   CONSTRUCTION, so a linear-prediction residual there
    #                   measures round-off. Including it would reinstate exactly
    #                   the blindness this suite exists to remove. Scored alone
    #                   it runs at AUC 0.27 (p=0.014) — significantly
    #                   anti-correlated, which is the root cause confirming
    #                   itself.
    #   `flux_offset`   `|onset_a - onset_b| / period` has no upper bound and
    #                   grows with the fade, so across arms it ranks fade length
    #                   rather than misalignment — the same extreme-value defect
    #                   that made the first `hollow` a length proxy with a minus
    #                   sign. Onset misalignment is measured properly by `flam`,
    #                   which gates on audibility and caps at FLAM_MAX_MS.
    return (fade_spike if np.isfinite(fade_spike) else float("nan")), boundary, fade_spike, flux_offset


def _hollow(rc: RenderedCycles, src_a: np.ndarray, src_b: np.ndarray, period: float, fb, n_fft) -> tuple:
    """Band energy the blend LOSES relative to an incoherent sum — comb notching.

    The first version measured an amplitude dip and the worst short-window
    correlation, and both were significantly ANTI-correlated with the verdicts.
    The reason is instructive: equal-power blending preserves level for
    UNCORRELATED sources, so mere decorrelation is not a defect, and taking the
    WORST correlation over a fade makes the score an extreme-value statistic
    that necessarily worsens as the fade gets longer. It was measuring fade
    length with a minus sign.

    What "hollow" actually describes is comb filtering: summing two copies of
    similar material at a non-period offset notches specific bands out. So the
    measurement is the per-band deficit of the real blend against what an
    incoherent sum of the same two sources would give — zero when the sources
    are unrelated, large when they are the same sound slightly displaced.
    """
    if src_a.size < n_fft or src_b.size != src_a.size or fb is None:
        return 0.0, 0.0, 0.0

    window = np.hanning(n_fft)
    worst = 0.0
    n_probe = 5
    for j in range(n_probe):
        # Sample across the fade, weighted toward the middle where both sources
        # are near equal gain and cancellation is deepest.
        centre = int((j + 0.5) * src_a.size / n_probe)
        s = int(np.clip(centre - n_fft // 2, 0, src_a.size - n_fft))
        a = src_a[s : s + n_fft] * window
        b = src_b[s : s + n_fft] * window
        progress = (s + n_fft / 2.0) / max(1.0, float(src_a.size))
        arg = progress * math.pi * 0.5
        ga, gb = math.cos(arg), math.sin(arg)

        pa = np.abs(np.fft.rfft(a)) ** 2
        pb = np.abs(np.fft.rfft(b)) ** 2
        pmix = np.abs(np.fft.rfft(ga * a + gb * b)) ** 2

        band_inc = fb @ (ga * ga * pa + gb * gb * pb)  # incoherent expectation
        band_mix = fb @ pmix
        peak = float(band_inc.max())
        if peak <= _EPS:
            continue
        keep = band_inc > peak * 1e-3  # ignore bands with no energy to lose
        if not np.any(keep):
            continue
        deficit_db = 10.0 * np.log10(np.maximum(band_inc[keep], _EPS) / np.maximum(band_mix[keep], _EPS))
        worst = max(worst, float(np.mean(np.maximum(deficit_db, 0.0))))

    return worst, worst, 0.0


def _wobble(rc: RenderedCycles, period: float) -> float:
    """Envelope modulation at the loop rate and its first two harmonics.

    The render is exactly periodic, so the envelope of ONE cycle taken
    circularly is the envelope of the infinitely repeated loop, and bin k of its
    DFT is the k-th harmonic of the loop repetition rate exactly. Rendering M
    cycles and reading bins M, 2M, 3M of an M-times-longer transform gives the
    identical numbers at M times the cost.

    Only the first three harmonics: those are the once-, twice- and
    thrice-per-loop swings that are heard as pumping. Higher harmonics are the
    material's own texture, which is not the loop's fault.
    """
    win = max(2, int(round(period))) if np.isfinite(period) and period > 1.0 else max(
        2, int(ENVELOPE_WIN_MS * 0.001 * rc.sample_rate)
    )
    env = circular_rms(rc.cycle, win)
    n = env.size
    if n < 8:
        return float("nan")
    mean = float(np.mean(env))
    if mean <= _EPS:
        return float("nan")
    spec = np.fft.rfft(env)
    depths = []
    for k in (1, 2, 3):
        if k < spec.size:
            depths.append(2.0 * abs(spec[k]) / (n * mean))
    if not depths:
        return float("nan")
    return float(math.sqrt(sum(d * d for d in depths)))


def _chorusing(rc: RenderedCycles, period: float) -> float:
    """Pitch excursion inside the fade, against the loop's own body pitch.

    Measured on the RENDER, not the sources: beating between two nearly-tuned
    copies is created by the blend and exists nowhere else.
    """
    if rc.xfade <= 0 or not np.isfinite(period) or period <= 1.0:
        return 0.0
    if rc.xfade < MIN_CHORUS_PERIODS * period:
        # Too short to sustain audible beating; a pitch read from it would be
        # measuring the window, not the loop.
        return 0.0

    frame = int(max(4.0 * period, 512))
    need = int(period * 2.0) * 2 + 8
    frame = max(frame, need)

    def period_at(centre: int) -> float:
        seg = _circular_take(rc.cycle, centre - frame // 2, frame)
        return _local_period(seg, rc.sample_rate, period)

    # Reference: the body's own pitch. With no body (fade at the half-loop
    # clamp) the whole cycle is the reference — the question is then whether the
    # pitch is stable ACROSS the fade, which is the same question.
    if rc.body_len > frame:
        ref = period_at(rc.body_len // 2)
    else:
        ref = period
    if not np.isfinite(ref) or ref <= 1.0:
        return 0.0

    worst = 0.0
    n_probe = 5
    for j in range(n_probe):
        centre = rc.body_len + int((j + 0.5) * rc.xfade / n_probe)
        p = period_at(centre)
        if np.isfinite(p) and p > 1.0:
            worst = max(worst, abs(1200.0 * math.log2(p / ref)))
    return float(worst)


def _flam(rc: RenderedCycles, src_a: np.ndarray, src_b: np.ndarray) -> float:
    """Prominent onsets in the two fade sources, offset beyond fusion.

    Only onsets INSIDE the fade matter: that is the only place the two sources
    are audible at once, and it is the doubling that reads as a flam.
    """
    if src_a.size < 8 or src_b.size != src_a.size:
        return 0.0
    win = max(2, int(ENVELOPE_WIN_MS * 0.001 * rc.sample_rate))

    # Only the stretch where BOTH sources are actually audible can produce a
    # doubled attack. Outside it one source is faded down and its onset is not
    # heard twice, it is simply not heard. Without this restriction a long
    # crossfade reports the offset between two unrelated onsets at opposite ends
    # of the fade — 128 ms on one gold arm here, which is not a flam, it is two
    # different events. Both gains exceed 0.25 (-12 dB) over the middle 84%.
    lo = int(0.08 * src_a.size)
    hi = int(0.92 * src_a.size)
    if hi - lo < 4:
        return 0.0
    ia, ra = strongest_onset(circular_rms(src_a[lo:hi], win), rc.sample_rate)
    ib, rb = strongest_onset(circular_rms(src_b[lo:hi], win), rc.sample_rate)
    if ia < 0 or ib < 0 or min(ra, rb) < ONSET_RISE_DB:
        # At most one source has a real attack; there is nothing to double.
        return 0.0
    offset_ms = abs(ia - ib) * 1000.0 / rc.sample_rate
    if offset_ms > FLAM_MAX_MS:
        # Too far apart to fuse into one thickened attack; these are two
        # separate events and whatever they are, they are not a flam.
        return 0.0
    return float(max(0.0, offset_ms - FLAM_FUSION_MS))


def _timbre_jump(
    rc: RenderedCycles,
    x: np.ndarray,
    cfg: LoopConfig,
    fb: np.ndarray,
    n_fft: int,
    ref: SourceReference,
) -> tuple:
    """Formant-band character moving faster than the material's own drift.

    ``timbre-jump`` was the commonest complaint (18 tags) and it is a rate
    percept, not a magnitude one: a vowel that migrates over 300 ms is the sound
    of a voice, while the same migration crammed into 30 ms is the sound of a
    splice. So the measurement is the fastest mel-band movement anywhere in the
    rendered cycle, divided by the median frame-to-frame movement of the SOURCE
    material — dimensionless, and 1.0 means "no faster than the sample itself".

    That framing also survives ``body_len == 0``, which the brief's
    body-versus-fade comparison does not and which describes roughly half the
    gold arms here. The body-versus-fade term is still computed and reported as
    ``timbre_body_fade`` wherever a body exists, so the brief's version can be
    scored on its own in the validation table rather than taken on trust.
    """
    hop = max(1, n_fft // 2)
    window = np.hanning(n_fft)

    # Frame the cycle CIRCULARLY: the loop is periodic, so the movement across
    # the wrap is as real as any other and must not be treated as an edge.
    frames = []
    step = max(1, rc.advance // 32) if rc.advance > 32 else 1
    hop = max(hop // 2, step)
    for s in range(0, rc.advance, hop):
        seg = _circular_take(rc.cycle, s, n_fft)
        mag = fb @ np.abs(np.fft.rfft(seg * window))
        peak = float(mag.max())
        if peak <= _EPS:
            continue
        frames.append(20.0 * np.log10(np.maximum(mag, peak * 1e-3)))

    rate = float("nan")
    if len(frames) >= 3 and ref.mel_rate > _EPS:
        # Adjacent-frame distances around the cycle, including the wrap-around
        # pair, so a splice that lands exactly at the loop point is counted.
        dists = [_mel_distance(frames[i], frames[(i + 1) % len(frames)]) for i in range(len(frames))]
        finite = [d for d in dists if np.isfinite(d)]
        if finite:
            rate = float(max(finite) / ref.mel_rate)

    win = int(max(TIMBRE_WINDOW_MS * 0.001 * rc.sample_rate, n_fft))

    # RENDER versus SOURCE over a full timbre window, and this term is what
    # stops the suite rewarding a degenerate loop. `rate` measures how fast the
    # timbre MOVES inside a cycle, so a one-period loop with no crossfade scores
    # a perfect zero on it: nothing blends, nothing moves, nothing to complain
    # about. Ranking on that alone put 85-sample "loops" — 2 ms, a buzz, not a
    # loop — at the top of 3 of 26 samples, which is structurally the same trap
    # the FIRST suite had with seam_ncc (1.0 by construction for a one-period
    # loop). The defect of a frozen loop is not motion, it is the ABSENCE of the
    # motion the material has: over 100 ms the source evolves and the loop
    # repeats a static comb. Comparing the two catches it, and costs nothing on
    # a faithful loop, where the render and the source are the same samples.
    x_arr = np.asarray(x, dtype=np.float64)
    eff = resolve(cfg, x_arr.shape[0], rc.sample_rate)
    src_start = eff.eff_loop_start + eff.eff_xfade
    source_dev = float("nan")
    if src_start + win <= x_arr.shape[0] and win >= n_fft:
        # `_circular_take` TILES a cycle shorter than the window, which is
        # exactly what the loop does to the ear.
        rendered = _circular_take(rc.cycle, 0, win)
        source = x_arr[src_start : src_start + win]
        source_dev = _mel_distance(
            mel_log_envelope(rendered, fb, n_fft), mel_log_envelope(source, fb, n_fft)
        )

    # The brief's body-versus-fade comparison, reported but not relied on: it is
    # undefined wherever body_len == 0, i.e. for half the gold arms.
    body_fade = float("nan")
    if rc.body_len >= n_fft and rc.xfade >= n_fft:
        body = _circular_take(rc.cycle, 0, min(rc.body_len, win))
        fade = _circular_take(rc.cycle, rc.body_len, min(rc.xfade, win))
        body_fade = _mel_distance(mel_log_envelope(body, fb, n_fft), mel_log_envelope(fade, fb, n_fft))

    finite = [v for v in (rate, source_dev) if np.isfinite(v)]
    return (max(finite) if finite else float("nan")), body_fade, source_dev


# ── Entry point ─────────────────────────────────────────────────────────────

_FB_CACHE: dict[tuple[int, float], np.ndarray] = {}


def _filterbank_for(period: float, sample_rate: float) -> tuple[np.ndarray, int]:
    """Mel filterbank sized to resolve the fundamental, cached per (n_fft, rate)."""
    target = 4.0 * period if np.isfinite(period) and period > 1.0 else 1024.0
    n_fft = 1 << max(8, min(12, int(math.ceil(math.log2(max(64.0, target))))))
    key = (n_fft, float(sample_rate))
    if key not in _FB_CACHE:
        _FB_CACHE[key] = mel_filterbank(n_fft, sample_rate)
    return _FB_CACHE[key], n_fft


def measure_perceptual(
    x: np.ndarray,
    cfg: LoopConfig,
    period: float,
    sample_rate: float = ENGINE_SAMPLE_RATE,
    reference: SourceReference | None = None,
) -> PerceptualMetrics:
    """Measure one loop configuration the way the listeners described it.

    ``period`` is the MEASURED fundamental period in samples, as before: the
    declared root note is never used.

    ``reference`` is the source material's own rate of change
    (:func:`source_reference`). Pass it in when measuring many candidates from
    one sample — it is identical for all of them and costs more to compute than
    a single candidate's metrics. Computed here if omitted.
    """
    xf = np.asarray(x, dtype=np.float32)
    eff = resolve(cfg, xf.shape[0], sample_rate)
    nan = float("nan")

    if not eff.use_loop or eff.wrap_advance <= 0:
        return PerceptualMetrics(nan, nan, nan, nan, nan, nan, nan,
                                 wrap_advance=eff.wrap_advance, eff_xfade=eff.eff_xfade)

    advance = eff.wrap_advance
    k = int(round(advance / period)) if np.isfinite(period) and period > 1.0 else 0
    cents_err = 1200.0 * math.log2(advance / (k * period)) if k >= 1 else nan

    rc = render_cycles(xf, cfg, sample_rate)
    if rc is None:
        return PerceptualMetrics(nan, nan, nan, nan, nan, nan, cents_err,
                                 wrap_advance=advance, eff_xfade=eff.eff_xfade,
                                 body_len=max(0, advance - eff.eff_xfade), period_multiple=k)

    # The two signals the engine's blend mixes, in the SOURCE domain — the same
    # pair the old suite's zero_lag_corr looked at, but examined along the fade
    # rather than collapsed to a single number.
    if eff.eff_xfade > 0:
        src_a = xf[eff.eff_loop_end - eff.eff_xfade : eff.eff_loop_end].astype(np.float64)
        src_b = xf[eff.eff_loop_start : eff.eff_loop_start + eff.eff_xfade].astype(np.float64)
    else:
        src_a = src_b = np.zeros(0)

    fb, n_fft = _filterbank_for(period, sample_rate)
    ref = reference if reference is not None else source_reference(xf, period, sample_rate, fb, n_fft)

    click, c_bound, c_spike, c_flux = _click(
        rc, src_a, src_b, period, ref, eff.eff_loop_start, eff.eff_loop_end
    )
    hollow, h_dip, h_corr = _hollow(rc, src_a, src_b, period, fb, n_fft)
    wobble = _wobble(rc, period)
    chorusing = _chorusing(rc, period)
    flam = _flam(rc, src_a, src_b)
    timbre, t_bf, t_sd = _timbre_jump(rc, xf, cfg, fb, n_fft, ref)

    return PerceptualMetrics(
        click=click,
        hollow=hollow,
        wobble=wobble,
        chorusing=chorusing,
        flam=flam,
        timbre_jump=timbre,
        cents_err_per_loop=cents_err,
        click_boundary=c_bound,
        click_fade_spike=c_spike,
        click_flux_offset=c_flux,
        hollow_dip_db=h_dip,
        hollow_corr_db=h_corr,
        timbre_body_fade=t_bf,
        timbre_source_dev=t_sd,
        wrap_advance=advance,
        eff_xfade=eff.eff_xfade,
        body_len=rc.body_len,
        period_multiple=k,
        loop_rate_hz=sample_rate / advance if advance > 0 else nan,
        fade_fraction=eff.eff_xfade / advance if advance > 0 else nan,
    )


def measure_click_only(
    x: np.ndarray,
    cfg: LoopConfig,
    period: float,
    sample_rate: float = ENGINE_SAMPLE_RATE,
    reference: SourceReference | None = None,
) -> float:
    """Just `click` — the ranking metric — skipping everything else.

    Ranking is by `click` alone (see :data:`RANKING_METRICS`), and the corpus
    report measures every candidate the generator emits: 53,675 of them across
    26 samples. Computing the whole suite for all of them takes 4.5 minutes,
    almost all of it in the two metrics ranking never consults — `timbre_jump`
    frames the cycle into ~32 mel spectra and `chorusing` runs five YIN probes.
    Neither can change an ordering decided by `click`.

    So the report ranks on this, then measures the full suite only for the
    handful of candidates that are actually reported or exported. The ordering
    is bit-identical to measuring everything; only the wasted work is gone.
    """
    xf = np.asarray(x, dtype=np.float32)
    eff = resolve(cfg, xf.shape[0], sample_rate)
    if not eff.use_loop or eff.wrap_advance <= 0:
        return float("nan")
    # One cycle is enough: `click`'s headline term reads only the circular
    # envelope of rc.cycle, and `boundary` (which would need the second cycle)
    # is deliberately not part of it.
    rc = render_cycles(xf, cfg, sample_rate, n_cycles=1, min_cycles=1)
    if rc is None:
        return float("nan")
    if eff.eff_xfade > 0:
        src_a = xf[eff.eff_loop_end - eff.eff_xfade : eff.eff_loop_end].astype(np.float64)
        src_b = xf[eff.eff_loop_start : eff.eff_loop_start + eff.eff_xfade].astype(np.float64)
    else:
        src_a = src_b = np.zeros(0)
    ref = reference if reference is not None else source_reference(xf, period, sample_rate)
    click, _b, _s, _f = _click(rc, src_a, src_b, period, ref, eff.eff_loop_start, eff.eff_loop_end)
    return click


def perceptual_cost(m: PerceptualMetrics, rule: str = "max", metrics=None) -> float:
    """Collapse the suite to one number, for ranking.

    Each metric is divided by its own audibility reference
    (:data:`PERCEPTUAL_REFERENCE`) and the worst one wins. ``max``, not a
    weighted sum, for the same reason the old ``seam_step`` combined its two
    components with ``max``: a loop is only as good as its most audible defect,
    and one bad enough to hear is not excused by five clean ones.

    ``rule='sum'`` and ``rule='rms'`` exist so the concordance can be reported
    under more than one collapsing rule — if the answer depends on which is
    chosen, that is worth knowing and worth saying.

    A metric that is NaN is SKIPPED, not treated as zero: "not defined here" is
    not evidence of quality. A candidate with no defined metric at all costs
    infinity, because nothing is known about it.
    """
    terms = []
    for name in metrics or RANKING_METRICS:
        value = getattr(m, name)
        if value is None or not np.isfinite(value):
            continue
        scaled = abs(float(value)) / PERCEPTUAL_REFERENCE[name]
        terms.append(scaled)
    if not terms:
        return math.inf
    if rule == "sum":
        return float(sum(terms))
    if rule == "rms":
        return float(math.sqrt(sum(t * t for t in terms) / len(terms)))
    return float(max(terms))
