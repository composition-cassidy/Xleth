"""Read a PyTorch checkpoint into numpy arrays, without torch.

The Roformer tiers ship as `.ckpt` files — the author's own, downloaded from
the author's own repository — and the sidecar no longer has torch to open them
with. Fortunately the modern format is not a torch-specific binary: it is a ZIP
holding one pickle that describes the tensors and one flat file per storage.

    archive/data.pkl          the object graph; tensors are _rebuild_tensor_v2
                              calls whose storages are persistent-id references
    archive/data/0, /1, ...   the raw little-endian bytes of each storage
    archive/version

## This unpickler is restricted, and that is a security property, not a detail

Unpickling executes whatever the pickle says to execute, and `torch.load`
without `weights_only=True` is a remote-code-execution primitive pointed at a
file from the internet. `find_class` here refuses everything outside a fixed
allowlist of tensor-rebuilding callables and container types, so a doctored
checkpoint gets a `CheckpointError` instead of a shell. That is the same
posture as `weights_only=True` and it is enforced here rather than inherited.

The store has already verified the file's sha256 against `models.json` by the
time anything reaches this module, so this is the second lock on that door,
not the first.

## What is deliberately not supported

Only the ZIP format torch has written since 1.6. The pre-1.6 tar/legacy format
gets a clear error rather than a partial read: no checkpoint this project
ships uses it, and half-decoding one would produce weights that load and
separate badly.
"""

from __future__ import annotations

import pickle
import struct
import zipfile
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import numpy as np

__all__ = ["CheckpointError", "load_state_dict", "load_checkpoint"]


class CheckpointError(RuntimeError):
    """The checkpoint is not readable as a torch ZIP archive."""


# torch storage class name -> (numpy dtype, element size in the file).
#
# bfloat16 has no numpy equivalent and is handled separately below: it is the
# TOP 16 bits of a float32, so it widens losslessly rather than converting.
_STORAGE_DTYPES: Dict[str, str] = {
    "FloatStorage": "float32",
    "DoubleStorage": "float64",
    "HalfStorage": "float16",
    "BFloat16Storage": "bfloat16",
    "LongStorage": "int64",
    "IntStorage": "int32",
    "ShortStorage": "int16",
    "CharStorage": "int8",
    "ByteStorage": "uint8",
    "BoolStorage": "bool",
    "ComplexFloatStorage": "complex64",
    "ComplexDoubleStorage": "complex128",
}

_DTYPE_ITEMSIZE: Dict[str, int] = {
    "float32": 4, "float64": 8, "float16": 2, "bfloat16": 2,
    "int64": 8, "int32": 4, "int16": 2, "int8": 1, "uint8": 1,
    "bool": 1, "complex64": 8, "complex128": 16,
}


class _Storage:
    """A storage the pickle referred to, read from the archive on demand."""

    def __init__(self, archive: zipfile.ZipFile, prefix: str, key: str,
                 dtype: str, numel: int):
        self.archive = archive
        self.prefix = prefix
        self.key = key
        self.dtype = dtype
        self.numel = numel
        self._data: Optional[np.ndarray] = None

    def array(self) -> np.ndarray:
        if self._data is not None:
            return self._data

        name = f"{self.prefix}/data/{self.key}"
        try:
            raw = self.archive.read(name)
        except KeyError as exc:
            raise CheckpointError(f"storage {name!r} is missing from the archive") from exc

        if self.dtype == "bfloat16":
            # Widen to float32 by placing each 16-bit value in the high half of
            # a 32-bit word. Exact — bfloat16 IS truncated float32 — where a
            # cast through float16 would overflow on values above 65504.
            halves = np.frombuffer(raw, dtype="<u2")
            widened = np.zeros(halves.shape, dtype="<u4")
            widened |= halves.astype("<u4") << 16
            self._data = widened.view("<f4")
        else:
            self._data = np.frombuffer(raw, dtype=np.dtype(self.dtype).newbyteorder("<"))

        return self._data


def _rebuild_tensor(storage: _Storage, storage_offset: int, size, stride,
                    *_rest) -> np.ndarray:
    """`torch._utils._rebuild_tensor_v2`, in numpy."""
    flat = storage.array()
    size = tuple(int(s) for s in size)
    if not size:
        return np.array(flat[storage_offset], dtype=flat.dtype)

    stride = tuple(int(s) for s in stride)
    itemsize = flat.dtype.itemsize
    view = flat[storage_offset:]

    # Checkpoint tensors are almost always contiguous, but "almost" is not a
    # guarantee worth betting the weights on — a transposed tensor read as
    # contiguous loads without error and separates to noise.
    expected_contiguous = _contiguous_stride(size)
    if stride == expected_contiguous:
        needed = int(np.prod(size)) if size else 0
        if view.size < needed:
            raise CheckpointError(
                f"storage holds {view.size} elements, tensor of shape {size} needs {needed}")
        return view[:needed].reshape(size)

    byte_strides = tuple(s * itemsize for s in stride)
    span = sum((d - 1) * s for d, s in zip(size, stride)) + 1
    if view.size < span:
        raise CheckpointError(
            f"strided tensor of shape {size} stride {stride} overruns its storage")
    return np.lib.stride_tricks.as_strided(view, shape=size, strides=byte_strides)


def _contiguous_stride(size: Tuple[int, ...]) -> Tuple[int, ...]:
    stride = [1] * len(size)
    for i in range(len(size) - 2, -1, -1):
        stride[i] = stride[i + 1] * size[i + 1]
    return tuple(stride)


class _Rebuilder:
    """Stand-in for a torch callable the pickle wants to invoke."""

    def __init__(self, name: str):
        self.name = name

    def __call__(self, *args, **kwargs):
        if self.name in ("_rebuild_tensor_v2", "_rebuild_tensor"):
            return _rebuild_tensor(*args)
        if self.name == "_rebuild_parameter":
            # (data, requires_grad, backward_hooks) — only the data matters.
            return args[0]
        if self.name == "OrderedDict":
            from collections import OrderedDict
            return OrderedDict(*args, **kwargs)
        raise CheckpointError(f"checkpoint calls unsupported constructor {self.name!r}")


class _StorageType:
    """Stand-in for `torch.FloatStorage` and friends, used only as a tag."""

    def __init__(self, name: str):
        self.name = name


# module -> {name} that the unpickler will resolve. Everything else raises.
_ALLOWED: Dict[str, set] = {
    "torch._utils": {"_rebuild_tensor_v2", "_rebuild_tensor", "_rebuild_parameter"},
    "torch": set(_STORAGE_DTYPES) | {"device", "Size"},
    "collections": {"OrderedDict"},
}


class _Unpickler(pickle.Unpickler):
    def __init__(self, file, archive: zipfile.ZipFile, prefix: str):
        super().__init__(file, encoding="latin1")
        self._archive = archive
        self._prefix = prefix

    def find_class(self, module: str, name: str):
        allowed = _ALLOWED.get(module)
        if allowed is None or name not in allowed:
            raise CheckpointError(
                f"checkpoint tries to load {module}.{name}, which is not on the "
                "allowlist — refusing. A checkpoint only needs tensor "
                "constructors and plain containers; anything else is either a "
                "format this reader does not support or an attack.")
        if module == "collections":
            from collections import OrderedDict
            return OrderedDict
        if module == "torch" and name in _STORAGE_DTYPES:
            return _StorageType(name)
        if module == "torch" and name == "Size":
            return tuple
        if module == "torch" and name == "device":
            return lambda *a, **k: None
        return _Rebuilder(name)

    def persistent_load(self, saved_id):
        if not isinstance(saved_id, tuple) or not saved_id:
            raise CheckpointError(f"unexpected persistent id {saved_id!r}")
        if saved_id[0] != "storage":
            raise CheckpointError(f"unsupported persistent id kind {saved_id[0]!r}")

        _, storage_type, key, _location, numel = saved_id
        name = storage_type.name if isinstance(storage_type, _StorageType) else str(storage_type)
        dtype = _STORAGE_DTYPES.get(name)
        if dtype is None:
            raise CheckpointError(f"unsupported storage type {name!r}")
        return _Storage(self._archive, self._prefix, str(key), dtype, int(numel))


def _archive_prefix(zf: zipfile.ZipFile) -> str:
    for entry in zf.namelist():
        if entry.endswith("data.pkl"):
            return entry[: -len("/data.pkl")] if "/" in entry else ""
    raise CheckpointError(
        "no data.pkl in the archive — this is not a torch ZIP checkpoint. "
        "The pre-1.6 legacy format is not supported.")


def load_checkpoint(path: Path | str) -> Any:
    """Read `path` and return whatever object it holds, tensors as numpy."""
    path = Path(path)
    if not zipfile.is_zipfile(path):
        raise CheckpointError(
            f"{path.name} is not a ZIP archive. torch has written this format "
            "since 1.6; the legacy format is not supported.")

    with zipfile.ZipFile(path) as zf:
        prefix = _archive_prefix(zf)
        pkl_name = f"{prefix}/data.pkl" if prefix else "data.pkl"
        with zf.open(pkl_name) as handle:
            return _Unpickler(handle, zf, prefix).load()


def load_state_dict(path: Path | str) -> Dict[str, np.ndarray]:
    """Read `path` and return its tensors as `{name: ndarray}`.

    Unwraps the envelopes reference checkpoints arrive in. Anything else that
    is already a flat mapping of arrays is returned as-is, and anything that is
    neither raises rather than guessing.
    """
    obj = load_checkpoint(path)

    for key in ("state", "state_dict", "model_state_dict"):
        if isinstance(obj, dict) and key in obj and isinstance(obj[key], dict):
            obj = obj[key]
            break

    if not isinstance(obj, dict):
        raise CheckpointError(
            f"expected a mapping of tensors, got {type(obj).__name__}")

    out: Dict[str, np.ndarray] = {}
    for name, value in obj.items():
        if isinstance(value, np.ndarray):
            out[str(name)] = value
        elif np.isscalar(value):
            continue        # step counters, epochs and the like
        else:
            raise CheckpointError(
                f"entry {name!r} is a {type(value).__name__}, not a tensor")
    return out
