"""Candidate generation, the metric suite's own properties, and corpus IO."""

from __future__ import annotations

import json

import numpy as np
import pytest

from loop_optimizer.analysis import (
    Selection,
    _compare_metric,
    _xfade_ratio,
    analyse_entry,
    rank_candidates,
)
from loop_optimizer.candidates import generate_candidates, sliding_end_match_ncc
from loop_optimizer.constants import ENGINE_SAMPLE_RATE
from loop_optimizer.corpus import GoldLoop, load_dataset, write_dataset_with_features
from loop_optimizer.engine_emu import LoopConfig, resolve
from loop_optimizer.metrics import (
    log_spectral_distance,
    measure,
    normalized_cross_correlation,
    sliding_rms,
)
from loop_optimizer.wavio import write_wav

SR = ENGINE_SAMPLE_RATE


def sine(freq, n, sr=SR, amp=0.5):
    t = np.arange(n) / sr
    return amp * np.sin(2 * np.pi * freq * t)


# ── primitives ───────────────────────────────────────────────────────────────


def test_ncc_is_one_for_identical_and_minus_one_for_inverted():
    a = np.array([1.0, -2.0, 3.0, -4.0])
    assert normalized_cross_correlation(a, a) == pytest.approx(1.0)
    assert normalized_cross_correlation(a, -a) == pytest.approx(-1.0)
    assert normalized_cross_correlation(a, a * 7.0) == pytest.approx(1.0), "scale invariant"


def test_ncc_is_undefined_for_silence():
    assert np.isnan(normalized_cross_correlation(np.zeros(8), np.ones(8)))
    assert np.isnan(normalized_cross_correlation(np.zeros(0), np.zeros(0)))


def test_sliding_rms_matches_a_direct_computation():
    x = np.arange(10, dtype=float)
    env = sliding_rms(x, 3)
    assert env.size == 8
    assert env[0] == pytest.approx(np.sqrt((0 + 1 + 4) / 3))
    assert env[-1] == pytest.approx(np.sqrt((49 + 64 + 81) / 3))


def test_log_spectral_distance_is_zero_for_identical_frames():
    x = sine(300.0, 1024)
    assert log_spectral_distance(x, x) == pytest.approx(0.0, abs=1e-9)


def test_log_spectral_distance_grows_with_difference():
    a = sine(300.0, 1024)
    b = sine(300.0, 1024) + sine(3000.0, 1024, amp=0.5)
    assert log_spectral_distance(a, b) > 5.0


def test_sliding_end_match_ncc_peaks_at_the_true_period():
    """The search objective must be maximal when the two ends are in phase."""
    period = 120
    x = sine(SR / period, 6000)
    w = period
    # A loop length of exactly one period correlates perfectly at every start.
    exact = sliding_end_match_ncc(x, period, w, 500, 1500)
    assert np.nanmax(exact) == pytest.approx(1.0, abs=1e-6)
    # Half a period off puts the ends in antiphase everywhere.
    off = sliding_end_match_ncc(x, period + period // 2, w, 500, 1500)
    assert np.nanmax(off) < -0.9


# ── candidate generation ─────────────────────────────────────────────────────


def test_candidates_are_period_multiples_and_stay_inside_the_window():
    period = 150.0
    x = sine(SR / period, 30_000)
    lo, hi = 5000, 25_000
    cands = generate_candidates(x, period, lo, hi)

    assert cands, "a clean tone should yield candidates"
    for c in cands:
        assert c.loop_start >= lo
        assert c.loop_end <= hi
        assert c.period_multiple >= 1
        # Length is the rounded period multiple, exactly.
        assert c.length == round(c.period_multiple * period)


def test_candidate_crossfade_variants_are_deduplicated_after_clamping():
    """Two requests that clamp to the same width are the same loop."""
    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)

    by_loop: dict[tuple[int, int], list[int]] = {}
    for c in cands:
        eff = resolve(c.to_config(), x.size).eff_xfade
        by_loop.setdefault((c.loop_start, c.loop_end), []).append(eff)
    for effs in by_loop.values():
        assert len(effs) == len(set(effs)), "duplicate effective crossfades were emitted"


def test_candidate_generation_refuses_noise():
    rng = np.random.default_rng(3)
    x = rng.standard_normal(20_000) * 0.3
    # A period exists numerically, but no alignment will correlate above the floor.
    assert generate_candidates(x, 150.0, 1000, 15_000) == []


def test_candidate_generation_refuses_an_impossible_period():
    x = sine(300.0, 5000)
    assert generate_candidates(x, float("nan"), 0, 5000) == []
    assert generate_candidates(x, 0.5, 0, 5000) == []
    # Window too short to hold even one period plus a correlation window.
    assert generate_candidates(x, 160.0, 0, 200) == []


def test_generated_candidates_never_produce_a_degenerate_loop():
    period = 100.0
    x = sine(SR / period, 20_000)
    for c in generate_candidates(x, period, 1000, 15_000):
        assert resolve(c.to_config(), x.size).wrap_advance > 0


# ── metric behaviour on candidates ───────────────────────────────────────────


def test_metrics_are_nan_when_the_loop_is_disabled():
    x = sine(300.0, 5000)
    cfg = LoopConfig(loop_start=100, loop_end=2000, loop_enabled=False)
    m = measure(x, cfg, 160.0)
    assert np.isnan(m.seam_step)
    assert np.isnan(m.seam_ncc)


def test_zero_lag_corr_is_nan_without_a_crossfade_and_high_when_aligned():
    period = 100
    x = sine(SR / period, 20_000)
    span = 40 * period
    assert np.isnan(measure(x, LoopConfig(5000, 5000 + span, 0), float(period)).zero_lag_corr)

    aligned = measure(x, LoopConfig(5000, 5000 + span, 6 * period), float(period))
    assert aligned.zero_lag_corr > 0.99, "in-phase fade sources should correlate"


def test_metrics_are_finite_for_a_realistic_loop():
    """Every metric must produce a number, not a NaN, on ordinary material."""
    period = 120
    x = sine(SR / period, 40_000) + 0.3 * sine(2 * SR / period, 40_000)
    m = measure(x, LoopConfig(8000, 8000 + 30 * period, 6 * period), float(period))
    for name, value in m.as_dict().items():
        assert np.isfinite(value), f"{name} was not finite"


def test_metrics_are_finite_for_a_very_short_loop():
    """A one-period loop still has to be measurable.

    The render span is sized from the period and the crossfade rather than from
    the loop length precisely so this case does not fall off the end.
    """
    period = 100
    x = sine(SR / period, 20_000)
    m = measure(x, LoopConfig(5000, 5000 + period, 0), float(period))
    assert np.isfinite(m.seam_step)
    assert np.isfinite(m.rms_ripple_db)
    assert np.isfinite(m.spectral_dist)


def test_measure_uses_the_measured_period_not_the_declared_one():
    """cents_err must be computed against the period it is handed."""
    period = 100
    x = sine(SR / period, 20_000)
    cfg = LoopConfig(5000, 5000 + 20 * period, 0)
    truthful = measure(x, cfg, float(period))
    wrong = measure(x, cfg, float(period) * 1.02)  # a 2% mis-declared period
    assert abs(truthful.cents_err_per_loop) < 0.5
    # 2% is ~34 cents. Small-looking, and exactly the size of error that reading
    # the period off root_note instead of measuring it produces on this corpus,
    # where the hard-tuned material sits a few cents off equal temperament.
    assert wrong.cents_err_per_loop == pytest.approx(
        1200.0 * np.log2(2000.0 / (20 * period * 1.02)), rel=1e-6
    )
    assert abs(wrong.cents_err_per_loop) > 20.0


# ── ranking and gold comparison helpers ──────────────────────────────────────


def _scored_perceptual(x, cands, period):
    from loop_optimizer.analysis import ScoredCandidate
    from loop_optimizer.perceptual import measure_perceptual

    return [
        ScoredCandidate(
            c,
            measure_perceptual(x, c.to_config(), period),
            resolve(c.to_config(), x.size).eff_xfade,
        )
        for c in cands
    ]


def test_ranking_puts_nan_metrics_last():
    """A candidate nothing could be measured on must not sort to the top.

    Ranks on `click` now rather than `seam_step`: the seam suite was replaced
    after the blind A/B round showed it anti-correlated with the listeners
    (loop_optimizer.perceptual). The ordering INVARIANT is unchanged.
    """
    import dataclasses

    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)[:6]
    scored = _scored_perceptual(x, cands, period)
    scored[0] = dataclasses.replace(
        scored[0], metrics=dataclasses.replace(scored[0].metrics, click=float("nan"))
    )
    ranked = rank_candidates(scored, "click")
    assert np.isnan(ranked[-1].metrics.click)


def test_ranking_is_deterministic():
    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)
    scored = _scored_perceptual(x, cands, period)
    first = [(s.candidate.loop_start, s.eff_xfade) for s in rank_candidates(scored, "click")]
    second = [
        (s.candidate.loop_start, s.eff_xfade)
        for s in rank_candidates(list(reversed(scored)), "click")
    ]
    assert first == second


def test_top_invalid_guard_fires_when_an_unmeasured_candidate_would_outrank_a_measured_one():
    """The metric-invariant assertion, tested directly against the guard rather
    than hoping to provoke it through `_rank_key` (which already excludes NaN
    from rank 1 by sorting it to infinity — the guard exists to CATCH a
    regression in that sort, so it has to be exercised with an input the sort
    itself would never produce).
    """
    from loop_optimizer.analysis import PERCEPTUAL_RANK_KEY, ScoredCandidate, _assert_top_not_invalid

    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)[:2]
    scored = _scored_perceptual(x, cands, period)

    import dataclasses

    invalid_top = dataclasses.replace(
        scored[0], metrics=dataclasses.replace(scored[0].metrics, click=float("nan"))
    )
    valid_second = dataclasses.replace(
        scored[1], metrics=dataclasses.replace(scored[1].metrics, click=0.1)
    )
    with pytest.raises(AssertionError):
        _assert_top_not_invalid([invalid_top, valid_second], PERCEPTUAL_RANK_KEY)


def test_top_invalid_guard_allows_an_invalid_top_when_nothing_else_was_measurable():
    """If every candidate is unmeasurable, an INVALID one at rank 1 is not a
    ranking failure — there was no valid alternative to have preferred.
    """
    from loop_optimizer.analysis import PERCEPTUAL_RANK_KEY, _assert_top_not_invalid

    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)[:2]
    scored = _scored_perceptual(x, cands, period)

    import dataclasses

    all_invalid = [
        dataclasses.replace(sc, metrics=dataclasses.replace(sc.metrics, click=float("nan")))
        for sc in scored
    ]
    _assert_top_not_invalid(all_invalid, PERCEPTUAL_RANK_KEY)  # must not raise


def test_perceptual_rank_key_orders_by_the_collapsed_cost():
    """The default key collapses the suite instead of naming one metric."""
    from loop_optimizer.analysis import PERCEPTUAL_RANK_KEY
    from loop_optimizer.perceptual import perceptual_cost

    period = 100.0
    x = sine(SR / period, 20_000)
    cands = generate_candidates(x, period, 2000, 12_000)[:12]
    ranked = rank_candidates(_scored_perceptual(x, cands, period), PERCEPTUAL_RANK_KEY)
    costs = [perceptual_cost(s.metrics) for s in ranked]
    assert costs == sorted(costs)


def test_xfade_ratio_handles_the_zero_cases_explicitly():
    assert _xfade_ratio(0, 0) == 1.0
    assert np.isinf(_xfade_ratio(100, 0))
    assert np.isinf(_xfade_ratio(0, 100))
    assert _xfade_ratio(200, 100) == 2.0


def test_compare_metric_respects_each_metric_direction():
    assert _compare_metric("click", 0.1, 0.5) == "tool"  # lower is better
    assert _compare_metric("timbre_jump", 0.1, 0.5) == "tool"  # lower is better
    # cents error is judged on magnitude, so a negative can still win.
    assert _compare_metric("cents_err_per_loop", -1.0, 50.0) == "tool"
    assert _compare_metric("click", 0.5, 0.5) == "tie"
    assert _compare_metric("click", float("nan"), 0.5) == "n/a"


# ── corpus IO ────────────────────────────────────────────────────────────────


def test_gold_loop_domain_conversion_inverts_the_exporter():
    """convertGold multiplies by fileRate/engineRate; to_engine is its inverse."""
    gold_file = GoldLoop(start=11025, end=22050, xfade=4410)
    gold_engine = gold_file.to_engine(44100.0, 48000.0)
    assert gold_engine.start == 12000
    assert gold_engine.end == 24000
    assert gold_engine.xfade == 4800


def test_gold_loop_conversion_is_identity_at_matching_rates():
    gold = GoldLoop(start=100, end=200, xfade=25)
    assert gold.to_engine(48000.0, 48000.0) == gold


def _make_corpus(tmp_path, sample_id="tone_0001"):
    audio_dir = tmp_path / "corpus" / "Test"
    audio_dir.mkdir(parents=True)
    period = 100
    # 441 Hz in the FILE domain: generated AT the file rate, not the engine rate.
    x = (sine(44100.0 / period, 44100, sr=44100.0) * np.hanning(44100) ** 0.1).astype(np.float32)
    write_wav(audio_dir / "tone.wav", x, 44100)
    rows = [
        {
            "sample_id": sample_id,
            "file": "corpus/Test/tone.wav",
            "class": "Test",
            "behavior_family": "stable_periodic",
            "root_note": 60,
            "sample_rate": 44100,
            "channels": 1,
            "num_samples": 44100,
            "gold_loop": {"start": 10000, "end": 30000, "xfade": 1000},
            "measured_features": None,
        }
    ]
    (tmp_path / "dataset.json").write_text(json.dumps(rows), encoding="utf-8")
    return tmp_path


def test_load_dataset_resolves_paths_and_gold(tmp_path):
    root = _make_corpus(tmp_path)
    entries, rows, path = load_dataset(root)
    assert len(entries) == 1
    assert entries[0].path.exists()
    assert entries[0].gold == GoldLoop(10000, 30000, 1000)
    assert path.name == "dataset.json"
    # Passing the dataset file directly must work too.
    assert load_dataset(path)[0][0].sample_id == entries[0].sample_id


def test_write_dataset_with_features_does_not_touch_the_original(tmp_path):
    root = _make_corpus(tmp_path)
    _, rows, dataset_path = load_dataset(root)
    before = dataset_path.read_text(encoding="utf-8")

    out = write_dataset_with_features(rows, {"tone_0001": {"median_f0_hz": 441.0}}, tmp_path / "out.json")

    assert dataset_path.read_text(encoding="utf-8") == before, "the corpus was modified in place"
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written[0]["measured_features"]["median_f0_hz"] == 441.0
    assert written[0]["gold_loop"] == {"start": 10000, "end": 30000, "xfade": 1000}


def test_analyse_entry_runs_end_to_end(tmp_path):
    root = _make_corpus(tmp_path)
    entries, _, _ = load_dataset(root)
    result = analyse_entry(entries[0], selection=Selection.GOLD)

    assert result.features.median_f0_hz == pytest.approx(441.0, rel=0.02)
    assert result.ranked, "should produce candidates on a clean tone"
    assert result.gold is not None
    assert result.gold.nearest_rank is not None
    # Gold is in the file domain; the comparison must happen in the engine domain.
    assert result.gold.gold_engine.start == round(10000 * 48000 / 44100)
