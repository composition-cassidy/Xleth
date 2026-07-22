"""Text rendering of corpus results.

Plain text on purpose: this output is meant to be diffed between runs and pasted
into a commit message or an issue, so it must not depend on terminal width,
colour support or a table library.
"""

from __future__ import annotations

import math
from collections import Counter

from .analysis import METRIC_NAMES, SampleResult
from .export import FORMANT_FADE_GATE_CENTS


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


def format_policy_table(payload: dict) -> str:
    """The policy-v2 gate table, rendered from a candidates.json payload.

    Read from the PAYLOAD rather than from the in-memory trace so that the table
    describes the document that shipped. A verdict recorded weeks later is
    recorded against the file, and a table generated from anything else could
    quietly stop matching it.

    Three questions, in the order the round-4 brief asks them:

      * did the placement gate find calmer material than the selection's
        typical placement? (``drift`` against ``median``, and their ratio)
      * did the fade gate shorten the fade, and from what? (``xfade`` against
        ``max``, which is what round-3 policy would have taken at this span)
      * which gate was binding, and how often? (the last column, and the
        tally underneath)

    Returns "" when the document carries no gate traces at all — a v1 export or
    an optimizer-only one — so the caller can simply not print it.
    """
    rows = []
    for s in payload.get("samples") or []:
        for arm in s.get("arms") or []:
            p = arm.get("policy")
            if p:
                rows.append((s.get("sample_id", ""), arm, p))
    if not rows:
        return ""

    lines: list[str] = []
    lines.append(_rule("=", 120))
    lines.append("POLICY v2 GATE TABLE - formant-gated placement, drift-gated fade")
    lines.append(_rule("=", 120))
    lines.append("")
    lines.append(
        "  drift/median: chosen span's F1-F3 drift (cents) vs the median over every span "
        "considered"
    )
    lines.append(
        "  drift@long:   drift of the LONGEST span - what round-3 policy would have taken. "
        "The gate worked where this is high and drift is not."
    )
    lines.append(
        "                chosen drift normally EXCEEDS the median: survivors are taken "
        "longest-first, so the policy spends drift up to the cut."
    )
    lines.append(
        "  len/longest:  loop length chosen vs the longest the selection could hold; short "
        "means the gate refused a drifting tail"
    )
    lines.append(
        "  xfade/max:    fade chosen vs the longest the engine clamp allowed at this span "
        "(= what round-3 policy took)"
    )
    lines.append(
        "  dF:           formant distance (cents) of the fade that was REFUSED, or of the "
        "chosen one where nothing was refused"
    )
    lines.append(
        "  bound:        which gate refused the next-longer fade; 'floor' marks a fade that "
        "fell back to one period"
    )
    lines.append("")
    header = (
        f"{'sample':<26} {'k':>4} {'drift':>8} {'median':>8} {'drift@long':>10} {'cut':>6} "
        f"{'kept':>11} {'len':>7} {'longest':>7} {'xfade':>7} {'max':>7} {'frac':>6} "
        f"{'dF':>7} {'bound':>10}"
    )
    lines.append(header)
    lines.append(_rule("-", 120))

    bound = Counter()
    floors = 0
    seen_df: list[float] = []
    ratios: list[float] = []
    frac: list[float] = []
    len_frac: list[float] = []

    for sid, arm, p in rows:
        drift = p.get("span_drift_cents")
        median = p.get("selection_median_drift_cents")
        xf = int(p.get("chosen_xfade") or 0)
        mx = int(p.get("max_xfade") or 0)
        gate = str(p.get("binding_gate") or "none")
        # The reading that bound where one exists, else the chosen fade's own.
        dF = p.get("binding_distance_cents")
        if dF is None or not math.isfinite(float(dF)):
            dF = p.get("formant_distance_cents")
        if dF is not None and math.isfinite(float(dF)):
            seen_df.append(float(dF))
        if p.get("hit_floor"):
            gate = f"{gate}/floor"
            floors += 1
        bound[str(p.get("binding_gate") or "none") if xf < mx else "none"] += 1

        ratio = (
            float(drift) / float(median)
            if drift is not None and median not in (None, 0) and math.isfinite(float(median))
            and float(median) > 0
            else float("nan")
        )
        if math.isfinite(ratio):
            ratios.append(ratio)
        fr = float(xf) / mx if mx > 0 else float("nan")
        if math.isfinite(fr):
            frac.append(fr)
        longest = int(p.get("longest_span") or 0)
        if longest > 0:
            len_frac.append(float(int(p.get("length") or 0)) / longest)

        lines.append(
            f"{sid[:26]:<26} {int(p.get('period_multiple') or 0):>4} "
            f"{_num(drift, 8, 1)} {_num(median, 8, 1)} "
            f"{_num(p.get('longest_span_drift_cents'), 10, 1)} {_num(p.get('drift_cut_cents'), 6, 1)} "
            f"{str(p.get('spans_kept')) + '/' + str(p.get('spans_considered')):>11} "
            f"{int(p.get('length') or 0):>7} {int(p.get('longest_span') or 0):>7} "
            f"{xf:>7} {mx:>7} {_num(fr, 6, 2)} "
            f"{_num(dF, 7, 0)} {gate:>10}"
        )

    lines.append(_rule("-", 120))
    lines.append("")
    lines.append(f"  samples with a policy arm      {len(rows)}")
    if ratios:
        lines.append(
            "  chosen drift / selection median  median %.2f, worst %.2f"
            % (float(sorted(ratios)[len(ratios) // 2]), float(max(ratios)))
        )
    if len_frac:
        shortened = sum(1 for f in len_frac if f < 1.0)
        lines.append(
            "  length / longest available       median %.2f; placement gate shortened %d of %d"
            % (float(sorted(len_frac)[len(len_frac) // 2]), shortened, len(len_frac))
        )
    if frac:
        shortened = sum(1 for f in frac if f < 1.0)
        lines.append(
            "  fade kept / drift-free maximum   median %.2f; fade gate shortened %d of %d"
            % (float(sorted(frac)[len(frac) // 2]), shortened, len(frac))
        )
    lines.append(f"  fell back to the one-period floor  {floors}")
    if seen_df:
        # Stated as a number rather than left as a row of zeros: "the gate never
        # fired" and "the gate was never close to firing" are different results,
        # and only the second one says the threshold is not merely untested.
        lines.append(
            "  largest fade formant distance    %.0f cents, against a gate of %.0f"
            % (max(seen_df), FORMANT_FADE_GATE_CENTS)
        )
    lines.append("")
    lines.append("  binding gate")
    for name in ("none", "formant", "click", "flam"):
        lines.append(f"    {name:<10} {bound.get(name, 0):>4}")
    return "\n".join(lines)
