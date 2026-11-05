"""Build the Python runtime that XLETH ships the separation sidecar on.

    python tools/build_sidecar_runtime.py

Produces `runtime/` next to this package: a self-contained, relocatable CPython
with the sidecar's dependencies installed and everything it does not need
removed. electron-builder copies that tree into the packaged app, and
`ui/electron-main/separation.js` runs `runtime/python.exe` in preference to
anything it finds on the user's PATH.

**This is what makes the feature work for people who do not have Python.** The
sidecar used to require the user to install Python 3.9+ and pip-install a
requirements file — on a build where `tools/separation_sidecar/` does not even
exist, because the installer does not ship a source tree. Vocal separation was
effectively developer-only.

## Why the whole thing fits

The dependency list is ~135 MB installed, and it is that small only because the
Roformer tiers infer in onnxruntime rather than torch. With torch it was ~1.1 GB
— 533 MB for torch, 330 MB for librosa's scientific stack, 100 MB for torch's
own sympy/networkx — which is not an installer anybody downloads to try a
feature. See `onnx_export.py` for how that was removed.

## Why python-build-standalone rather than a venv or the embeddable zip

A venv is not relocatable: it hardcodes the interpreter path of the machine
that made it, so it breaks the moment it is copied into Program Files. The
official Windows "embeddable" package is relocatable but deliberately ships
without pip and with a `._pth` file that disables normal site-packages
handling, both of which have to be undone by hand. python-build-standalone
produces a normal, complete, relocatable CPython under the PSF licence and is
what most tools in this position use.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path
from typing import Iterable

REPO = Path(__file__).resolve().parents[1]

# Pinned. A floating "latest" would mean two builds of the same XLETH commit
# could ship different interpreters, and a Python release that drops a wheel
# the sidecar needs would break the build with no trace of what changed.
#
# 3.12 rather than the newest: every dependency here has had cp312 wheels for
# years, whereas a brand-new minor is where "no matching distribution" comes
# from, usually for onnxruntime.
PYTHON_VERSION = "3.12.14"
PBS_RELEASE = "20260901"
ASSET = (f"cpython-{PYTHON_VERSION}+{PBS_RELEASE}-x86_64-pc-windows-msvc-"
         "install_only.tar.gz")
ASSET_URL = ("https://github.com/astral-sh/python-build-standalone/releases/"
             f"download/{PBS_RELEASE}/{ASSET}")

# Removed after the install. Each is either a build-time tool the runtime never
# calls, or a stdlib component the sidecar has no use for.
#
# NOT on this list, deliberately: anything under `*.dist-info`. Those carry the
# licence texts of packages XLETH redistributes, and dropping them to save a
# megabyte would turn a packaging optimisation into a licensing problem.
PRUNE_DIRS = (
    "pip", "pip-*.dist-info", "setuptools", "setuptools-*.dist-info",
    "wheel", "wheel-*.dist-info", "pkg_resources", "_distutils_hack",
)
PRUNE_STDLIB = (
    "test", "tests", "idlelib", "tkinter", "turtledemo", "lib2to3",
    "ensurepip", "distutils",
)
# Trees at the root of the interpreter that nothing here calls.
#
# `tcl` is Tk's data files and is 10 MB on its own — dead weight the moment
# tkinter goes. `include` is C headers for building extensions, which this
# runtime never does. `Scripts` holds console-entry-point .exe shims
# (uvicorn.exe, f2py.exe); the sidecar is started as `python.exe -m
# xleth_separation`, so nothing resolves through them.
PRUNE_TOP = ("tcl", "include", "Scripts")
PRUNE_GLOBS = (
    "**/__pycache__", "**/*.pdb", "**/*.pyc",
    # The Tk binaries, which live beside the stdlib rather than inside it.
    "DLLs/_tkinter.pyd", "DLLs/tcl*.dll", "DLLs/tk*.dll",
)


def human(num_bytes: int) -> str:
    return f"{num_bytes / 1e6:.0f} MB"


def tree_size(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())


def download(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  cached {dest.name} ({human(dest.stat().st_size)})")
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, open(tmp, "wb") as handle:
        shutil.copyfileobj(response, handle)
    tmp.replace(dest)
    print(f"  got {human(dest.stat().st_size)}")
    return dest


def extract(archive: Path, target: Path) -> Path:
    """Unpack the standalone build; its files sit under a `python/` prefix."""
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        # `filter="data"` refuses absolute paths, parent traversal and device
        # nodes. The archive is from a known release, but an extractor that
        # trusts its input is how a supply-chain problem becomes a local one.
        try:
            tar.extractall(target, filter="data")
        except TypeError:                     # Python < 3.12 has no filter=
            tar.extractall(target)

    inner = target / "python"
    if not inner.is_dir():
        raise RuntimeError(f"unexpected archive layout under {target}")
    return inner


def prune(root: Path, patterns: Iterable[str], label: str) -> int:
    freed = 0
    for pattern in patterns:
        for path in sorted(root.glob(pattern), reverse=True):
            if not path.exists():
                continue
            size = tree_size(path) if path.is_dir() else path.stat().st_size
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)
            freed += size
    if freed:
        print(f"  pruned {label}: {human(freed)}")
    return freed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=REPO / "runtime")
    parser.add_argument("--cache", type=Path, default=REPO / ".runtime-cache")
    parser.add_argument("--keep-pip", action="store_true",
                        help="leave pip installed (useful when iterating)")
    args = parser.parse_args()

    print(f"Building the sidecar runtime (CPython {PYTHON_VERSION})")
    archive = download(ASSET_URL, args.cache / ASSET)

    staging = args.cache / "staging"
    print("  extracting…")
    extracted = extract(archive, staging)
    print(f"  base interpreter: {human(tree_size(extracted))}")

    python = extracted / "python.exe"
    if not python.exists():
        raise RuntimeError(f"no python.exe in {extracted}")

    requirements = REPO / "requirements.txt"
    print(f"  installing {requirements.name}…")
    subprocess.run(
        [str(python), "-m", "pip", "install", "--no-cache-dir", "--no-compile",
         "--disable-pip-version-check", "-r", str(requirements)],
        check=True)

    before = tree_size(extracted)
    print(f"  with dependencies: {human(before)}")

    site_packages = extracted / "Lib" / "site-packages"
    if not args.keep_pip:
        prune(site_packages, PRUNE_DIRS, "build tools")
    prune(extracted / "Lib", PRUNE_STDLIB, "unused stdlib")
    prune(extracted, PRUNE_TOP, "unused interpreter trees")
    prune(extracted, PRUNE_GLOBS, "caches, symbols and Tk")

    after = tree_size(extracted)
    print(f"  after pruning: {human(after)}  (saved {human(before - after)})")

    # Prove the result actually runs before declaring it built. A runtime that
    # imports nothing is worse than no runtime: it ships, and it fails on the
    # user's machine at the first separation.
    print("  verifying…")
    check = subprocess.run(
        [str(python), "-c",
         "import json, onnxruntime, numpy, soundfile, yaml, fastapi, uvicorn, soxr; "
         "print(json.dumps({'onnxruntime': onnxruntime.__version__, "
         "'numpy': numpy.__version__, "
         "'providers': onnxruntime.get_available_providers()}))"],
        capture_output=True, text=True)
    if check.returncode != 0:
        print(check.stdout)
        print(check.stderr, file=sys.stderr)
        raise RuntimeError("the built runtime cannot import its own dependencies")
    print(f"  {check.stdout.strip()}")

    if args.out.exists():
        shutil.rmtree(args.out)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(extracted), str(args.out))
    shutil.rmtree(staging, ignore_errors=True)

    total = tree_size(args.out)
    print(f"\nruntime ready at {args.out}  ({human(total)})")
    (args.out / "xleth-runtime.json").write_text(json.dumps({
        "pythonVersion": PYTHON_VERSION,
        "pythonBuildStandalone": PBS_RELEASE,
        "bytes": total,
    }, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
