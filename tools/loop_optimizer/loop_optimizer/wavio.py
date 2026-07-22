"""Minimal RIFF/WAVE reader and writer.

Hand-rolled rather than using :mod:`wave` because the corpus mixes formats
(16-bit mono 44.1 kHz and 16-bit stereo 48 kHz today, float32 and 24-bit
plausible tomorrow) and :mod:`wave` neither reports the format tag usefully nor
decodes 24-bit or float payloads. This is small enough to be obviously correct.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_IEEE_FLOAT = 0x0003
WAVE_FORMAT_EXTENSIBLE = 0xFFFE


@dataclass(frozen=True)
class WavFile:
    """Decoded WAV contents.

    ``data`` is float64 in [-1, 1], shape ``(num_frames, num_channels)``. Float64
    rather than float32 throughout the tool: the engine is float32, but carrying
    the analysis in float64 keeps the *measurement* error well below the effect
    being measured. The one place that matters — the emulated render — is
    rounded back to float32 explicitly. See :mod:`loop_optimizer.engine_emu`.
    """

    data: np.ndarray
    sample_rate: int
    num_frames: int
    num_channels: int
    bits_per_sample: int
    format_tag: int


def _iter_chunks(blob: bytes):
    """Yield ``(chunk_id, payload)`` for each top-level RIFF chunk."""
    off = 12  # past "RIFF" + size + "WAVE"
    n = len(blob)
    while off + 8 <= n:
        cid = blob[off : off + 4]
        (size,) = struct.unpack_from("<I", blob, off + 4)
        payload = blob[off + 8 : off + 8 + size]
        yield cid, payload
        off += 8 + size + (size & 1)  # chunks are word-aligned


def read_wav(path: str | Path) -> WavFile:
    blob = Path(path).read_bytes()
    if blob[:4] != b"RIFF" or blob[8:12] != b"WAVE":
        raise ValueError(f"not a RIFF/WAVE file: {path}")

    fmt = None
    data = None
    for cid, payload in _iter_chunks(blob):
        if cid == b"fmt " and fmt is None:
            fmt = payload
        elif cid == b"data" and data is None:
            data = payload
    if fmt is None or data is None:
        raise ValueError(f"WAV missing fmt or data chunk: {path}")

    tag, channels, rate, _byte_rate, _align, bits = struct.unpack_from("<HHIIHH", fmt, 0)
    if tag == WAVE_FORMAT_EXTENSIBLE and len(fmt) >= 40:
        # The real format tag is the first two bytes of the SubFormat GUID.
        (tag,) = struct.unpack_from("<H", fmt, 24)

    if tag == WAVE_FORMAT_PCM and bits == 16:
        raw = np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0
    elif tag == WAVE_FORMAT_PCM and bits == 8:
        # 8-bit WAV is unsigned with a 128 offset.
        raw = (np.frombuffer(data, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif tag == WAVE_FORMAT_PCM and bits == 24:
        b = np.frombuffer(data, dtype=np.uint8)
        usable = (len(b) // 3) * 3
        b = b[:usable].reshape(-1, 3).astype(np.int32)
        packed = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        packed = np.where(packed & 0x800000, packed - 0x1000000, packed)
        raw = packed.astype(np.float64) / 8388608.0
    elif tag == WAVE_FORMAT_PCM and bits == 32:
        raw = np.frombuffer(data, dtype="<i4").astype(np.float64) / 2147483648.0
    elif tag == WAVE_FORMAT_IEEE_FLOAT and bits == 32:
        raw = np.frombuffer(data, dtype="<f4").astype(np.float64)
    elif tag == WAVE_FORMAT_IEEE_FLOAT and bits == 64:
        raw = np.frombuffer(data, dtype="<f8").astype(np.float64)
    else:
        raise ValueError(f"unsupported WAV format tag={tag} bits={bits}: {path}")

    channels = max(1, int(channels))
    frames = len(raw) // channels
    samples = raw[: frames * channels].reshape(frames, channels)
    return WavFile(
        data=samples,
        sample_rate=int(rate),
        num_frames=frames,
        num_channels=channels,
        bits_per_sample=int(bits),
        format_tag=int(tag),
    )


def write_wav(path: str | Path, data: np.ndarray, sample_rate: int) -> None:
    """Write float32 WAV. Used only to dump rendered seams for listening."""
    arr = np.asarray(data, dtype=np.float32)
    if arr.ndim == 1:
        arr = arr[:, None]
    frames, channels = arr.shape
    payload = arr.reshape(-1).tobytes()
    fmt = struct.pack(
        "<HHIIHH",
        WAVE_FORMAT_IEEE_FLOAT,
        channels,
        sample_rate,
        sample_rate * channels * 4,
        channels * 4,
        32,
    )
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt
    body += b"data" + struct.pack("<I", len(payload)) + payload
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)
