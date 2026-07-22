"""Command line entry point: ``python -m loop_optimizer report --corpus <dir>``."""

from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import asdict
from pathlib import Path

from .analysis import METRIC_NAMES, PERCEPTUAL_RANK_KEY, Selection, analyse_entry
from .corpus import load_dataset, write_dataset_with_features
from .export import build_payload
from .report import format_report
from .validate import evaluate_trials, format_validation


def _json_safe(obj):
    """Recursively replace non-finite floats with None so json.dump succeeds."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _result_to_json(result) -> dict:
    top = result.top
    gold = result.gold
    return _json_safe(
        {
            "sample_id": result.entry.sample_id,
            "file": str(result.entry.path),
            "class": result.entry.sample_class,
            "behavior_family": result.entry.behavior_family,
            "root_note": result.entry.root_note,
            "selection": result.selection.value,
            "window": {
                "start": result.window.start,
                "end": result.window.end,
                "period": result.period,
                "viable": result.window.viable,
                "reason": result.window.reason,
            },
            "measured_features": result.features.as_dict(),
            "num_candidates": len(result.ranked),
            "top_candidate": (
                {
                    "loop_start": top.candidate.loop_start,
                    "loop_end": top.candidate.loop_end,
                    "crossfade_requested": top.candidate.crossfade_samples,
                    "crossfade_effective": top.eff_xfade,
                    "period_multiple": top.candidate.period_multiple,
                    "search_ncc": top.candidate.search_ncc,
                    "metrics": top.metrics.as_dict(),
                }
                if top
                else None
            ),
            "gold": (
                {
                    "engine_domain": asdict(gold.gold_engine),
                    "effective_xfade": gold.gold_eff_xfade,
                    "metrics": gold.gold_metrics.as_dict(),
                    "top_matches": gold.top_matches,
                    "best_matching_rank": gold.best_matching_rank,
                    "start_delta_periods": gold.start_delta_periods,
                    "end_delta_periods": gold.end_delta_periods,
                    "xfade_ratio": gold.xfade_ratio,
                    "metric_winners": gold.metric_winners,
                }
                if gold
                else None
            ),
            "notes": result.notes,
        }
    )


def _analyse_corpus(args: argparse.Namespace):
    """Shared front half of every command: load, filter, analyse.

    Returns ``(results, rows, dataset_path)``, or ``None`` when the run has
    nothing to say — the caller turns that into exit code 2.
    """
    entries, rows, dataset_path = load_dataset(args.corpus)
    if args.only:
        wanted = set(args.only)
        entries = [e for e in entries if e.sample_id in wanted]
        if not entries:
            print(f"no sample matched {sorted(wanted)}", file=sys.stderr)
            return None

    results = []
    for entry in entries:
        if not entry.path.exists():
            print(f"SKIP {entry.sample_id}: missing audio at {entry.path}", file=sys.stderr)
            continue
        if args.progress:
            print(f"... {entry.sample_id}", file=sys.stderr, flush=True)
        results.append(
            analyse_entry(
                entry,
                selection=Selection(args.selection),
                rank_key=args.rank_by,
                margin_periods=args.margin_periods,
            )
        )

    if not results:
        print("no analysable samples", file=sys.stderr)
        return None
    return results, rows, dataset_path


def cmd_report(args: argparse.Namespace) -> int:
    analysed = _analyse_corpus(args)
    if analysed is None:
        return 2
    results, rows, dataset_path = analysed

    print(format_report(results, args.rank_by, detail=not args.summary_only))

    if args.json:
        payload = {
            "dataset": str(dataset_path),
            "selection": args.selection,
            "rank_by": args.rank_by,
            "samples": [_result_to_json(r) for r in results],
        }
        Path(args.json).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote JSON results to {args.json}", file=sys.stderr)

    if args.write_features:
        features = {r.entry.sample_id: _json_safe(r.features.as_dict()) for r in results}
        out = write_dataset_with_features(rows, features, args.write_features)
        print(f"wrote dataset copy with measured_features to {out}", file=sys.stderr)

    return 0


def cmd_export(args: argparse.Namespace) -> int:
    analysed = _analyse_corpus(args)
    if analysed is None:
        return 2
    results, _rows, dataset_path = analysed

    payload = _json_safe(build_payload(results, dataset_path, args.selection, args.rank_by, args.top_k))
    out = Path(args.out) if args.out else Path(dataset_path).parent / "candidates.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    arms = sum(len(s["arms"]) for s in payload["samples"])
    print(f"wrote {len(payload['samples'])} samples / {arms} arms to {out}")
    for s in payload["samples"]:
        for note in s["notes"]:
            print(f"  {s['sample_id']}: {note}", file=sys.stderr)
    return 0


def _add_corpus_args(p: argparse.ArgumentParser) -> None:
    """Options shared by every command that analyses a corpus."""
    p.add_argument(
        "--corpus",
        required=True,
        help="directory holding dataset.json (or the path to dataset.json itself)",
    )
    p.add_argument(
        "--selection",
        choices=[s.value for s in Selection],
        default=Selection.AUTO.value,
        help=(
            "where to search for loops. 'auto' detects the steady-state window and so also "
            "tests region selection; 'gold' searches the gold region +/- a margin and isolates "
            "the loop-point question; 'full' searches the whole file. (default: auto)"
        ),
    )
    p.add_argument(
        "--margin-periods",
        type=float,
        default=8.0,
        help="margin around the gold region for --selection gold, in periods (default: 8)",
    )
    p.add_argument(
        "--rank-by",
        choices=[PERCEPTUAL_RANK_KEY] + list(METRIC_NAMES) + ["search_ncc"],
        default=PERCEPTUAL_RANK_KEY,
        help=(
            "how to order candidates. 'perceptual' (the default) collapses the perceptual "
            "suite with perceptual_cost, which after validation against 36 blind A/B verdicts "
            "means ranking on `click` - see RANKING_METRICS in perceptual.py for why a single "
            "metric beat the composite. Naming one metric instead orders by it alone, which is "
            "how the FIRST suite worked and how it went wrong: its default, seam_step, scores "
            "AUC 0.21 against the verdicts, i.e. significantly anti-correlated. "
            f"(default: {PERCEPTUAL_RANK_KEY})"
        ),
    )
    p.add_argument("--only", nargs="+", metavar="SAMPLE_ID", help="restrict to these sample ids")
    p.add_argument("--progress", action="store_true", help="log each sample id to stderr as it runs")


def cmd_validate(args: argparse.Namespace) -> int:
    trials = evaluate_trials(args.corpus, args.candidates, progress=args.progress)
    if not trials:
        print("no trials could be evaluated (need ratings.jsonl + candidates.json)", file=sys.stderr)
        return 2
    print(format_validation(trials, rule=args.rule))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m loop_optimizer",
        description=(
            "XLETH auto-loop-optimizer lab. Generates candidate loops for monophonic tonal "
            "samples, scores them on an emulation of the real sampler render path, and "
            "evaluates them against a gold-labelled corpus. Measurement only: no tuning, "
            "no thresholds, no auto-apply."
        ),
    )
    sub = parser.add_subparsers(dest="command", required=True)

    rep = sub.add_parser("report", help="analyse a corpus and print the per-sample + aggregate report")
    _add_corpus_args(rep)
    rep.add_argument("--summary-only", action="store_true", help="omit the per-sample detail blocks")
    rep.add_argument("--json", metavar="PATH", help="also write full results as JSON")
    rep.add_argument(
        "--write-features",
        metavar="PATH",
        help="write a COPY of dataset.json with measured_features filled in (never in place)",
    )
    rep.set_defaults(func=cmd_report)

    exp = sub.add_parser(
        "export",
        help="write candidates.json (top-K + gold + naive arms) for the Loop Lab blind A/B rater",
        description=(
            "Write the arms the blind A/B rater auditions: per sample, the top-K optimizer "
            "candidates, the gold loop, and one deliberately period-unaligned naive anchor. "
            "Loop points are in FILE-domain samples, matching dataset.json. Deterministic: "
            "re-running on the same corpus reproduces the same file."
        ),
    )
    _add_corpus_args(exp)
    exp.add_argument(
        "--top-k",
        type=int,
        default=3,
        help="how many ranked optimizer candidates to export per sample (default: 3)",
    )
    exp.add_argument(
        "--out",
        metavar="PATH",
        help="destination (default: candidates.json beside dataset.json)",
    )
    exp.set_defaults(func=cmd_export)

    val = sub.add_parser(
        "validate",
        help="score the redesigned metric suite against the recorded blind A/B verdicts",
        description=(
            "Replay every trial in ratings.jsonl, score both arms with the old and the new "
            "suite, and report concordance with the listeners, per-metric discriminative "
            "power, and what the content-free baselines score on the same trials."
        ),
    )
    val.add_argument("--corpus", required=True, help="corpus directory (holding ratings.jsonl)")
    val.add_argument("--candidates", metavar="PATH", help="candidates.json (default: beside the corpus)")
    val.add_argument("--rule", choices=["max", "sum", "rms"], default="max",
                     help="how perceptual_cost collapses the suite (default: max)")
    val.add_argument("--progress", action="store_true", help="log ingest progress to stdout")
    val.set_defaults(func=cmd_validate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
