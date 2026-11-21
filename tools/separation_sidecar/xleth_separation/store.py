"""Versioned, checksummed model store.

Layout under the store root (Electron passes it in; default is
~/.xleth/separation-models):

    <root>/<store_version>/<model_id>/<name>          a file the model needs
    <root>/<store_version>/<model_id>/<name>.json     what we verified

A file is only considered present when its bytes hash to the sha256 the
manifest names, and a MODEL is only present when every one of its files is.
That is the whole point: a truncated download, a mirror that quietly served a
different revision, or a half-written file from a killed process all read as
"not present" and are re-fetched, rather than being handed to the runtime to
fail in some less legible way later.

A model is a LIST of files, not one blob. MDX-Net is a single self-describing
.onnx; Mel-Band RoFormer is 435 MB of raw tensors plus a 1.2 kB YAML that says
what shape they go in. The YAML is checksummed exactly like the weight — it is
small, but it is the file that decides whether the weight is used correctly,
and a wrong one separates worse without ever erroring.

Downloads are resumable-by-restart only (no HTTP range requests): each file
lands at `<name>.part` and is renamed into place only after the hash matches.
There is never a moment when a bad file occupies the real name.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .manifest import ModelFile, ModelSpec, assert_license_cleared

# Read size for both hashing and downloading. 1 MiB keeps the progress
# callback frequent enough to feel live without making it a hot loop.
CHUNK_BYTES = 1024 * 1024

USER_AGENT = "XLETH-separation-sidecar/1.1 (+https://github.com/xleth)"

ProgressFn = Callable[[str, float, str], None]


class DownloadCancelled(RuntimeError):
    pass


class ChecksumMismatch(RuntimeError):
    def __init__(self, model_id: str, name: str, expected: str, actual: str):
        self.model_id = model_id
        self.name = name
        self.expected = expected
        self.actual = actual
        super().__init__(
            f"checksum mismatch for '{model_id}' file '{name}': expected sha256 "
            f"{expected}, got {actual}. The download was discarded."
        )


@dataclass
class FileStatus:
    role: str
    name: str
    present: bool
    path: Optional[str]
    size_bytes: int
    verified_at: Optional[float]

    def to_dict(self) -> dict:
        return {
            "role": self.role,
            "name": self.name,
            "present": self.present,
            "path": self.path,
            "sizeBytes": self.size_bytes,
            "verifiedAt": self.verified_at,
        }


@dataclass
class ModelStatus:
    model_id: str
    present: bool
    path: Optional[str]
    size_bytes: int
    verified_at: Optional[float]
    files: List[FileStatus] = field(default_factory=list)
    # Bytes still to fetch. The UI sizes the download phase from this rather
    # than from the model's total, so a store holding the weight but missing
    # the config does not claim 435 MB of work it is not going to do.
    missing_bytes: int = 0

    def to_dict(self) -> dict:
        return {
            "modelId": self.model_id,
            "present": self.present,
            "path": self.path,
            "sizeBytes": self.size_bytes,
            "verifiedAt": self.verified_at,
            "missingBytes": self.missing_bytes,
            "files": [f.to_dict() for f in self.files],
        }


def sha256_file(path: Path, on_bytes: Optional[Callable[[int], None]] = None) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        while True:
            block = fh.read(CHUNK_BYTES)
            if not block:
                break
            h.update(block)
            if on_bytes is not None:
                on_bytes(len(block))
    return h.hexdigest()


class _Weighted:
    """Turns per-file progress into one fraction across a whole model.

    Without this, fetching a 435 MB weight and a 1.2 kB YAML would drive the
    bar from 0 to 100 and then from 0 to 100 again — the second one instantly.
    Weighting by bytes is the only split that matches what the user is waiting
    for.
    """

    def __init__(self, total_bytes: int, on_progress: Optional[ProgressFn]):
        self.total = max(1, total_bytes)
        self.done = 0
        self.on_progress = on_progress

    def report(self, phase: str, file_done: int, detail: str) -> None:
        if self.on_progress is None:
            return
        self.on_progress(phase, min(1.0, (self.done + file_done) / self.total), detail)

    def complete(self, size: int) -> None:
        self.done += size


class ModelStore:
    def __init__(self, root: Path | str, store_version: str = "v1"):
        self.root = Path(root).expanduser().resolve()
        self.store_version = store_version
        # One lock per store instance rather than per model: two concurrent
        # jobs wanting the SAME weight must not both download it, and jobs
        # wanting different weights are rare enough that serialising the
        # fetch costs nothing real.
        self._lock = threading.Lock()

    # ── Paths ────────────────────────────────────────────────────────────

    def model_dir(self, spec: ModelSpec) -> Path:
        return self.root / self.store_version / spec.id

    def file_path(self, spec: ModelSpec, mf: ModelFile) -> Path:
        return self.model_dir(spec) / mf.name

    def model_path(self, spec: ModelSpec) -> Path:
        """Path of the model's WEIGHTS file. Kept because that is what callers
        mean when they say "where is the model"."""
        return self.file_path(spec, spec.weights)

    def _receipt_path(self, spec: ModelSpec, mf: ModelFile) -> Path:
        return self.model_dir(spec) / (mf.name + ".json")

    # ── Presence ─────────────────────────────────────────────────────────

    def file_status(self, spec: ModelSpec, mf: ModelFile) -> FileStatus:
        """Cheap presence check: trusts the receipt when the file's size and
        mtime still match what was verified. A full re-hash of 435 MB on every
        status poll would make the UI's model-state readout cost real time."""
        path = self.file_path(spec, mf)
        if not path.exists():
            return FileStatus(mf.role, mf.name, False, None, 0, None)

        stat = path.stat()
        receipt = self._read_receipt(spec, mf)
        if receipt and receipt.get("sha256") == mf.sha256 \
                and receipt.get("size") == stat.st_size \
                and receipt.get("mtime") == int(stat.st_mtime):
            return FileStatus(mf.role, mf.name, True, str(path), stat.st_size,
                              receipt.get("verifiedAt"))

        # No usable receipt — the file is there but unproven. Report absent so
        # the caller re-verifies (ensure() will hash it before re-downloading).
        return FileStatus(mf.role, mf.name, False, str(path), stat.st_size, None)

    def status(self, spec: ModelSpec) -> ModelStatus:
        files = [self.file_status(spec, mf) for mf in spec.files]
        present = all(f.present for f in files)
        verified = [f.verified_at for f in files if f.verified_at is not None]
        missing_bytes = sum(mf.size_bytes for mf, fs in zip(spec.files, files)
                            if not fs.present)
        return ModelStatus(
            model_id=spec.id,
            present=present,
            path=str(self.model_path(spec)) if present else None,
            size_bytes=sum(f.size_bytes for f in files),
            # The OLDEST verification is the honest one for the model as a
            # whole: it is the point from which every file has been proven.
            verified_at=min(verified) if verified and present else None,
            files=files,
            missing_bytes=missing_bytes,
        )

    def _read_receipt(self, spec: ModelSpec, mf: ModelFile) -> Optional[dict]:
        try:
            return json.loads(self._receipt_path(spec, mf).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def _write_receipt(self, spec: ModelSpec, mf: ModelFile, path: Path) -> None:
        stat = path.stat()
        self._receipt_path(spec, mf).write_text(json.dumps({
            "modelId": spec.id,
            "role": mf.role,
            "file": mf.name,
            "sha256": mf.sha256,
            "size": stat.st_size,
            "mtime": int(stat.st_mtime),
            "url": mf.url,
            "verifiedAt": time.time(),
            "license": spec.license.status,
        }, indent=2), encoding="utf-8")

    # ── Acquisition ──────────────────────────────────────────────────────

    def ensure(
        self,
        spec: ModelSpec,
        on_progress: Optional[ProgressFn] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Dict[str, Path]:
        """Return verified local paths for every file `spec` needs, keyed by role.

        `on_progress(phase, fraction, detail)` is called with phase in
        {'verifying', 'downloading'}; fraction is 0..1 across the WHOLE model,
        weighted by bytes.

        Refuses outright for a model whose license audit is not closed — a
        weight we may not use is a weight we should not even fetch. The
        acknowledgement gate is NOT checked here: it belongs at the HTTP door,
        where the answer can still change what happens (see app.py).
        """
        assert_license_cleared(spec)

        with self._lock:
            self.model_dir(spec).mkdir(parents=True, exist_ok=True)
            meter = _Weighted(spec.total_bytes, on_progress)
            paths: Dict[str, Path] = {}
            for mf in spec.files:
                paths[mf.role] = self._ensure_one(spec, mf, meter, cancel)
                meter.complete(mf.size_bytes)
            return paths

    def _ensure_one(
        self,
        spec: ModelSpec,
        mf: ModelFile,
        meter: _Weighted,
        cancel: Optional[threading.Event],
    ) -> Path:
        path = self.file_path(spec, mf)

        # An unproven file already on disk: hash it before assuming the worst.
        # This is the ordinary path after an app restart when the receipt was
        # lost, and re-hashing beats re-downloading.
        if path.exists():
            if self._verify(mf, path, meter, cancel):
                self._write_receipt(spec, mf, path)
                return path
            path.unlink(missing_ok=True)

        self._download(mf, path, meter, cancel)
        if not self._verify(mf, path, meter, cancel):
            actual = sha256_file(path)
            path.unlink(missing_ok=True)
            raise ChecksumMismatch(spec.id, mf.name, mf.sha256, actual)

        self._write_receipt(spec, mf, path)
        return path

    def _verify(
        self,
        mf: ModelFile,
        path: Path,
        meter: _Weighted,
        cancel: Optional[threading.Event],
    ) -> bool:
        total = max(1, path.stat().st_size)
        seen = 0

        def bump(n: int) -> None:
            nonlocal seen
            if cancel is not None and cancel.is_set():
                raise DownloadCancelled("cancelled while verifying")
            seen += n
            # Scale the file's own hashing progress onto its share of the
            # model, so a 1.2 kB config cannot jump the bar.
            meter.report("verifying", int(mf.size_bytes * min(1.0, seen / total)), mf.name)

        return sha256_file(path, bump) == mf.sha256

    def _download(
        self,
        mf: ModelFile,
        dest: Path,
        meter: _Weighted,
        cancel: Optional[threading.Event],
    ) -> None:
        part = dest.with_suffix(dest.suffix + ".part")
        part.unlink(missing_ok=True)

        req = urllib.request.Request(mf.url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp, part.open("wb") as out:
                declared = resp.headers.get("Content-Length")
                total = int(declared) if declared and declared.isdigit() else mf.size_bytes
                total = max(1, total)
                seen = 0
                while True:
                    if cancel is not None and cancel.is_set():
                        raise DownloadCancelled("cancelled while downloading")
                    block = resp.read(CHUNK_BYTES)
                    if not block:
                        break
                    out.write(block)
                    seen += len(block)
                    meter.report(
                        "downloading",
                        int(mf.size_bytes * min(1.0, seen / total)),
                        f"{mf.name} — {seen // (1024 * 1024)} of {total // (1024 * 1024)} MB")
        except urllib.error.URLError as exc:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"could not download {mf.name} from {mf.url}: {exc}") from None
        except BaseException:
            part.unlink(missing_ok=True)
            raise

        # Rename only after the body is complete. os.replace is atomic on
        # both Windows and POSIX, so the real name never holds a partial file.
        os.replace(part, dest)

    # ── Housekeeping ─────────────────────────────────────────────────────

    def remove(self, spec: ModelSpec) -> bool:
        d = self.model_dir(spec)
        if not d.exists():
            return False
        shutil.rmtree(d, ignore_errors=True)
        return True

    def disk_usage(self) -> int:
        root = self.root / self.store_version
        if not root.exists():
            return 0
        return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
