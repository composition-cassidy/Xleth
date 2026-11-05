"""onnxruntime session and device plumbing, shared by all three tiers.

Since the Roformer tiers moved off torch, **every** tier infers in
onnxruntime. That collapses what used to be the most confusing thing about
this service: the FAST tier's GPU and the BALANCED tier's GPU were separate
questions with separate answers, because one asked onnxruntime and the other
asked torch. A CUDA onnxruntime did nothing for BALANCED, and a CUDA torch did
nothing for FAST. There is now one runtime, one provider list, and one answer.

The CUDA DLL handling below is unchanged and still necessary — see
`_register_cuda_dll_dirs`, where the comment explains why registering a
directory is not enough.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional, Tuple

__all__ = [
    "PROVIDER_PREFERENCE",
    "available_device",
    "make_session",
    "register_cuda_dll_dirs",
    "missing_packages",
]

# Preference order. DirectML sits above CPU because on this project's primary
# platform (Windows) it is the GPU path that needs no CUDA install at all.
PROVIDER_PREFERENCE: List[Tuple[str, str]] = [
    ("CUDAExecutionProvider", "cuda"),
    ("DmlExecutionProvider", "directml"),
    ("CPUExecutionProvider", "cpu"),
]

_cuda_dlls_registered = False


def register_cuda_dll_dirs() -> List[str]:
    """Put pip-installed NVIDIA runtime DLLs on Windows' DLL search path.

    onnxruntime-gpu's CUDA provider needs cuDNN and cuBLAS at load time. When
    those come from pip (`nvidia-cudnn-cu12`, `nvidia-cublas-cu12`) rather than
    a system CUDA Toolkit install, their DLLs sit inside site-packages where
    Windows will not look — and the failure is silent: ORT reports the CUDA
    provider as simply unavailable and quietly runs on CPU, ~12x slower, with
    nothing in the log saying why.

    A no-op on non-Windows and when the packages are absent.
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
    # LoadLibrary, and the directories registered above only participate in the
    # search for callers that pass LOAD_LIBRARY_SEARCH_USER_DIRS. So the
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


def available_device() -> str:
    """Best device onnxruntime can offer here, without building a session."""
    register_cuda_dll_dirs()
    try:
        import onnxruntime as ort
    except ImportError:
        return "unavailable"
    have = set(ort.get_available_providers())
    for provider, label in PROVIDER_PREFERENCE:
        if provider in have:
            return label
    return "cpu"


def make_session(model_path: Path | str, prefer_device: Optional[str] = None):
    """An InferenceSession for `model_path`, plus the device label it got.

    Graph optimisation is set to ORT_ENABLE_ALL deliberately. The exported
    graphs are traced with constant folding DISABLED — that is what keeps
    initializer names matching checkpoint keys so the weightless graphs can be
    filled on the user's machine — so each Linear arrives as an explicit
    Transpose feeding a MatMul. ORT folds exactly those away at session load,
    against the weights the user downloaded, which is where that work belongs.
    """
    register_cuda_dll_dirs()
    import onnxruntime as ort

    available = set(ort.get_available_providers())
    ordered = PROVIDER_PREFERENCE
    if prefer_device:
        ordered = ([p for p in PROVIDER_PREFERENCE if p[1] == prefer_device]
                   + [p for p in PROVIDER_PREFERENCE if p[1] != prefer_device])
    providers = [p for p, _ in ordered if p in available] or ["CPUExecutionProvider"]

    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    session = ort.InferenceSession(str(model_path), sess_options=opts,
                                   providers=providers)
    active = session.get_providers()
    device = next((label for p, label in PROVIDER_PREFERENCE
                   if active and p == active[0]), "cpu")
    return session, device


# The CORE packages, needed before any tier can run at all.
#
# PyYAML is deliberately NOT here even though two of the three tiers need it:
# it belongs to those tiers, and app.py's ARCH_MODULES gates them on it
# individually. Listing it here would make a missing PyYAML report the whole
# service as broken when the FAST tier would run perfectly well.
#
# torch is not here either, and neither are the packages it used to drag in for
# the Roformer tiers (einops, librosa, rotary-embedding-torch, beartype) — the
# exported graphs carry that architecture as ops.
REQUIRED_PACKAGES = ("fastapi", "uvicorn", "numpy", "soundfile", "onnxruntime")


def missing_packages() -> List[str]:
    """Which of the sidecar's runtime dependencies cannot be imported."""
    import importlib

    missing = []
    for name in REQUIRED_PACKAGES:
        try:
            importlib.import_module(name)
        except Exception:
            missing.append("PyYAML" if name == "yaml" else name)
    return missing
