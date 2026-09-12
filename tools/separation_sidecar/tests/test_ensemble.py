"""ENSEMBLE averaging — a pure function over plain numpy arrays, no model,
no torch, no manifest. The job orchestration in pipeline.py that calls two
real separate() runs is exercised at a higher level (it needs real models,
so it is not unit-tested here — see NOTICE/the PR report for the manual
end-to-end verification instead).
"""

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.ensemble import average_stems  # noqa: E402


def stereo(value, n=1000):
    return np.full((2, n), value, dtype=np.float32)


def test_common_stems_are_averaged():
    a = {"Vocals": stereo(1.0), "Instrumental": stereo(3.0)}
    b = {"Vocals": stereo(3.0), "Instrumental": stereo(5.0)}
    averaged, dropped = average_stems(a, 44100, b, 44100)
    assert dropped == []
    assert np.allclose(averaged["Vocals"], 2.0)
    assert np.allclose(averaged["Instrumental"], 4.0)


def test_stems_present_in_only_one_model_are_dropped_not_passed_through():
    a = {"Vocals": stereo(1.0), "Instrumental": stereo(3.0)}
    b = {"Vocals": stereo(3.0)}
    averaged, dropped = average_stems(a, 44100, b, 44100)
    assert set(averaged.keys()) == {"Vocals"}
    assert dropped == ["Instrumental"]


def test_no_common_stems_averages_nothing():
    a = {"Vocals": stereo(1.0)}
    b = {"Instrumental": stereo(3.0)}
    averaged, dropped = average_stems(a, 44100, b, 44100)
    assert averaged == {}
    assert set(dropped) == {"Vocals", "Instrumental"}


def test_mismatched_lengths_are_trimmed_to_the_shorter():
    a = {"Vocals": stereo(1.0, n=1000)}
    b = {"Vocals": stereo(3.0, n=997)}
    averaged, _ = average_stems(a, 44100, b, 44100)
    assert averaged["Vocals"].shape[-1] == 997


def test_a_different_sample_rate_is_resampled_before_averaging():
    # b at half the sample rate of a: after resampling to a's rate, b's
    # array should be roughly twice as long as it started, and the average
    # should still land between the two constant values.
    a = {"Vocals": stereo(1.0, n=44100)}
    b = {"Vocals": stereo(3.0, n=22050)}
    averaged, dropped = average_stems(a, 44100, b, 22050)
    assert dropped == []
    assert averaged["Vocals"].shape[-1] > 22050 * 1.5
    assert 1.5 < float(averaged["Vocals"].mean()) < 2.5


def test_output_is_always_float32():
    a = {"Vocals": stereo(1.0).astype(np.float64)}
    b = {"Vocals": stereo(3.0).astype(np.float64)}
    averaged, _ = average_stems(a, 44100, b, 44100)
    assert averaged["Vocals"].dtype == np.float32
