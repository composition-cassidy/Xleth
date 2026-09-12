"""Mel-Band RoFormer inference (torch weights, the model's own YAML).

The BALANCED tier. Two things make this materially different from the MDX tier
in mdx.py, and both of them are traps rather than details.

**The checkpoint carries no architecture.** `becruily_deux.ckpt` is 1188 raw
tensors. Everything about how they are wired — 12 layers, 60 mel bands, a
2048-point STFT at hop 441 — lives in a YAML next to it, which is why that YAML
is downloaded and checksummed like the weight rather than paraphrased into
models.json. Guessing any of it wrong either fails a strict state_dict load
(loud, fine) or silently degrades the separation (quiet, not fine).

**The chunking is config-driven, and this config is not like the others.** The
reference inference path (ZFTurbo's Music-Source-Separation-Training, `demix`
in `utils/model_utils.py`) reads `audio.chunk_size` and `inference.num_overlap`
and overlap-adds linearly-faded chunks. This model's YAML sets chunk_size to
573300 — 13.0 s — where nearly every other published Mel-RoFormer config uses
352800 (8 s). It also carries an `inference.dim_t: 1101` that implies a
485100-sample chunk and contradicts its own `audio.chunk_size`. See
CHUNKING PITFALLS below; the short version is that this YAML belongs to this
checkpoint and to no other.

Torch does the inference here, not onnxruntime. That means the GPU path is
torch's: a CPU-only torch build runs this tier on the CPU no matter what
onnxruntime can see, which is why `available_device()` in this module asks
torch and not ORT.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from .manifest import ModelSpec, assert_license_cleared

# torch is imported LAZILY, for the same two reasons as in mdx.py: /health has
# to be able to report a half-finished install rather than crash on import,
# and importing torch costs seconds and hundreds of MB that a session which
# never separates anything should not pay.
_torch = None


def _t():
    global _torch
    if _torch is None:
        import torch as torch_module
        _torch = torch_module
    return _torch


class SeparationCancelled(RuntimeError):
    pass


class ConfigError(RuntimeError):
    """The model's YAML is missing something inference cannot proceed without."""


def available_device() -> str:
    """Best device TORCH can offer, which is the only one that matters here.

    Deliberately not onnxruntime's answer. A machine can have a perfectly good
    `onnxruntime-gpu` — making the FAST tier report `cuda` — and a CPU-only
    torch wheel, in which case this tier runs on the CPU at roughly 3 s of wall
    clock per second of audio. Reporting `cuda` there would be a nine-minute
    lie about a ninety-second job.
    """
    try:
        torch = _t()
    except ImportError:
        return "unavailable"
    try:
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return "cpu"


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


def windowing_array(window_size: int, fade_size: int, torch_mod) -> "torch.Tensor":
    """Linear fade-in / fade-out window, matching the reference exactly.

    Linear rather than a Hann or a raised cosine: with the overlap-add below
    dividing by the summed window, a linear cross-fade sums to a constant for
    any integer overlap, so the seam is flat by construction. Substituting a
    "better" window here would put a ripple into every chunk boundary.
    """
    window = torch_mod.ones(window_size)
    window[:fade_size] = torch_mod.linspace(0, 1, fade_size)
    window[-fade_size:] = torch_mod.linspace(1, 0, fade_size)
    return window


def chunk_plan(n_samples: int, chunk_size: int, step: int, border: int) -> Dict[str, Any]:
    """How a run of `n_samples` is cut into overlapping chunks.

    Module-level and the SINGLE source of this arithmetic, for the same reason
    as mdx.chunk_plan: `plan()` feeds the UI's chunk counter and the ETA
    denominator, `separate()` does the work, and when they each computed it
    themselves an off-by-one showed up as a progress bar that finished at 97%
    — never as a failure.

    `padded` accounts for the reflect-padded border the reference adds at both
    ends, because that padding is real audio the model has to process: leaving
    it out of the count makes every ETA optimistic by 2*border/step chunks.
    """
    padded = n_samples
    if n_samples > 2 * border and border > 0:
        padded = n_samples + 2 * border
    starts = list(range(0, padded, step)) if step > 0 else [0]
    return {
        "chunks": len(starts),
        "chunkSize": chunk_size,
        "step": step,
        "border": border,
        "padded": padded,
        "starts": starts,
    }


class MelBandRoformerSeparator:
    """One loaded Mel-Band RoFormer, ready to separate.

    Construction is the expensive part (217M parameters off disk, plus the
    librosa mel filterbank), so a job holds one of these for its whole run.
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
        self.sample_rate = int(model_cfg.get("sample_rate", spec.sample_rate))
        self.hop = int(model_cfg.get("stft_hop_length", 0))
        if self.hop <= 0:
            raise ConfigError("model.stft_hop_length is missing or not positive")

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
        #    RoFormer is length-agnostic (no fixed time dimension anywhere in
        #    the graph), so the reference never reads dim_t for this
        #    architecture; the field is a leftover from the MDX-style configs
        #    these YAMLs were cloned from. Same for audio.dim_f / audio.dim_t /
        #    audio.n_fft, which describe a transform this model does not use.
        #    We warn rather than adopt: a contradiction in a config is worth
        #    surfacing, but the field the reference reads is the field that
        #    was used to train.
        #
        # 3. chunk_size must be a whole number of STFT hops. The overlap-add
        #    below assumes each chunk lands on a frame boundary, and a
        #    remainder puts a sub-frame drift into every seam. It holds here
        #    (573300 = 1300 * 441) and is asserted rather than assumed.
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
        self.batch_size = max(1, int(inference.get("batch_size", 1)))

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
        # becomes a job warning. Same rule mdx.py applies when the ONNX graph
        # and the manifest disagree.
        self._check_expectations(spec)

        # ── Build and load ───────────────────────────────────────────────
        from .vendor.mel_band_roformer import MelBandRoformer

        self.model = MelBandRoformer(**model_cfg)
        state = torch.load(str(self.weights_path), map_location="cpu", weights_only=True)
        # Reference checkpoints occasionally arrive wrapped. Unwrap the known
        # envelopes; anything else is handed to load_state_dict as-is so a
        # genuinely unfamiliar layout fails loudly instead of half-loading.
        for key in ("state", "state_dict", "model_state_dict"):
            if isinstance(state, dict) and key in state and isinstance(state[key], dict):
                state = state[key]
        # strict=True on purpose. A partial load is the failure mode that
        # produces plausible-sounding but wrong output: randomly-initialised
        # attention blocks do not error, they just smear.
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
            # Asked for, unavailable, and silence here would mean a run that
            # takes six times longer than promised with nothing saying why.
            self.warnings.append(
                "cuda was requested but this torch build reports no CUDA device — "
                "running on the CPU. The Roformer tiers infer in torch, so a CUDA "
                "onnxruntime does not help; install a CUDA torch build.")
            return "cpu"
        return "cuda" if has_cuda else "cpu"

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
        """
        torch = _t()
        if mix.ndim != 2 or mix.shape[0] != 2:
            raise ValueError(f"expected [2, n] input, got {mix.shape}")

        batch = max(1, int(batch_size or self.batch_size))
        n_sample = mix.shape[1]
        layout = self.plan(n_sample)
        total_chunks = layout["chunks"]

        x = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))

        # Reflect-pad the borders so the first and last chunks have real
        # signal either side of them instead of the silence that produces an
        # audible swell at both ends of every separated stem.
        padded = layout["padded"] != n_sample
        if padded:
            x = torch.nn.functional.pad(x, (self.border, self.border), mode="reflect")

        n_stems = len(self.instruments)
        result = torch.zeros((n_stems,) + tuple(x.shape), dtype=torch.float32)
        # One counter for the whole run, not one per stem and channel. The
        # window applied at a given sample is identical across both, so the
        # reference's full-shape counter is n_stems*channels copies of the same
        # numbers — a quarter of a gigabyte of them on a three-minute stereo
        # song. Broadcasting at the divide gives the same result.
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
                        # Reflect only when there is enough signal to reflect
                        # from; a short tail padded by reflection would repeat
                        # material that is mostly padding already.
                        mode = "reflect" if seg_len > self.chunk_size // 2 else "constant"
                        part = torch.nn.functional.pad(
                            part, (0, self.chunk_size - seg_len), mode=mode)
                    parts.append(part)

                arr = torch.stack(parts, dim=0).to(self.device)
                with autocast:
                    out = self.model(arr)
                out = out.float().cpu()

                for j, (start, seg_len) in enumerate(zip(group, lengths)):
                    # The window is built PER CHUNK LOCATION rather than once
                    # per batch. At the config's own batch_size of 1 that is
                    # identical to the reference; above it, it is the fix for
                    # the reference's batched-edge behaviour, where a single
                    # window derived from the loop counter is applied to every
                    # chunk in the batch.
                    #
                    # Both edge cases are checked independently (the reference
                    # uses if/elif). An input short enough to be one chunk is
                    # both the first and the last, and leaving its fade-out in
                    # place would divide the tail by a window falling to zero
                    # — 0/0, which nan_to_num then flattens to silence.
                    window = self._window.clone()
                    if start == 0:
                        window[: self.fade_size] = 1.0      # first chunk: no fade-in
                    if start + self.step >= x.shape[1]:
                        window[-self.fade_size:] = 1.0      # last chunk: no fade-out
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

        return {name: np.ascontiguousarray(estimated[i], dtype=np.float32)
                for i, name in enumerate(self.instruments)}


class _NullContext:
    def __enter__(self):
        return None

    def __exit__(self, *exc):
        return False
