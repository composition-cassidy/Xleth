"""Per-sample pipeline: ingest -> track -> select -> generate -> measure -> compare.

Also home to the deliberately-untuned ordering used to pick a "top" candidate.
The phase brief forbids weight tuning, and this module holds to that: ranking is
by ONE metric, chosen on the command line, with tie-breaks that exist purely so
runs are reproducible. It is not a cost function and must not be mistaken for
one — the report prints both "did the top candidate match gold" and "did ANY
candidate match gold, and at what rank", precisely so a poor placeholder
ordering cannot masquerade as a finding about the metrics.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from enum import Enum

import numpy as np

from .candidates import Candidate, generate_candidates
from .constants import (
    ENGINE_SAMPLE_RATE,
    GOLD_TOLERANCE_PERIODS,
    GOLD_XFADE_TOLERANCE_FACTOR,
)
from .corpus import CorpusEntry, GoldLoop
from .engine_emu import LoopConfig, resolve
from .features import MeasuredFeatures, measure_features
from .ingest import IngestedSample, ingest_file
from .metrics import METRIC_DIRECTION, SeamMetrics, measure
from .pitch import PitchTrack, SteadyStateWindow, detect_steady_state_window, track_pitch

#: Metrics reported in the per-candidate table, in order.
METRIC_NAMES = tuple(METRIC_DIRECTION.keys())


class Selection(str, Enum):
    """Where to search for loops."""

    #: Detected steady-state window. Exercises the whole pipeline, including
    #: region selection, and can therefore fail to contain gold at all.
    AUTO = "auto"
    #: The entire file. The brief's "full file" option.
    FULL = "full"
    #: The gold region plus a margin. Isolates the loop-point question from the
    #: region-selection question — use it to ask "given the same region, does the
    #: metric suite agree with the human?"
    GOLD = "gold"


@dataclass(frozen=True)
class ScoredCandidate:
    candidate: Candidate
    metrics: SeamMetrics
    #: Crossfade after the engine's clamp — what actually plays.
    eff_xfade: int


@dataclass(frozen=True)
class GoldComparison:
    """How the tool's answer relates to the human-authored one."""

    gold_engine: GoldLoop
    gold_metrics: SeamMetrics
    gold_eff_xfade: int
    #: Did the top-ranked candidate land within tolerance of gold, on BOTH the
    #: loop points and the crossfade?
    top_matches: bool
    #: Loop points and crossfade judged separately. A miss on the crossfade
    #: alone is a very different finding from a miss on where the loop is, and
    #: collapsing the two hides which one the tool actually got wrong.
    top_points_match: bool
    top_xfade_match: bool
    #: Rank (1-based) of the best candidate matching on both counts, if any.
    best_matching_rank: int | None
    #: Rank of the best candidate matching on loop POINTS alone, if any. When
    #: this is set and best_matching_rank is not, the generator found gold's loop
    #: and only the crossfade variants missed it.
    best_points_rank: int | None
    start_delta_periods: float
    end_delta_periods: float
    xfade_ratio: float
    #: The candidate closest to gold in loop points, whatever its rank. Answers
    #: "did generation even propose this loop?" independently of ranking.
    nearest_rank: int | None = None
    nearest_start_delta_periods: float = float("nan")
    nearest_end_delta_periods: float = float("nan")
    #: Per-metric verdict: "tool", "gold", "tie" or "n/a".
    metric_winners: dict[str, str] = field(default_factory=dict)
    #: Per metric, how many candidates beat gold on it. This is the flatness
    #: measure: when hundreds of candidates out of a few hundred beat gold, the
    #: metric is not selecting a loop, it is only ruling bad ones out — which is
    #: the difference between a measurement and a cost function.
    candidates_better_than_gold: dict[str, int] = field(default_factory=dict)
    #: Total candidates considered, so the above is readable as a fraction.
    candidate_count: int = 0


@dataclass(frozen=True)
class SampleResult:
    entry: CorpusEntry
    sample: IngestedSample
    track: PitchTrack
    features: MeasuredFeatures
    window: SteadyStateWindow
    selection: Selection
    period: float
    ranked: list[ScoredCandidate]
    gold: GoldComparison | None
    notes: list[str]

    @property
    def top(self) -> ScoredCandidate | None:
        return self.ranked[0] if self.ranked else None


def _period_in_window(track: PitchTrack, start: int, end: int) -> float:
    """Median voiced period among hops inside ``[start, end)``."""
    if track.positions.size == 0:
        return float("nan")
    inside = (track.positions >= start) & (track.positions < end) & track.voiced
    vals = track.periods[inside]
    if vals.size:
        return float(np.median(vals))
    return track.median_period()


def _select_window(
    selection: Selection,
    track: PitchTrack,
    sample: IngestedSample,
    gold_engine: GoldLoop | None,
    margin_periods: float,
) -> tuple[SteadyStateWindow, list[str]]:
    notes: list[str] = []
    n = sample.num_samples

    if selection is Selection.AUTO:
        return detect_steady_state_window(track, n), notes

    if selection is Selection.FULL:
        period = _period_in_window(track, 0, n)
        viable = bool(np.isfinite(period) and period > 1.0)
        return SteadyStateWindow(0, n, period, viable, "" if viable else "no voiced hops"), notes

    # Selection.GOLD
    if gold_engine is None:
        notes.append("gold selection requested but this entry has no gold loop; fell back to full file")
        period = _period_in_window(track, 0, n)
        return SteadyStateWindow(0, n, period, bool(np.isfinite(period)), ""), notes

    # Margin is expressed in periods, so it needs a period before the window is
    # known. The whole-file median is the only estimate available at this point;
    # the window's own period is re-derived below once the range is fixed.
    rough = track.median_period()
    margin = int(round(margin_periods * rough)) if np.isfinite(rough) else 0
    start = max(0, gold_engine.start - margin)
    end = min(n, gold_engine.end + margin)
    period = _period_in_window(track, start, end)
    viable = bool(np.isfinite(period) and period > 1.0 and end - start > 4)
    return SteadyStateWindow(start, end, period, viable, "" if viable else "gold region not analysable"), notes


def _rank_key(sc: ScoredCandidate, key: str) -> tuple:
    """Sort key: primary metric, then deterministic tie-breaks.

    Tie-breaks are for REPRODUCIBILITY, not quality. Ranking by a single metric
    leaves many candidates genuinely tied (a long crossfade drives seam_ncc to
    0.999+ for most alignments), and an unstable sort would make the corpus
    report change between runs for no reason.
    """
    metrics = sc.metrics
    value = getattr(metrics, key, None)
    if value is None:
        value = getattr(sc.candidate, key, float("nan"))
    value = float(value)

    direction = METRIC_DIRECTION.get(key, "higher")
    if direction == "higher":
        primary = -value
    elif direction == "lower_abs":
        primary = abs(value)
    else:
        primary = value
    if not math.isfinite(primary):
        primary = math.inf  # NaN sorts last, always

    cents = abs(metrics.cents_err_per_loop) if math.isfinite(metrics.cents_err_per_loop) else math.inf
    step = metrics.seam_step if math.isfinite(metrics.seam_step) else math.inf
    return (primary, cents, step, sc.candidate.period_multiple, sc.candidate.loop_start)


def rank_candidates(scored: list[ScoredCandidate], key: str) -> list[ScoredCandidate]:
    return sorted(scored, key=lambda sc: _rank_key(sc, key))


def _xfade_ratio(candidate_xfade: int, gold_xfade: int) -> float:
    """Ratio used for the "within 2x" test, with the zero cases made explicit."""
    if gold_xfade == 0 and candidate_xfade == 0:
        return 1.0
    if gold_xfade == 0 or candidate_xfade == 0:
        # One side fades and the other does not. That is not "within a factor";
        # it is a different loop, so report an out-of-range ratio rather than
        # dividing by zero or quietly calling it a match.
        return math.inf
    return candidate_xfade / gold_xfade


def _points_match(sc: ScoredCandidate, gold: GoldLoop, gold_advance: int, period: float) -> bool:
    """Start position AND audible advance within +/-GOLD_TOLERANCE_PERIODS of gold.

    Deliberately not "both raw endpoints within tolerance" (the span). The
    engine's wrap skips the crossfade, so the span is not what repeats —
    ``advance = loopEnd - loopStart - effXfade`` is, and that is true of gold's
    loop exactly as much as a candidate's. Two loops with identical spans but
    different crossfades sound like different-length loops; comparing spans
    would call that a match anyway. ``gold_advance`` must already be resolved
    through the engine's clamp (``SeamMetrics.wrap_advance``), not computed
    from ``gold.end - gold.start - gold.xfade`` directly, for the same reason.
    """
    tol = GOLD_TOLERANCE_PERIODS * period
    if abs(sc.candidate.loop_start - gold.start) > tol:
        return False
    return abs(sc.metrics.wrap_advance - gold_advance) <= tol


def _xfade_match(sc: ScoredCandidate, gold: GoldLoop) -> bool:
    ratio = _xfade_ratio(sc.eff_xfade, gold.xfade)
    return (1.0 / GOLD_XFADE_TOLERANCE_FACTOR) <= ratio <= GOLD_XFADE_TOLERANCE_FACTOR


def _matches_gold(sc: ScoredCandidate, gold: GoldLoop, gold_advance: int, period: float) -> bool:
    return _points_match(sc, gold, gold_advance, period) and _xfade_match(sc, gold)


def _compare_metric(name: str, tool_value: float, gold_value: float, rel_tol: float = 1e-3) -> str:
    """Who wins on one metric: "tool", "gold", "tie", or "n/a"."""
    if not (math.isfinite(tool_value) and math.isfinite(gold_value)):
        return "n/a"
    direction = METRIC_DIRECTION[name]
    a, b = tool_value, gold_value
    if direction == "lower_abs":
        a, b = abs(a), abs(b)
    scale = max(abs(a), abs(b), 1e-9)
    if abs(a - b) <= rel_tol * scale:
        return "tie"
    if direction == "higher":
        return "tool" if a > b else "gold"
    return "tool" if a < b else "gold"


def analyse_entry(
    entry: CorpusEntry,
    selection: Selection = Selection.AUTO,
    rank_key: str = "seam_step",
    margin_periods: float = 8.0,
    engine_rate: float = ENGINE_SAMPLE_RATE,
) -> SampleResult:
    """Run the whole pipeline for one corpus entry."""
    notes: list[str] = []
    sample = ingest_file(entry.path, engine_rate)

    if entry.declared_sample_rate and entry.declared_sample_rate != sample.file_sample_rate:
        notes.append(
            f"dataset declares sample_rate={entry.declared_sample_rate} but the file is "
            f"{sample.file_sample_rate}; trusting the file"
        )

    track = track_pitch(sample.x, sample.sample_rate)
    features = measure_features(track)

    # Cross-check the declared root_note against the measured fundamental. This
    # changes nothing — every calculation downstream already uses the measured
    # period — but a silent disagreement is worth surfacing, because root_note is
    # what a human would reach for and 6 of the 26 corpus entries disagree with
    # the audio by more than 50 cents, four of them by exactly an octave.
    #
    # An octave disagreement is not necessarily a mislabelling: the loop
    # optimizer cares about the PERIOD OF REPETITION, which is what YIN measures
    # and what a loop must be quantised to, and that can legitimately be an
    # octave above the note a listener names.
    if entry.root_note is not None and math.isfinite(features.median_f0_hz):
        root_hz = 440.0 * 2.0 ** ((entry.root_note - 69) / 12.0)
        cents = 1200.0 * math.log2(features.median_f0_hz / root_hz)
        if abs(cents) > 50.0:
            octaves = cents / 1200.0
            shape = (
                f"{round(octaves):+d} octave(s)"
                if abs(octaves - round(octaves)) < 0.05
                else f"{cents:+.0f} cents"
            )
            notes.append(
                f"declared root_note={entry.root_note} ({root_hz:.2f} Hz) disagrees with the measured "
                f"{features.median_f0_hz:.2f} Hz by {shape}; analysis uses the measurement"
            )

    gold_engine = (
        entry.gold.to_engine(sample.file_sample_rate, sample.sample_rate) if entry.gold else None
    )

    window, sel_notes = _select_window(selection, track, sample, gold_engine, margin_periods)
    notes.extend(sel_notes)

    period = window.period if np.isfinite(window.period) else track.median_period()
    if not window.viable:
        notes.append(f"no viable search window ({window.reason or 'unspecified'})")
        return SampleResult(entry, sample, track, features, window, selection, period, [], None, notes)

    if gold_engine is not None and selection is Selection.AUTO:
        if not (window.start <= gold_engine.start and gold_engine.end <= window.end):
            notes.append(
                f"gold [{gold_engine.start},{gold_engine.end}) lies outside the detected window "
                f"[{window.start},{window.end}) — the tool cannot reach gold in this mode"
            )

    raw = generate_candidates(sample.x, period, window.start, window.end, sample.sample_rate)
    scored: list[ScoredCandidate] = []
    for cand in raw:
        cfg = cand.to_config()
        eff = resolve(cfg, sample.num_samples, sample.sample_rate)
        scored.append(
            ScoredCandidate(
                candidate=cand,
                metrics=measure(sample.x, cfg, period, sample.sample_rate),
                eff_xfade=eff.eff_xfade,
            )
        )
    ranked = rank_candidates(scored, rank_key)
    if not ranked:
        notes.append("no candidate cleared the seam-NCC floor")

    gold_cmp = None
    if gold_engine is not None:
        gold_cfg = LoopConfig(
            loop_start=gold_engine.start,
            loop_end=gold_engine.end,
            crossfade_samples=gold_engine.xfade,
        )
        gold_eff = resolve(gold_cfg, sample.num_samples, sample.sample_rate)
        gold_metrics = measure(sample.x, gold_cfg, period, sample.sample_rate)
        gold_advance = gold_metrics.wrap_advance

        best_rank = None
        best_points = None
        nearest_rank = None
        nearest_error = math.inf
        nearest_deltas = (float("nan"), float("nan"))
        for idx, sc in enumerate(ranked, start=1):
            if best_points is None and _points_match(sc, gold_engine, gold_advance, period):
                best_points = idx
            if best_rank is None and _matches_gold(sc, gold_engine, gold_advance, period):
                best_rank = idx
            d_start = sc.candidate.loop_start - gold_engine.start
            d_end = sc.candidate.loop_end - gold_engine.end
            error = max(abs(d_start), abs(d_end))
            if error < nearest_error:
                nearest_error = error
                nearest_rank = idx
                nearest_deltas = (d_start / period, d_end / period) if period > 0 else (float("nan"),) * 2

        top = ranked[0] if ranked else None
        winners = {}
        if top is not None:
            for name in METRIC_NAMES:
                winners[name] = _compare_metric(
                    name, getattr(top.metrics, name), getattr(gold_metrics, name)
                )

        better = {
            name: sum(
                1
                for sc in ranked
                if _compare_metric(name, getattr(sc.metrics, name), getattr(gold_metrics, name)) == "tool"
            )
            for name in METRIC_NAMES
        }

        gold_cmp = GoldComparison(
            gold_engine=gold_engine,
            gold_metrics=gold_metrics,
            gold_eff_xfade=gold_eff.eff_xfade,
            top_matches=bool(top is not None and _matches_gold(top, gold_engine, gold_advance, period)),
            top_points_match=bool(top is not None and _points_match(top, gold_engine, gold_advance, period)),
            top_xfade_match=bool(top is not None and _xfade_match(top, gold_engine)),
            best_matching_rank=best_rank,
            best_points_rank=best_points,
            nearest_rank=nearest_rank,
            nearest_start_delta_periods=nearest_deltas[0],
            nearest_end_delta_periods=nearest_deltas[1],
            start_delta_periods=(
                (top.candidate.loop_start - gold_engine.start) / period if top and period > 0 else float("nan")
            ),
            end_delta_periods=(
                (top.candidate.loop_end - gold_engine.end) / period if top and period > 0 else float("nan")
            ),
            xfade_ratio=_xfade_ratio(top.eff_xfade, gold_engine.xfade) if top else float("nan"),
            metric_winners=winners,
            candidates_better_than_gold=better,
            candidate_count=len(ranked),
        )

    return SampleResult(entry, sample, track, features, window, selection, period, ranked, gold_cmp, notes)
