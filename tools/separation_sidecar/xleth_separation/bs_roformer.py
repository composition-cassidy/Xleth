"""BS-Roformer inference (ONNX graph + the model's own YAML).

The BEST tier. A close cousin of the BALANCED tier's Mel-Band RoFormer — same
vendor commit, same reflect-padded chunked overlap-add, same `demix` lineage —
but architecturally distinct: BS-Roformer splits the spectrogram into FIXED
frequency bands (`model.freqs_per_bands`, in raw STFT bins) rather than
mel-scale ones. That difference mattered a great deal when the tiers ran in
torch, because it was the reason this one never needed librosa; now that both
run as exported graphs with their band layouts baked in as constants, neither
does.

The chunking machinery is imported from roformer_engine rather than
re-derived: "reflect-pad, cut into overlapping chunks, cross-fade the seams"
is generic and does not know which architecture's config it was handed.
mdx.py's chunk_plan is a genuinely different shape (trim-based framing) and
rightly stands alone; this one is the same shape as BALANCED's.

**Single-target, not multi-output.** The FT1 checkpoint's yaml sets
`training.target_instrument: vocals` and `model.num_stems: 1` — the model
predicts ONE stem, and the manifest's `stems.mode` is `primary_plus_residual`,
the same convention the FAST tier's MDX-Net uses: the instrumental is
mix-minus-vocals, not a second model output. A future BS-Roformer checkpoint
trained multi-target would set `num_stems` > 1 and `model_outputs` instead;
this module reads `spec.stem_mode` rather than assuming one or the other.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from .manifest import STEM_MODE_RESIDUAL, ModelSpec, assert_license_cleared
from .ort_util import available_device
from .roformer import ConfigError, load_config
from .roformer_engine import (
    GraphMissing,
    RoformerOnnxEngine,
    SeparationCancelled,
    chunk_plan,
    separate_chunked,
)

__all__ = ["BSRoformerSeparator", "available_device", "SeparationCancelled",
           "ConfigError", "GraphMissing", "chunk_plan"]


class BSRoformerSeparator:
    """One loaded BS-Roformer, ready to separate.

    Construction is the expensive part (writing the weight file on a first run,
    then opening the onnxruntime session), so a job holds one of these for its
    whole run — same lifecycle as MelBandRoformerSeparator.
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
        audio_cfg = dict(cfg.get("audio", {}))
        self.sample_rate = int(audio_cfg.get("sample_rate", spec.sample_rate))

        # The model's OWN STFT hop, not audio.hop_length. Both are present in
        # this yaml and they disagree (512 vs 441) — audio.hop_length is a
        # decoy leftover from the MDX-style configs these files are cloned
        # from, same trap BALANCED's audio.dim_f/dim_t/n_fft are. The model
        # never reads the audio.* transform fields; its STFT is built entirely
        # from model.stft_n_fft / stft_hop_length / stft_win_length.
        self.hop = int(model_cfg.get("stft_hop_length", 0))
        if self.hop <= 0:
            raise ConfigError("model.stft_hop_length is missing or not positive")
        self.n_fft = int(model_cfg.get("stft_n_fft", 0))
        if self.n_fft <= 0:
            raise ConfigError("model.stft_n_fft is missing or not positive")
        self.audio_channels = 2 if model_cfg.get("stereo", True) else 1

        decoy_hop = audio_cfg.get("hop_length")
        if decoy_hop and int(decoy_hop) != self.hop:
            self.warnings.append(
                f"config's audio.hop_length={decoy_hop} disagrees with the model's own "
                f"stft_hop_length={self.hop}; using stft_hop_length (what the graph "
                "was exported against)")

        inference = dict(cfg.get("inference", {}))
        chunk_size = inference.get("chunk_size", audio_cfg.get("chunk_size"))
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

        num_stems = int(model_cfg.get("num_stems", len(instruments)))
        if target and num_stems != 1:
            self.warnings.append(
                f"training.target_instrument is set but model.num_stems={num_stems}; "
                "using the single target instrument, which is what the checkpoint's "
                "mask_estimators actually predict for a target-instrument model")

        if spec.stem_mode != STEM_MODE_RESIDUAL:
            expected = spec.stem_names
            if expected and expected != instruments:
                self.warnings.append(
                    f"manifest expects stems {expected} but the model's config declares "
                    f"{instruments}; using the config's")

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
        actual = {
            "chunk_size": self.chunk_size,
            "stft_hop_length": self.hop,
            "stft_n_fft": self.n_fft,
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
        the same chunk_plan BALANCED uses — identical geometry, different
        numbers."""
        return chunk_plan(n_samples, self.chunk_size, self.step, self.border)

    def separate(
        self,
        mix: np.ndarray,
        batch_size: Optional[int] = None,
        on_chunk: Optional[Callable[[int, int], None]] = None,
        cancel: Optional[threading.Event] = None,
    ) -> Dict[str, np.ndarray]:
        """Separate [2, n] float32 at self.sample_rate.

        Runs the identical reflect-pad / windowed overlap-add loop
        MelBandRoformerSeparator.separate uses. What differs is the tail: this
        checkpoint predicts one stem, so the second one is computed as the
        residual, exactly like the FAST tier.

        `batch_size` is accepted and ignored — see the note on the BALANCED
        tier's `separate`.
        """
        if mix.ndim != 2 or mix.shape[0] != 2:
            raise ValueError(f"expected [2, n] input, got {mix.shape}")

        estimated = separate_chunked(
            self.engine, mix,
            n_stems=len(self.instruments),
            step=self.step, border=self.border, fade_size=self.fade_size,
            on_chunk=on_chunk, cancel=cancel)

        stems = {name: np.ascontiguousarray(estimated[i], dtype=np.float32)
                 for i, name in enumerate(self.instruments)}

        if self.spec.stem_mode != STEM_MODE_RESIDUAL:
            return stems

        # Single model output plus the residual, same convention mdx.py uses:
        # the two stems sum back to the mix exactly, which is a property worth
        # having when both land as layers in the Sandbox.
        primary_name = self.spec.stems["primary"]
        secondary_name = self.spec.stems.get("secondary", "Residual")
        primary = stems[self.instruments[0]]
        secondary = (mix.astype(np.float32, copy=False) - primary).astype(np.float32)
        return {primary_name: primary, secondary_name: secondary}
