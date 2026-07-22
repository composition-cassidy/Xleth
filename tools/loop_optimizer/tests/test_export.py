"""``export`` — the arm set the blind A/B rater loads.

The rater's whole value rests on the arms being what they claim to be: gold
unmodified, the naive anchor genuinely off-period, and the file reproducible so
a verdict can be traced back to a loop months later.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from loop_optimizer.__main__ import main
from loop_optimizer.corpus import GoldLoop
from loop_optimizer.export import (
    NAIVE_MIN_PHASE_ERROR,
    NAIVE_XFADE_DIVISOR,
    naive_loop,
    policy_loop,
)
from loop_optimizer.wavio import write_wav

GOLD = {"start": 8000, "end": 34000, "xfade": 1000}


def _make_corpus(tmp_path, n_samples=2):
    audio_dir = tmp_path / "corpus" / "Test"
    audio_dir.mkdir(parents=True)
    rows = []
    for i in range(n_samples):
        period = 100 + 20 * i
        t = np.arange(44100) / 44100.0
        freq = 44100.0 / period
        x = 0.5 * np.sin(2 * np.pi * freq * t) * np.hanning(44100) ** 0.1
        write_wav(audio_dir / f"tone{i}.wav", x.astype(np.float32), 44100)
        rows.append(
            {
                "sample_id": f"tone_{i:04d}",
                "file": f"corpus/Test/tone{i}.wav",
                "class": "Test",
                "behavior_family": "stable_periodic",
                "root_note": 60,
                "sample_rate": 44100,
                "channels": 1,
                "num_samples": 44100,
                "gold_loop": dict(GOLD),
                "measured_features": None,
            }
        )
    (tmp_path / "dataset.json").write_text(json.dumps(rows), encoding="utf-8")
    return tmp_path


def _export(tmp_path, capsys, *extra, n_samples=2):
    root = _make_corpus(tmp_path, n_samples)
    out = tmp_path / "candidates.json"
    assert main(["export", "--corpus", str(root), "--selection", "gold", *extra]) == 0
    capsys.readouterr()
    return json.loads(out.read_text(encoding="utf-8")), out


def test_export_writes_top_k_plus_gold_plus_naive(tmp_path, capsys):
    payload, _ = _export(tmp_path, capsys, "--top-k", "3")

    assert payload["schema"] == "xleth.loop-optimizer.candidates/1"
    assert payload["top_k"] == 3
    assert len(payload["samples"]) == 2

    for sample in payload["samples"]:
        provenances = [a["provenance"] for a in sample["arms"]]
        assert provenances.count("optimizer") == 3
        assert provenances.count("gold") == 1
        assert provenances.count("naive") == 1
        # Optimizer arms carry their rank; the other two are not ranked at all.
        assert [a["rank"] for a in sample["arms"] if a["provenance"] == "optimizer"] == [1, 2, 3]
        assert all(a["rank"] is None for a in sample["arms"] if a["provenance"] != "optimizer")


def test_round3_recipe_is_gold_policy_naive_with_top_k_zero(tmp_path, capsys):
    """The round-3 export: selection-first, no full-auto optimizer arms.

    Reachable only via ``--policy v1`` now that v2 is the default. Kept
    exercised rather than deleted: candidates.round3.json is the document the
    round-3 verdicts were recorded against, and a document that can no longer
    be regenerated cannot be checked against those verdicts.
    """
    payload, _ = _export(tmp_path, capsys, "--top-k", "0", "--policy", "v1")

    assert payload["policy_version"] == "v1"
    for sample in payload["samples"]:
        provenances = [a["provenance"] for a in sample["arms"]]
        assert provenances.count("optimizer") == 0
        assert provenances.count("gold") == 1
        assert provenances.count("policy") == 1
        assert provenances.count("naive") == 1
        assert provenances == ["gold", "policy", "naive"]
        policy = next(a for a in sample["arms"] if a["provenance"] == "policy")
        assert policy["rank"] is None


def test_round4_recipe_is_gold_policy_v2_naive_and_is_the_default(tmp_path, capsys):
    """The round-4 export: same three slots, the policy arm now gated."""
    payload, _ = _export(tmp_path, capsys, "--top-k", "0")

    assert payload["policy_version"] == "v2"
    for sample in payload["samples"]:
        provenances = [a["provenance"] for a in sample["arms"]]
        assert provenances == ["gold", "policy_v2", "naive"]
        policy = next(a for a in sample["arms"] if a["provenance"] == "policy_v2")
        assert policy["rank"] is None
        # The gate trace ships WITH the arm: a verdict recorded against this
        # document has to be readable against what the gates did to produce it.
        assert policy["policy"]["chosen_xfade"] <= policy["policy"]["max_xfade"]
        assert policy["policy"]["spans_kept"] <= policy["policy"]["spans_considered"]
        assert policy["policy"]["length"] <= policy["policy"]["longest_span"]


@pytest.mark.parametrize("version,provenance", [("v1", "policy"), ("v2", "policy_v2")])
def test_policy_arm_is_period_aligned_and_matches_the_standalone_helper(
    tmp_path, capsys, version, provenance
):
    payload, _ = _export(tmp_path, capsys, "--top-k", "0", "--policy", version, n_samples=1)
    sample = payload["samples"][0]
    policy = next(a for a in sample["arms"] if a["provenance"] == provenance)

    period = sample["period_engine"]
    engine = policy["loop_engine"]
    length = engine["end"] - engine["start"]
    advance = length - engine["xfade"]
    # length and crossfade are each independently rounded to the nearest
    # sample from a period multiple, so their DIFFERENCE is aligned to within
    # about a sample, not to floating-point precision — unlike the exact
    # integer periods used in tests/test_policy_arm.py's synthetic cases.
    nearest_multiple = round(advance / period)
    assert abs(advance - nearest_multiple * period) < 1.0
    # With this much room (the GOLD region is 26000 samples), the longest
    # valid fade should never be zero.
    assert engine["xfade"] > 0


def test_top_k_is_respected(tmp_path, capsys):
    payload, _ = _export(tmp_path, capsys, "--top-k", "1", n_samples=1)
    arms = payload["samples"][0]["arms"]
    assert sum(1 for a in arms if a["provenance"] == "optimizer") == 1


def test_every_arm_carries_the_metric_suite_and_a_file_domain_loop(tmp_path, capsys):
    payload, _ = _export(tmp_path, capsys, n_samples=1)
    sample = payload["samples"][0]
    # Six perceptual metrics plus the retained cents_err_per_loop.
    assert len(payload["metric_names"]) == 7
    assert "click" in payload["metric_names"] and "seam_step" not in payload["metric_names"]
    for arm in sample["arms"]:
        assert set(arm["metrics"]) == set(payload["metric_names"])
        loop = arm["loop"]
        assert set(loop) == {"start", "end", "xfade"}
        assert 0 <= loop["start"] < loop["end"] <= sample["file_num_samples"]
        assert all(isinstance(v, int) for v in loop.values())


def test_gold_arm_round_trips_the_dataset_loop_exactly(tmp_path, capsys):
    """engine -> file conversion must hand back the authored numbers.

    The gold arm is written in the FILE domain but is measured in the engine
    domain, so it makes the same round trip a rated loop does. If that trip
    isn't lossless at 44.1k, the rater is auditioning something other than what
    the human authored.
    """
    payload, _ = _export(tmp_path, capsys, n_samples=1)
    gold = next(a for a in payload["samples"][0]["arms"] if a["provenance"] == "gold")
    assert gold["loop"] == GOLD


def test_naive_anchor_is_period_unaligned_with_an_eighth_length_crossfade(tmp_path, capsys):
    payload, _ = _export(tmp_path, capsys, n_samples=1)
    sample = payload["samples"][0]
    naive = next(a for a in sample["arms"] if a["provenance"] == "naive")

    engine = naive["loop_engine"]
    length = engine["end"] - engine["start"]
    assert engine["xfade"] == length // NAIVE_XFADE_DIVISOR

    # Inside the gold region, and genuinely off-period — the point of the anchor.
    gold_engine = next(a for a in sample["arms"] if a["provenance"] == "gold")["loop_engine"]
    assert gold_engine["start"] <= engine["start"] < engine["end"] <= gold_engine["end"]
    in_periods = length / sample["period_engine"]
    assert abs(in_periods - round(in_periods)) >= NAIVE_MIN_PHASE_ERROR

    # ...and it should audibly lose to the optimizer's top candidate on tuning.
    top = next(a for a in sample["arms"] if a["rank"] == 1)
    assert abs(naive["metrics"]["cents_err_per_loop"]) > abs(top["metrics"]["cents_err_per_loop"])


def test_export_is_byte_for_byte_reproducible(tmp_path, capsys):
    """No RNG anywhere: a verdict recorded today must name the same loop later."""
    first, out = _export(tmp_path, capsys, n_samples=2)
    text_a = out.read_text(encoding="utf-8")
    assert main(["export", "--corpus", str(tmp_path), "--selection", "gold"]) == 0
    capsys.readouterr()
    assert out.read_text(encoding="utf-8") == text_a
    assert first["samples"][0]["arms"][0]["loop"] == json.loads(text_a)["samples"][0]["arms"][0]["loop"]


def test_naive_start_differs_between_samples(tmp_path, capsys):
    """The 'arbitrary' offset is hashed per sample, not one constant corpus-wide."""
    payload, _ = _export(tmp_path, capsys, n_samples=2)
    starts = [
        next(a for a in s["arms"] if a["provenance"] == "naive")["loop_engine"]["start"]
        for s in payload["samples"]
    ]
    assert starts[0] != starts[1]


def test_naive_is_skipped_when_the_gold_region_is_too_short():
    """Better no anchor than one that is bad for the wrong reason."""
    assert naive_loop("x", GoldLoop(start=0, end=300, xfade=0), period=100.0, num_samples=44100) is None
    assert naive_loop("x", GoldLoop(start=0, end=20000, xfade=0), period=float("nan"), num_samples=44100) is None
    assert naive_loop("x", GoldLoop(start=0, end=20000, xfade=0), period=100.0, num_samples=44100) is not None


def test_policy_is_skipped_when_the_gold_region_is_too_short():
    """Better no arm than a degenerate one — same failure mode as naive_loop."""
    x = np.zeros(44100, dtype=np.float32)
    assert policy_loop(x, GoldLoop(start=0, end=300, xfade=0), period=100.0, sample_rate=44100.0) is None
    assert policy_loop(
        x, GoldLoop(start=0, end=20000, xfade=0), period=float("nan"), sample_rate=44100.0
    ) is None


def test_export_json_has_no_nan_literals(tmp_path, capsys):
    """NaN is valid Python json.dump output and invalid JSON; the rater must parse."""
    _, out = _export(tmp_path, capsys, n_samples=2)
    assert "NaN" not in out.read_text(encoding="utf-8")


def test_export_defaults_beside_dataset_json(tmp_path, capsys):
    root = _make_corpus(tmp_path, 1)
    assert main(["export", "--corpus", str(root / "dataset.json"), "--selection", "gold"]) == 0
    capsys.readouterr()
    assert (tmp_path / "candidates.json").exists()


def test_unknown_sample_id_is_an_error(tmp_path, capsys):
    root = _make_corpus(tmp_path, 1)
    assert main(["export", "--corpus", str(root), "--only", "nope"]) == 2


def test_policy_table_reports_what_each_gate_did(tmp_path, capsys):
    """The deliverable table, rendered from the shipped document.

    It is generated from the payload rather than from the in-memory trace so
    that it describes the file a verdict will later be recorded against.
    """
    from loop_optimizer.report import format_policy_table

    payload, _ = _export(tmp_path, capsys, "--top-k", "0", n_samples=1)
    table = format_policy_table(payload)

    assert "POLICY v2 GATE TABLE" in table
    for column in ("drift", "median", "drift@long", "len", "longest", "xfade", "max", "bound"):
        assert column in table
    # Every gate that can bind is tallied, including the ones that did not —
    # "formant never fired" is a result, and a table that omits the row cannot
    # distinguish it from "formant was not checked".
    for gate in ("none", "formant", "click", "flam"):
        assert f"    {gate:<10}" in table
    assert "fell back to the one-period floor" in table

    # A v1 document carries no traces, so there is no table to print.
    v1_payload, _ = _export(tmp_path / "v1", capsys, "--top-k", "0", "--policy", "v1")
    assert format_policy_table(v1_payload) == ""


def test_export_is_reproducible(tmp_path, capsys):
    """Same corpus in, byte-identical candidates.json out — including the trace."""
    a, path_a = _export(tmp_path / "a", capsys, "--top-k", "0")
    b, path_b = _export(tmp_path / "b", capsys, "--top-k", "0")
    a["dataset"] = b["dataset"] = ""
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
