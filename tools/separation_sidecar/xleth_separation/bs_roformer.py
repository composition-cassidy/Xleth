"""BS-Roformer inference (torch weights, the model's own YAML).

The BEST tier. A close cousin of the BALANCED tier's Mel-Band RoFormer — same
vendor commit, same reflect-padded chunked overlap-add, same `demix` lineage —
but architecturally distinct: BS-Roformer splits the spectrogram into FIXED
frequency bands (`model.freqs_per_bands`, in raw STFT bins) rather than
mel-scale ones, so it never needs librosa's mel filterbank. One fewer runtime
dependency than BALANCED despite being the heavier model.

The chunking machinery is imported from roformer.py rather than re-derived:
`chunk_plan`, `windowing_array`, `load_config` and `available_device` are
generic to "reflect-pad, cut into overlapping chunks, cross-fade the seams,
ask torch for a device" and do not know or care which architecture's config
they are handed. Duplicating that math here would risk the two copies
drifting — mdx.py's chunk_plan is a genuinely different shape (trim-based
framing) and rightly stands alone; this one is the same shape as BALANCED's.

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
from .roformer import (
    ConfigError,
    SeparationCancelled,
    _NullContext,
    _t,
    available_device,
    chunk_plan,
    load_config,
    windowing_array,
)

__all__ = ["BSRoformerSeparator", "available_device", "SeparationCancelled", "ConfigError"]


class BSRoformerSeparator:
    """One loaded BS-Roformer, ready to separate.

    Construction is the expensive part (the model off disk, band-split and
    mask-estimator heads for every one of ~60 bands), so a job holds one of
    these for its whole run — same lifecycle as MelBandRoformerSeparator.
    """

    def __init__(
        self,
        spec: ModelSpec,
        weights_path: Path,
        config_path: Path,
        prefer_device: Optional[str] = None,
    ):
        assert_license_cleared(spec)
        torch = _t()

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
        # never reads the audio.* transform fields; forward() builds its STFT
        # entirely from model.stft_n_fft/stft_hop_length/stft_win_length.
        self.hop = int(model_cfg.get("stft_hop_length", 0))
        if self.hop <= 0:
            raise ConfigError("model.stft_hop_length is missing or not positive")

        decoy_hop = audio_cfg.get("hop_length")
        if decoy_hop and int(decoy_hop) != self.hop:
            self.warnings.append(
                f"config's audio.hop_length={decoy_hop} disagrees with the model's own "
                f"stft_hop_length={self.hop}; using stft_hop_length (what forward() reads)")

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
        self.batch_size = max(1, int(inference.get("batch_size", 1)))

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

        # ── Build and load ───────────────────────────────────────────────
        from .vendor.bs_roformer import BSRoformer

        self.model = BSRoformer(**model_cfg)
        state = torch.load(str(self.weights_path), map_location="cpu", weights_only=True)
        for key in ("state", "state_dict", "model_state_dict"):
            if isinstance(state, dict) and key in state and isinstance(state[key], dict):
                state = state[key]
        # strict=True: a partial load is the failure mode that produces
        # plausible-sounding but wrong output, same reasoning as roformer.py.
        self.model.load_state_dict(state, strict=True)
        self.model.eval()

        self.device = self._select_device(prefer_device)
        self.model.to(self.device)

        self.use_amp = bool(training.get("use_amp", False)) and self.device == "cuda"
        self._window = windowing_array(self.chunk_size, self.fade_size, torch)

    # ── Setup helpers ────────────────────────────────────────────────────

    def _check_expectations(self, spec: ModelSpec) -> None:
        expects = dict(spec.params.get("expects", {}))
        if not expects:
            return
        model_cfg = dict(self.config["model"])
        actual = {
            "chunk_size": self.chunk_size,
            "stft_hop_length": self.hop,
            "stft_n_fft": int(model_cfg.get("stft_n_fft", 0)),
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

    def _select_device(self, prefer_device: Optional[str]) -> str:
        torch = _t()
        want = (prefer_device or "").lower()
        if want == "cpu":
            return "cpu"
        try:
            has_cuda = torch.cuda.is_available()
        except Exception:
            has_cuda = False
        if want == "cuda" and not has_cuda:
            self.warnings.append(
                "cuda was requested but this torch build reports no CUDA device — "
                "running on the CPU. The Roformer tiers infer in torch, so a CUDA "
                "onnxruntime does not help; install a CUDA torch build.")
            return "cpu"
        return "cuda" if has_cuda else "cpu"

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
        MelBandRoformerSeparator.separate uses — the two architectures share
        it because BSRoformer.forward and MelBandRoformer.forward present the
        same [B, channels, T] in / [B, stems, channels, T] out shape. What
        differs is the tail: this checkpoint predicts one stem, so the second
        one is computed as the residual, exactly like the FAST tier.
        """
        torch = _t()
        if mix.ndim != 2 or mix.shape[0] != 2:
            raise ValueError(f"expected [2, n] input, got {mix.shape}")

        batch = max(1, int(batch_size or self.batch_size))
        n_sample = mix.shape[1]
        layout = self.plan(n_sample)
        total_chunks = layout["chunks"]

        x = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))

        padded = layout["padded"] != n_sample
        if padded:
            x = torch.nn.functional.pad(x, (self.border, self.border), mode="reflect")

        n_stems = len(self.instruments)
        result = torch.zeros((n_stems,) + tuple(x.shape), dtype=torch.float32)
        counter = torch.zeros(x.shape[-1], dtype=torch.float32)

        starts = layout["starts"]
        done = 0
        autocast = (torch.autocast(device_type="cuda", dtype=torch.float16)
                    if self.use_amp else _NullContext())

        with torch.inference_mode():
            for base in range(0, total_chunks, batch):
                if cancel is not None and cancel.is_set():
                    raise SeparationCancelled("cancelled during inference")

                group = starts[base: base + batch]
                parts = []
                lengths = []
                for start in group:
                    part = x[:, start: start + self.chunk_size]
                    seg_len = part.shape[-1]
                    lengths.append(seg_len)
                    if seg_len < self.chunk_size:
                        mode = "reflect" if seg_len > self.chunk_size // 2 else "constant"
                        part = torch.nn.functional.pad(
                            part, (0, self.chunk_size - seg_len), mode=mode)
                    parts.append(part)

                arr = torch.stack(parts, dim=0).to(self.device)
                with autocast:
                    out = self.model(arr)
                out = out.float().cpu()

                for j, (start, seg_len) in enumerate(zip(group, lengths)):
                    window = self._window.clone()
                    if start == 0:
                        window[: self.fade_size] = 1.0
                    if start + self.step >= x.shape[1]:
                        window[-self.fade_size:] = 1.0
                    w = window[:seg_len]
                    result[..., start: start + seg_len] += out[j, ..., :seg_len] * w
                    counter[start: start + seg_len] += w

                done += len(group)
                if on_chunk is not None:
                    on_chunk(done, total_chunks)

        estimated = (result / counter).numpy()
        np.nan_to_num(estimated, copy=False, nan=0.0)
        if padded:
            estimated = estimated[..., self.border: -self.border]
        estimated = estimated[..., :n_sample]

        stems = {name: np.ascontiguousarray(estimated[i], dtype=np.float32)
                for i, name in enumerate(self.instruments)}

        if self.spec.stem_mode != STEM_MODE_RESIDUAL:
            return stems

        # Single model output plus the residual, same convention mdx.py uses:
        # the two stems sum back to the mix exactly, which is a property
        # worth having when both land as layers in the Sandbox.
        primary_name = self.spec.stems["primary"]
        secondary_name = self.spec.stems.get("secondary", "Residual")
        primary = stems[self.instruments[0]]
        secondary = (mix.astype(np.float32, copy=False) - primary).astype(np.float32)
        return {primary_name: primary, secondary_name: secondary}
