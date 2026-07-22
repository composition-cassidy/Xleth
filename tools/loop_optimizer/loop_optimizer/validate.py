"""Validation against the blind A/B verdicts — the acceptance test for the ruler.

A metric suite that cannot be checked against ears is decoration. This module
replays the 36 recorded trials, scores both arms of each with both suites, and
reports whether the redesigned one agrees with the listeners where the old one
did not.

Three things are reported, and the second and third exist to stop the first from
being believed too easily:

CONCORDANCE
    Per trial, does the suite rank the arm the listener preferred above the one
    they rejected? Reported per sample, with regressions shown rather than
    summarised away.

BASELINES
    What a rule with no perceptual content scores on the same trials. "Prefer
    the longer loop" and "prefer the smaller crossfade" are the two obvious
    confounds: if either matches the listeners as well as the suite does, the
    suite has not earned its complexity. (It does not — see the report.)

PER-METRIC DISCRIMINATIVE POWER
    Which individual metrics separate the preferred arm from the rejected one.
    Computed PAIRED, within trial, which is the only correct way here: the 130
    arms are not 130 independent observations, because gold appears in all 36
    trials and only two arms per trial were ever heard. An unpaired
    Mann-Whitney over "all arms" would count the same gold arm dozens of times
    and report a confidence the data does not support. The paired statistic is
    equivalent to AUC over the trials, and its exact sign-test p-value is
    reported beside it.

With 26 optimizer trials there is not enough data to fit anything. Nothing in
:mod:`loop_optimizer.perceptual` is tuned here; this module only measures.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .corpus import CorpusEntry, load_dataset
from .engine_emu import LoopConfig
from .ingest import IngestedSample, ingest_file
from .metrics import measure as measure_old
from .perceptual import (
    METRIC_NAMES,
    RANKING_METRICS,
    PerceptualMetrics,
    SourceReference,
    measure_perceptual,
    perceptual_cost,
    source_reference,
)
from .pitch import track_pitch

RATINGS_FILENAME = "ratings.jsonl"


@dataclass
class ArmEval:
    arm_id: str
    provenance: str
    cfg: LoopConfig
    new: PerceptualMetrics
    old_seam_step: float
    advance: int
    xfade: int


@dataclass
class TrialEval:
    trial_id: str
    sample_id: str
    kind: str
    winner_arm_id: str | None  # None == tie
    loser_arm_id: str | None
    failure_tags: list[str]
    arms: dict[str, ArmEval]

    @property
    def decided(self) -> bool:
        return self.winner_arm_id is not None


def load_ratings(corpus_dir: str | Path) -> list[dict]:
    """Read ratings.jsonl from the corpus directory. Tolerates a torn last line."""
    root = Path(corpus_dir)
    path = root if root.is_file() else root / RATINGS_FILENAME
    if not path.exists():
        raise FileNotFoundError(f"no {RATINGS_FILENAME} at {path}")
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict) and "trial_id" in rec:
            out.append(rec)
    return out


def _cfg_from_file_loop(loop: dict, file_rate: float, sample: IngestedSample) -> LoopConfig:
    """candidates.json is FILE-domain; the engine indexes the engine domain."""
    return LoopConfig(
        loop_start=int(round(sample.file_to_engine(loop["start"]))),
        loop_end=int(round(sample.file_to_engine(loop["end"]))),
        crossfade_samples=int(round(sample.file_to_engine(loop["xfade"]))),
    )


def evaluate_trials(
    corpus_dir: str | Path,
    candidates_path: str | Path | None = None,
    progress: bool = False,
) -> list[TrialEval]:
    """Score both arms of every recorded trial with both suites."""
    root = Path(corpus_dir)
    base = root if root.is_dir() else root.parent
    cand_path = Path(candidates_path) if candidates_path else base / "candidates.json"
    doc = json.loads(Path(cand_path).read_text(encoding="utf-8"))
    by_sample = {s["sample_id"]: s for s in doc["samples"]}

    entries, _rows, _ds = load_dataset(base)
    entry_by_id: dict[str, CorpusEntry] = {e.sample_id: e for e in entries}

    ratings = load_ratings(base)
    wanted = sorted({r["sample_id"] for r in ratings})

    cache: dict[str, tuple[IngestedSample, float]] = {}
    for sid in wanted:
        entry = entry_by_id.get(sid)
        if entry is None or not entry.path.exists():
            continue
        if progress:
            print(f"... ingest {sid}", flush=True)
        smp = ingest_file(entry.path)
        cache[sid] = (smp, track_pitch(smp.x, smp.sample_rate).median_period())

    trials: list[TrialEval] = []
    for rec in ratings:
        sid = rec["sample_id"]
        if sid not in cache or sid not in by_sample:
            continue
        smp, period = cache[sid]
        sample_doc = by_sample[sid]
        arms: dict[str, ArmEval] = {}
        for arm_id in rec["arm_order"]:
            arm = next((a for a in sample_doc["arms"] if a["arm_id"] == arm_id), None)
            if arm is None:
                continue
            cfg = _cfg_from_file_loop(arm["loop"], sample_doc["file_sample_rate"], smp)
            new = measure_perceptual(smp.x, cfg, period, smp.sample_rate)
            old = measure_old(smp.x, cfg, period, smp.sample_rate)
            arms[arm_id] = ArmEval(
                arm_id=arm_id,
                provenance=arm["provenance"],
                cfg=cfg,
                new=new,
                old_seam_step=old.seam_step,
                advance=new.wrap_advance,
                xfade=new.eff_xfade,
            )
        if len(arms) != 2:
            continue
        trials.append(
            TrialEval(
                trial_id=rec["trial_id"],
                sample_id=sid,
                kind=rec["kind"],
                winner_arm_id=rec.get("winner_arm_id"),
                loser_arm_id=rec.get("loser_arm_id"),
                failure_tags=list(rec.get("failure_tags") or []),
                arms=arms,
            )
        )
    return trials


# ── Scoring rules under test ────────────────────────────────────────────────


def _prefers(trial: TrialEval, score, lower_is_better: bool = True) -> float:
    """1.0 if the rule agrees with the listener, 0.0 if it disagrees, 0.5 if tied.

    A NaN for either arm is 0.5, not a free pass: an undefined metric expresses
    no preference and should score as a coin flip rather than be dropped from
    the denominator, which would flatter metrics that are frequently undefined.
    """
    if not trial.decided:
        return float("nan")
    w = score(trial.arms[trial.winner_arm_id])
    l = score(trial.arms[trial.loser_arm_id])
    if not (np.isfinite(w) and np.isfinite(l)):
        return 0.5
    if w == l:
        return 0.5
    better = (w < l) if lower_is_better else (w > l)
    return 1.0 if better else 0.0


def _binomial_sign_p(agree: float, n: int) -> float:
    """Two-sided exact sign-test p-value for `agree` successes out of n.

    Half-credit ties are rounded to the nearest whole success, which is the
    conservative direction (it can only move the count toward chance).
    """
    if n == 0:
        return float("nan")
    k = int(round(agree))
    k = min(k, n - k)
    tail = sum(math.comb(n, i) for i in range(0, k + 1))
    return min(1.0, 2.0 * tail / (2.0 ** n))


def metric_scorers() -> dict:
    """Every per-metric rule under test, plus the confound baselines."""
    scorers = {}
    for name in METRIC_NAMES:
        scorers[name] = (lambda a, n=name: abs(float(getattr(a.new, n))), True)
    # Diagnostic sub-terms.
    for name in ("click_boundary", "click_fade_spike", "click_flux_offset",
                 "hollow_dip_db", "hollow_corr_db", "timbre_body_fade", "timbre_source_dev"):
        scorers[f"  .{name}"] = (lambda a, n=name: abs(float(getattr(a.new, n))), True)
    # The old ruler, as the thing being replaced.
    scorers["OLD seam_step"] = (lambda a: abs(float(a.old_seam_step)), True)
    # Confounds with no perceptual content.
    scorers["BASE longer advance"] = (lambda a: float(a.advance), False)
    scorers["BASE smaller fade frac"] = (
        lambda a: float(a.xfade) / a.advance if a.advance > 0 else float("nan"), True)
    scorers["BASE lower loop rate"] = (lambda a: float(a.advance), False)
    return scorers


def concordance(trials: list[TrialEval], score, lower_is_better: bool = True) -> tuple[float, int]:
    """(agreements, decided trials) for one scoring rule."""
    vals = [_prefers(t, score, lower_is_better) for t in trials if t.decided]
    vals = [v for v in vals if np.isfinite(v)]
    return (float(sum(vals)), len(vals))


def format_validation(trials: list[TrialEval], rule: str = "max") -> str:
    """The report. ASCII only — it has to survive a cp1252 console."""
    out: list[str] = []
    w = out.append

    decided = [t for t in trials if t.decided]
    opt = [t for t in trials if t.kind == "optimizer"]
    # `policy` (round 3) and `policy_v2` (round 4) are the selection-first
    # challenger kinds (see loopLabRater.js's CHALLENGER_PROVENANCES and
    # export.policy_loop / policy_v2_loop). A document carries `optimizer`
    # trials, one of the policy kinds, or a mix, never none, so both buckets are
    # always computed even though one is typically empty. Matched by prefix so a
    # later generation does not silently fall out of the report — an arm missing
    # from every bucket would be counted in the overall figure and nowhere else.
    policy = [t for t in trials if t.kind.startswith("policy")]
    anchor = [t for t in trials if t.kind == "naive"]

    w("=" * 100)
    w("PERCEPTUAL SUITE VALIDATION vs %d BLIND A/B VERDICTS" % len(trials))
    w("=" * 100)
    w("")
    w("The old suite ranked candidates by seam_step. The wrap is continuous by")
    w("construction, so that metric was measuring round-off; this is what replacing it")
    w("with a fade-zone-referenced suite does to agreement with the listeners.")
    w("")

    # ── Per-sample detail ──
    w("-" * 100)
    w("PER-TRIAL  (cost = worst metric / its audibility reference; lower is better)")
    w("-" * 100)
    w("%-26s %-6s %-11s %9s %9s  %-4s %-4s  %s" % (
        "sample", "kind", "listener", "cost(win)", "cost(lose)", "new", "old", "tags"))
    for t in sorted(trials, key=lambda x: (x.kind, x.sample_id)):
        if not t.decided:
            w("%-26s %-6s %-11s %9s %9s  %-4s %-4s  %s" % (
                t.sample_id, t.kind, "tie", "-", "-", "-", "-", ",".join(t.failure_tags)))
            continue
        cw = perceptual_cost(t.arms[t.winner_arm_id].new, rule)
        cl = perceptual_cost(t.arms[t.loser_arm_id].new, rule)
        new_ok = _prefers(t, lambda a: perceptual_cost(a.new, rule))
        old_ok = _prefers(t, lambda a: abs(float(a.old_seam_step)))
        mark = {1.0: "OK", 0.0: "MISS", 0.5: "tie"}
        w("%-26s %-6s %-11s %9.2f %9.2f  %-4s %-4s  %s" % (
            t.sample_id, t.kind, t.winner_arm_id, cw, cl,
            mark.get(new_ok, "?"), mark.get(old_ok, "?"), ",".join(t.failure_tags)))
    w("")

    # ── Concordance ──
    w("-" * 100)
    w("CONCORDANCE")
    w("-" * 100)
    groups = [("all decided trials", decided),
              ("optimizer vs gold", [t for t in opt if t.decided]),
              ("policy vs gold", [t for t in policy if t.decided]),
              ("naive anchors", [t for t in anchor if t.decided])]
    w("%-24s %14s %14s" % ("", "NEW suite", "OLD seam_step"))
    for label, group in groups:
        if not group:
            continue
        na, nn = concordance(group, lambda a: perceptual_cost(a.new, rule))
        oa, on = concordance(group, lambda a: abs(float(a.old_seam_step)))
        w("%-24s %8.1f/%-5d %8.1f/%-5d" % (label, na, nn, oa, on))
    na, nn = concordance(decided, lambda a: perceptual_cost(a.new, rule))
    w("")
    w("  new suite p (sign test, all decided) = %.4g" % _binomial_sign_p(na, nn))
    w("")
    w("  Collapsing rule sensitivity (does the answer depend on how the metrics are combined?)")
    for r in ("max", "sum", "rms"):
        a, n = concordance(decided, lambda arm, rr=r: perceptual_cost(arm.new, rr))
        w("    rule=%-4s  %.1f/%d" % (r, a, n))
    w("")
    w("  Which metrics to rank on. THIS TABLE WAS COMPUTED ON THESE TRIALS, so it is a")
    w("  disclosure and not evidence about them; the second blind round is the held-out")
    w("  test. The composite scoring worse than its own best term is the reason the")
    w("  default is a single metric - see RANKING_METRICS in perceptual.py.")
    w("    %-28s %10s %10s %9s" % ("subset", "all", "optimizer", "anchors"))
    subsets = [
        ("click alone", ("click",)),
        ("max(click, cents)", ("click", "cents_err_per_loop")),
        ("max(click, cents, timbre)", ("click", "cents_err_per_loop", "timbre_jump")),
        ("all seven", METRIC_NAMES),
        ("RANKING_METRICS (default)", RANKING_METRICS),
    ]
    opt_d = [t for t in opt if t.decided]
    anc_d = [t for t in anchor if t.decided]
    for label, subset in subsets:
        f = lambda arm, s=subset: perceptual_cost(arm.new, rule, s)
        a, n = concordance(decided, f)
        ao, no = concordance(opt_d, f)
        aa, na = concordance(anc_d, f)
        w("    %-28s %5.1f/%-4d %5.1f/%-4d %4.1f/%-4d" % (label, a, n, ao, no, aa, na))
    w("")

    # ── The confound ──
    w("-" * 100)
    w("BEYOND THE CONFOUND")
    w("-" * 100)
    w("'Prefer the longer crossfade' is the strongest content-free rule available and it")
    w("matches most of the verdicts on its own. A suite that only reproduces it has")
    w("learned nothing, so the question is what happens on the trials where it is WRONG.")
    w("")
    xa, xn = concordance(decided, lambda a: float(a.xfade), False)
    w("  BASE longer crossfade (ms)   %.1f/%d = %.3f" % (xa, xn, xa / xn if xn else float("nan")))
    right = [t for t in decided if _prefers(t, lambda a: float(a.xfade), False) == 1.0]
    wrong = [t for t in decided if _prefers(t, lambda a: float(a.xfade), False) == 0.0]
    for label, group in (("where the confound is RIGHT", right),
                         ("where the confound is WRONG", wrong)):
        if not group:
            continue
        a, n = concordance(group, lambda arm: perceptual_cost(arm.new, rule))
        w("  new suite %-28s %.1f/%d" % (label, a, n))
    w("")

    # ── Per-metric discriminative power ──
    w("-" * 100)
    w("PER-METRIC DISCRIMINATIVE POWER  (paired within trial; 0.5 = chance, 1.0 = perfect)")
    w("-" * 100)
    w("A metric scoring well BELOW 0.5 is not useless - it is anti-correlated, i.e. it is")
    w("measuring something real with the sign flipped. Both are reported as found.")
    w("")
    w("%-26s %10s %8s %8s   %s" % ("rule", "agree/n", "AUC", "p", "verdict"))
    rows = []
    for name, (fn, lower) in metric_scorers().items():
        a, n = concordance(decided, fn, lower)
        auc = a / n if n else float("nan")
        rows.append((name, a, n, auc, _binomial_sign_p(a, n)))
    for name, a, n, auc, p in rows:
        if not np.isfinite(auc):
            verdict = "undefined"
        elif p < 0.05 and auc > 0.5:
            verdict = "DISCRIMINATES"
        elif p < 0.05 and auc < 0.5:
            verdict = "ANTI-correlated"
        else:
            verdict = "chance"
        w("%-26s %5.1f/%-4d %8.3f %8.4g   %s" % (name, a, n, auc, p, verdict))
    w("")

    # ── Tag-conditioned check ──
    w("-" * 100)
    w("TAG-CONDITIONED: does the metric named after a tag fire when listeners used it?")
    w("-" * 100)
    w("Restricted to trials carrying that tag. The metric is checked on the LOSING arm,")
    w("which is the arm the tag describes.")
    w("")
    w("%-14s %6s %10s %10s   %s" % ("tag", "trials", "loser", "winner", "separation"))
    tag_to_metric = {"click": "click", "hollow": "hollow", "wobble": "wobble",
                     "chorusing": "chorusing", "flam": "flam", "timbre-jump": "timbre_jump"}
    for tag, metric in tag_to_metric.items():
        tagged = [t for t in decided if tag in t.failure_tags]
        if not tagged:
            w("%-14s %6d %10s %10s   %s" % (tag, 0, "-", "-", "no trials"))
            continue
        lose = [abs(float(getattr(t.arms[t.loser_arm_id].new, metric))) for t in tagged]
        win = [abs(float(getattr(t.arms[t.winner_arm_id].new, metric))) for t in tagged]
        lose = [v for v in lose if np.isfinite(v)]
        win = [v for v in win if np.isfinite(v)]
        if not lose or not win:
            w("%-14s %6d %10s %10s   %s" % (tag, len(tagged), "-", "-", "undefined"))
            continue
        ml, mw = float(np.median(lose)), float(np.median(win))
        sep = "loser worse" if ml > mw else ("winner worse" if mw > ml else "equal")
        w("%-14s %6d %10.3f %10.3f   %s" % (tag, len(tagged), ml, mw, sep))
    w("")
    return "\n".join(out)
