"""Mel-Band RoFormer inference (ONNX graph + the model's own YAML).

The BALANCED tier. Two things make this materially different from the MDX tier
in mdx.py, and both of them are traps rather than details.

**The checkpoint carries no architecture.** `becruily_deux.ckpt` is 1188 raw
tensors. Everything about how they are wired — 12 layers, 60 mel bands, a
2048-point STFT at hop 441 — lives in a YAML next to it, which is why that YAML
is downloaded and checksummed like the weight rather than paraphrased into
models.json. Guessing any of it wrong either fails a strict load (loud, fine)
or silently degrades the separation (quiet, not fine).

**The chunking is config-driven, and this config is not like the others.** The
reference inference path (ZFTurbo's Music-Source-Separation-Training, `demix`
in `utils/model_utils.py`) reads `audio.chunk_size` and `inference.num_overlap`
and overlap-adds linearly-faded chunks. This model's YAML sets chunk_size to
573300 — 13.0 s — where nearly every other published Mel-RoFormer config uses
352800 (8 s). It also carries an `inference.dim_t: 1101` that implies a
485100-sample chunk and contradicts its own `audio.chunk_size`. See
CHUNKING PITFALLS below; the short version is that this YAML belongs to this
checkpoint and to no other.

## This tier no longer needs torch

It used to build the vendored PyTorch model and run its `forward` end to end.
It now runs a shipped ONNX graph through onnxruntime, with the STFT pair in
numpy either side of it (`dsp.py`), and the mel band layout baked into the
graph as constants — which is what removed librosa, einops,
rotary-embedding-torch and beartype along with torch itself.

Two consequences worth knowing:

  * **The GPU question is no longer split.** It used to be that a CUDA
    onnxruntime did nothing for this tier and a CUDA torch did nothing for
    FAST, so the two tiers could honestly report different devices on one
    machine. All three tiers now share one runtime and one provider list.
  * **First run on a new checkpoint writes a weight file.** The shipped graph
    has no weights in it; `weights.install` fills it from the `.ckpt` the user
    downloaded. That takes a second or so and happens once per model.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from .manifest import ModelSpec, assert_license_cleared
from .ort_util import available_device
from .roformer_engine import (
    GraphMissing,
    RoformerOnnxEngine,
    SeparationCancelled,
    chunk_plan,
    separate_chunked,
    windowing_array,
)

__all__ = [
    "MelBandRoformerSeparator",
    "available_device",
    "SeparationCancelled",
    "ConfigError",
    "GraphMissing",
    "chunk_plan",
    "windowing_array",
    "load_config",
]


class ConfigError(RuntimeError):
    """The model's YAML is missing something inference cannot proceed without."""


def load_config(path: Path | str) -> Dict[str, Any]:
    """Read the model's YAML.

    `yaml.unsafe_load`, not `safe_load`, and that is not laziness: these
    configs use `!!python/tuple` for the multi-STFT window sizes, which the
    safe loader refuses outright. The file is not untrusted input — it is
    pinned to a commit and checksummed against models.json before it ever
    reaches here, so by this point its bytes are known exactly.
    """
    import yaml

    text = Path(path).read_text(encoding="utf-8")
    cfg = yaml.unsafe_load(text)
    if not isinstance(cfg, dict):
        raise ConfigError(f"{path}: expected a mapping at the top level")
    for section in ("audio", "model", "training", "inference"):
        if section not in cfg:
            raise ConfigError(f"{path}: missing '{section}' section")
    return cfg


class MelBandRoformerSeparator:
    """One loaded Mel-Band RoFormer, ready to separate.

    Construction is the expensive part (writing the weight file on a first run,
    then opening the onnxruntime session), so a job holds one of these for its
    whole run.
    """

    def __init__(
        self,
        spec: ModelSpec,
        weights_path: Path,
        config_path: Path,
        prefer_device: Optional[str] = None,
        on_install_progress: Optional[Callable[[int, int], None]] = None,
    ):
        assert_license_cleared(spec)

        self.spec = spec
        self.weights_path = Path(weights_path)
        self.config_path = Path(config_path)
        self.warnings: List[str] = []

        cfg = load_config(self.config_path)
        self.config = cfg

        model_cfg = dict(cfg["model"])
        self.sample_rate = int(model_cfg.get("sample_rate", spec.sample_rate))
        self.hop = int(model_cfg.get("stft_hop_length", 0))
        if self.hop <= 0:
            raise ConfigError("model.stft_hop_length is missing or not positive")
        self.n_fft = int(model_cfg.get("stft_n_fft", 0))
        if self.n_fft <= 0:
            raise ConfigError("model.stft_n_fft is missing or not positive")
        self.audio_channels = 2 if model_cfg.get("stereo", True) else 1

        # ── CHUNKING PITFALLS ────────────────────────────────────────────
        #
        # 1. WHERE chunk_size comes from. The reference prefers
        #    `inference.chunk_size` and falls back to `audio.chunk_size`. This
        #    config has no inference.chunk_size, so audio.chunk_size (573300 =
        #    13.0 s) is the operative value. Most published Mel-RoFormer
        #    configs say 352800 (8 s); pasting one of those in here runs
        #    without error and separates worse, because the model has never
        #    seen a context window that short.
        #
        # 2. `inference.dim_t` IS A DECOY in this file. It says 1101, which at
        #    hop 441 implies a 485100-sample chunk — not 573300. Mel-Band
        #    RoFormer is length-agnostic, so the reference never reads dim_t
        #    for this architecture; the field is a leftover from the MDX-style
        #    configs these YAMLs were cloned from. Same for audio.dim_f /
        #    audio.dim_t / audio.n_fft, which describe a transform this model
        #    does not use. We warn rather than adopt.
        #
        # 3. chunk_size must be a whole number of STFT hops. The overlap-add
        #    assumes each chunk lands on a frame boundary, and a remainder puts
        #    a sub-frame drift into every seam. It holds here (573300 =
        #    1300 * 441) and is asserted rather than assumed.
        inference = dict(cfg.get("inference", {}))
        audio = dict(cfg.get("audio", {}))
        chunk_size = inference.get("chunk_size", audio.get("chunk_size"))
        if not chunk_size:
            raise ConfigError(
                "neither inference.chunk_size nor audio.chunk_size is set — "
                "there is no honest default for this, every checkpoint differs")
        self.chunk_size = int(chunk_size)

        if self.chunk_size % self.hop:
            raise ConfigError(
                f"chunk_size {self.chunk_size} is not a multiple of stft_hop_length "
                f"{self.hop} (remainder {self.chunk_size % self.hop}). The chunked "
                "overlap-add assumes chunks land on frame boundaries.")

        decoy_dim_t = inference.get("dim_t")
        if decoy_dim_t:
            implied = (int(decoy_dim_t) - 1) * self.hop
            if implied != self.chunk_size:
                self.warnings.append(
                    f"config's inference.dim_t={decoy_dim_t} implies a {implied}-sample "
                    f"chunk but audio.chunk_size is {self.chunk_size}; using "
                    f"{self.chunk_size} (the value the reference inference path reads)")

        self.num_overlap = max(1, int(inference.get("num_overlap", 2)))
        self.step = self.chunk_size // self.num_overlap
        self.border = self.chunk_size - self.step
        self.fade_size = self.chunk_size // 10

        # ── Stems ────────────────────────────────────────────────────────
        training = dict(cfg.get("training", {}))
        target = training.get("target_instrument")
        instruments = ([str(target)] if target
                       else [str(i) for i in training.get("instruments", [])])
        if not instruments:
            raise ConfigError("training.instruments is empty and no target_instrument is set")
        self.instruments = instruments

        expected = spec.stem_names
        if expected and expected != instruments:
            self.warnings.append(
                f"manifest expects stems {expected} but the model's config declares "
                f"{instruments}; using the config's")

        # ── Cross-check the manifest's `expects` block ───────────────────
        #
        # The config is checksummed, so it cannot drift behind our back — this
        # exists to catch the other direction: a manifest entry written from
        # the wrong model's numbers. The CONFIG wins, always, and the mismatch
        # becomes a job warning.
        self._check_expectations(spec)

        # ── Graph, weights and session ───────────────────────────────────
        self.engine = RoformerOnnxEngine(
            model_id=spec.id,
            checkpoint_path=self.weights_path,
            model_dir=self.weights_path.parent,
            n_fft=self.n_fft,
            hop=self.hop,
            audio_channels=self.audio_channels,
            chunk_size=self.chunk_size,
            prefer_device=prefer_device,
            on_install_progress=on_install_progress,
        )
        self.warnings.extend(self.engine.warnings)
        self.device = self.engine.device
        self.chunk_size = self.engine.chunk_size

    # ── Setup helpers ────────────────────────────────────────────────────

    def _check_expectations(self, spec: ModelSpec) -> None:
        expects = dict(spec.params.get("expects", {}))
        if not expects:
            return
        model_cfg = dict(self.config["model"])
        actual = {
            "chunk_size": self.chunk_size,
            "stft_hop_length": self.hop,
            "stft_n_fft": self.n_fft,
            "num_bands": int(model_cfg.get("num_bands", 0)),
            "num_overlap": self.num_overlap,
            "sample_rate": self.sample_rate,
            "instruments": self.instruments,
        }
        for key, want in expects.items():
            if key not in actual:
                continue
            got = actual[key]
            if isinstance(want, list):
                want = [str(v) for v in want]
            if got != want:
                self.warnings.append(
                    f"manifest expects {key}={want} but the model's config says {got}; "
                    "using the config's")

    # ── Separation ───────────────────────────────────────────────────────

    def plan(self, n_samples: int) -> Dict[str, Any]:
        """How the job will be cut up, without doing any of it. Delegates to
        chunk_plan so the UI's denominator and the real run cannot disagree."""
        return chunk_plan(n_samples, self.chunk_size, self.step, self.border)

    def separate(
        self,
        mix: np.ndarray,
        batch_size: Optional[int] = None,
        on_chunk: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Dict[str, np.ndarray]:
        """Separate [2, n] float32 at self.sample_rate.

        Returns {instrument: [2, n]} for every instrument the model predicts.

        Unlike the MDX tier, BOTH stems here are model outputs — there is no
        residual — so they do not sum back to the mix. Each is an independent
        estimate and their errors do not cancel. That is normally the better
        separation and is worth knowing about before relying on the sum.

        `batch_size` is accepted and ignored. The exported graph has a fixed
        batch of 1: both tiers run at the config's own batch_size of 1 anyway,
        and a static batch is part of what lets onnxruntime pick
        shape-specialised kernels.
        """
        if mix.ndim != 2 or mix.shape[0] != 2:
            raise ValueError(f"expected [2, n] input, got {mix.shape}")

        estimated = separate_chunked(
            self.engine, mix,
            n_stems=len(self.instruments),
            step=self.step, border=self.border, fade_size=self.fade_size,
            on_chunk=on_chunk, cancel=cancel)

        return {name: np.ascontiguousarray(estimated[i], dtype=np.float32)
                for i, name in enumerate(self.instruments)}
