"""CLI surface: the report must actually run and produce parseable output."""

from __future__ import annotations

import json

import numpy as np
import pytest

from loop_optimizer.__main__ import main
from loop_optimizer.wavio import write_wav


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
                "gold_loop": {"start": 10000, "end": 30000, "xfade": 1000},
                "measured_features": None,
            }
        )
    (tmp_path / "dataset.json").write_text(json.dumps(rows), encoding="utf-8")
    return tmp_path


def test_report_runs_and_prints_a_table_and_aggregate(tmp_path, capsys):
    root = _make_corpus(tmp_path)
    assert main(["report", "--corpus", str(root), "--selection", "gold"]) == 0

    out = capsys.readouterr().out
    assert "XLETH LOOP OPTIMIZER LAB" in out
    assert "AGGREGATE" in out
    assert "tone_0000" in out and "tone_0001" in out
    # Every metric must appear as a column.
    for name in (
        "seam_step",
        "seam_ncc",
        "zero_lag_corr",
        "cents_err_per_loop",
        "rms_ripple_db",
        "spectral_dist",
    ):
        assert name in out
    assert "top-1 matches gold" in out


def test_report_output_is_ascii_only(tmp_path, capsys):
    """The report has to survive a cp1252 Windows console."""
    root = _make_corpus(tmp_path, n_samples=1)
    main(["report", "--corpus", str(root), "--selection", "gold"])
    out = capsys.readouterr().out
    out.encode("ascii")  # raises if anything non-ASCII slipped in


@pytest.mark.parametrize("selection", ["auto", "full", "gold"])
def test_every_selection_mode_runs(tmp_path, capsys, selection):
    root = _make_corpus(tmp_path, n_samples=1)
    assert main(["report", "--corpus", str(root), "--selection", selection, "--summary-only"]) == 0
    assert "AGGREGATE" in capsys.readouterr().out


def test_json_and_feature_writeback(tmp_path, capsys):
    root = _make_corpus(tmp_path)
    json_out = tmp_path / "results.json"
    features_out = tmp_path / "dataset_with_features.json"
    original = (tmp_path / "dataset.json").read_text(encoding="utf-8")

    main(
        [
            "report",
            "--corpus",
            str(root),
            "--selection",
            "gold",
            "--summary-only",
            "--json",
            str(json_out),
            "--write-features",
            str(features_out),
        ]
    )
    capsys.readouterr()

    payload = json.loads(json_out.read_text(encoding="utf-8"))
    assert len(payload["samples"]) == 2
    assert payload["samples"][0]["top_candidate"]["metrics"]["seam_step"] is not None
    assert payload["samples"][0]["gold"]["engine_domain"]["start"] == round(10000 * 48000 / 44100)

    # The original corpus is untouched; the copy carries the features.
    assert (tmp_path / "dataset.json").read_text(encoding="utf-8") == original
    written = json.loads(features_out.read_text(encoding="utf-8"))
    assert written[0]["measured_features"]["median_f0_hz"] == pytest.approx(441.0, rel=0.02)
    # NaNs must serialise as null, never as the invalid JSON literal NaN.
    assert "NaN" not in features_out.read_text(encoding="utf-8")


def test_only_filter_selects_a_single_sample(tmp_path, capsys):
    root = _make_corpus(tmp_path)
    main(["report", "--corpus", str(root), "--only", "tone_0001", "--summary-only"])
    out = capsys.readouterr().out
    assert "tone_0001" in out
    assert "tone_0000" not in out


def test_unknown_sample_id_is_an_error(tmp_path, capsys):
    root = _make_corpus(tmp_path)
    assert main(["report", "--corpus", str(root), "--only", "nope"]) == 2


def test_missing_dataset_raises(tmp_path):
    with pytest.raises(FileNotFoundError):
        main(["report", "--corpus", str(tmp_path)])
