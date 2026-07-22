"""``candidates.json`` — the arm set the blind A/B rater auditions.

The report answers "does the metric suite agree with the human?" numerically.
On 19 of the 26 corpus samples the top candidate beats gold on tuning and on
every seam metric at once, which is either a real result or a sign that the
metrics measure something the ear does not care about. Only listening settles
that, so this module writes the arms out in a form Loop Lab can load and play
through the real sampler.

Four provenances per sample:

``optimizer``
    The top-K candidates, in rank order, exactly as the report ranks them.
    Full-auto: the search covers whatever window ``--selection`` picked. Lost
    43-3-3 to gold across rounds 1-2 — the metric suite agreeing with itself
    is not the same as agreeing with a listener.
``gold``
    The human-authored loop, unmodified.
``policy`` / ``policy_v2``
    The selection-first arm, in two generations. Neither is metric-ranked;
    both test the shipping product's actual shape (user drags a rough region,
    machine snaps) rather than full-auto placement.

    :func:`policy_loop` is round 3: snap the period-aligned length closest to
    the rough drag, take the longest crossfade the engine clamp allows. It went
    7-17-1 against gold where full-auto had gone 43-3-3, and it retired the
    mechanical complaints — but 12 of its 17 losses were tagged timbre-jump.

    :func:`policy_v2_loop` is round 4 and the default: same snap, but the
    placement inside the drag is gated on F1-F3 stability and the fade length
    is gated on the two fade sources still being the same vowel. See the block
    comment above it.
``naive``
    A deliberately period-UNALIGNED loop inside the gold region, with
    ``xfade = len/8``. The anchor: a rater who cannot hear it lose to gold is
    not hearing loop quality, and every optimizer/policy-vs-gold verdict in
    the same session should be read with that in mind.

Loop points are written in the FILE sample domain, matching ``gold_loop`` in
dataset.json and the WAV that ships beside it. Everything measured here happens
in the engine domain; :meth:`IngestedSample.engine_to_file` is the only thing
that crosses between the two, exactly as ``convertGold`` does on the export
side (ui/electron-main/loopLabExport.js). A loop therefore makes one rounding
trip engine -> file -> engine before it is heard, worth at most a sample either
way at 44.1k -> 48k, which is well under the tolerances every metric here is
quoted to.

The naive arm is derived deterministically — its "arbitrary" start comes from a
stable hash of the sample id, not from an RNG. The policy arm is derived from
the same joint (length, crossfade) search :mod:`loop_optimizer.candidates` uses
for the optimizer arms, restricted to a fixed window and read off with no
metric involved. Both make re-running ``export`` on the same corpus reproduce
the same file byte for byte.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass
from typing import Any

import numpy as np

from .analysis import METRIC_NAMES, SampleResult
from .candidates import (
    Candidate,
    generate_candidates,
    seam_window,
    sliding_end_match_ncc,
    viable_lengths,
    xfade_variants,
)
from .constants import MIN_SEAM_NCC
from .corpus import GoldLoop
from .engine_emu import LoopConfig, resolve
from .formants import FormantTrack, formant_distance_cents, track_formants
from .ingest import IngestedSample
from .perceptual import (
    PERCEPTUAL_REFERENCE,
    PerceptualMetrics,
    SourceReference,
    _filterbank_for,
    measure_perceptual,
    source_reference,
)

#: Which policy the ``export`` command emits unless told otherwise. ``v1`` is
#: kept reachable so ``candidates.round3.json`` stays reproducible from the tool
#: rather than only from the file already on disk.
POLICY_VERSION = "v2"
POLICY_VERSIONS = ("v1", "v2")

#: Naive crossfade width, as a fraction of the loop length. Chosen by the task
#: brief, not by measurement: it is what an implementation that never thought
#: about periods would reach for.
NAIVE_XFADE_DIVISOR = 8

#: How far the policy arm's search window extends past the gold region on each
#: side, as a fraction of the region's own length. Stands in for the slop in a
#: user's rough drag in the selection-first product: the shipping flow is
#: "user drags a rough region, machine snaps", not "machine searches the whole
#: file", so the policy arm's window is deliberately narrow and anchored on a
#: real region rather than run auto-detection again.
POLICY_SELECTION_MARGIN_FRAC = 0.15

#: The naive loop starts this far into the gold region and ends this far short
#: of its end, as fractions of the region. Ranges, not constants: the exact
#: value is drawn per sample from a hash of the sample id so the baseline is not
#: one hand-picked offset applied to the whole corpus.
NAIVE_HEAD_FRAC = (0.10, 0.30)
NAIVE_TAIL_FRAC = (0.05, 0.15)

#: How far from a whole period multiple the naive length must land, in periods.
#: A length that happens to be period-aligned would make the anchor a decent
#: loop and defeat its purpose.
NAIVE_MIN_PHASE_ERROR = 0.15


def _stable_frac(key: str, salt: str) -> float:
    """FNV-1a over ``salt + key``, mapped to [0, 1). Deterministic across runs.

    Python's ``hash()`` is salted per process and would make the naive arm move
    between runs, so the hash is spelled out here.
    """
    h = 2166136261
    for byte in f"{salt}\x00{key}".encode("utf-8"):
        h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
    return h / 4294967296.0


def _lerp_frac(key: str, salt: str, lo: float, hi: float) -> float:
    return lo + (hi - lo) * _stable_frac(key, salt)


def _six_metrics(metrics: PerceptualMetrics) -> dict[str, float]:
    """Just the headline metrics. The sub-terms and context are not metrics."""
    return {name: getattr(metrics, name) for name in METRIC_NAMES}


def _to_file_loop(sample: IngestedSample, cfg: LoopConfig) -> dict[str, int]:
    """Engine-domain :class:`LoopConfig` -> FILE-domain ``{start, end, xfade}``."""
    n = sample.file_num_frames
    conv = lambda v: int(round(sample.engine_to_file(v)))  # noqa: E731
    return {
        "start": max(0, min(n, conv(cfg.loop_start))),
        "end": max(0, min(n, conv(cfg.loop_end))),
        "xfade": max(0, conv(cfg.crossfade_samples)),
    }


def _arm(
    sample: IngestedSample,
    arm_id: str,
    provenance: str,
    cfg: LoopConfig,
    metrics: PerceptualMetrics,
    eff_xfade: int,
    rank: int | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    arm = {
        "arm_id": arm_id,
        "provenance": provenance,
        "rank": rank,
        # FILE domain — the contract with dataset.json and with the rater.
        "loop": _to_file_loop(sample, cfg),
        # Engine domain, informational: what was actually measured. The rater
        # re-derives its own engine-domain values from `loop` and the region's
        # real rate rather than trusting these.
        "loop_engine": {
            "start": cfg.loop_start,
            "end": cfg.loop_end,
            "xfade": cfg.crossfade_samples,
        },
        "metrics": _six_metrics(metrics),
        "engine": {
            # The crossfade the engine's clamp actually applies. Equal to the
            # request for every optimizer candidate by construction; gold and
            # naive are hand-shaped and may well be cut down.
            "eff_xfade": eff_xfade,
            "wrap_advance": metrics.wrap_advance,
            "period_multiple": metrics.period_multiple,
        },
    }
    if extra:
        arm.update(extra)
    return arm


def naive_loop(
    sample_id: str,
    gold: GoldLoop,
    period: float,
    num_samples: int,
) -> LoopConfig | None:
    """Build the period-UNALIGNED anchor loop inside ``gold`` (engine domain).

    Returns ``None`` when the gold region is too short to fit a loop that is
    both inside it and unmistakably off-period — better no anchor than one whose
    badness comes from being three periods long rather than from misalignment.
    """
    region = gold.end - gold.start
    if not (math.isfinite(period) and period > 1.0) or region < 6 * period:
        return None

    head = int(round(_lerp_frac(sample_id, "naive-head", *NAIVE_HEAD_FRAC) * region))
    tail = int(round(_lerp_frac(sample_id, "naive-tail", *NAIVE_TAIL_FRAC) * region))
    start = gold.start + head
    end = gold.end - tail

    # Force the length off-period. `phase` is how far the length sits from the
    # nearest whole multiple, in periods; nudging `end` by half a period moves a
    # near-aligned length to maximally misaligned without leaving the region
    # (the tail margin above is at least 0.05 * region >= 0.3 periods of room).
    length = end - start
    phase = abs(length / period - round(length / period))
    if phase < NAIVE_MIN_PHASE_ERROR:
        end = min(gold.end, end + int(round(0.5 * period)))
        length = end - start

    if length < 2 * period or end > num_samples or start < 0:
        return None
    return LoopConfig(
        loop_start=start,
        loop_end=end,
        crossfade_samples=length // NAIVE_XFADE_DIVISOR,
    )


def policy_loop(
    x: np.ndarray,
    gold: GoldLoop,
    period: float,
    sample_rate: float,
) -> Candidate | None:
    """The selection-first policy arm (engine domain): no metric ranking at all.

    Round 1/2 tested full-auto candidate generation against gold and lost
    43-3-3; the strongest signal in those verdicts was "prefer the longer
    period-multiple fade" (16-5-2), and the persistent complaint was
    timbre-jump — the loop sitting on the wrong vowel moment, a PLACEMENT
    error, not a seam-mechanics one. The shipping product does not do
    full-auto placement: the user drags a rough region and the machine snaps.
    This arm tests exactly that.

    The window stands in for the user's rough drag: gold's own region,
    expanded by :data:`POLICY_SELECTION_MARGIN_FRAC` on each side (a real
    human already placed gold approximately right, so widening it a little is
    a more honest stand-in for "rough" than picking an arbitrary offset would
    be). Inside that window, :func:`generate_candidates` already does the two
    things the policy needs and enforces the invariant this task cares about
    by construction:

      * every (length, crossfade) pair it returns is quantised to whole
        periods, so ``advance = length - crossfade`` is an integer number of
        periods automatically — there is no separate alignment step here;
      * every crossfade it returns already survived ``resolve()`` unchanged
        (candidates.py rejects anything the engine's clamp would cut down),
        so "the longest the clamp allows" is just "the largest survivor".

    So the policy is two lookups, not a search:

      1. pick the length (period multiple) closest to the FULL dragged span
         — the snap a selection-first tool performs is choosing where the
         period-aligned loop points fall inside what the user selected, not
         second-guessing how much they selected;
      2. among candidates at that length, take the one with the longest
         crossfade — the corpus's own strongest taste signal.

    Returns ``None`` when the window cannot support any candidate (mirrors
    :func:`naive_loop`'s failure mode: better no arm than a degenerate one).
    """
    region = gold.end - gold.start
    if not (math.isfinite(period) and period > 1.0) or region <= 0:
        return None

    n = x.shape[0]
    margin = int(round(POLICY_SELECTION_MARGIN_FRAC * region))
    window_start = max(0, gold.start - margin)
    window_end = min(n, gold.end + margin)
    selection_span = window_end - window_start
    if selection_span < period:
        return None

    candidates = generate_candidates(x, period, window_start, window_end, sample_rate)
    if not candidates:
        return None

    by_k: dict[int, list[Candidate]] = {}
    for c in candidates:
        by_k.setdefault(c.period_multiple, []).append(c)

    # Step 1: snap the length to the period multiple closest to the dragged
    # span. All candidates sharing a k share the same (loop_start, loop_end) —
    # generate_candidates fixes the start via its own NCC search per k before
    # sweeping crossfade widths — so this also fixes the start.
    k_star = min(by_k, key=lambda k: abs(by_k[k][0].length - selection_span))
    # Step 2: the longest period-multiple crossfade the engine clamp allowed
    # at that length.
    return max(by_k[k_star], key=lambda c: c.crossfade_samples)


# ── Policy v2: formant-gated placement + drift-gated fade ───────────────────
#
# Round 3 result, and what it leaves: the round-3 policy arm above took 7 of 25
# against human gold (round 1/2 full-auto managed 1-2), and the mechanical
# complaints all but disappeared from the loss tags — click and flam are solved.
# What did NOT move is timbre-jump: 12 of the 17 losses. Both halves of the
# round-3 policy are implicated, and each gets a gate here.
#
#   PLACEMENT. The round-3 policy snapped the loop LENGTH to the whole dragged
#   span and then chose the start on seam NCC. Those two steps interact in a way
#   that is easy to miss: a loop as long as the drag has essentially nowhere to
#   sit inside it, so "choose the start" was never a real choice — on this
#   corpus the snap leaves a single placement. A placement gate layered on top
#   of that snap would do nothing at all.
#
#   So the length is no longer snapped first. Placement and length are searched
#   together, as one pool of spans, and the loop is the LONGEST span whose
#   F1-F3 drift is stable. That is still "use as much of what the user dragged
#   as you can" — it just stops at the point where taking more material means
#   taking a vowel transition with it. NCC still decides between spans that tie.
#
#   FADE LENGTH. "Longest fade the clamp allows" was the strongest taste signal
#   in rounds 1-2 (16-5-2) and it is still the default here — but taken to its
#   limit on evolving material it makes the fade span the drift, blending a
#   vowel with a DIFFERENT vowel and manufacturing a morph the source never
#   had. The fade is now the longest one whose two sources still sound like the
#   same moment: formant distance under an audibility threshold, and levels
#   within a few dB.
#
# Both gates are one-sided. Neither can make a fade longer or move a loop
# somewhere NCC rejected; they only refuse. If the material never drifts, this
# policy returns exactly what the round-3 one would have.

#: Placement gate: the fraction of candidate spans, ranked by formant drift,
#: that stay eligible. A quartile is a deliberately weak filter — the claim
#: being tested is "the drifting placements are the losses", not "the single
#: calmest placement is the best one", and handing the whole decision to a
#: measurement that under-discriminated as a ranker would be repeating the
#: round-1/2 mistake in a new place. Length still decides within the survivors.
FORMANT_DRIFT_QUANTILE = 0.25

#: ...and a span this stable is kept whatever the quartile says. This constant
#: is what stops the placement gate from firing on material that never drifts,
#: and it is not optional: drift is a standard deviation over the span's frames,
#: so even on a perfectly held vowel it creeps up with length as measurement
#: noise accumulates. A pure quartile would therefore prefer SHORT loops on
#: every sample in the corpus, drifting or not, and round 4 would be testing
#: "shorter loops" rather than "stabler placement" — the same kind of confound
#: that made "prefer the longer crossfade" so hard to separate from the metric
#: suite in round 2.
#:
#: 50 cents of standard deviation is roughly +/-3% of formant movement, well
#: under the ~5-8% JND for a formant shift. Below it there is nothing to hear,
#: so there is nothing for the gate to protect against and the policy falls
#: back to exactly what round 3 did: take the longest span the drag allows.
FORMANT_STABLE_DRIFT_CENTS = 50.0

#: Fade gate: how far the two fade sources' formants may differ, in cents.
#:
#: NOT the audibility figure, and the difference matters. The audibility figure
#: is ~150 cents: the JND for a formant shift is around 5-8% (85-135 cents), so
#: 150 (~9%) is where a blend stops sounding like one held sound. That value was
#: implemented first and then measured against the corpus, where it fails a test
#: it should not fail — GOLD'S OWN FADES EXCEED IT ON 8 OF THE 19 SAMPLES WHERE
#: IT IS MEASURABLE (median 127, p90 303, max 494 cents). A gate that refuses
#: the answer humans chose and listeners preferred is a bug, not a gate.
#:
#: So the line sits at gold's own 90th percentile instead. That is BOUNDED BY
#: THE CORPUS, not derived from hearing, and is labelled as such deliberately:
#: it can only refuse fades more extreme than nine out of ten human ones, which
#: makes it a tail guard rather than a preference. It is also the conservative
#: choice on purpose — shortening a fade contradicts the strongest signal in the
#: round-1/2 verdicts ("prefer the longer period-multiple fade", 16-5-2), so the
#: fade half of this policy should only fire where the evidence is lopsided.
#: The PLACEMENT gate below is where the round-4 hypothesis is actually tested.
FORMANT_FADE_GATE_CENTS = 300.0

#: The audibility figure the gate above is NOT set to, kept because the next
#: round should be able to find it without re-deriving it.
FORMANT_JND_CENTS = 150.0

#: Mechanical rejectors, retained from the metric suite rather than reinvented:
#: a candidate that measures a clearly-audible click or a clearly-doubled attack
#: is refused whatever the formant gates think. These are PERCEPTUAL_REFERENCE's
#: own "clearly audible" values, used as the pass/fail line they were written to
#: describe, and they pass the same test the fade gate had to: across the corpus
#: gold measures click 0.79-1.07 against a guard of 2.0 and flam 0.0 against 20,
#: so neither can refuse a human answer.
CLICK_GUARD = PERCEPTUAL_REFERENCE["click"]
FLAM_GUARD = PERCEPTUAL_REFERENCE["flam"]

#: Gates whose failure condemns the whole SPAN rather than one fade width. A
#: click or a doubled attack that survives every fade length at a placement is
#: a property of where the loop points fell, so the search moves on rather than
#: shortening the fade at a placement that cannot be fixed by shortening.
MECHANICAL_GATES = ("click", "flam")

#: How many spans the search will try before giving up and emitting no policy
#: arm. A runtime guard in the spirit of MAX_PERIOD_MULTIPLES, not a quality
#: policy: with the gates below, the first span almost always survives.
MAX_SPAN_ATTEMPTS = 32

# THE GATE THAT IS NOT HERE: an envelope-RMS difference between the two fade
# sources, which the round-4 brief asks for as a wobble guard. It was
# implemented, measured, and removed, for two independent reasons.
#
#   It is anti-monotone in the quantity it controls. A gate is only usable as
#   "shorten until it passes" if shortening helps. It does the opposite: the two
#   fade sources are windows at the loop's end and start, and on decaying
#   material a LONGER fade averages both towards each other while a shorter one
#   converges on the raw level step at the seam. Measured on
#   hard_tuned_vocal_0001, the difference runs 4.6 dB at the longest fade and
#   10.2 dB at the one-period floor. "Shorten until it passes" would never
#   terminate; it would walk every option down to the floor and land on the
#   worst one.
#
#   And it fires on gold. Human gold fades measure up to 5.1 dB across this
#   corpus, against the 3 dB the `hollow` reference calls clearly audible — so
#   the same test that moved the formant gate would have had to move this one
#   past every value it was meant to catch.
#
# The reading is still computed and still reported in the trace: it is real
# information about a candidate, and a later round may find a use for it that
# does not involve shortening a fade. It just does not decide anything here.


@dataclass(frozen=True)
class PolicyV2Trace:
    """What the two gates did on one sample. The deliverable table, per row.

    Carried into candidates.json beside the arm so a listener's verdict can
    later be read against the gate that produced it — without this, a round-4
    loss would say only "policy v2 lost", not "policy v2 lost on a sample where
    the formant gate cut the fade from 8 periods to 2".
    """

    #: Loop length actually chosen, in whole periods and in samples.
    period_multiple: int
    length: int
    #: Formant drift of the chosen span, in cents (:meth:`FormantTrack.span_drift_cents`).
    span_drift_cents: float
    #: Median drift over EVERY span considered — the "vs the full selection"
    #: column. A chosen drift near the median means the gate had nothing to work
    #: with on this sample, not that it was skipped.
    selection_median_drift_cents: float
    #: The line drift had to fall under to stay eligible: the lowest quartile,
    #: or FORMANT_STABLE_DRIFT_CENTS where that is higher.
    drift_cut_cents: float
    spans_considered: int
    spans_kept: int
    #: Longest span the selection could have held at all. Against ``length``,
    #: this says how much material the placement gate gave up: equal means the
    #: gate cost nothing, shorter means it refused to include a drifting tail.
    longest_span: int
    #: ...and that span's own drift. This is the pair that shows the gate
    #: working: ``span_drift_cents`` is what was accepted, this is what was
    #: refused. Note ``span_drift_cents`` is normally ABOVE the pool median and
    #: that is not a failure — survivors are taken longest-first, so the policy
    #: deliberately spends drift up to the cut rather than hunting the single
    #: calmest (and therefore shortest) span in the window.
    longest_span_drift_cents: float
    #: Longest fade available at the chosen span before any gate ran — the
    #: "drift-free maximum". This is exactly what round-3 policy would have
    #: taken at this span.
    max_xfade: int
    chosen_xfade: int
    #: Which gate refused the next-longer fade, or "none" when the chosen fade
    #: IS the maximum. This is the column that says how often each gate bound.
    binding_gate: str
    #: True when every gated option was refused and the fade fell back to the
    #: one-period floor. These are the cases to look at first if round 4 loses.
    #:
    #: Expect this to be rare or absent, and that is a property of the gate
    #: rather than of the material: the formant gate's EFFECTIVE floor is one
    #: formant frame (30 ms), not one period. Below a frame there is nothing to
    #: measure, the reading is NaN, and a NaN reading passes — so walking down
    #: from the longest fade, the gate stops refusing as soon as the fade is too
    #: short to span a vowel transition, which is exactly when it should stop
    #: caring. The one-period floor stays as the backstop for a gate that CAN
    #: read a short fade and still refuses it.
    hit_floor: bool
    #: The chosen fade's own gate readings, for auditing the thresholds. Often
    #: NaN for a short fade: under one formant frame (30 ms) there is no formant
    #: to compare, which is why `binding_distance_cents` is reported beside it.
    formant_distance_cents: float
    rms_delta_db: float
    #: Formant distance of the fade that WAS refused — the reading that actually
    #: bound. Without it the table shows a chosen fade with no measurable
    #: distance and no evidence of why it was not longer.
    binding_distance_cents: float


def _rms_delta_db(src_a: np.ndarray, src_b: np.ndarray) -> float:
    """Level difference between the two blended sources, in dB. NaN if either is silent."""
    if src_a.size == 0 or src_b.size == 0:
        return float("nan")
    ra = float(np.sqrt(np.mean(np.square(src_a, dtype=np.float64))))
    rb = float(np.sqrt(np.mean(np.square(src_b, dtype=np.float64))))
    if ra <= 1e-9 or rb <= 1e-9:
        return float("nan")
    return abs(20.0 * math.log10(ra / rb))


def _fade_gate_readings(
    x: np.ndarray,
    cand: Candidate,
    track: FormantTrack,
) -> tuple[float, float]:
    """``(formant distance, level difference)`` between the two sources a fade blends.

    The spans are the engine's own: ``[loop_end - xfade, loop_end)`` fades out
    while ``[loop_start, loop_start + xfade)`` fades in. Both readings are NaN
    for a fade too short to hold a formant frame, and a NaN gate PASSES — a
    2 ms fade physically cannot span a vowel transition, so refusing it would be
    the gate inventing a problem rather than finding one.
    """
    xf = cand.crossfade_samples
    if xf <= 0:
        return float("nan"), float("nan")
    a_lo, a_hi = cand.loop_end - xf, cand.loop_end
    b_lo, b_hi = cand.loop_start, cand.loop_start + xf
    dist = formant_distance_cents(
        track.span_formants_cents(a_lo, a_hi), track.span_formants_cents(b_lo, b_hi)
    )
    level = _rms_delta_db(
        np.asarray(x[a_lo:a_hi], dtype=np.float64), np.asarray(x[b_lo:b_hi], dtype=np.float64)
    )
    return dist, level


def _fade_rejection(
    x: np.ndarray,
    cand: Candidate,
    track: FormantTrack,
    period: float,
    sample_rate: float,
    ref: SourceReference | None,
) -> tuple[str | None, float, float]:
    """First gate this fade fails, or ``None``. Plus its two gate readings.

    Every comparison is written so a NaN reading passes: ``value > gate`` is
    False for NaN, which is the behaviour bb83b03/db7e180 established for the
    metric suite — an unmeasurable quantity expresses no opinion and must not be
    silently scored as either good or bad. In particular a fade shorter than one
    formant frame (30 ms) has no measurable formant distance, and that is the
    correct answer rather than a hole: a fade that brief cannot span a vowel
    transition, so there is nothing for the gate to refuse.

    Cheapest first: the source comparison is a handful of FFTs, the mechanical
    guards are a full render plus the metric suite, so the expensive check only
    runs on fades that already passed the structural one.
    """
    dist, level = _fade_gate_readings(x, cand, track)
    if dist > FORMANT_FADE_GATE_CENTS:
        return "formant", dist, level

    m = measure_perceptual(x, cand.to_config(), period, sample_rate, ref)
    if m.click > CLICK_GUARD:
        return "click", dist, level
    if m.flam > FLAM_GUARD:
        return "flam", dist, level
    return None, dist, level


@dataclass(frozen=True)
class _Span:
    """One (placement, length) pair the search considered."""

    period_multiple: int
    length: int
    loop_start: int
    search_ncc: float
    drift_cents: float


def _span_pool(
    x: np.ndarray,
    period: float,
    window_start: int,
    window_end: int,
    sample_rate: float,
    track: FormantTrack,
) -> list[_Span]:
    """Every (start, length) span in the window that the seam search accepts.

    Lengths come from :func:`~loop_optimizer.candidates.viable_lengths`, so the
    minimum-loop-duration floor and the engine's own bounds apply here exactly
    as they do to the optimizer arms — the policy cannot reach a 2 ms "loop"
    that the generator is forbidden to propose.

    Starts are enumerated on a one-period grid rather than sample by sample.
    Two starts a fraction of a period apart describe the same placement in every
    way this gate can see — they fall in the same formant frames — so a finer
    grid would only inflate the pool the quartile is computed over.

    PLUS, at every length, the best-correlating start — the one
    :func:`~loop_optimizer.candidates.generate_candidates` would have picked.
    Without it the pool is not a superset of what round-3 policy could reach:
    at long lengths only a handful of starts correlate at all, the grid can
    step straight over every one of them, and v2 would then look like it had
    rejected a placement on formant grounds when in fact it never saw it. That
    is what makes "with the gate inert, v2 returns v1's answer" a structural
    property rather than a coincidence.
    """
    w = seam_window(period)
    pool: list[_Span] = []
    step = max(1, int(round(period)))

    for k, length in viable_lengths(period, window_end - window_start, sample_rate):
        lo = window_start
        hi = window_end - length - w
        if hi <= lo:
            continue
        ncc = sliding_end_match_ncc(x, length, w, lo, hi)
        if ncc.size == 0:
            continue
        offsets = list(range(0, ncc.size, step))
        if np.any(np.isfinite(ncc)):
            best = int(np.nanargmax(ncc))
            if best not in offsets:
                offsets.append(best)
        for off in offsets:
            v = float(ncc[off])
            if not np.isfinite(v) or v < MIN_SEAM_NCC:
                continue
            start = lo + off
            pool.append(
                _Span(
                    period_multiple=k,
                    length=length,
                    loop_start=start,
                    search_ncc=v,
                    drift_cents=track.span_drift_cents(start, start + length),
                )
            )
    return pool


def _drift_gated_spans(pool: list[_Span]) -> tuple[list[_Span], float, float]:
    """Filter the pool to the stable spans. Returns ``(kept, median, cut)``.

    The cut is ``max(lowest quartile, FORMANT_STABLE_DRIFT_CENTS)`` — see those
    two constants for why an absolute floor has to be there beside the quartile.

    When drift is unmeasurable everywhere (no frames resolved — silence, or a
    window shorter than a formant frame) NO span is dropped and the cut is
    reported as NaN. The alternative, treating unmeasurable as calm, would hand
    the gate's decision to whichever spans the tracker happened to fail on.

    Survivors are ordered LONGEST first, then by seam correlation, then by
    start. Longest first is the round-3 instinct — use as much of the dragged
    material as possible — now applied only to spans that passed the gate.
    """
    drifts = np.array([s.drift_cents for s in pool], dtype=np.float64)
    finite = drifts[np.isfinite(drifts)]
    if finite.size == 0:
        median = cut = float("nan")
        kept = list(pool)
    else:
        median = float(np.median(finite))
        cut = max(
            float(np.quantile(finite, FORMANT_DRIFT_QUANTILE)), FORMANT_STABLE_DRIFT_CENTS
        )
        kept = [s for s in pool if np.isfinite(s.drift_cents) and s.drift_cents <= cut]
        if not kept:
            # Only reachable if every drift is NaN except ones above their own
            # quantile, which cannot happen — but a search that silently returns
            # nothing is a worse failure than one that falls back to the pool.
            kept = list(pool)

    kept.sort(key=lambda s: (-s.length, -s.search_ncc, s.loop_start))
    return kept, median, cut


def policy_v2_loop(
    x: np.ndarray,
    gold: GoldLoop,
    period: float,
    sample_rate: float,
    ref: SourceReference | None = None,
) -> tuple[Candidate, PolicyV2Trace] | None:
    """The round-4 policy arm: formant-gated placement, drift-gated fade length.

    Same product shape as :func:`policy_loop` — the user drags roughly, the
    machine snaps. What changed is that length and placement are no longer
    decided in that order: round 3 snapped the length to the whole drag and
    then placed a loop that had nowhere left to go, so they are searched
    together here as one pool of spans. Fade length is still decided last. See
    the block comment above for why.

    Returns ``(candidate, trace)``, or ``None`` when the window supports no
    loop at all. Never returns a candidate whose crossfade the engine would
    clamp: every fade comes from :func:`~loop_optimizer.candidates.xfade_variants`,
    which verifies each one against ``resolve()`` first.
    """
    region = gold.end - gold.start
    if not (math.isfinite(period) and period > 1.0) or region <= 0:
        return None

    n = int(np.asarray(x).shape[0])
    margin = int(round(POLICY_SELECTION_MARGIN_FRAC * region))
    window_start = max(0, gold.start - margin)
    window_end = min(n, gold.end + margin)
    selection_span = window_end - window_start
    if selection_span < period:
        return None

    xs = np.asarray(x, dtype=np.float64)
    track = track_formants(xs, sample_rate, window_start, window_end)

    # Step 1: the formant-stability search. Spans (start AND length together),
    # filtered to the stable ones, longest first.
    pool = _span_pool(xs, period, window_start, window_end, sample_rate, track)
    if not pool:
        return None
    kept, median, cut = _drift_gated_spans(pool)

    period_int = max(1, int(round(period)))

    for span in kept[:MAX_SPAN_ATTEMPTS]:
        # Step 2: advance-align. Nothing to do — every variant below has a
        # whole-period length AND a whole-period fade, so
        # advance = length - xfade is a whole number of periods by
        # construction, exactly as in round 3.
        variants = xfade_variants(
            n,
            period,
            span.loop_start,
            span.loop_start + span.length,
            span.period_multiple,
            span.search_ncc,
            sample_rate,
        )
        if not variants:
            continue
        variants.sort(key=lambda c: c.crossfade_samples, reverse=True)
        max_xfade = variants[0].crossfade_samples

        # Step 3: the longest fade that passes every gate. `verdicts` keeps
        # every option's reading rather than only the last, because the gate
        # that matters is the one that refused the option immediately ABOVE the
        # one taken — reporting the last rejection instead makes the trace
        # blame whichever gate happened to catch the zero-width variant at the
        # bottom of the list.
        verdicts: dict[int, tuple[str | None, float, float]] = {}
        chosen: Candidate | None = None
        for cand in variants:
            verdicts[cand.crossfade_samples] = _fade_rejection(
                xs, cand, track, period, sample_rate, ref
            )
            if verdicts[cand.crossfade_samples][0] is None:
                chosen = cand
                break

        fell_back = chosen is None
        if chosen is None:
            # Nothing passed. The floor is one period, not zero: a fade shorter
            # than a period cannot be period-aligned, and `xfade_variants` would
            # not have offered it. Where even one period does not fit (k=1,
            # whose half-loop clamp is under a period) the only available
            # variant is 0, and that is a physical fact about the length rather
            # than the gates settling for silence.
            floor = [c for c in variants if c.crossfade_samples >= period_int]
            chosen = floor[-1] if floor else variants[-1]
            if verdicts[chosen.crossfade_samples][0] in MECHANICAL_GATES:
                # The floor itself clicks. Shortening cannot fix a click that
                # survives every fade width — that is the PLACEMENT talking, so
                # the span is rejected and the search moves on rather than
                # shipping a loop the guard already refused.
                continue

        # The binding gate is the reason recorded against the shortest REFUSED
        # option, i.e. the one just longer than what was taken.
        longer = [xf for xf in verdicts if xf > chosen.crossfade_samples]
        binding = "none"
        binding_distance = float("nan")
        if longer:
            reason, dist, _level = verdicts[min(longer)]
            binding = reason or "none"
            binding_distance = dist
        readings = verdicts[chosen.crossfade_samples][1:]

        shortened = chosen.crossfade_samples < max_xfade
        # Only a floor that actually cost something counts as one. Where the
        # span offers a single fade width the fallback picks it, but nothing was
        # given up and calling that "hit the floor" would inflate the one number
        # in the table meant to flag samples worth listening to first.
        hit_floor = fell_back and shortened
        longest = max(pool, key=lambda s: (s.length, s.search_ncc))
        return chosen, PolicyV2Trace(
            period_multiple=span.period_multiple,
            span_drift_cents=span.drift_cents,
            selection_median_drift_cents=median,
            drift_cut_cents=cut,
            spans_considered=len(pool),
            spans_kept=len(kept),
            longest_span=longest.length,
            longest_span_drift_cents=longest.drift_cents,
            length=span.length,
            max_xfade=max_xfade,
            chosen_xfade=chosen.crossfade_samples,
            binding_gate=binding if shortened else "none",
            hit_floor=hit_floor,
            formant_distance_cents=readings[0],
            rms_delta_db=readings[1],
            binding_distance_cents=binding_distance if shortened else float("nan"),
        )

    return None


def build_sample_payload(
    result: SampleResult, top_k: int, policy_version: str = POLICY_VERSION
) -> dict[str, Any]:
    """One sample's entry in candidates.json: its arms plus the context to read them."""
    sample = result.sample
    notes = list(result.notes)
    arms: list[dict[str, Any]] = []

    for rank, sc in enumerate(result.ranked[: max(0, top_k)], start=1):
        arms.append(
            _arm(
                sample,
                arm_id=f"optimizer_{rank}",
                provenance="optimizer",
                cfg=sc.candidate.to_config(),
                metrics=sc.metrics,
                eff_xfade=sc.eff_xfade,
                rank=rank,
            )
        )
    if not result.ranked:
        notes.append("no optimizer candidate to audition")

    gold_cmp = result.gold
    if gold_cmp is not None:
        gold_engine = gold_cmp.gold_engine
        gold_cfg = LoopConfig(
            loop_start=gold_engine.start,
            loop_end=gold_engine.end,
            crossfade_samples=gold_engine.xfade,
        )
        arms.append(
            _arm(
                sample,
                arm_id="gold",
                provenance="gold",
                cfg=gold_cfg,
                metrics=gold_cmp.gold_metrics,
                eff_xfade=gold_cmp.gold_eff_xfade,
            )
        )

        fb, n_fft = _filterbank_for(result.period, sample.sample_rate)
        ref = source_reference(sample.x, result.period, sample.sample_rate, fb, n_fft)

        if policy_version == "v1":
            policy_cand = policy_loop(sample.x, gold_engine, result.period, sample.sample_rate)
            trace = None
        else:
            found = policy_v2_loop(
                sample.x, gold_engine, result.period, sample.sample_rate, ref
            )
            policy_cand, trace = found if found is not None else (None, None)

        if policy_cand is None:
            notes.append("gold region too short for a policy arm; none emitted")
        else:
            policy_cfg = policy_cand.to_config()
            policy_eff = resolve(policy_cfg, sample.num_samples, sample.sample_rate)
            arm_id = "policy" if policy_version == "v1" else "policy_v2"
            arms.append(
                _arm(
                    sample,
                    arm_id=arm_id,
                    provenance=arm_id,
                    cfg=policy_cfg,
                    metrics=measure_perceptual(
                        sample.x, policy_cfg, result.period, sample.sample_rate, ref
                    ),
                    eff_xfade=policy_eff.eff_xfade,
                    # The gate trace rides beside the arm rather than in a
                    # sidecar file: a verdict is only interpretable next to what
                    # the gates did to produce the loop that was heard.
                    extra=None if trace is None else {"policy": asdict(trace)},
                )
            )

        naive_cfg = naive_loop(
            result.entry.sample_id, gold_engine, result.period, sample.num_samples
        )
        if naive_cfg is None:
            notes.append("gold region too short for a naive anchor; none emitted")
        else:
            naive_eff = resolve(naive_cfg, sample.num_samples, sample.sample_rate)
            arms.append(
                _arm(
                    sample,
                    arm_id="naive",
                    provenance="naive",
                    cfg=naive_cfg,
                    metrics=measure_perceptual(
                        sample.x, naive_cfg, result.period, sample.sample_rate, ref
                    ),
                    eff_xfade=naive_eff.eff_xfade,
                )
            )
    else:
        notes.append("no gold loop; nothing to compare against and no anchor")

    return {
        "sample_id": result.entry.sample_id,
        "file": str(result.entry.raw.get("file", "")),
        "class": result.entry.sample_class,
        "behavior_family": result.entry.behavior_family,
        "root_note": result.entry.root_note,
        "file_sample_rate": sample.file_sample_rate,
        "file_num_samples": sample.file_num_frames,
        "engine_sample_rate": sample.sample_rate,
        "period_engine": float(result.period) if np.isfinite(result.period) else None,
        "window": {"start": result.window.start, "end": result.window.end},
        "arms": arms,
        "notes": notes,
    }


def build_payload(
    results: list[SampleResult],
    dataset_path,
    selection: str,
    rank_by: str,
    top_k: int,
    policy_version: str = POLICY_VERSION,
) -> dict[str, Any]:
    """The whole candidates.json document."""
    return {
        "schema": "xleth.loop-optimizer.candidates/1",
        "dataset": str(dataset_path),
        "selection": selection,
        "rank_by": rank_by,
        "top_k": top_k,
        # Which policy generated the policy arm. An added key, not a schema
        # change: the rater keys off each arm's own `provenance`, so a document
        # stays readable by a rater that has never heard of this field.
        "policy_version": policy_version,
        "metric_names": list(METRIC_NAMES),
        "samples": [build_sample_payload(r, top_k, policy_version) for r in results],
    }
