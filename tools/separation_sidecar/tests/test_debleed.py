"""DE-BLEED post-pass — a ratio mask computed from two finished stems, no
model, no download. Tested with plain synthetic tones so the effect (bleed
shrinks, dominant content survives) is unambiguous, without needing any real
separation output.
"""

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.debleed import can_de_bleed, de_bleed  # noqa: E402

SR = 44100


def two_leaky_tones(duration=3.0):
    """Vocals: mostly 440 Hz with a small 110 Hz leak. Instrumental: the
    mirror image. Each leak is 1/10th the amplitude of its stem's own tone."""
    n = int(SR * duration)
    t = np.arange(n) / SR
    vocals = 0.5 * np.sin(2 * np.pi * 440 * t) + 0.05 * np.sin(2 * np.pi * 110 * t)
    inst = 0.5 * np.sin(2 * np.pi * 110 * t) + 0.05 * np.sin(2 * np.pi * 440 * t)
    return {
        "Vocals": np.stack([vocals, vocals]).astype(np.float32),
        "Instrumental": np.stack([inst, inst]).astype(np.float32),
    }


def band_energy(x, f0, bw=5):
    spectrum = np.abs(np.fft.rfft(x[0]))
    freqs = np.fft.rfftfreq(x.shape[-1], d=1 / SR)
    band = (freqs > f0 - bw) & (freqs < f0 + bw)
    return float(spectrum[band].sum())


def test_can_de_bleed_is_true_only_for_exactly_two_stems():
    assert can_de_bleed({"a": None, "b": None}) is True
    assert can_de_bleed({"a": None}) is False
    assert can_de_bleed({"a": None, "b": None, "c": None}) is False


def test_three_stems_is_a_no_op():
    """With more than two stems, 'the other stem's evidence' is not a single
    well-defined thing, so this pass must not touch anything rather than
    redistribute energy arbitrarily."""
    pytest.importorskip("torch")
    stems = two_leaky_tones()
    three = {"A": stems["Vocals"], "B": stems["Instrumental"], "C": stems["Vocals"]}
    out = de_bleed(three, SR)
    assert out is three or all(np.array_equal(out[k], three[k]) for k in three)


def test_bleed_shrinks_and_the_dominant_tone_survives():
    pytest.importorskip("torch")
    stems = two_leaky_tones()
    cleaned = de_bleed(stems, SR)

    vocals_leak_before = band_energy(stems["Vocals"], 110)
    vocals_leak_after = band_energy(cleaned["Vocals"], 110)
    inst_leak_before = band_energy(stems["Instrumental"], 440)
    inst_leak_after = band_energy(cleaned["Instrumental"], 440)

    # The leaked band shrinks substantially...
    assert vocals_leak_after < vocals_leak_before * 0.5
    assert inst_leak_after < inst_leak_before * 0.5

    # ...while each stem's own dominant tone is still clearly present.
    vocals_own_before = band_energy(stems["Vocals"], 440)
    vocals_own_after = band_energy(cleaned["Vocals"], 440)
    assert vocals_own_after > vocals_own_before * 0.5


def test_shape_sample_rate_and_names_are_preserved():
    pytest.importorskip("torch")
    stems = two_leaky_tones(duration=1.0)
    cleaned = de_bleed(stems, SR)
    assert set(cleaned.keys()) == set(stems.keys())
    for name in stems:
        assert cleaned[name].shape == stems[name].shape
        assert cleaned[name].dtype == np.float32


def test_mismatched_lengths_are_trimmed_to_the_shorter():
    pytest.importorskip("torch")
    stems = two_leaky_tones(duration=1.0)
    stems["Instrumental"] = stems["Instrumental"][:, :-100]
    cleaned = de_bleed(stems, SR)
    expected = stems["Instrumental"].shape[-1]
    assert cleaned["Vocals"].shape[-1] == expected
    assert cleaned["Instrumental"].shape[-1] == expected
