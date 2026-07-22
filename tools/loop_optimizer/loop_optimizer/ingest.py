"""File -> engine-domain ingest.

Reproduces what happens to a sample between "user drops a WAV on a pad" and
"the Sampler reads index N", because every loop point this tool reasons about is
an index into the *post-ingest* buffer, not into the file.

The chain, from engine/src/SampleBank.cpp:

  1. decode to float                         (:52-53)
  2. resample to the engine rate if it differs, storing
     ``bufferSampleRate = engineSampleRate`` (:59-79, :96)
  3. 2 ms linear fades at both buffer ends    (:86, :469-488)

Step 2 is why ``dataset.json`` stores gold loop points in the FILE domain while
the engine holds them in the 48 kHz domain: ui/electron-main/loopLabExport.js
``convertGold`` multiplies by ``fileRate / engineRate`` on the way out. This
module provides the inverse.

DOCUMENTED DIVERGENCE — resampler kernel. The engine resamples with JUCE's
``LagrangeInterpolator`` (SampleBank.cpp:69), a 5-point Lagrange FIR. This tool
uses a windowed-sinc (Kaiser) resampler instead. The reason is that a 5-point
Lagrange is a poor anti-imaging filter with several dB of droop approaching
Nyquist, and reproducing its exact passband error would put a rate-conversion
artefact into every spectral measurement while telling us nothing about the loop
seam. Both gold and candidates are measured on the identical ingested signal, so
the comparison the tool exists to make is unaffected. When this analysis is
ported into the engine it will run on the engine's own buffer and the question
disappears entirely.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .constants import ENGINE_SAMPLE_RATE, SAMPLE_BANK_FADE_SEC
from .wavio import read_wav

#: Half-width of the resampling kernel in zero crossings. 16 gives a stopband
#: well below 16-bit noise; the cost is linear and irrelevant at corpus size.
_SINC_HALF_WIDTH = 16

#: Kaiser beta. 8.6 is the textbook choice for ~-90 dB stopband attenuation.
_KAISER_BETA = 8.6


@dataclass(frozen=True)
class IngestedSample:
    """A sample as the engine's Sampler would see it."""

    #: Mono, float64, engine-rate. Index this with engine-domain loop points.
    x: np.ndarray
    #: Always ``ENGINE_SAMPLE_RATE``; carried explicitly so callers never guess.
    sample_rate: float
    #: The rate the file was stored at, for domain conversion.
    file_sample_rate: int
    #: Frame count in the FILE domain, for domain conversion.
    file_num_frames: int
    #: Channel count before the mono merge.
    file_num_channels: int

    @property
    def num_samples(self) -> int:
        return int(self.x.shape[0])

    def file_to_engine(self, n: float) -> float:
        """Convert a FILE-domain sample index to the engine domain."""
        return float(n) * (self.sample_rate / float(self.file_sample_rate))

    def engine_to_file(self, n: float) -> float:
        """Inverse of :meth:`file_to_engine` — mirrors ``convertGold``."""
        return float(n) * (float(self.file_sample_rate) / self.sample_rate)


def merge_to_mono(data: np.ndarray) -> np.ndarray:
    """Average channels down to mono.

    The engine keeps sample buffers multi-channel and the Sampler reads
    ``srcCh = min(ch, nCh - 1)`` per output channel (Sampler.cpp:1121), i.e. it
    never mixes. This tool measures a single seam, so it merges first; for the
    monophonic tonal material in scope the channels are near-identical and the
    merge is a no-op in all but rounding. Recorded here because it IS a
    divergence: a sample with genuinely decorrelated channels would need one
    measurement per channel.
    """
    arr = np.asarray(data, dtype=np.float64)
    if arr.ndim == 1:
        return arr
    if arr.shape[1] == 1:
        return arr[:, 0]
    return arr.mean(axis=1)


def resample(x: np.ndarray, src_rate: float, dst_rate: float) -> np.ndarray:
    """Windowed-sinc resample. Returns ``x`` untouched when the rates match."""
    if abs(src_rate - dst_rate) <= 0.5:
        # Mirrors the engine's own "close enough" test (SampleBank.cpp:59).
        return np.asarray(x, dtype=np.float64)

    x = np.asarray(x, dtype=np.float64)
    n_in = x.shape[0]
    if n_in == 0:
        return x.copy()

    speed_ratio = src_rate / dst_rate  # input samples advanced per output sample
    n_out = int(np.ceil(n_in / speed_ratio))  # mirrors SampleBank.cpp:62-63

    # Cutoff, in cycles per input sample. Downsampling must lower the cutoff to
    # the output Nyquist to avoid aliasing; upsampling keeps the input Nyquist.
    cutoff = min(1.0, 1.0 / speed_ratio)
    half = _SINC_HALF_WIDTH / cutoff

    pos = np.arange(n_out, dtype=np.float64) * speed_ratio
    base = np.floor(pos).astype(np.int64)
    frac = pos - base

    taps = np.arange(-int(np.ceil(half)) + 1, int(np.ceil(half)) + 1, dtype=np.int64)
    # offset[o, t] = distance from output position o to input sample base+taps[t]
    offset = taps[None, :].astype(np.float64) - frac[:, None]

    win_arg = 1.0 - (offset / half) ** 2
    np.clip(win_arg, 0.0, None, out=win_arg)
    window = np.i0(_KAISER_BETA * np.sqrt(win_arg)) / np.i0(_KAISER_BETA)
    kernel = cutoff * np.sinc(cutoff * offset) * window

    idx = base[:, None] + taps[None, :]
    inside = (idx >= 0) & (idx < n_in)
    gathered = np.where(inside, x[np.clip(idx, 0, n_in - 1)], 0.0)
    return np.einsum("ot,ot->o", gathered, kernel)


def apply_sample_bank_fades(x: np.ndarray, sample_rate: float) -> np.ndarray:
    """Mirror ``SampleBank::applyFades`` (engine/src/SampleBank.cpp:469-488).

    2 ms LINEAR (not Hann — that is the separate declick) ramps at both buffer
    ends. Note the exact ramp shape: ``data[i] *= i / fadeSamples``, so the first
    sample is hard zero and the ramp never reaches 1.0 until index ``fadeSamples``.
    The fade-out mirrors it from the last sample inward.

    Only observable for loops placed within 2 ms of a buffer edge, which is
    pathological but not impossible — so it is emulated rather than assumed away.
    """
    y = np.array(x, dtype=np.float64, copy=True)
    total = y.shape[0]
    # int() truncation, matching static_cast<int> in the C++.
    fade = min(int(sample_rate * SAMPLE_BANK_FADE_SEC), total // 2)
    if fade <= 0:
        return y
    ramp = np.arange(fade, dtype=np.float64) / float(fade)
    y[:fade] *= ramp
    y[total - fade :] *= ramp[::-1]
    return y


def ingest_file(path: str | Path, engine_rate: float = ENGINE_SAMPLE_RATE) -> IngestedSample:
    """Read a WAV and put it in the engine domain."""
    wav = read_wav(path)
    mono = merge_to_mono(wav.data)
    resampled = resample(mono, float(wav.sample_rate), engine_rate)
    faded = apply_sample_bank_fades(resampled, engine_rate)
    return IngestedSample(
        x=faded,
        sample_rate=engine_rate,
        file_sample_rate=wav.sample_rate,
        file_num_frames=wav.num_frames,
        file_num_channels=wav.num_channels,
    )
