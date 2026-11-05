"""Parity tests for the numpy STFT/iSTFT pair against the torch one it replaces.

**These tests skip when torch is absent, and that is the normal state.** torch
is no longer a runtime dependency of this sidecar — it was removed once the
Roformer tiers moved to onnxruntime — so a stock install runs everything here
except this file. That is the point: this file is the evidence that the numpy
pair reproduces what torch did, and it is run on a machine that still has torch
whenever `dsp.py` is touched.

`pip install torch --index-url https://download.pytorch.org/whl/cpu` is enough
to run them; nothing here needs a GPU or a model.

The parameter sets below are the REAL ones from the three shipped tiers, not
round numbers. A transform pair that agrees on a 1024/256 toy and disagrees at
n_fft=7680 hop=1024 would pass a prettier test and ship a broken FAST tier.
"""

from __future__ import annotations

import numpy as np
import pytest

from xleth_separation import dsp

torch = pytest.importorskip(
    "torch", reason="parity against torch needs torch; it is not a runtime dependency")


# (label, n_fft, hop_length) — every transform this sidecar actually performs.
TIER_PARAMS = [
    ("mdx_kim_vocal_2", 7680, 1024),
    ("mel_roformer_becruily_deux", 2048, 441),
    ("bs_roformer_ft1_anvuew", 2048, 512),
]


def _signal(n_samples: int, channels: int = 2, seed: int = 0) -> np.ndarray:
    """Broadband noise plus tones — not pure noise.

    A pure-noise signal hides ordering and conjugation mistakes: its spectrum
    is flat and symmetric enough that a transposed or mirrored bin axis still
    correlates. The tones give the comparison something with a known location.
    """
    rng = np.random.default_rng(seed)
    t = np.arange(n_samples, dtype=np.float64) / 44100.0
    out = np.empty((channels, n_samples), dtype=np.float32)
    for c in range(channels):
        tonal = (0.4 * np.sin(2 * np.pi * (220.0 * (c + 1)) * t)
                 + 0.2 * np.sin(2 * np.pi * 3150.0 * t + 0.7 * c))
        out[c] = (tonal + 0.25 * rng.standard_normal(n_samples)).astype(np.float32)
    return out


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
def test_hann_window_matches_torch(label, n_fft, hop):
    """Equal to within float32, and NOT to within float64 — on purpose.

    torch evaluates `0.5 - 0.5*cos(x)` in float32. Near the window's edges
    cos(x) is within 5e-6 of 1.0, so that subtraction is catastrophic
    cancellation: torch's second sample of a 2048-point window is 2.3543835e-06
    where the exact value is 2.3530952e-06 — wrong in its fourth significant
    digit. Ours is computed in float64 and is the more accurate of the two.

    The tolerance is therefore float32-scaled and absolute. Relative agreement
    is unobtainable at the edges and worthless there anyway: those samples are
    ~1e-6 of a window that peaks at 1.0, and what they multiply is scaled by
    the same ~1e-6.
    """
    ours = dsp.hann_window(n_fft, periodic=True)
    theirs = torch.hann_window(n_fft, periodic=True).numpy()
    assert ours.shape == theirs.shape
    diff = np.abs(ours - theirs).max()
    assert diff < 1e-6, f"{label}: periodic Hann differs by {diff:g}"

    # The exact double-precision window, to show which of the two is right.
    exact = 0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n_fft) / n_fft)
    assert np.abs(ours - exact).max() < 1e-15
    assert np.abs(theirs - exact).max() > np.abs(ours - exact).max()


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
def test_end_to_end_each_side_using_its_own_window(label, n_fft, hop):
    """The question the other tests deliberately do not ask.

    Every parity test here feeds BOTH implementations the same window, to
    isolate the transform from the window. This one lets each use the window it
    would actually use in production — ours float64, torch's float32-cancelled
    — because that difference is the one that ships, and "the transforms agree
    when handed identical inputs" would be a hollow result if the inputs they
    each construct diverged materially.
    """
    n_samples = n_fft * 6 + hop * 3
    x = _signal(n_samples)

    ours_spec = dsp.stft(x, n_fft=n_fft, hop_length=hop,
                         window=dsp.hann_window(n_fft, periodic=True), center=True)
    ours = dsp.istft(ours_spec, n_fft=n_fft, hop_length=hop,
                     window=dsp.hann_window(n_fft, periodic=True),
                     center=True, length=n_samples)

    torch_window = torch.hann_window(n_fft, periodic=True)
    theirs_spec = torch.stft(torch.from_numpy(x), n_fft=n_fft, hop_length=hop,
                             window=torch_window, center=True, return_complex=True)
    theirs = torch.istft(theirs_spec, n_fft=n_fft, hop_length=hop,
                         window=torch_window, center=True, length=n_samples).numpy()

    scale = float(np.abs(theirs).max())
    diff = float(np.abs(ours - theirs).max())
    assert diff < 2e-5 * scale, f"{label}: end-to-end diff {diff:g} (scale {scale:g})"


def test_hann_window_is_not_the_symmetric_one():
    """np.hanning is the symmetric window and is the wrong one here.

    Asserting the difference rather than only the match: if someone ever
    "simplifies" hann_window to np.hanning, every parity test above still
    passes on n_fft=2048 to within 1e-3, which is not a tolerance that catches
    it — but the endpoint does, unmistakably.
    """
    n = 2048
    periodic = dsp.hann_window(n, periodic=True)
    symmetric = np.hanning(n)
    assert not np.allclose(periodic, symmetric, atol=1e-6)
    assert periodic[-1] > 1e-6          # periodic never returns to zero
    assert symmetric[-1] == pytest.approx(0.0, abs=1e-12)


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
@pytest.mark.parametrize("center", [True, False])
def test_stft_matches_torch(label, n_fft, hop, center):
    n_samples = n_fft * 6 + hop * 3        # deliberately not a whole frame count
    x = _signal(n_samples)

    window = dsp.hann_window(n_fft, periodic=True)
    ours = dsp.stft(x, n_fft=n_fft, hop_length=hop, window=window, center=center)

    theirs = torch.stft(
        torch.from_numpy(x), n_fft=n_fft, hop_length=hop,
        window=torch.from_numpy(window).float(), center=center,
        return_complex=True).numpy()

    assert ours.shape == theirs.shape, f"{label}: shape {ours.shape} vs {theirs.shape}"

    # Scaled to the transform's own magnitude: an n_fft of 7680 sums 7680
    # windowed samples per bin, so a fixed 1e-6 would be asking for more
    # precision than float32 carries at that scale.
    scale = float(np.abs(theirs).max())
    assert np.allclose(ours, theirs, atol=2e-4 * scale, rtol=1e-4), (
        f"{label}: max abs diff {np.abs(ours - theirs).max():g} (scale {scale:g})")


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
def test_istft_matches_torch(label, n_fft, hop):
    n_samples = n_fft * 6 + hop * 3
    x = _signal(n_samples)
    window = dsp.hann_window(n_fft, periodic=True)

    # Both inverses are fed the SAME spectrogram — torch's — so this isolates
    # the inverse. Feeding each its own forward output would let a matched pair
    # of forward and inverse errors cancel and pass.
    spec = torch.stft(
        torch.from_numpy(x), n_fft=n_fft, hop_length=hop,
        window=torch.from_numpy(window).float(), center=True,
        return_complex=True)

    theirs = torch.istft(
        spec, n_fft=n_fft, hop_length=hop,
        window=torch.from_numpy(window).float(), center=True,
        length=n_samples).numpy()

    ours = dsp.istft(
        spec.numpy(), n_fft=n_fft, hop_length=hop, window=window,
        center=True, length=n_samples)

    assert ours.shape == theirs.shape
    scale = float(np.abs(theirs).max())
    assert np.allclose(ours, theirs, atol=2e-5 * scale, rtol=1e-4), (
        f"{label}: max abs diff {np.abs(ours - theirs).max():g} (scale {scale:g})")


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
def test_istft_without_length_matches_torch(label, n_fft, hop):
    """The `length=None` path trims differently and is used by the MDX tier."""
    n_samples = n_fft * 5
    x = _signal(n_samples)
    window = dsp.hann_window(n_fft, periodic=True)

    spec = torch.stft(
        torch.from_numpy(x), n_fft=n_fft, hop_length=hop,
        window=torch.from_numpy(window).float(), center=True, return_complex=True)

    theirs = torch.istft(spec, n_fft=n_fft, hop_length=hop,
                         window=torch.from_numpy(window).float(), center=True).numpy()
    ours = dsp.istft(spec.numpy(), n_fft=n_fft, hop_length=hop,
                     window=window, center=True)

    assert ours.shape == theirs.shape
    scale = float(np.abs(theirs).max())
    assert np.allclose(ours, theirs, atol=2e-5 * scale, rtol=1e-4)


@pytest.mark.parametrize("label,n_fft,hop", TIER_PARAMS)
def test_round_trip_reconstructs_the_signal(label, n_fft, hop):
    """Our forward into our inverse returns the input.

    Independent of torch: a pair that agreed with torch on both halves but got
    the centring convention wrong in BOTH directions would pass the two tests
    above and still destroy the audio.
    """
    n_samples = n_fft * 6 + hop * 3
    x = _signal(n_samples)
    window = dsp.hann_window(n_fft, periodic=True)

    spec = dsp.stft(x, n_fft=n_fft, hop_length=hop, window=window, center=True)
    back = dsp.istft(spec, n_fft=n_fft, hop_length=hop, window=window,
                     center=True, length=n_samples)

    assert back.shape == x.shape
    # The reflect-padded edges are the only places reconstruction is inexact.
    interior = slice(n_fft, n_samples - n_fft)
    assert np.allclose(back[:, interior], x[:, interior], atol=2e-5), (
        f"{label}: round trip max interior error "
        f"{np.abs(back[:, interior] - x[:, interior]).max():g}")


def test_batched_shapes_are_preserved():
    """The MDX tier hands in [batch, 2, chunk] and gets [batch, 2, bins, frames]."""
    n_fft, hop = 2048, 512
    x = _signal(n_fft * 4, channels=2)
    batched = np.stack([x, x * 0.5, x * 0.25])           # [3, 2, n]
    window = dsp.hann_window(n_fft, periodic=True)

    spec = dsp.stft(batched, n_fft=n_fft, hop_length=hop, window=window)
    assert spec.shape[:2] == (3, 2)
    assert spec.shape[2] == n_fft // 2 + 1

    back = dsp.istft(spec, n_fft=n_fft, hop_length=hop, window=window,
                     length=batched.shape[-1])
    assert back.shape == batched.shape
    # The scaling of the three batch entries has to survive independently —
    # a flattening bug that mixed them would still return the right shape.
    assert np.allclose(back[1], back[0] * 0.5, atol=1e-5)
    assert np.allclose(back[2], back[0] * 0.25, atol=1e-5)


def test_istft_refuses_a_non_invertible_hop():
    """NOLA violations raise rather than returning quiet rubbish."""
    n_fft = 64
    window = dsp.hann_window(n_fft, periodic=True)
    spec = np.zeros((n_fft // 2 + 1, 4), dtype=np.complex64)
    with pytest.raises(ValueError, match="NOLA"):
        dsp.istft(spec, n_fft=n_fft, hop_length=n_fft, window=window, center=False)


def test_stft_rejects_input_shorter_than_a_frame():
    window = dsp.hann_window(2048, periodic=True)
    with pytest.raises(ValueError, match="too short"):
        dsp.stft(np.zeros((2, 16), dtype=np.float32), n_fft=2048,
                 hop_length=512, window=window, center=False)
