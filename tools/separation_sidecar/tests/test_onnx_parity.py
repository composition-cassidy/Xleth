"""End-to-end parity: the ONNX separators against the torch models they replace.

**Opt-in, and slow.** It needs torch, the real checkpoints in the local model
store, and a couple of minutes of CPU per tier. Nothing here runs in ordinary
CI; it is the acceptance evidence for the move off torch, run when `dsp.py`,
`onnx_export.py`, `roformer_engine.py` or the vendored architecture changes,
and after every re-export of the shipped graphs.

    set XLETH_ONNX_PARITY=1
    .venv\\Scripts\\python -m pytest tests/test_onnx_parity.py -q -s

What it compares is the WHOLE path, not a piece of it: raw audio in, stems out,
through the real chunked overlap-add. The narrower comparisons (numpy STFT vs
torch STFT, exported core vs full model) live in test_dsp.py and are what tell
you *where* a failure here came from.

The reference side deliberately reconstructs the old torch inference inline
rather than importing it, because the whole point is that the old code is gone.
If this file and the shipped separators ever disagree about the chunking, this
test is the one that is wrong — the geometry is asserted against
`separator.plan()` to keep that from going unnoticed.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.manifest import STEM_MODE_RESIDUAL, load_manifest   # noqa: E402

pytestmark = pytest.mark.skipif(
    not os.environ.get("XLETH_ONNX_PARITY"),
    reason="slow end-to-end parity run; set XLETH_ONNX_PARITY=1 to enable")

torch = pytest.importorskip("torch", reason="the reference side needs torch")

STORE = (Path(os.environ.get("XLETH_MODEL_STORE",
                             Path(os.environ.get("APPDATA", Path.home()))
                             / "xleth-ui" / "xleth-separation" / "models" / "v1")))

CASES = [
    ("mel_roformer_becruily_deux", "MelBandRoformer", "mel_band_roformer"),
    ("bs_roformer_ft1_anvuew", "BSRoformer", "bs_roformer"),
]

# Long enough to cross at least two chunk boundaries on both tiers, so the
# cross-fade and the divide-by-the-summed-window are actually exercised. A
# single-chunk input would pass with the seam logic entirely broken.
SECONDS = 30.0
SAMPLE_RATE = 44100


def _signal() -> np.ndarray:
    """Something with structure, not white noise.

    A separator fed noise produces near-silence, and a comparison of two
    near-silences passes no matter how wrong either side is. Tones plus
    harmonics plus a transient give both paths something to actually
    disagree about.
    """
    n = int(SECONDS * SAMPLE_RATE)
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    rng = np.random.default_rng(5)

    out = np.zeros((2, n), dtype=np.float32)
    for ch in range(2):
        voice = sum(0.3 / (k + 1) * np.sin(2 * np.pi * 220.0 * (k + 1) * t + 0.3 * ch)
                    for k in range(5))
        bass = 0.25 * np.sin(2 * np.pi * 55.0 * t)
        hats = 0.1 * rng.standard_normal(n) * (np.sin(2 * np.pi * 4.0 * t) > 0.9)
        out[ch] = (voice + bass + hats).astype(np.float32)
    return out * 0.3


def _load_torch_model(class_name: str, config, checkpoint: Path):
    if class_name == "MelBandRoformer":
        from xleth_separation.vendor.mel_band_roformer import MelBandRoformer as Cls
    else:
        from xleth_separation.vendor.bs_roformer import BSRoformer as Cls

    model = Cls(**dict(config["model"]))
    state = torch.load(str(checkpoint), map_location="cpu", weights_only=True)
    for key in ("state", "state_dict", "model_state_dict"):
        if isinstance(state, dict) and key in state and isinstance(state[key], dict):
            state = state[key]
            break
    model.load_state_dict(state, strict=True)
    model.eval()
    return model


def _torch_reference(model, mix: np.ndarray, plan: dict, fade_size: int,
                     n_stems: int) -> np.ndarray:
    """The inference loop the shipped separators used to run, in torch."""
    chunk_size = plan["chunkSize"]
    step = plan["step"]
    border = plan["border"]
    n_sample = mix.shape[1]

    x = torch.from_numpy(np.ascontiguousarray(mix, dtype=np.float32))
    padded = plan["padded"] != n_sample
    if padded:
        x = torch.nn.functional.pad(x, (border, border), mode="reflect")

    result = torch.zeros((n_stems,) + tuple(x.shape), dtype=torch.float32)
    counter = torch.zeros(x.shape[-1], dtype=torch.float32)

    window_base = torch.ones(chunk_size)
    window_base[:fade_size] = torch.linspace(0, 1, fade_size)
    window_base[-fade_size:] = torch.linspace(1, 0, fade_size)

    with torch.inference_mode():
        for start in plan["starts"]:
            part = x[:, start: start + chunk_size]
            seg_len = part.shape[-1]
            if seg_len < chunk_size:
                mode = "reflect" if seg_len > chunk_size // 2 else "constant"
                part = torch.nn.functional.pad(part, (0, chunk_size - seg_len), mode=mode)

            out = model(part.unsqueeze(0)).float()
            if out.ndim == 3:                       # single-stem models squeeze it out
                out = out.unsqueeze(1)

            window = window_base.clone()
            if start == 0:
                window[:fade_size] = 1.0
            if start + step >= x.shape[1]:
                window[-fade_size:] = 1.0
            w = window[:seg_len]

            result[..., start: start + seg_len] += out[0, ..., :seg_len] * w
            counter[start: start + seg_len] += w

    estimated = (result / counter).numpy()
    np.nan_to_num(estimated, copy=False, nan=0.0)
    if padded:
        estimated = estimated[..., border:-border]
    return estimated[..., :n_sample]


@pytest.mark.parametrize("model_id,class_name,arch", CASES)
def test_onnx_matches_torch_end_to_end(model_id, class_name, arch):
    from xleth_separation.roformer import load_config

    model_dir = STORE / model_id
    if not model_dir.is_dir():
        pytest.skip(f"{model_dir} not present — download this tier first")

    config_path = next((p for p in sorted(model_dir.glob("*.yaml"))
                        if not p.name.endswith(".json")), None)
    checkpoint = next((p for p in sorted(model_dir.glob("*.ckpt"))
                       if not p.name.endswith(".json")), None)
    if not config_path or not checkpoint:
        pytest.skip(f"{model_dir} has no config/checkpoint pair")

    manifest = load_manifest()
    spec = manifest.model(model_id)

    if arch == "mel_band_roformer":
        from xleth_separation.roformer import MelBandRoformerSeparator as Sep
    else:
        from xleth_separation.bs_roformer import BSRoformerSeparator as Sep

    separator = Sep(spec, checkpoint, config_path, prefer_device="cpu")
    mix = _signal()

    got = separator.separate(mix)
    assert got, "the separator returned no stems"

    plan = separator.plan(mix.shape[1])
    assert plan["chunks"] >= 2, "input too short to exercise a seam"

    model = _load_torch_model(class_name, load_config(config_path), checkpoint)
    reference = _torch_reference(model, mix, plan, separator.fade_size,
                                 len(separator.instruments))

    # Build the reference in the SAME shape the separator returns, residual
    # included, so this compares the audio a user actually receives.
    expected = {}
    if spec.stem_mode == STEM_MODE_RESIDUAL:
        primary = reference[0]
        expected[spec.stems["primary"]] = primary
        expected[spec.stems.get("secondary", "Residual")] = mix - primary
    else:
        for index, name in enumerate(separator.instruments):
            expected[name] = reference[index]

    assert set(expected) == set(got), (
        f"{model_id}: separator returned {sorted(got)}, reference built "
        f"{sorted(expected)}")

    # The difference is measured against the MIX's peak, not each stem's own
    # peak, and that choice is the whole reason this test says anything.
    #
    # These separators are GOOD, which makes them awkward to test synthetically:
    # fed anything numpy can synthesize — harmonic stacks, formant-shaped
    # vibrato'd "singing", with or without a backing track — they correctly
    # decide there are no vocals and return silence. Measured, the vocals stem
    # peaks at 9e-5 against a mix peaking at 0.30.
    #
    # Normalising by the stem's own peak then divides one numerical noise floor
    # by another and reports two entirely correct results as 91% apart. Against
    # the mix, the same measurement is 9.7e-5 — a difference 80 dB below the
    # input, which is what "inaudible" means and what is actually being
    # asserted here.
    mix_peak = float(np.abs(mix).max())
    loud = []

    for name in sorted(expected):
        ours, theirs = got[name], expected[name]
        assert ours.shape == theirs.shape, f"{model_id}/{name}: shape"

        stem_peak = float(np.abs(theirs).max())
        diff = float(np.abs(ours - theirs).max())
        rel_to_mix = diff / mix_peak
        if stem_peak > 1e-3:
            loud.append(name)

        print(f"\n{model_id} / {name}: stem peak {stem_peak:.2e} "
              f"max|diff| {diff:.3e} = {rel_to_mix:.2e} of the mix peak"
              f"{'' if stem_peak > 1e-3 else '  (~silence for this input)'}")

        # 1e-3 of the mix, not 1e-6. Two independent float32 pipelines — a
        # torch STFT and torch's fused kernels on one side, a numpy STFT and
        # onnxruntime's own fusions on the other — accumulate different
        # rounding over 12 transformer layers. Measured runs land near 1e-4.
        assert rel_to_mix < 1e-3, (
            f"{model_id}/{name}: differs by {diff:.3e}, which is "
            f"{rel_to_mix:.2e} of the mix peak")

    # Two silences agree trivially. At least one stem has to carry real signal
    # or this comparison has asserted nothing — for a vocal separator on a
    # synthetic input that is the instrumental side, which is a full model
    # output on BALANCED and mix-minus-vocals on BEST.
    assert loud, (
        f"{model_id}: every stem came back as silence, so this run proves "
        "nothing about the pipeline")


@pytest.mark.parametrize("model_id,class_name,arch", CASES)
def test_the_shipped_graph_carries_no_weights(model_id, class_name, arch):
    """The licensing property, checked on the artefact that actually ships.

    NOTICE-separation-models.md rests the clearance for all three tiers on
    XLETH never redistributing a weight. The export asserts this too, but the
    export is not what reaches a user — this file is.
    """
    onnx = pytest.importorskip("onnx")
    from xleth_separation import roformer_engine

    assets = roformer_engine.graph_assets(model_id)
    graph = onnx.load(str(assets["template"]), load_external_data=False)

    inline = [t.name for t in graph.graph.initializer
              if t.data_location != onnx.TensorProto.EXTERNAL]
    assert not inline, (
        f"{model_id}: {len(inline)} initializers still hold their bytes, so the "
        f"shipped graph redistributes weights: {inline[:5]}")

    for tensor in graph.graph.initializer:
        assert not tensor.raw_data, (
            f"{model_id}: {tensor.name} is marked external but carries raw bytes")

    size_mb = assets["template"].stat().st_size / 1e6
    assert size_mb < 10, (
        f"{model_id}: shipped graph is {size_mb:.1f} MB. A weightless graph is "
        "~2 MB; this large usually means a big tensor got baked in as a "
        "Constant node — see the zeros-tensor note in onnx_export.py.")
