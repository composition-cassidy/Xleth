"""MDX-Net inference (ONNX weights, torch STFT/iSTFT).

The transform pipeline here is bit-faithful to the reference MDX-Net demix
implementations (UVR / MVSEP-MDX23): torch.stft with a periodic Hann window,
center=True, the real/imaginary planes interleaved into 4 "channels", the
lowest `dim_f` bins fed to the network, and the discarded high bins restored
as zeros before the inverse. Deviating from any of those — a different window
periodicity, a non-centered transform, keeping the high bins — does not error,
it just produces a worse separation, so none of it is re-derived here.

Why ONNX inside a PyTorch sidecar: the MDX-Net tier ships as .onnx weights and
runs through onnxruntime, while the STFT pair stays in torch. That is the same
split the reference implementations use, and it keeps torch present for the
Roformer tiers (P4-2 / P4-3) that need it for real.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from .manifest import ModelSpec, assert_license_cleared

# torch and onnxruntime are imported LAZILY, inside the functions that need
# them. Two reasons, both load-bearing:
#
#   * /health has to be able to report `torch: null, ok: false` on a machine
#     with a half-finished install. It cannot do that if importing this module
#     is what explodes.
#   * importing torch costs seconds and hundreds of MB of RSS. The sidecar is
#     started lazily precisely to avoid paying that for a session that never
#     separates anything; paying it at import time would undo that.
_torch = None


def _t():
    global _torch
    if _torch is None:
        import torch as torch_module
        _torch = torch_module
    return _torch


_cuda_dlls_registered = False


def _register_cuda_dll_dirs() -> List[str]:
    """Put pip-installed NVIDIA runtime DLLs on Windows' DLL search path.

    onnxruntime-gpu's CUDA provider needs cuDNN and cuBLAS at load time. When
    those come from pip (`nvidia-cudnn-cu12`, `nvidia-cublas-cu12`) rather than
    a system CUDA Toolkit install, their DLLs sit inside site-packages where
    Windows will not look — and the failure is silent: ORT reports the CUDA
    provider as simply unavailable and quietly runs on CPU, ~12x slower, with
    nothing in the log saying why.

    Older ORT builds do not search these directories themselves, so we do it
    explicitly. A no-op on non-Windows and when the packages are absent.
    """
    global _cuda_dlls_registered
    added: List[str] = []
    if _cuda_dlls_registered or not hasattr(os, "add_dll_directory"):
        return added
    _cuda_dlls_registered = True

    try:
        import nvidia  # type: ignore
    except ImportError:
        return added

    dirs: List[Path] = []
    for pkg_root in getattr(nvidia, "__path__", []):
        base = Path(pkg_root)
        for sub in ("cudnn", "cublas", "cuda_runtime", "cufft", "curand"):
            for leaf in ("bin", "lib"):
                d = base / sub / leaf
                if d.is_dir():
                    try:
                        os.add_dll_directory(str(d))
                        dirs.append(d)
                        added.append(str(d))
                    except OSError:
                        pass

    # add_dll_directory is NOT enough on its own.
    #
    # onnxruntime loads onnxruntime_providers_cuda.dll through a plain
    # LoadLibrary, and the directories registered above only participate in
    # the search for callers that pass LOAD_LIBRARY_SEARCH_USER_DIRS. So the
    # provider DLL fails to resolve cudnn64_9.dll — "Error 126: The specified
    # module could not be found" — while the file sits right there in
    # site-packages, and ORT falls back to CPU.
    #
    # Loading the libraries ourselves puts them in the process's module table
    # under their plain names, which is what the provider's import resolution
    # actually consults. Two passes because these have inter-dependencies
    # (cudnn64_9 needs cudnn_graph64_9 and friends) and the directory listing
    # order is not a topological one.
    import ctypes

    pending = [p for d in dirs for p in sorted(d.glob("*.dll"))]
    for _ in range(2):
        failed = []
        for dll in pending:
            try:
                ctypes.WinDLL(str(dll))
            except OSError:
                failed.append(dll)
        if not failed or len(failed) == len(pending):
            break
        pending = failed

    return added

# Preference order. DirectML is listed above CPU because on this project's
# primary platform (Windows) it is the GPU path that works without CUDA.
PROVIDER_PREFERENCE = [
    ("CUDAExecutionProvider", "cuda"),
    ("DmlExecutionProvider", "directml"),
    ("CPUExecutionProvider", "cpu"),
]


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


def available_device() -> str:
    """Best device onnxruntime can offer here, without building a session.

    Registers the CUDA DLL directories first: otherwise /health reports "cpu"
    on a machine that is about to run perfectly well on CUDA, and the UI
    truthfully relays a figure that is wrong.
    """
    _register_cuda_dll_dirs()
    try:
        import onnxruntime as ort
    except ImportError:
        return "unavailable"
    have = set(ort.get_available_providers())
    for provider, label in PROVIDER_PREFERENCE:
        if provider in have:
            return label
    return "cpu"


class MdxSeparator:
    """One loaded MDX-Net model, ready to separate.

    Construction is the expensive part (session creation, provider selection),
    so a job holds one of these for its whole run.
    """

    def __init__(self, spec: ModelSpec, model_path: Path, prefer_device: Optional[str] = None):
        assert_license_cleared(spec)

        # Order matters. torch first: its CUDA wheels ship cuDNN/cuBLAS and
        # loading them into the process is what lets ORT's CUDA provider
        # initialise on a machine whose system CUDA install is partial. Then
        # the pip nvidia-* DLL directories, then onnxruntime.
        _t()
        _register_cuda_dll_dirs()
        import onnxruntime as ort

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

        available = set(ort.get_available_providers())
        ordered = PROVIDER_PREFERENCE
        if prefer_device:
            ordered = ([p for p in PROVIDER_PREFERENCE if p[1] == prefer_device]
                       + [p for p in PROVIDER_PREFERENCE if p[1] != prefer_device])
        providers = [p for p, _ in ordered if p in available]
        if not providers:
            providers = ["CPUExecutionProvider"]

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        self.session = ort.InferenceSession(str(self.model_path), sess_options=opts,
                                            providers=providers)
        active = self.session.get_providers()
        self.device = next((label for p, label in PROVIDER_PREFERENCE
                            if active and p == active[0]), "cpu")

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

        torch = _t()
        self._window = torch.hann_window(window_length=self.n_fft, periodic=True)
        self._freq_pad = torch.zeros([1, self.dim_c, self.n_bins - self.dim_f, self.dim_t])

    # ── Transforms ───────────────────────────────────────────────────────

    def _stft(self, x: "torch.Tensor") -> "torch.Tensor":
        """[B, 2, chunk_size] → [B, dim_c, dim_f, dim_t]."""
        torch = _t()
        x = x.reshape([-1, self.chunk_size])
        x = torch.stft(x, n_fft=self.n_fft, hop_length=self.hop,
                       window=self._window, center=True, return_complex=True)
        x = torch.view_as_real(x)
        x = x.permute([0, 3, 1, 2])
        x = x.reshape([-1, 2, 2, self.n_bins, self.dim_t]) \
             .reshape([-1, self.dim_c, self.n_bins, self.dim_t])
        return x[:, :, : self.dim_f]

    def _istft(self, x: "torch.Tensor") -> "torch.Tensor":
        """[B, dim_c, dim_f, dim_t] → [B, 2, chunk_size]."""
        torch = _t()
        freq_pad = self._freq_pad.repeat([x.shape[0], 1, 1, 1])
        x = torch.cat([x, freq_pad], -2)
        x = x.reshape([-1, 2, 2, self.n_bins, self.dim_t]) \
             .reshape([-1, 2, self.n_bins, self.dim_t])
        x = x.permute([0, 2, 3, 1]).contiguous()
        x = torch.view_as_complex(x)
        x = torch.istft(x, n_fft=self.n_fft, hop_length=self.hop,
                        window=self._window, center=True)
        return x.reshape([-1, 2, self.chunk_size])

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

            with _t().no_grad():
                spec_in = self._stft(_t().from_numpy(waves))
                out = self.session.run(None, {self.input_name: spec_in.numpy()})[0]
                tar_waves = self._istft(_t().from_numpy(out))
                # Drop the STFT edge padding each chunk carries on both sides;
                # what is left is exactly gen_size of clean signal per chunk.
                trimmed = tar_waves[:, :, trim:-trim].numpy()

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
