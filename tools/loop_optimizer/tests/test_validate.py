"""The validation harness: the arithmetic every claim in the report rests on.

If `concordance` miscounts or the sign test is wrong, the conclusion "the
redesign agrees with the listeners and the old suite did not" is worth nothing.
These test the statistics, not the audio.
"""

from __future__ import annotations

import json

import numpy as np
import pytest

from loop_optimizer.validate import (
    ArmEval,
    TrialEval,
    _binomial_sign_p,
    _prefers,
    concordance,
    load_ratings,
)


def _arm(arm_id: str, provenance: str, score: float, advance: int = 1000, xfade: int = 100) -> ArmEval:
    class _M:
        pass

    m = _M()
    m.click = score
    return ArmEval(
        arm_id=arm_id, provenance=provenance, cfg=None, new=m,
        old_seam_step=score, advance=advance, xfade=xfade,
    )


def _trial(winner: str | None, win_score: float, lose_score: float, kind: str = "optimizer") -> TrialEval:
    arms = {"gold": _arm("gold", "gold", 0.0), "optimizer_1": _arm("optimizer_1", "optimizer", 0.0)}
    loser = "optimizer_1" if winner == "gold" else "gold"
    if winner is not None:
        arms[winner].new.click = win_score
        arms[loser].new.click = lose_score
    return TrialEval(
        trial_id=f"t::{winner}", sample_id="s", kind=kind,
        winner_arm_id=winner, loser_arm_id=(loser if winner else None),
        failure_tags=[], arms=arms,
    )


# ── Agreement scoring ───────────────────────────────────────────────────────


def test_prefers_agrees_when_the_rule_scores_the_winner_better():
    t = _trial("gold", win_score=0.1, lose_score=0.9)
    assert _prefers(t, lambda a: a.new.click) == 1.0


def test_prefers_disagrees_when_the_rule_scores_the_loser_better():
    t = _trial("gold", win_score=0.9, lose_score=0.1)
    assert _prefers(t, lambda a: a.new.click) == 0.0


def test_prefers_honours_the_direction_flag():
    t = _trial("gold", win_score=0.9, lose_score=0.1)
    assert _prefers(t, lambda a: a.new.click, lower_is_better=False) == 1.0


def test_an_exact_tie_is_half_credit():
    t = _trial("gold", win_score=0.5, lose_score=0.5)
    assert _prefers(t, lambda a: a.new.click) == 0.5


def test_a_nan_is_half_credit_not_a_free_pass():
    """An undefined metric expresses no preference and must score as a coin flip.

    Dropping it from the denominator instead would flatter metrics that are
    frequently undefined, which is the opposite of what the report is for.
    """
    t = _trial("gold", win_score=float("nan"), lose_score=0.1)
    assert _prefers(t, lambda a: a.new.click) == 0.5


def test_an_undecided_trial_is_excluded_entirely():
    t = _trial(None, 0.0, 0.0)
    assert not t.decided
    assert np.isnan(_prefers(t, lambda a: a.new.click))


def test_concordance_counts_only_decided_trials():
    trials = [
        _trial("gold", 0.1, 0.9),   # agree
        _trial("gold", 0.9, 0.1),   # disagree
        _trial("gold", 0.5, 0.5),   # tie -> 0.5
        _trial(None, 0.0, 0.0),     # excluded
    ]
    agree, n = concordance(trials, lambda a: a.new.click)
    assert n == 3
    assert agree == pytest.approx(1.5)


# ── The sign test ───────────────────────────────────────────────────────────


def test_sign_test_is_symmetric_and_bounded():
    assert _binomial_sign_p(5, 10) == pytest.approx(1.0)
    assert _binomial_sign_p(0, 10) == _binomial_sign_p(10, 10)
    for k in range(11):
        p = _binomial_sign_p(k, 10)
        assert 0.0 <= p <= 1.0


def test_sign_test_matches_the_exact_binomial():
    # Two-sided: 2 * P(X <= 1) for n=10 == 2 * (1 + 10) / 1024.
    assert _binomial_sign_p(1, 10) == pytest.approx(2.0 * 11 / 1024)
    # A unanimous result is 2 * (1/2^n).
    assert _binomial_sign_p(10, 10) == pytest.approx(2.0 / 1024)


def test_sign_test_is_significant_only_for_a_lopsided_split():
    assert _binomial_sign_p(26, 33) < 0.05
    assert _binomial_sign_p(19, 33) > 0.05


def test_sign_test_handles_the_empty_case():
    assert np.isnan(_binomial_sign_p(0, 0))


# ── ratings.jsonl ───────────────────────────────────────────────────────────


def test_load_ratings_reads_records_and_survives_a_torn_line(tmp_path):
    good = {
        "trial_id": "a::optimizer_1_vs_gold", "sample_id": "a", "kind": "optimizer",
        "arm_order": ["gold", "optimizer_1"], "winner": "A",
        "winner_arm_id": "gold", "loser_arm_id": "optimizer_1", "failure_tags": [],
    }
    text = json.dumps(good) + "\n" + json.dumps(dict(good, trial_id="b")) + "\n" + '{"trial_id":"hal'
    (tmp_path / "ratings.jsonl").write_text(text, encoding="utf-8")
    recs = load_ratings(tmp_path)
    assert [r["trial_id"] for r in recs] == ["a::optimizer_1_vs_gold", "b"]


def test_load_ratings_requires_the_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_ratings(tmp_path)
