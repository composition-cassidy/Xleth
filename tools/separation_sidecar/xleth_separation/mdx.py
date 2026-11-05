"""MDX-Net inference (ONNX weights, numpy STFT/iSTFT).

The transform pipeline here is bit-faithful to the reference MDX-Net demix
implementations (UVR / MVSEP-MDX23): a centred STFT with a periodic Hann
window, the real/imaginary planes interleaved into 4 "channels", the lowest
`dim_f` bins fed to the network, and the discarded high bins restored as zeros
before the inverse. Deviating from any of those — a different window
periodicity, a non-centered transform, keeping the high bins — does not error,
it just produces a worse separation, so none of it is re-derived here.

The transform pair used to be torch's. It is now `dsp.py`'s numpy pair, which
`tests/test_dsp.py` holds to torch's output on this tier's exact parameters
(n_fft=7680, hop=1024). That was the last thing in this module that needed
torch, and removing it is what let the package drop a ~1 GB dependency tree —
see the module docstring in `onnx_export.py` for the whole story.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from . import dsp
from .manifest import ModelSpec, assert_license_cleared
from .ort_util import PROVIDER_PREFERENCE, available_device, make_session

__all__ = ["MdxSeparator", "available_device", "SeparationCancelled", "chunk_plan"]


class SeparationCancelled(RuntimeError):
    pass


def chunk_plan(n_samples: int, chunk_size: int, gen_size: int) -> Dict[str, Any]:
    """How a run of `n_samples` is cut into model-sized chunks.

    Module-level, and the SINGLE source of this arithmetic: `plan()` (which
    feeds the UI's chunk counter and ETA denominator) and `separate()` (which
    does the work) both call it. When they each computed it themselves, an
    off-by-one between them showed up as a progress bar that finished at 97%
    or overshot 100% — never as a failure.

    `pad` is always non-zero: when the input divides evenly a whole extra
    gen_size is still appended, because the final chunk's tail is STFT edge
    padding that gets trimmed away.
    """
    pad = gen_size - n_samples % gen_size
    total = n_samples + pad
    starts = list(range(0, total, gen_size))
    return {
        "chunks": len(starts),
        "chunkSize": chunk_size,
        "genSize": gen_size,
        "pad": pad,
        "starts": starts,
    }


class MdxSeparator:
    """One loaded MDX-Net model, ready to separate.

    Construction is the expensive part (session creation, provider selection),
    so a job holds one of these for its whole run.
    """

    def __init__(self, spec: ModelSpec, model_path: Path, prefer_device: Optional[str] = None):
        assert_license_cleared(spec)

        self.spec = spec
        self.model_path = Path(model_path)

        params = spec.params
        self.dim_c = int(params["dim_c"])
        self.dim_f = int(params["dim_f"])
        self.dim_t = int(params["dim_t"])
        self.n_fft = int(params["n_fft"])
        self.hop = int(params["hop"])
        self.compensate = float(params.get("compensate", 1.0))
        self.sample_rate = int(spec.sample_rate)

        self.session, self.device = make_session(self.model_path, prefer_device)
        self.input_name = self.session.get_inputs()[0].name

        # The graph is self-describing about dim_f / dim_t, and it is the
        # authority: a manifest typo here would otherwise surface as an
        # onnxruntime shape error thousands of samples into a long job.
        # n_fft and hop are NOT recoverable from the graph, which is exactly
        # why they have to be correct in the manifest.
        shape = self.session.get_inputs()[0].shape
        self.shape_warnings: List[str] = []
        if len(shape) == 4:
            graph_dim_f, graph_dim_t = shape[2], shape[3]
            if isinstance(graph_dim_f, int) and graph_dim_f != self.dim_f:
                self.shape_warnings.append(
                    f"manifest dim_f={self.dim_f} but graph declares {graph_dim_f}; using the graph")
                self.dim_f = graph_dim_f
            if isinstance(graph_dim_t, int) and graph_dim_t != self.dim_t:
                self.shape_warnings.append(
                    f"manifest dim_t={self.dim_t} but graph declares {graph_dim_t}; using the graph")
                self.dim_t = graph_dim_t

        self.n_bins = self.n_fft // 2 + 1
        self.chunk_size = self.hop * (self.dim_t - 1)
        self.trim = self.n_fft // 2
        self.gen_size = self.chunk_size - 2 * self.trim
        if self.gen_size <= 0:
            raise ValueError(
                f"model '{spec.id}': chunk_size {self.chunk_size} is not larger than "
                f"2*trim {2 * self.trim} — n_fft/hop/dim_t in the manifest disagree")

        self._window = dsp.hann_window(self.n_fft, periodic=True)

    # ── Transforms ───────────────────────────────────────────────────────
    #
    # A transcription of the torch pair these replace, reshape for reshape.
    # The one thing to keep straight is what the 4 "channels" of dim_c are:
    # they are (audio channel, complex part) flattened in that order, so the
    # `[-1, 2, 2, bins, frames]` reshape groups L/R first and real/imag second.
    # Swapping those two axes runs, and separates to mush.

    def _stft(self, x: np.ndarray) -> np.ndarray:
        """[B, 2, chunk_size] → [B, dim_c, dim_f, dim_t]."""
        x = x.reshape(-1, self.chunk_size)
        spec = dsp.stft(x, n_fft=self.n_fft, hop_length=self.hop,
                        window=self._window, center=True)      # [B*2, bins, frames]
        out = np.stack([spec.real, spec.imag], axis=-1)        # [B*2, bins, frames, 2]
        out = np.transpose(out, (0, 3, 1, 2))                  # [B*2, 2, bins, frames]
        out = out.reshape(-1, 2, 2, self.n_bins, self.dim_t) \
                 .reshape(-1, self.dim_c, self.n_bins, self.dim_t)
        return np.ascontiguousarray(out[:, :, : self.dim_f], dtype=np.float32)

    def _istft(self, x: np.ndarray) -> np.ndarray:
        """[B, dim_c, dim_f, dim_t] → [B, 2, chunk_size]."""
        freq_pad = np.zeros((x.shape[0], self.dim_c, self.n_bins - self.dim_f,
                             self.dim_t), dtype=x.dtype)
        x = np.concatenate([x, freq_pad], axis=-2)
        x = x.reshape(-1, 2, 2, self.n_bins, self.dim_t) \
             .reshape(-1, 2, self.n_bins, self.dim_t)
        x = np.transpose(x, (0, 2, 3, 1))                      # [B*2, bins, frames, 2]
        complex_spec = x[..., 0] + 1j * x[..., 1]
        audio = dsp.istft(complex_spec, n_fft=self.n_fft, hop_length=self.hop,
                          window=self._window, center=True)
        return audio.reshape(-1, 2, self.chunk_size)

    # ── Separation ───────────────────────────────────────────────────────

    def plan(self, n_samples: int) -> Dict[str, Any]:
        """How the job will be cut up, without doing any of it. Delegates to
        chunk_plan so the UI's denominator and the real run can never disagree."""
        return chunk_plan(n_samples, self.chunk_size, self.gen_size)

    def separate(
        self,
        mix: np.ndarray,
        batch_size: int = 1,
        on_chunk: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Dict[str, np.ndarray]:
        """Separate [2, n] float32 at self.sample_rate.

        Returns {primary_stem: [2, n], secondary_stem: [2, n]}. The secondary
        stem is the residual (mix minus primary), which is what makes the two
        outputs sum back to the input — a property the Sandbox's layering
        relies on when both stems are added as layers.
        """
        if mix.ndim != 2 or mix.shape[0] != 2:
            raise ValueError(f"expected [2, n] input, got {mix.shape}")

        n_sample = mix.shape[1]
        trim = self.trim
        layout = chunk_plan(n_sample, self.chunk_size, self.gen_size)
        pad = layout["pad"]

        mix_p = np.concatenate(
            (np.zeros((2, trim), dtype=np.float32),
             mix.astype(np.float32, copy=False),
             np.zeros((2, pad), dtype=np.float32),
             np.zeros((2, trim), dtype=np.float32)),
            axis=1)

        starts = layout["starts"]
        total_chunks = layout["chunks"]
        done = 0
        pieces: List[np.ndarray] = []

        for base in range(0, total_chunks, max(1, batch_size)):
            if cancel is not None and cancel.is_set():
                raise SeparationCancelled("cancelled during inference")

            group = starts[base: base + max(1, batch_size)]
            waves = np.stack([mix_p[:, s: s + self.chunk_size] for s in group]).astype(np.float32)

            spec_in = self._stft(waves)
            out = self.session.run(None, {self.input_name: spec_in})[0]
            tar_waves = self._istft(out)
            # Drop the STFT edge padding each chunk carries on both sides;
            # what is left is exactly gen_size of clean signal per chunk.
            trimmed = tar_waves[:, :, trim:-trim]

            pieces.append(trimmed)
            done += len(group)
            if on_chunk is not None:
                on_chunk(done, total_chunks)

        stacked = np.concatenate(pieces, axis=0)              # [chunks, 2, gen_size]
        primary = stacked.transpose(1, 0, 2).reshape(2, -1)   # [2, chunks*gen_size]
        primary = primary[:, :-pad] if pad else primary
        primary = (primary * self.compensate).astype(np.float32)

        secondary = (mix.astype(np.float32, copy=False) - primary).astype(np.float32)

        return {
            self.spec.stems["primary"]: primary,
            self.spec.stems.get("secondary", "Residual"): secondary,
        }
