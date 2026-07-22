"""Ingest chain and pitch tracker."""

from __future__ import annotations

import numpy as np
import pytest

from loop_optimizer.constants import ENGINE_SAMPLE_RATE
from loop_optimizer.features import measure_features
from loop_optimizer.ingest import (
    apply_sample_bank_fades,
    ingest_file,
    merge_to_mono,
    resample,
)
from loop_optimizer.pitch import detect_steady_state_window, track_pitch
from loop_optimizer.wavio import read_wav, write_wav

SR = ENGINE_SAMPLE_RATE


def sine(freq, n, sr=SR, amp=0.5):
    t = np.arange(n) / sr
    return amp * np.sin(2 * np.pi * freq * t)


# ── ingest ───────────────────────────────────────────────────────────────────


def test_merge_to_mono_averages_channels():
    stereo = np.array([[1.0, 0.0], [0.5, 0.5], [-1.0, 1.0]])
    assert np.allclose(merge_to_mono(stereo), [0.5, 0.5, 0.0])
    mono = np.array([[0.25], [0.75]])
    assert np.allclose(merge_to_mono(mono), [0.25, 0.75])


def test_resample_is_a_noop_when_rates_match():
    """Mirrors the engine's own "within 0.5 Hz is the same rate" test."""
    x = sine(440, 1000)
    assert np.array_equal(resample(x, 48000.0, 48000.0), x)
    assert np.array_equal(resample(x, 48000.0, 48000.4), x)


def test_resample_preserves_frequency_and_length():
    """44.1k -> 48k must keep the tone's frequency and stretch the length."""
    src_rate, dst_rate, freq = 44100.0, 48000.0, 440.0
    n = 44100
    x = np.sin(2 * np.pi * freq * np.arange(n) / src_rate)
    y = resample(x, src_rate, dst_rate)

    assert y.shape[0] == pytest.approx(n * dst_rate / src_rate, rel=1e-3)
    # Locate the spectral peak; it must still be at 440 Hz in the new domain.
    spectrum = np.abs(np.fft.rfft(y * np.hanning(y.size)))
    peak_hz = float(np.argmax(spectrum)) * dst_rate / y.size
    assert peak_hz == pytest.approx(freq, abs=2.0)


def test_resample_does_not_introduce_large_artefacts():
    """Round-tripping 44.1k -> 48k -> 44.1k should return roughly the input."""
    x = sine(1000.0, 8000, sr=44100.0)
    there = resample(x, 44100.0, 48000.0)
    back = resample(there, 48000.0, 44100.0)
    n = min(x.size, back.size)
    # Ignore the kernel's edge transient at both ends.
    edge = 200
    err = np.abs(x[edge : n - edge] - back[edge : n - edge]).max()
    assert err < 1e-2


def test_sample_bank_fades_match_the_engine_ramp():
    """SampleBank.cpp:469-488 — linear, 2 ms, first sample hard zero."""
    x = np.ones(48000)
    y = apply_sample_bank_fades(x, 48000.0)
    fade = int(48000.0 * 0.002)  # 96 samples
    assert y[0] == 0.0
    assert y[fade] == pytest.approx(1.0)
    assert y[fade // 2] == pytest.approx(0.5, abs=1e-9)
    assert y[-1] == 0.0
    assert y[-1 - fade] == pytest.approx(1.0)
    assert np.all(y[fade : y.size - fade] == 1.0)


def test_sample_bank_fades_cannot_overlap():
    x = np.ones(10)
    y = apply_sample_bank_fades(x, 48000.0)  # fade would be 96, clamped to 5
    assert y.size == 10
    assert y[0] == 0.0 and y[-1] == 0.0


def test_wav_roundtrip_and_ingest(tmp_path):
    path = tmp_path / "tone.wav"
    x = sine(440.0, 4410, sr=44100.0).astype(np.float32)
    write_wav(path, x, 44100)

    wav = read_wav(path)
    assert wav.sample_rate == 44100 and wav.num_channels == 1
    assert np.allclose(wav.data[:, 0], x, atol=1e-6)

    sample = ingest_file(path)
    assert sample.sample_rate == SR
    assert sample.file_sample_rate == 44100
    # Domain conversion is a proper inverse pair.
    assert sample.engine_to_file(sample.file_to_engine(1000.0)) == pytest.approx(1000.0)
    assert sample.file_to_engine(44100) == pytest.approx(48000)


# ── pitch ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("freq", [110.0, 261.63, 440.0, 525.0, 880.0, 1500.0])
def test_yin_recovers_synthetic_pitches(freq):
    """Including 525 Hz, the C5 that the old 500 Hz ceiling resolved an octave low."""
    x = sine(freq, int(SR * 0.4)) + 0.3 * sine(2 * freq, int(SR * 0.4))
    track = track_pitch(x, SR)
    assert track.voiced_fraction > 0.9
    measured = SR / track.median_period()
    assert measured == pytest.approx(freq, rel=0.005)


def test_yin_reports_noise_as_unvoiced():
    rng = np.random.default_rng(0)
    x = rng.standard_normal(int(SR * 0.3)) * 0.3
    track = track_pitch(x, SR)
    assert track.voiced_fraction < 0.5


def test_yin_handles_silence_without_dividing_by_zero():
    track = track_pitch(np.zeros(int(SR * 0.2)), SR)
    assert track.voiced_fraction == 0.0
    assert np.all(np.isfinite(track.clarity))


def test_steady_state_window_skips_attack_and_decay():
    """The window should land on the sustain, not on the ramp at either end."""
    n = int(SR * 1.2)
    x = sine(220.0, n)
    env = np.ones(n)
    attack = int(SR * 0.25)
    release = int(SR * 0.3)
    env[:attack] = np.linspace(0.0, 1.0, attack)
    env[n - release :] = np.linspace(1.0, 0.0, release)
    x = x * env

    track = track_pitch(x, SR)
    window = detect_steady_state_window(track, n)

    assert window.viable, window.reason
    assert window.start >= attack * 0.5, "window started inside the attack ramp"
    assert window.end <= n - release * 0.3, "window ran into the release ramp"
    assert window.period == pytest.approx(SR / 220.0, rel=0.01)


def test_steady_state_window_refuses_noise():
    rng = np.random.default_rng(1)
    track = track_pitch(rng.standard_normal(int(SR * 0.5)) * 0.2, SR)
    window = detect_steady_state_window(track, int(SR * 0.5))
    assert not window.viable
    assert window.reason


def test_steady_state_window_ignores_a_loud_overtone_region():
    """A loud region voiced at an OVERTONE must not be taken for the sustain.

    Mirrors the Pitch_17_C3 case documented in LoopOptimizer.h: the tonal band
    around the fundamental, not the level, decides what counts as sustain.
    """
    body = sine(150.0, int(SR * 0.8), amp=0.3)  # the real fundamental, quieter
    overtone = sine(600.0, int(SR * 0.4), amp=0.9)  # 4x, much louder
    x = np.concatenate([body, overtone])

    track = track_pitch(x, SR)
    window = detect_steady_state_window(track, x.size)
    assert window.viable, window.reason
    # The window must sit in the fundamental's part of the file, not the loud
    # overtone tail, even though the tail is 10 dB hotter.
    assert window.end <= int(SR * 0.8) + 2048
    assert window.period == pytest.approx(SR / 150.0, rel=0.05)


# ── features ─────────────────────────────────────────────────────────────────


def test_measured_features_on_a_steady_tone():
    x = sine(440.0, int(SR * 0.5))
    features = measure_features(track_pitch(x, SR))
    assert features.median_f0_hz == pytest.approx(440.0, rel=0.005)
    assert features.f0_cents_std < 5.0  # a pure tone barely jitters
    assert features.voiced_fraction > 0.95
    assert abs(features.decay_slope_db_per_sec) < 1.0  # steady, so flat
    assert abs(features.cents_from_equal_temperament) < 5.0  # A440 is on the grid


def test_measured_features_detect_a_decay():
    n = int(SR * 1.0)
    x = sine(440.0, n) * np.exp(-3.0 * np.arange(n) / SR)
    features = measure_features(track_pitch(x, SR))
    # exp(-3t) is about -26 dB/s.
    assert features.decay_slope_db_per_sec == pytest.approx(-26.0, abs=4.0)


def test_f0_jitter_ignores_octave_outliers_but_counts_them():
    """A steady tone with a few octave-errored hops must still read as steady.

    A single hop an octave out contributes 1200 cents to an ungated standard
    deviation. Splicing a short 2x segment onto a steady tone simulates exactly
    what YIN does in a decaying tail, and the jitter must stay small while the
    outlier fraction records that it happened.
    """
    steady = sine(300.0, int(SR * 0.9))
    octave_up = sine(600.0, int(SR * 0.15))
    x = np.concatenate([steady, octave_up])

    features = measure_features(track_pitch(x, SR))
    assert features.median_f0_hz == pytest.approx(300.0, rel=0.01)
    assert features.f0_cents_std < 20.0, "octave hops leaked into the jitter statistic"
    assert features.octave_outlier_fraction > 0.05, "the octave hops were not counted"


def test_measured_features_survive_silence():
    features = measure_features(track_pitch(np.zeros(int(SR * 0.2)), SR))
    assert np.isnan(features.median_f0_hz)
    assert features.voiced_fraction == 0.0
