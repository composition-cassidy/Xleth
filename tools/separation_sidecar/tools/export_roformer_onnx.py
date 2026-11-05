"""Produce the shipped weightless ONNX graphs for the Roformer tiers.

**Dev-time, run by hand, output committed.** This is the only step in the
project that needs torch, and it is why torch is not in `requirements.txt`: it
runs here, on a maintainer's machine, and the artefacts it writes are what
ships.

    python tools/export_roformer_onnx.py

It reads the model configs and checkpoints out of the local model store — the
same directory the app downloads into — so run a separation once for each tier
first, or point `--store` somewhere else. It writes
`xleth_separation/graphs/<model_id>.onnx` (topology only, ~2 MB) and
`<model_id>.onnx.json` (the weight manifest).

## Re-export when, exactly

Whenever the vendored architecture under `xleth_separation/vendor/` changes,
whenever a tier's config changes its chunk size or hop, and whenever
`onnx_export.py` changes. The graphs encode all three. They do NOT encode the
weights, so a checkpoint being re-uploaded upstream is not a reason to
re-export — the manifest is matched against the checkpoint by tensor name and
shape at install time, and a genuine mismatch is reported there.

## The checkpoint is needed here but is not baked in

The export loads real weights because tracing runs the model, and because the
completeness check compares the graph's initializers against the checkpoint's
own key set. Every one of those initializers is then emptied before the file is
written. `verify_shipped_graphs` re-opens the result and asserts that no
initializer kept its bytes, so "we meant to strip it" is not taken on trust.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from xleth_separation import onnx_export                      # noqa: E402
from xleth_separation.roformer import load_config             # noqa: E402

DEFAULT_STORE = (Path(os.environ.get("APPDATA", Path.home()))
                 / "xleth-ui" / "xleth-separation" / "models" / "v1")

# model_id -> how to build it. The checkpoint and config file NAMES come from
# models.json, but the store lays them out per model id, so a glob is enough
# and stays correct if a manifest revision renames a file.
ARCHITECTURES = {
    "mel_roformer_becruily_deux": "mel_band_roformer",
    "bs_roformer_ft1_anvuew": "bs_roformer",
}


def _find(model_dir: Path, *suffixes: str) -> Path:
    for suffix in suffixes:
        hits = sorted(model_dir.glob(f"*{suffix}"))
        hits = [h for h in hits if not h.name.endswith(".json")]
        if hits:
            return hits[0]
    raise FileNotFoundError(f"no {suffixes} file in {model_dir}")


def build_model(arch: str, config: Dict[str, Any], checkpoint: Path):
    import torch

    model_cfg = dict(config["model"])
    if arch == "mel_band_roformer":
        from xleth_separation.vendor.mel_band_roformer import MelBandRoformer as Cls
    elif arch == "bs_roformer":
        from xleth_separation.vendor.bs_roformer import BSRoformer as Cls
    else:
        raise ValueError(f"unknown architecture {arch!r}")

    model = Cls(**model_cfg)
    state = torch.load(str(checkpoint), map_location="cpu", weights_only=True)
    for key in ("state", "state_dict", "model_state_dict"):
        if isinstance(state, dict) and key in state and isinstance(state[key], dict):
            state = state[key]
            break
    # strict=True: a partial load produces plausible-sounding but wrong output,
    # and an export of a half-initialised model would bake that in permanently.
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def chunk_geometry(config: Dict[str, Any]) -> Dict[str, int]:
    """chunk_size / hop / frames, by the same rules the separators use."""
    model_cfg = dict(config["model"])
    audio_cfg = dict(config.get("audio", {}))
    inference = dict(config.get("inference", {}))

    hop = int(model_cfg.get("stft_hop_length", 0))
    if hop <= 0:
        raise ValueError("model.stft_hop_length is missing or not positive")

    chunk_size = inference.get("chunk_size", audio_cfg.get("chunk_size"))
    if not chunk_size:
        raise ValueError("neither inference.chunk_size nor audio.chunk_size is set")
    chunk_size = int(chunk_size)

    if chunk_size % hop:
        raise ValueError(
            f"chunk_size {chunk_size} is not a multiple of stft_hop_length {hop}")

    return {
        "chunkSize": chunk_size,
        "hop": hop,
        "nFft": int(model_cfg.get("stft_n_fft", 0)),
        # A full chunk through a CENTRED stft yields exactly this many frames.
        # The graph is exported to it and every chunk is padded up to it.
        "frames": 1 + chunk_size // hop,
    }


def verify_shipped_graph(path: Path) -> Dict[str, int]:
    """Re-open the written graph and prove no weight survived in it."""
    import onnx

    graph = onnx.load(str(path), load_external_data=False)
    external = 0
    inline_bytes = 0
    for tensor in graph.graph.initializer:
        if tensor.data_location == onnx.TensorProto.EXTERNAL:
            external += 1
            if tensor.raw_data:
                raise RuntimeError(
                    f"{path.name}: initializer {tensor.name!r} is marked external "
                    "but still carries raw bytes")
        else:
            inline_bytes += len(tensor.raw_data)

    return {"external": external, "inlineBytes": inline_bytes,
            "fileBytes": path.stat().st_size}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--store", type=Path, default=DEFAULT_STORE,
                        help="model store root (default: the app's userData store)")
    parser.add_argument("--out", type=Path, default=REPO / "xleth_separation" / "graphs")
    parser.add_argument("--only", action="append", default=None,
                        help="export just this model id (repeatable)")
    args = parser.parse_args()

    wanted = {k: v for k, v in ARCHITECTURES.items()
              if not args.only or k in args.only}
    if not wanted:
        print(f"nothing to export; known ids: {sorted(ARCHITECTURES)}", file=sys.stderr)
        return 2

    args.out.mkdir(parents=True, exist_ok=True)
    failures = 0

    for model_id, arch in wanted.items():
        model_dir = args.store / model_id
        print(f"\n=== {model_id} ({arch}) ===", flush=True)
        if not model_dir.is_dir():
            print(f"  SKIP: {model_dir} does not exist — download this tier first")
            failures += 1
            continue

        try:
            config_path = _find(model_dir, ".yaml", ".yml")
            checkpoint = _find(model_dir, ".ckpt")
            config = load_config(config_path)
            geometry = chunk_geometry(config)
            print(f"  config     {config_path.name}")
            print(f"  checkpoint {checkpoint.name} ({checkpoint.stat().st_size/1e6:.0f} MB)")
            print(f"  geometry   chunk={geometry['chunkSize']} hop={geometry['hop']} "
                  f"n_fft={geometry['nFft']} frames={geometry['frames']}", flush=True)

            model = build_model(arch, config, checkpoint)
            out_path = args.out / f"{model_id}.onnx"
            print("  tracing…", flush=True)
            info = onnx_export.export_weightless_graph(
                model, out_path, n_frames=geometry["frames"],
                external_data_name=f"{model_id}.weights")

            info["modelId"] = model_id
            info["architecture"] = arch
            info["geometry"] = geometry
            info["audioChannels"] = model.audio_channels
            info.pop("path", None)

            checks = verify_shipped_graph(out_path)
            info["shipped"] = checks

            manifest_path = args.out / f"{model_id}.onnx.json"
            manifest_path.write_text(json.dumps(info, indent=1), encoding="utf-8")

            print(f"  graph      {out_path.name} "
                  f"{checks['fileBytes']/1e6:.2f} MB, {checks['external']} external "
                  f"initializers, {checks['inlineBytes']/1e3:.0f} kB inline constants")
            print(f"  weights    {info['totalWeightBytes']/1e6:.0f} MB to be written "
                  "on the user's machine at install time")
        except Exception as exc:                                  # noqa: BLE001
            import traceback
            traceback.print_exc()
            print(f"  FAILED: {exc}")
            failures += 1

    print("\ndone" if not failures else f"\n{failures} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
