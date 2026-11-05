"""STFT / iSTFT in numpy, bit-comparable to the torch pair they replace.

This module exists so the sidecar can drop its torch dependency. Every tier
used torch for the transform pair and nothing else would have justified the
~1 GB the package costs once its own dependency tree is counted:

  * MDX-Net (FAST) infers in onnxruntime and used torch ONLY for this pair.
  * The Roformer tiers (BALANCED / BEST) ran the transform INSIDE the model's
    forward pass. ONNX has an STFT op but no inverse at all, so the pair has
    to come out of the graph for those tiers to be exportable regardless.

**These are not general-purpose transforms — they are reimplementations of
torch's, conventions included.** `tests/test_dsp.py` asserts that against the
real thing. The conventions that actually matter, all of which are silent
quality bugs rather than errors when wrong:

  * `center=True` reflect-pads by `n_fft // 2` either side. Padding with zeros
    instead puts a fade at both ends of every separated stem.
  * The window is a PERIODIC Hann (`sym=False` in scipy terms). The symmetric
    one is a different window and the reference implementations all use the
    periodic one.
  * iSTFT divides the overlap-added result by the overlap-added window SQUARE,
    not by the window. Dividing by the window sums to a comb.
  * The trim happens BEFORE the divide, which is what keeps the 0/0 at the
    edges of the unpadded region out of the output. torch does it in this
    order for the same reason.

Everything runs in float64 internally and returns float32/complex64. torch
computes its FFTs in the input dtype, so a float32 input there goes through a
float32 FFT; doing the same arithmetic in double and rounding once at the end
is strictly more accurate, and the parity tests are written to that tolerance
rather than to bit equality.
"""

from __future__ import annotations

from typing import Dict, Optional, Tuple

import numpy as np

__all__ = ["hann_window", "stft", "istft"]


def hann_window(window_length: int, periodic: bool = True) -> np.ndarray:
    """`torch.hann_window`, default (periodic) flavour.

    numpy's own `np.hanning` is the SYMMETRIC window — it is not this function
    and substituting it changes the analysis. Periodic means the window of
    length N is the first N points of the symmetric window of length N+1.
    """
    if window_length < 1:
        return np.zeros(0, dtype=np.float64)
    if window_length == 1:
        return np.ones(1, dtype=np.float64)
    denom = window_length if periodic else window_length - 1
    n = np.arange(window_length, dtype=np.float64)
    return 0.5 - 0.5 * np.cos(2.0 * np.pi * n / denom)


def _as_window(window: Optional[np.ndarray], n_fft: int) -> np.ndarray:
    if window is None:
        return np.ones(n_fft, dtype=np.float64)
    w = np.asarray(window, dtype=np.float64)
    if w.ndim != 1:
        raise ValueError(f"window must be 1-D, got shape {w.shape}")
    if w.shape[0] > n_fft:
        raise ValueError(f"window length {w.shape[0]} exceeds n_fft {n_fft}")
    if w.shape[0] < n_fft:
        # torch centres a short window inside n_fft rather than left-aligning.
        pad = n_fft - w.shape[0]
        left = pad // 2
        w = np.pad(w, (left, pad - left))
    return w


def stft(
    x: np.ndarray,
    n_fft: int,
    hop_length: int,
    window: Optional[np.ndarray] = None,
    center: bool = True,
    pad_mode: str = "reflect",
) -> np.ndarray:
    """`torch.stft(..., return_complex=True)`.

    `[..., n_samples]` real → `[..., n_fft // 2 + 1, n_frames]` complex64.
    """
    x = np.asarray(x)
    if x.ndim < 1:
        raise ValueError("stft input must have at least one dimension")
    if hop_length <= 0:
        raise ValueError(f"hop_length must be positive, got {hop_length}")

    win = _as_window(window, n_fft)
    lead = x.shape[:-1]
    flat = np.ascontiguousarray(x, dtype=np.float64).reshape(-1, x.shape[-1])

    if center:
        pad = n_fft // 2
        flat = np.pad(flat, ((0, 0), (pad, pad)), mode=pad_mode)

    n_padded = flat.shape[-1]
    if n_padded < n_fft:
        raise ValueError(
            f"input of {x.shape[-1]} samples is too short for n_fft={n_fft} "
            f"(padded length {n_padded})")

    n_frames = 1 + (n_padded - n_fft) // hop_length

    # sliding_window_view is a view, not a copy — the multiply below is what
    # materialises the frames, once.
    frames = np.lib.stride_tricks.sliding_window_view(flat, n_fft, axis=-1)
    frames = frames[:, ::hop_length][:, :n_frames]          # [b, n_frames, n_fft]

    spec = np.fft.rfft(frames * win, n=n_fft, axis=-1)      # [b, n_frames, n_bins]
    spec = np.swapaxes(spec, -1, -2)                        # [b, n_bins, n_frames]
    return spec.astype(np.complex64).reshape(lead + spec.shape[-2:])


# The window-square envelope depends only on (window bytes, n_fft, hop,
# n_frames), and a chunked run asks for the same one hundreds of times.
_ENVELOPE_CACHE: Dict[Tuple[int, int, int, int], np.ndarray] = {}
_ENVELOPE_CACHE_LIMIT = 32


def _window_envelope(win: np.ndarray, n_fft: int, hop_length: int, n_frames: int) -> np.ndarray:
    key = (hash(win.tobytes()), n_fft, hop_length, n_frames)
    hit = _ENVELOPE_CACHE.get(key)
    if hit is not None:
        return hit

    length = n_fft + hop_length * (n_frames - 1)
    env = np.zeros(length, dtype=np.float64)
    win_sq = win * win
    for i in range(n_frames):
        start = i * hop_length
        env[start: start + n_fft] += win_sq

    if len(_ENVELOPE_CACHE) >= _ENVELOPE_CACHE_LIMIT:
        _ENVELOPE_CACHE.clear()
    _ENVELOPE_CACHE[key] = env
    return env


def istft(
    X: np.ndarray,
    n_fft: int,
    hop_length: int,
    window: Optional[np.ndarray] = None,
    center: bool = True,
    length: Optional[int] = None,
) -> np.ndarray:
    """`torch.istft(..., return_complex=False)`.

    `[..., n_bins, n_frames]` complex → `[..., n_samples]` float32.
    """
    X = np.asarray(X)
    if X.ndim < 2:
        raise ValueError("istft input must have at least two dimensions")
    if hop_length <= 0:
        raise ValueError(f"hop_length must be positive, got {hop_length}")

    win = _as_window(window, n_fft)
    lead = X.shape[:-2]
    n_bins, n_frames = X.shape[-2], X.shape[-1]
    expected_bins = n_fft // 2 + 1
    if n_bins != expected_bins:
        raise ValueError(
            f"expected {expected_bins} frequency bins for n_fft={n_fft}, got {n_bins}")

    flat = np.ascontiguousarray(X, dtype=np.complex128).reshape(-1, n_bins, n_frames)

    frames = np.fft.irfft(flat, n=n_fft, axis=-2)           # [b, n_fft, n_frames]
    frames *= win[None, :, None]

    expected_len = n_fft + hop_length * (n_frames - 1)
    out = np.zeros((flat.shape[0], expected_len), dtype=np.float64)
    for i in range(n_frames):
        start = i * hop_length
        out[:, start: start + n_fft] += frames[:, :, i]

    env = _window_envelope(win, n_fft, hop_length, n_frames)

    start = n_fft // 2 if center else 0
    end = (start + length) if length is not None else (
        expected_len - (n_fft // 2 if center else 0))

    # A caller asking for more samples than the frames can supply gets zeros
    # for the excess, which is what torch does rather than erroring.
    if end > expected_len:
        pad = end - expected_len
        out = np.pad(out, ((0, 0), (0, pad)))
        env = np.pad(env, (0, pad))

    out = out[:, start: end]
    env = env[start: end]

    # Trimmed first, divided second — outside the trimmed span the envelope is
    # legitimately zero and the divide would be 0/0. Inside it, a zero means
    # the window/hop pair fails NOLA and the transform is not invertible;
    # torch raises there. Guarding instead of raising would hand back silence
    # that looks like a quiet mix rather than a broken one.
    lowest = np.abs(env).min() if env.size else 0.0
    if lowest <= 1e-11:
        raise ValueError(
            f"window overlap-add is not invertible for n_fft={n_fft}, "
            f"hop_length={hop_length} (envelope minimum {lowest:g}); "
            "the window and hop violate the NOLA condition")
    out /= env

    return out.astype(np.float32).reshape(lead + (out.shape[-1],))
