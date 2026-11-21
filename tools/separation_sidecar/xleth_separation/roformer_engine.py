"""ONNX-backed inference for both Roformer tiers.

The two tiers differ in architecture, in how their bands are laid out and in
how many stems they predict, but from here down they are the same machine:
reflect-pad the input, cut it into overlapping fixed-size chunks, run each
through a graph, cross-fade the seams, divide by the summed window. That loop
lived twice in torch (`roformer.py` and `bs_roformer.py` each had a copy); it
lives once here, in numpy.

## The graph is fixed-size, and that is deliberate

Each tier's graph is exported at exactly `1 + chunk_size // hop` frames — the
frame count a full chunk produces through a centred STFT. Every chunk fed to
it is a full chunk, short tails included, because the loop pads them before
inference. Static shapes let onnxruntime pick shape-specialised kernels at
session load, and keep the memory planner's job tractable on graphs whose
attention tensors are measured in gigabytes.

This path is about 1.3x SLOWER than the torch one it replaced, and uses 3-4x
the memory. That is the price of not shipping a 1 GB dependency; see
"What it cost" in the README for the measurements.

## Weights arrive at install time, not export time

`graph_assets` returns a WEIGHTLESS graph shipped inside the application plus
its manifest. `weights.install` fills it from the checkpoint the user
downloaded, into that model's own directory in userData, and the session is
opened on the filled copy. See `weights.py` for why it is built this way.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import numpy as np

from . import dsp, ort_util, weights

__all__ = [
    "SeparationCancelled",
    "GraphMissing",
    "RoformerOnnxEngine",
    "graph_assets",
    "chunk_plan",
    "windowing_array",
]


class SeparationCancelled(RuntimeError):
    pass


class GraphMissing(RuntimeError):
    """No exported graph ships for this model."""


def graph_dir() -> Path:
    return Path(__file__).resolve().parent / "graphs"


def graph_assets(model_id: str) -> Dict[str, Path]:
    """The shipped weightless graph and manifest for `model_id`."""
    base = graph_dir()
    template = base / f"{model_id}.onnx"
    manifest = base / f"{model_id}.onnx.json"
    if not template.exists() or not manifest.exists():
        raise GraphMissing(
            f"no exported ONNX graph for {model_id!r} in {base}. "
            "Graphs are produced by tools/export_roformer_onnx.py and shipped "
            "with the application.")
    return {"template": template, "manifest": manifest}


def windowing_array(window_size: int, fade_size: int) -> np.ndarray:
    """Linear fade-in / fade-out window, matching the reference exactly.

    Linear rather than a Hann or a raised cosine: with the overlap-add below
    dividing by the summed window, a linear cross-fade sums to a constant for
    any integer overlap, so the seam is flat by construction. Substituting a
    "better" window here would put a ripple into every chunk boundary.
    """
    window = np.ones(window_size, dtype=np.float32)
    window[:fade_size] = np.linspace(0, 1, fade_size, dtype=np.float32)
    window[-fade_size:] = np.linspace(1, 0, fade_size, dtype=np.float32)
    return window


def chunk_plan(n_samples: int, chunk_size: int, step: int, border: int) -> Dict[str, Any]:
    """How a run of `n_samples` is cut into overlapping chunks.

    The SINGLE source of this arithmetic: `plan()` feeds the UI's chunk counter
    and the ETA denominator, `separate()` does the work, and when they each
    computed it themselves an off-by-one showed up as a progress bar that
    finished at 97% — never as a failure.

    `padded` accounts for the reflect-padded border added at both ends, because
    that padding is real audio the model has to process: leaving it out of the
    count makes every ETA optimistic by 2*border/step chunks.
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


class RoformerOnnxEngine:
    """One loaded graph, ready to run chunks.

    Construction installs the weights if they are not already in place and
    opens the session, both of which are the expensive parts, so a job holds
    one of these for its whole run.
    """

    def __init__(
        self,
        model_id: str,
        checkpoint_path: Path | str,
        model_dir: Path | str,
        n_fft: int,
        hop: int,
        audio_channels: int,
        chunk_size: int,
        prefer_device: Optional[str] = None,
        on_install_progress: Optional[Callable[[int, int], None]] = None,
    ):
        assets = graph_assets(model_id)
        self.model_id = model_id
        self.n_fft = int(n_fft)
        self.hop = int(hop)
        self.audio_channels = int(audio_channels)
        self.chunk_size = int(chunk_size)
        self.n_frames = 1 + self.chunk_size // self.hop
        self.warnings: List[str] = []

        installed = weights.install(
            checkpoint_path=checkpoint_path,
            graph_template=assets["template"],
            manifest_path=assets["manifest"],
            model_dir=model_dir,
            on_progress=on_install_progress,
        )
        self.graph_path = Path(installed["path"])
        self.weights_rebuilt = bool(installed.get("rebuilt"))

        self.session, self.device = ort_util.make_session(self.graph_path, prefer_device)
        self.input_name = self.session.get_inputs()[0].name

        # The graph is the authority on its own shape, the same rule mdx.py
        # applies to its ONNX input: a config typo would otherwise surface as
        # an onnxruntime shape error minutes into a long job.
        shape = self.session.get_inputs()[0].shape
        if len(shape) == 4 and isinstance(shape[2], int) and shape[2] != self.n_frames:
            self.warnings.append(
                f"config implies {self.n_frames} STFT frames per chunk but the graph "
                f"declares {shape[2]}; using the graph's")
            self.n_frames = shape[2]
            self.chunk_size = (self.n_frames - 1) * self.hop

        self._window = dsp.hann_window(self.n_fft, periodic=True)

    # ── One chunk ────────────────────────────────────────────────────────

    def _to_spectrogram(self, audio: np.ndarray) -> np.ndarray:
        """`[s, chunk]` → `[1, F, t, 2]`, F = freq * channels + channel.

        That interleaving is what the models' own
        `rearrange('b s f t c -> b (f s) t c')` produced, and it is not
        freq-major. Getting it wrong swaps the stereo channels into each
        other's spectra and separates to mush without erroring.
        """
        spec = dsp.stft(audio, n_fft=self.n_fft, hop_length=self.hop,
                        window=self._window, center=True)          # [s, f, t]
        spec = np.transpose(spec, (1, 0, 2))                       # [f, s, t]
        spec = spec.reshape(-1, spec.shape[-1])                    # [(f s), t]
        return np.stack([spec.real, spec.imag], axis=-1).astype(np.float32)[None]

    def _from_spectrogram(self, masked: np.ndarray, length: int) -> np.ndarray:
        """`[1, n, F, t, 2]` → `[n, s, length]`."""
        _, n_stems, n_freq_ch, n_frames, _ = masked.shape
        channels = self.audio_channels
        freqs = n_freq_ch // channels

        arr = masked.reshape(1, n_stems, freqs, channels, n_frames, 2)
        arr = np.transpose(arr, (0, 1, 3, 2, 4, 5))                # [1, n, s, f, t, 2]
        complex_spec = arr[..., 0] + 1j * arr[..., 1]
        complex_spec = complex_spec.reshape(-1, freqs, n_frames)   # [(n s), f, t]

        audio = dsp.istft(complex_spec, n_fft=self.n_fft, hop_length=self.hop,
                          window=self._window, center=True, length=length)
        return audio.reshape(n_stems, channels, length)

    def infer_chunk(self, audio: np.ndarray) -> np.ndarray:
        """`[s, chunk_size]` float32 → `[n_stems, s, chunk_size]` float32."""
        spec = self._to_spectrogram(audio)
        masked = self.session.run(None, {self.input_name: spec})[0]
        return self._from_spectrogram(masked, audio.shape[-1])


def separate_chunked(
    engine: RoformerOnnxEngine,
    mix: np.ndarray,
    n_stems: int,
    step: int,
    border: int,
    fade_size: int,
    on_chunk: Optional[Callable[[int, int], None]] = None,
    cancel: Optional[threading.Event] = None,
) -> np.ndarray:
    """The reflect-padded, cross-faded overlap-add loop. `[2, n]` → `[n_stems, 2, n]`.

    A faithful numpy transcription of the torch loop both tiers used to carry.
    The two edge rules are the parts worth not paraphrasing:

      * The window is rebuilt PER CHUNK LOCATION, not once per batch, so the
        first chunk keeps its fade-in suppressed and the last its fade-out,
        independently.
      * Both edges are checked separately (not if/elif). An input short enough
        to be a single chunk is both the first and the last, and leaving its
        fade-out in place would divide the tail by a window falling to zero —
        0/0, which nan_to_num then flattens to silence.
    """
    if mix.ndim != 2:
        raise ValueError(f"expected [channels, n] input, got {mix.shape}")

    chunk_size = engine.chunk_size
    n_sample = mix.shape[1]
    layout = chunk_plan(n_sample, chunk_size, step, border)
    total_chunks = layout["chunks"]

    x = np.ascontiguousarray(mix, dtype=np.float32)
    padded = layout["padded"] != n_sample
    if padded:
        x = np.pad(x, ((0, 0), (border, border)), mode="reflect")

    result = np.zeros((n_stems,) + x.shape, dtype=np.float32)
    # One counter for the whole run, not one per stem and channel. The window
    # applied at a given sample is identical across both, so a full-shape
    # counter is n_stems*channels copies of the same numbers — a quarter of a
    # gigabyte of them on a three-minute stereo song. Broadcasting at the
    # divide gives the same result.
    counter = np.zeros(x.shape[-1], dtype=np.float32)
    base_window = windowing_array(chunk_size, fade_size)

    for index, start in enumerate(layout["starts"]):
        if cancel is not None and cancel.is_set():
            raise SeparationCancelled("cancelled during inference")

        part = x[:, start: start + chunk_size]
        seg_len = part.shape[-1]
        if seg_len < chunk_size:
            # Reflect only when there is enough signal to reflect from; a short
            # tail padded by reflection would repeat material that is mostly
            # padding already.
            mode = "reflect" if seg_len > chunk_size // 2 else "constant"
            part = np.pad(part, ((0, 0), (0, chunk_size - seg_len)), mode=mode)

        out = engine.infer_chunk(part)

        window = base_window.copy()
        if start == 0:
            window[:fade_size] = 1.0
        if start + step >= x.shape[1]:
            window[-fade_size:] = 1.0
        w = window[:seg_len]

        result[..., start: start + seg_len] += out[..., :seg_len] * w
        counter[start: start + seg_len] += w

        if on_chunk is not None:
            on_chunk(index + 1, total_chunks)

    estimated = result / counter
    np.nan_to_num(estimated, copy=False, nan=0.0)
    if padded:
        estimated = estimated[..., border: -border]
    return estimated[..., :n_sample]
