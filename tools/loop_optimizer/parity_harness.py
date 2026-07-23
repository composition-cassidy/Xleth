"""Parity harness: C++ AutoLoopPolicy vs the Python reference policy_v2.

For each corpus sample this ingests the WAV at its OWN native rate (so the Python
`resample` is a no-op and the analysis buffer is exactly what a native-rate XLETH
engine would hold), dumps that identical mono buffer to a .f32, runs BOTH:

  * the Python reference `policy_v2_loop` at that native rate, and
  * the compiled C++ diagnostic (test_auto_loop_policy.exe) on the same .f32,

and compares the chosen loop in PERIOD units — the definition-of-done tolerance:
loop points within +/-0.5 period, crossfade within one period-multiple. Both
operate on identical samples, so the only differences measured are the algorithm
port itself (NSDF-vs-YIN period, LPC formants, Durand-Kerner roots).

It also reports the NSDF-vs-YIN f0 disagreement the task asks for (max/median
cents), and the C++ AUTO timing per sample for the perf budget.

Usage:
    python parity_harness.py <dataset.json> <path-to-test_auto_loop_policy.exe>
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from loop_optimizer.corpus import GoldLoop
from loop_optimizer.export import policy_v2_loop
from loop_optimizer.ingest import ingest_file
from loop_optimizer.perceptual import _filterbank_for, source_reference
from loop_optimizer.pitch import track_pitch


def _period_in_window(track, start: int, end: int) -> float:
    """Mirror analysis._period_in_window (median voiced period inside a window)."""
    if track.positions.size == 0:
        return float("nan")
    inside = (track.positions >= start) & (track.positions < end) & track.voiced
    vals = track.periods[inside]
    if vals.size:
        return float(np.median(vals))
    return track.median_period()


def run_sample(entry: dict, dataset_dir: Path, exe: Path) -> dict | None:
    wav_path = dataset_dir / entry["file"]
    if not wav_path.exists():
        return {"sample_id": entry["sample_id"], "error": f"missing {wav_path}"}

    gold = entry.get("gold_loop")
    if not gold:
        return {"sample_id": entry["sample_id"], "error": "no gold_loop"}

    # Ingest at the file's OWN rate: engine == file, ratio == 1, no resampling.
    native = int(entry["sample_rate"])
    sample = ingest_file(wav_path, engine_rate=float(native))
    x = np.ascontiguousarray(sample.x, dtype=np.float32)

    # Gold file -> engine (ratio 1 here, but keep the conversion honest).
    gold_engine = GoldLoop(
        start=int(round(sample.file_to_engine(gold["start"]))),
        end=int(round(sample.file_to_engine(gold["end"]))),
        xfade=int(round(sample.file_to_engine(gold["xfade"]))),
    )

    # Period as analysis._select_window derives it for --selection gold: an
    # 8-period margin around the gold region, off the whole-file rough median.
    track = track_pitch(x.astype(np.float64), sample.sample_rate)
    rough = track.median_period()
    margin = int(round(8.0 * rough)) if np.isfinite(rough) else 0
    pw_start = max(0, gold_engine.start - margin)
    pw_end = min(sample.num_samples, gold_engine.end + margin)
    period = _period_in_window(track, pw_start, pw_end)

    # Run the C++ diagnostic first (on the identical buffer) so we can read back
    # the period IT measured with NSDF and feed that same period into the Python
    # reference — the "algorithm parity" comparison that holds the one legitimately
    # divergent input (NSDF-vs-YIN f0) fixed and tests only the ported chain.
    with tempfile.NamedTemporaryFile(suffix=".f32", delete=False) as tf:
        x.tofile(tf.name)
        f32 = tf.name
    try:
        out = subprocess.run(
            [str(exe), f32, str(native), str(gold_engine.start), str(gold_engine.end)],
            capture_output=True, text=True, timeout=60,
        )
        cpp = json.loads(out.stdout.strip().splitlines()[-1])
    finally:
        Path(f32).unlink(missing_ok=True)

    def run_python(p: float):
        # ref only feeds the click/flam gate the C++ port deliberately omits (inert
        # on this corpus), so it cannot change the output.
        fb, n_fft = _filterbank_for(p, sample.sample_rate)
        ref = source_reference(x.astype(np.float64), p, sample.sample_rate, fb, n_fft)
        found = policy_v2_loop(x.astype(np.float64), gold_engine, p, sample.sample_rate, ref)
        if found is None:
            return None
        cand, _trace = found
        return {"loopStart": cand.loop_start, "loopEnd": cand.loop_end,
                "xfade": cand.crossfade_samples}

    py = run_python(period)                                   # YIN period (end-to-end)
    cpp_period = cpp.get("period") or period
    py_same_period = run_python(cpp_period)                   # C++ period (algorithm parity)

    return {
        "sample_id": entry["sample_id"],
        "period_py": period,
        "period_cpp": cpp.get("period"),
        "py": py,
        "py_same_period": py_same_period,
        "cpp": cpp,
        "gold_engine": {"start": gold_engine.start, "end": gold_engine.end, "xfade": gold_engine.xfade},
    }


def main() -> int:
    dataset_path = Path(sys.argv[1])
    exe = Path(sys.argv[2])
    dataset = json.loads(dataset_path.read_text())
    dataset_dir = dataset_path.parent

    rows = []
    for entry in dataset:
        rows.append(run_sample(entry, dataset_dir, exe))

    # Two comparisons. ALGO parity holds the period fixed (feeds C++'s NSDF period
    # into the Python reference) and tests only the ported chain — this is the
    # port-correctness gate. E2E lets each side use its own f0 (NSDF vs YIN) and
    # is expected to deviate where a sub-cent period gap flips a long span.
    print(f"{'sample':26} {'k':>3} | {'ALGO dS':>7} {'dE':>6} {'dXf':>6} | "
          f"{'E2E dS':>7} {'dE':>6} {'dXf':>6} | {'f0cent':>7} {'ms':>7}")
    print("-" * 100)

    def dev(cpp, py, period, key_s, key_e):
        return (abs(cpp["loopStart"] - py[key_s]) / period,
                abs(cpp["loopEnd"] - py[key_e]) / period,
                abs(cpp["crossfadeSamples"] - py["xfade"]) / period)

    algo_s, algo_e, algo_x = [], [], []
    e2e_s, e2e_e, e2e_x = [], [], []
    f0_cents, timings = [], []
    algo_pass = e2e_pass = fails = skips = 0
    for r in rows:
        if r.get("error"):
            print(f"{r['sample_id']:26} ERROR: {r['error']}"); skips += 1; continue
        cpp, py, pys = r["cpp"], r["py"], r["py_same_period"]
        period = r["period_py"]
        if not cpp.get("valid") and py is None:
            print(f"{r['sample_id']:26} both refused (ok)"); algo_pass += 1; e2e_pass += 1; continue
        if not cpp.get("valid") or py is None or pys is None:
            print(f"{r['sample_id']:26} MISMATCH refusal cpp={cpp.get('valid')} py={py is not None}")
            fails += 1; continue

        a_s, a_e, a_x = dev(cpp, pys, period, "loopStart", "loopEnd")
        e_s, e_e, e_x = dev(cpp, py, period, "loopStart", "loopEnd")
        f0c = 1200.0 * np.log2(cpp["period"] / period) if period > 0 else float("nan")
        ms = cpp.get("elapsedMs", float("nan"))
        algo_s.append(a_s); algo_e.append(a_e); algo_x.append(a_x)
        e2e_s.append(e_s); e2e_e.append(e_e); e2e_x.append(e_x)
        if np.isfinite(f0c): f0_cents.append(abs(f0c))
        timings.append(ms)
        # "within one period-multiple" on xfade == one period step (allow rounding).
        algo_ok = a_s <= 0.5 and a_e <= 0.5 and a_x <= 1.05
        e2e_ok = e_s <= 0.5 and e_e <= 0.5 and e_x <= 1.05
        algo_pass += algo_ok; e2e_pass += e2e_ok
        flag = "" if algo_ok else "  <-- ALGO"
        print(f"{r['sample_id']:26} {cpp.get('periodMultiple',0):>3} | "
              f"{a_s:>7.3f} {a_e:>6.3f} {a_x:>6.3f} | {e_s:>7.3f} {e_e:>6.3f} {e_x:>6.3f} | "
              f"{f0c:>7.2f} {ms:>7.1f}{flag}")

    print("-" * 100)
    def stat(name, arr):
        a = np.array(arr) if arr else np.array([np.nan])
        print(f"  {name}: max {np.nanmax(a):.3f}  median {np.nanmedian(a):.3f}")
    print("ALGORITHM parity (C++ vs Python given the SAME period) — the port gate:")
    stat("  loopStart dev (periods)", algo_s)
    stat("  loopEnd   dev (periods)", algo_e)
    stat("  xfade     dev (periods)", algo_x)
    print("END-TO-END (each side its own f0) — sensitivity to the period estimator:")
    stat("  loopStart dev (periods)", e2e_s)
    stat("  loopEnd   dev (periods)", e2e_e)
    print("Validation:")
    stat("  f0 NSDF-vs-YIN (cents) ", f0_cents)
    stat("  C++ AUTO time (ms)     ", timings)
    total = len([r for r in rows if not r.get("error")])
    print(f"\n  ALGO parity: {algo_pass}/{total}   E2E within +/-0.5T: {e2e_pass}/{total}   "
          f"({skips} skip, {fails} refusal-mismatch)")
    return 0 if algo_pass == total and fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
