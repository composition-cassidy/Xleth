"""Text rendering of corpus results.

Plain text on purpose: this output is meant to be diffed between runs and pasted
into a commit message or an issue, so it must not depend on terminal width,
colour support or a table library.
"""

from __future__ import annotations

import math
from collections import Counter

from .analysis import METRIC_NAMES, SampleResult


def _num(value: float, width: int = 8, places: int = 3) -> str:
    if value is None or not math.isfinite(float(value)):
        return "-".rjust(width)
    return f"{float(value):{width}.{places}f}"


def _rule(char: str = "-", width: int = 118) -> str:
    return char * width


def format_sample_row(result: SampleResult) -> str:
    """One line per sample for the summary table."""
    sid = result.entry.sample_id[:26].ljust(26)
    f0 = result.features.median_f0_hz
    top = result.top

    if top is None:
        return f"{sid} f0={_num(f0, 7, 1)}Hz  " + "no candidates".ljust(60)

    m = top.metrics
    match = "-"
    if result.gold is not None:
        if result.gold.top_matches:
            match = "MATCH"
        elif result.gold.best_matching_rank is not None:
            match = f"@#{result.gold.best_matching_rank}"
        else:
            match = "miss"

    return (
        f"{sid} f0={_num(f0, 7, 1)}Hz "
        f"k={top.candidate.period_multiple:<4d} "
        f"loop=[{top.candidate.loop_start:>7d},{top.candidate.loop_end:>7d}) "
        f"xf={top.eff_xfade:>6d} "
        f"click={_num(m.click, 7, 3)} "
        f"timb={_num(m.timbre_jump, 6, 2)} "
        f"cents={_num(m.cents_err_per_loop, 7, 2)} "
        f"{match:>6}"
    )


def format_sample_detail(result: SampleResult) -> str:
    """Full per-sample block: features, window, top candidate, gold comparison."""
    e = result.entry
    f = result.features
    lines: list[str] = []
    lines.append(_rule("="))
    lines.append(f"{e.sample_id}   [{e.sample_class} / {e.behavior_family}]")
    lines.append(_rule())

    root = e.root_note if e.root_note is not None else "-"
    lines.append(
        f"  material   f0={f.median_f0_hz:.2f} Hz (T={f.median_period_samples:.2f} smp)   "
        f"root_note={root}   off-ET={_num(f.cents_from_equal_temperament, 6, 1)} cents"
    )
    lines.append(
        f"             f0 jitter={_num(f.f0_cents_std, 5, 1)} cents (tonal hops)   "
        f"octave outliers={f.octave_outlier_fraction:.2f}   voiced={f.voiced_fraction:.2f}   "
        f"clarity={_num(f.median_clarity, 5, 3)}   decay={_num(f.decay_slope_db_per_sec, 6, 1)} dB/s"
    )
    lines.append(
        f"  ingest     file {result.sample.file_sample_rate} Hz x{result.sample.file_num_channels}ch "
        f"({result.sample.file_num_frames} smp)  ->  engine {result.sample.sample_rate:.0f} Hz "
        f"({result.sample.num_samples} smp)"
    )
    lines.append(
        f"  window     {result.selection.value}: [{result.window.start}, {result.window.end}) "
        f"= {result.window.length} smp, T={result.period:.2f}"
        + (f"   ({result.window.reason})" if result.window.reason else "")
    )
    lines.append(f"  candidates {len(result.ranked)}")

    for note in result.notes:
        lines.append(f"  NOTE       {note}")

    if result.top is not None:
        top = result.top
        lines.append("")
        lines.append("             " + "  ".join(f"{n:>18}" for n in METRIC_NAMES))
        lines.append(
            "  top        "
            + "  ".join(f"{_num(getattr(top.metrics, n), 18, 4)}" for n in METRIC_NAMES)
        )
        if result.gold is not None:
            g = result.gold
            lines.append(
                "  gold       "
                + "  ".join(f"{_num(getattr(g.gold_metrics, n), 18, 4)}" for n in METRIC_NAMES)
            )
            lines.append(
                "  winner     "
                + "  ".join(f"{g.metric_winners.get(n, 'n/a'):>18}" for n in METRIC_NAMES)
            )
            lines.append(
                "  beat gold  "
                + "  ".join(
                    f"{str(g.candidates_better_than_gold.get(n, 0)) + '/' + str(g.candidate_count):>18}"
                    for n in METRIC_NAMES
                )
            )
            lines.append("")
            lines.append(
                f"  top loop   [{top.candidate.loop_start}, {top.candidate.loop_end}) "
                f"xfade={top.eff_xfade} (requested {top.candidate.crossfade_samples})  "
                f"k={top.candidate.period_multiple}  advance={top.metrics.wrap_advance}"
            )
            lines.append(
                f"  gold loop  [{g.gold_engine.start}, {g.gold_engine.end}) "
                f"xfade={g.gold_eff_xfade} (file-domain {result.entry.gold.xfade})  "
                f"advance={g.gold_metrics.wrap_advance}"
            )
            verdict = (
                "top candidate MATCHES gold"
                if g.top_matches
                else (
                    f"top candidate misses; best matching candidate is rank #{g.best_matching_rank}"
                    if g.best_matching_rank is not None
                    else "NO candidate matches gold within tolerance"
                )
            )
            lines.append(
                f"  vs gold    d_start={g.start_delta_periods:+.2f} periods  "
                f"d_end={g.end_delta_periods:+.2f} periods  "
                f"xfade ratio={'inf' if math.isinf(g.xfade_ratio) else f'{g.xfade_ratio:.2f}'}x  "
                f"(points {'ok' if g.top_points_match else 'miss'}, "
                f"xfade {'ok' if g.top_xfade_match else 'miss'})"
            )
            if g.nearest_rank is not None:
                lines.append(
                    f"  nearest    rank #{g.nearest_rank}: d_start={g.nearest_start_delta_periods:+.2f} "
                    f"d_end={g.nearest_end_delta_periods:+.2f} periods "
                    "(closest candidate to gold at any rank)"
                )
            if g.best_points_rank is not None and g.best_matching_rank is None:
                lines.append(
                    f"             loop POINTS matched at rank #{g.best_points_rank}; "
                    "only the crossfade variants missed"
                )
            lines.append(f"             {verdict}")

    return "\n".join(lines)


def format_aggregate(results: list[SampleResult], rank_key: str) -> str:
    """Corpus-level summary."""
    lines: list[str] = []
    lines.append(_rule("="))
    lines.append("AGGREGATE")
    lines.append(_rule())

    with_gold = [r for r in results if r.gold is not None]
    analysed = [r for r in results if r.ranked]

    lines.append(f"  samples                    {len(results)}")
    lines.append(f"  with a gold loop           {len(with_gold)}")
    lines.append(f"  produced candidates        {len(analysed)}")
    lines.append(f"  ranked by                  {rank_key}  (untuned placeholder ordering)")

    if with_gold:
        top_match = sum(1 for r in with_gold if r.gold.top_matches)
        any_match = sum(1 for r in with_gold if r.gold.best_matching_rank is not None)
        lines.append("")
        lines.append(
            f"  top-1 matches gold         {top_match}/{len(with_gold)} "
            f"({100.0 * top_match / len(with_gold):.0f}%)"
        )
        lines.append(
            f"  some candidate matches     {any_match}/{len(with_gold)} "
            f"({100.0 * any_match / len(with_gold):.0f}%)"
        )
        ranks = [r.gold.best_matching_rank for r in with_gold if r.gold.best_matching_rank]
        if ranks:
            lines.append(
                f"  rank of first match        median {sorted(ranks)[len(ranks) // 2]}, worst {max(ranks)}"
            )

        # Loop points and crossfade separately: a tool that finds the right loop
        # but offers the wrong fade width has a different problem from one that
        # cannot find the loop, and the combined number cannot tell them apart.
        points_top = sum(1 for r in with_gold if r.gold.top_points_match)
        points_any = sum(1 for r in with_gold if r.gold.best_points_rank is not None)
        xfade_top = sum(1 for r in with_gold if r.gold.top_xfade_match)
        lines.append("")
        lines.append(f"  top-1 loop POINTS match    {points_top}/{len(with_gold)}")
        lines.append(f"  some candidate's POINTS    {points_any}/{len(with_gold)}")
        lines.append(f"  top-1 crossfade within 2x  {xfade_top}/{len(with_gold)}")

        nearest = [
            max(abs(r.gold.nearest_start_delta_periods), abs(r.gold.nearest_end_delta_periods))
            for r in with_gold
            if r.gold.nearest_rank is not None
            and math.isfinite(r.gold.nearest_start_delta_periods)
        ]
        if nearest:
            nearest.sort()
            lines.append(
                f"  closest candidate to gold  median {nearest[len(nearest) // 2]:.2f} periods off, "
                f"best {nearest[0]:.2f}, worst {nearest[-1]:.2f}"
            )

        excluded = sum(
            1 for r in with_gold if any("lies outside the detected window" in n for n in r.notes)
        )
        if excluded:
            lines.append(
                f"  gold outside search window {excluded}  "
                "(region selection, not loop scoring - rerun with --selection gold to separate them)"
            )

        lines.append("")
        lines.append("  per-metric wins, tool vs gold (calibration signal - gold winning is expected):")
        lines.append(
            "  'beat gold' is the share of ALL candidates that beat gold on that metric - a high"
        )
        lines.append(
            "  share means the metric rules bad loops out but does not pick one, i.e. it is flat.")
        for name in METRIC_NAMES:
            counts = Counter(
                r.gold.metric_winners.get(name, "n/a") for r in with_gold if r.gold.metric_winners
            )
            beat = sum(r.gold.candidates_better_than_gold.get(name, 0) for r in with_gold)
            total = sum(r.gold.candidate_count for r in with_gold)
            share = f"{100.0 * beat / total:.0f}%" if total else "-"
            lines.append(
                f"    {name:<20} tool {counts.get('tool', 0):>3}   gold {counts.get('gold', 0):>3}   "
                f"tie {counts.get('tie', 0):>3}   n/a {counts.get('n/a', 0):>3}   "
                f"beat gold {beat:>6}/{total:<6} ({share})"
            )

    root_disagree = sum(1 for r in results if any("disagrees with the measured" in n for n in r.notes))
    if root_disagree:
        lines.append("")
        lines.append(
            f"  root_note disagreements    {root_disagree}/{len(results)} by more than 50 cents "
            "(analysis always uses the measurement)"
        )

    notes = [n for r in results for n in r.notes]
    if notes:
        lines.append("")
        lines.append(f"  notes raised               {len(notes)} (see per-sample detail)")

    return "\n".join(lines)


def format_report(results: list[SampleResult], rank_key: str, detail: bool = True) -> str:
    parts: list[str] = []
    parts.append(_rule("="))
    parts.append("XLETH LOOP OPTIMIZER LAB - corpus report")
    parts.append("metrics measured on the emulated Sampler render, not on idealised loop math")
    parts.append(_rule("="))
    parts.append("")
    for r in results:
        parts.append(format_sample_row(r))
    parts.append("")
    if detail:
        for r in results:
            parts.append(format_sample_detail(r))
            parts.append("")
    parts.append(format_aggregate(results, rank_key))
    return "\n".join(parts)
