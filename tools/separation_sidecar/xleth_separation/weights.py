"""Fill a shipped weightless ONNX graph from the user's own checkpoint.

XLETH ships each Roformer tier as topology only — ops, shapes and the band
layout, all of it derived from the vendored (MIT) architecture — plus a JSON
manifest saying which checkpoint tensor belongs at which byte offset. The
weights themselves are never in the installer: the user downloads the author's
`.ckpt` exactly as before, and this module writes those tensors into the
external-data file the graph points at.

That ordering is what keeps `NOTICE-separation-models.md` true. It rests the
licence clearance for all three tiers on XLETH never redistributing a weight,
and names bundling one as the thing that would reopen the GPL-3.0 question for
the BEST tier. A graph with weights baked in would be a redistributed
derivative of the checkpoint; a graph with holes in it is not.

## No `onnx` dependency

ONNX's external-data format is a plain flat file: each initializer records a
`location`, `offset` and `length`, and the bytes at that offset are the
tensor, little-endian, C-contiguous. Writing one therefore needs no protobuf
library and no `onnx` package — just the manifest and `numpy`. The export side
(`onnx_export.py`) produced the manifest on a machine that did have onnx.

## Where the files land

onnxruntime resolves `location` RELATIVE TO THE GRAPH FILE, so the graph and
its weight file have to sit in the same directory. The shipped graph is inside
the installed application, which is read-only on a normal install, so
`install()` copies the graph into the model's own directory in userData and
writes the weights beside it.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from . import ckpt

__all__ = ["WeightError", "install", "is_installed", "graph_path_for"]

# Bumped when the export changes in a way that invalidates already-written
# weight files. The receipt records it, and a mismatch rebuilds rather than
# loading a file laid out by an older export against a newer graph.
LAYOUT_VERSION = 1

_CHUNK = 8 * 1024 * 1024


class WeightError(RuntimeError):
    """The checkpoint does not fit the graph the manifest describes."""


def _load_manifest(manifest_path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise WeightError(f"cannot read weight manifest {manifest_path}: {exc}") from exc

    for field in ("initializers", "externalDataName", "inputShape"):
        if field not in data:
            raise WeightError(f"weight manifest {manifest_path} has no {field!r}")
    return data


def graph_path_for(model_dir: Path | str, manifest: Dict[str, Any]) -> Path:
    """Where the runnable graph lives once installed."""
    return Path(model_dir) / Path(manifest["externalDataName"]).with_suffix(".onnx").name


def _weights_path(model_dir: Path, manifest: Dict[str, Any]) -> Path:
    return Path(model_dir) / manifest["externalDataName"]


def _receipt_path(weights_path: Path) -> Path:
    return weights_path.with_suffix(weights_path.suffix + ".json")


def _graph_fingerprint(graph_template: Path) -> str:
    """sha256 of the shipped graph, so a re-export is detected as a change."""
    digest = hashlib.sha256()
    with open(graph_template, "rb") as handle:
        for block in iter(lambda: handle.read(_CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def is_installed(model_dir: Path | str, manifest_path: Path | str,
                 graph_template: Optional[Path | str] = None) -> bool:
    """Has a complete, CURRENT graph-and-weights pair already been written here?

    Checks the receipt rather than the mere existence of the files: a run
    killed midway leaves a plausible-looking multi-hundred-megabyte file that
    would load as garbage.

    `graph_template` is what makes this answer "current" rather than merely
    "complete", and leaving it out is a trap that already bit once. The weight
    file depends only on the CHECKPOINT, so re-exporting a graph — new
    topology, same weights — produces an identical `totalWeightBytes` and this
    function used to say "already installed". The stale graph stayed in place
    and the session silently kept running it; a memory fix that had been
    exported correctly measured as having changed nothing at all. In
    production the same bug would mean users never receiving a re-exported
    graph until something unrelated invalidated their weight file.
    """
    manifest = _load_manifest(Path(manifest_path))
    model_dir = Path(model_dir)
    weights = _weights_path(model_dir, manifest)
    graph = graph_path_for(model_dir, manifest)
    receipt_file = _receipt_path(weights)

    if not (weights.exists() and graph.exists() and receipt_file.exists()):
        return False
    try:
        receipt = json.loads(receipt_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False

    if not (receipt.get("layoutVersion") == LAYOUT_VERSION
            and receipt.get("bytes") == weights.stat().st_size
            and receipt.get("bytes") == manifest.get("totalWeightBytes")):
        return False

    if graph_template is not None:
        template = Path(graph_template)
        if not template.exists():
            return False
        if receipt.get("graphSha256") != _graph_fingerprint(template):
            return False

    return True


def install(
    checkpoint_path: Path | str,
    graph_template: Path | str,
    manifest_path: Path | str,
    model_dir: Path | str,
    on_progress: Optional[Any] = None,
    force: bool = False,
) -> Dict[str, Any]:
    """Write the graph and its weights into `model_dir`, ready for onnxruntime.

    `on_progress(done, total)` is called as tensors are written; the caller
    turns that into the same progress bar the download uses, because on a cold
    install this runs immediately after a 435 MB fetch and a silent 20 seconds
    there reads as a hang.
    """
    checkpoint_path = Path(checkpoint_path)
    graph_template = Path(graph_template)
    model_dir = Path(model_dir)
    manifest = _load_manifest(Path(manifest_path))

    if not force and is_installed(model_dir, manifest_path, graph_template):
        return {"path": str(graph_path_for(model_dir, manifest)), "rebuilt": False}

    model_dir.mkdir(parents=True, exist_ok=True)
    weights = _weights_path(model_dir, manifest)
    graph = graph_path_for(model_dir, manifest)

    state = ckpt.load_state_dict(checkpoint_path)
    entries: List[Dict[str, Any]] = manifest["initializers"]

    # Written to a .part and renamed only once every tensor is in place, the
    # same discipline store.py applies to downloads: the real name never holds
    # an incomplete file, so a kill mid-write costs a rebuild rather than a
    # model that loads and separates to noise.
    part = weights.with_suffix(weights.suffix + ".part")
    digest = hashlib.sha256()
    total = len(entries)

    try:
        with open(part, "wb") as handle:
            for index, entry in enumerate(entries):
                array = _tensor_for(state, entry)
                if handle.tell() != entry["offset"]:
                    raise WeightError(
                        f"manifest offsets are not contiguous at {entry['name']!r}: "
                        f"expected {entry['offset']}, file is at {handle.tell()}")
                raw = array.tobytes()
                if len(raw) != entry["bytes"]:
                    raise WeightError(
                        f"{entry['key']!r} is {len(raw)} bytes, manifest says "
                        f"{entry['bytes']}")
                handle.write(raw)
                digest.update(raw)
                if on_progress is not None:
                    on_progress(index + 1, total)

        written = part.stat().st_size
        if written != manifest.get("totalWeightBytes", written):
            raise WeightError(
                f"wrote {written} bytes, manifest expects {manifest['totalWeightBytes']}")

        shutil.copyfile(graph_template, graph)
        part.replace(weights)
    except BaseException:
        part.unlink(missing_ok=True)
        raise

    receipt = {
        "layoutVersion": LAYOUT_VERSION,
        "bytes": weights.stat().st_size,
        "sha256": digest.hexdigest(),
        "graphSha256": _graph_fingerprint(graph_template),
        "checkpoint": checkpoint_path.name,
        "initializers": total,
    }
    _receipt_path(weights).write_text(json.dumps(receipt, indent=1), encoding="utf-8")

    return {"path": str(graph), "rebuilt": True, "bytes": receipt["bytes"]}


def _tensor_for(state: Dict[str, np.ndarray], entry: Dict[str, Any]) -> np.ndarray:
    """The checkpoint tensor for one initializer, validated against the graph."""
    key = entry["key"]
    array = state.get(key)
    if array is None:
        raise WeightError(
            f"the checkpoint has no tensor {key!r}, which the graph needs. "
            "This checkpoint does not match the model this graph was exported for.")

    want_shape = tuple(entry["shape"])
    if tuple(array.shape) != want_shape:
        raise WeightError(
            f"{key!r} is {tuple(array.shape)} in the checkpoint but the graph "
            f"expects {want_shape}")

    want_dtype = np.dtype(entry["dtype"])
    if array.dtype != want_dtype:
        # Widening a half-precision checkpoint into a float32 graph is fine and
        # is how some mirrors distribute these weights. Narrowing is not: it
        # would silently quantise every weight in the model.
        if array.dtype.itemsize > want_dtype.itemsize:
            raise WeightError(
                f"{key!r} is {array.dtype} but the graph expects {want_dtype}; "
                "refusing to narrow the weights")
        array = array.astype(want_dtype)

    # A shared tensor is written once and read by several sites in the graph.
    # If the checkpoint disagrees between those names, one of them is about to
    # be silently wrong, and which one depends on export order.
    for alias in entry.get("aliases", ()):
        other = state.get(alias)
        if other is None:
            continue
        if other.shape != array.shape or not np.array_equal(
                other.astype(want_dtype, copy=False), array):
            raise WeightError(
                f"{key!r} and {alias!r} share one initializer in the graph but "
                "hold different values in this checkpoint")

    return np.ascontiguousarray(array, dtype=want_dtype)
