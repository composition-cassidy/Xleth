"""Audio load / resample / save for the separation sidecar.

MDX-Net weights are trained at 44100 Hz. Feeding them anything else does not
error — it just shifts every frequency the model learned, which shows up as a
quietly worse separation rather than a failure. So the contract here is
explicit: everything is resampled to the model's own rate on the way in, and
the stems come back out at that rate. The caller (the Electron layer-add path)
re-imports the stems through the engine's normal loader, which handles rate
conversion for playback the same way it does for any other file.

Resampling quality is not negotiable for a source generator whose output the
user will keep and edit, so this module refuses to fall back to a naive
interpolation: if no real resampler is installed it raises with the install
line rather than silently producing aliased stems.
"""

from __future__ import annotations

from pathlib import Path
from typing import Tuple

import numpy as np
import soundfile as sf

_RESAMPLER_HINT = (
    "No high-quality resampler is available. Install one with:\n"
    "    pip install soxr\n"
    "(or `pip install scipy`, which this module will use as a fallback)."
)


def _resample(x: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Resample `x` (shape [channels, samples], float32) src_rate → dst_rate."""
    if src_rate == dst_rate:
        return x

    try:
        import soxr  # type: ignore

        # soxr wants [samples, channels]; VHQ is the default quality and is
        # what we want for material the user keeps.
        out = soxr.resample(x.T.astype(np.float32), src_rate, dst_rate, quality="VHQ")
        return np.ascontiguousarray(out.T, dtype=np.float32)
    except ImportError:
        pass

    try:
        from math import gcd

        from scipy.signal import resample_poly  # type: ignore

        g = gcd(int(src_rate), int(dst_rate))
        up, down = int(dst_rate) // g, int(src_rate) // g
        out = resample_poly(x, up, down, axis=1)
        return np.ascontiguousarray(out, dtype=np.float32)
    except ImportError:
        raise RuntimeError(_RESAMPLER_HINT) from None


def load_audio(path: Path | str, target_rate: int) -> Tuple[np.ndarray, int]:
    """Read `path` as float32 stereo at `target_rate`.

    Returns (samples, original_rate). `samples` is [2, n] — MDX's input layout
    is fixed at 2 channels, so mono is duplicated rather than rejected, and
    anything wider is downmixed by averaging. `original_rate` is reported so
    the caller can say what it did.
    """
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    x = np.ascontiguousarray(data.T, dtype=np.float32)  # [channels, samples]

    if x.shape[0] == 1:
        x = np.repeat(x, 2, axis=0)
    elif x.shape[0] > 2:
        # Average down rather than dropping channels: a 5.1 source whose
        # vocal sits in the centre channel would otherwise separate to silence.
        mono = x.mean(axis=0, keepdims=True)
        x = np.repeat(mono, 2, axis=0)

    x = _resample(x, int(rate), int(target_rate))
    return x, int(rate)


def save_audio(path: Path | str, x: np.ndarray, rate: int, subtype: str = "FLOAT") -> None:
    """Write [channels, samples] float32 to a WAV.

    32-bit float, not 16-bit int: a stem is an intermediate the user will edit
    further in the Sandbox, and a separation residual can legitimately exceed
    ±1.0 in places. Clipping it on the way to disk would bake in damage the
    op-stack could otherwise undo.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), np.ascontiguousarray(x.T, dtype=np.float32), int(rate), subtype=subtype)


def duration_seconds(x: np.ndarray, rate: int) -> float:
    return float(x.shape[1]) / float(rate) if rate else 0.0
