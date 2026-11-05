"""Export the Roformer tiers to ONNX, so the sidecar does not need torch.

**Dev-time only.** Nothing in the runtime path imports this; it needs torch,
which is exactly the dependency the exported graphs exist to remove. The
`export_weightless_graph` entry point is driven by `tools/export_roformer_onnx.py`
and its output is committed as a shipped asset.

## What gets exported, and what deliberately does not

The graph is the model with its head and tail cut off:

    audio ──stft──▶ [b, F, t, 2] ──▶ ┃ ONNX ┃ ──▶ [b, n, F, t, 2] ──istft──▶ stems

Both transforms stay outside, in numpy (`dsp.py`), for two independent reasons:

  * **ONNX has no inverse STFT at all.** It has had an `STFT` op since opset
    17; there is no `ISTFT`. The tail has to come out no matter what, so the
    head comes out too rather than splitting the pair across two languages.
  * The pair is cheap next to 12 transformer layers, and keeping it in numpy
    means one implementation serves all three tiers — the MDX tier needed the
    same pair and nothing else from torch.

`F` is frequency and audio channel interleaved (`F = f * channels + s`), which
is the layout the models' own `rearrange(... 'b s f t c -> b (f s) t c')`
produces. It is not freq-major; getting it wrong swaps the stereo channels
into each other's spectra and separates to mush without erroring.

## Why the graph ships WITHOUT weights

Every model this project runs is downloaded to the user's machine from the
author's own repository, and `NOTICE-separation-models.md` rests the entire
licence clearance for all three tiers on XLETH never redistributing a weight —
it names bundling one as the thing that would reopen the GPL-3.0 question for
the BEST tier. An ONNX file with the weights baked in IS a redistributed
derivative of that checkpoint, so exporting one and shipping it would trade a
packaging win for a licensing problem.

So the export writes the graph with its initializers stripped to zero-byte
external-data references. What ships is topology: shapes, ops, and the band
layout derived from the vendored (MIT) architecture. The user's machine still
downloads the author's `.ckpt` exactly as before, and `weights.py` writes those
tensors into the graph's external-data file at install time. Nothing about the
posture in NOTICE-separation-models.md changes.

## Determinism

`flash` attention is forced off before tracing. The flash path branches on
`torch.cuda.is_available()` and dispatches into a fused kernel; the einsum path
beside it is the same arithmetic written in ops that export cleanly. Tracing
the fused path would either fail or bake in a CUDA-specific decomposition on
the machine that happened to run the export.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# torch, onnx and einops are imported inside the functions. This module is
# importable — and its docstring readable — on a runtime install that has none
# of them.


# ── Shared pieces ────────────────────────────────────────────────────────


def _complex_mul(a, b):
    """(a * b) for complex numbers carried as a trailing size-2 dimension.

    The models do this with `torch.view_as_complex`, which ONNX has no type
    for. Written out, it is the same arithmetic: (ar + ai·i)(br + bi·i).
    """
    import torch

    ar, ai = a[..., 0], a[..., 1]
    br, bi = b[..., 0], b[..., 1]
    return torch.stack([ar * br - ai * bi, ar * bi + ai * br], dim=-1)


def _run_layers(model, x):
    """The axial transformer stack, identical in both architectures.

    Lifted from the vendored `forward`s rather than called through them,
    because those start at raw audio and end at reconstructed audio — the two
    ends this export exists to remove. `use_torch_checkpoint` is ignored:
    gradient checkpointing is a training-memory tactic and has no meaning in an
    inference graph.
    """
    from einops import rearrange, pack, unpack

    store: List[Any] = [None] * len(model.layers)

    for i, transformer_block in enumerate(model.layers):
        if len(transformer_block) == 3:
            linear_transformer, time_transformer, freq_transformer = transformer_block
            x, ft_ps = pack([x], 'b * d')
            x = linear_transformer(x)
            x, = unpack(x, ft_ps, 'b * d')
        else:
            time_transformer, freq_transformer = transformer_block

        if model.skip_connection:
            for j in range(i):
                x = x + store[j]

        x = rearrange(x, 'b t f d -> b f t d')
        x, ps = pack([x], '* t d')
        x = time_transformer(x)
        x, = unpack(x, ps, '* t d')

        x = rearrange(x, 'b f t d -> b t f d')
        x, ps = pack([x], '* f d')
        x = freq_transformer(x)
        x, = unpack(x, ps, '* f d')

        if model.skip_connection:
            store[i] = x

    return x


def _apply_zero_dc(masked, audio_channels: int, zero_dc: bool):
    """Zero the DC bin, without an in-place write.

    The models do `stft_repr[:, 0] = 0.` after reshaping to `(b n s) f t`,
    where index 0 is the DC bin of every (batch, stem, channel). In the
    interleaved `F = f * channels + s` layout that is the first
    `audio_channels` entries of F. Expressed as a multiply by a constant mask
    rather than a slice assignment: an in-place write into a traced tensor
    exports as a ScatterND against the whole spectrogram, which is both larger
    and slower than the multiply it replaces.
    """
    import torch

    if not zero_dc:
        return masked

    F = masked.shape[2]
    keep = torch.ones(F, dtype=masked.dtype, device=masked.device)
    keep[:audio_channels] = 0.0
    return masked * keep.view(1, 1, F, 1, 1)


# ── The two cores ────────────────────────────────────────────────────────


def _make_core(model):
    """Wrap a loaded Roformer as a spectrogram → masked-spectrogram module."""
    import torch
    from einops import rearrange

    arch = type(model).__name__

    class MelBandCore(torch.nn.Module):
        """Mel-Band RoFormer (BALANCED).

        Its bands OVERLAP — a frequency bin can belong to several mel bands —
        so each bin's mask is the average of every band that predicted it. The
        original expresses that as `scatter_add_` into a zeroed complex tensor
        followed by a divide by `num_bands_per_freq`. Both survive the move to
        real arithmetic unchanged; only the complex dtype goes away.
        """

        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, stft_real):                  # [b, F, t, 2]
            m = self.m
            x = stft_real.index_select(1, m.freq_indices)     # [b, F_sel, t, 2]
            x = rearrange(x, 'b f t c -> b t (f c)')
            x = m.band_split(x)
            x = _run_layers(m, x)

            masks = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)
            masks = rearrange(masks, 'b n t (f c) -> b n f t c', c=2)

            b, n, _, t, _ = masks.shape
            F = stft_real.shape[1]

            idx = m.freq_indices.view(1, 1, -1, 1, 1).expand(b, n, -1, t, 2)

            # The zeros the scatter accumulates into are derived from the
            # graph INPUT, by multiplying it by zero.
            #
            # That looks gratuitous and is not. Both `torch.zeros((b,n,F,t,2))`
            # and `torch.zeros_like(...)` have statically known shapes here, so
            # the TorchScript exporter evaluates them at trace time and emits
            # the result as a literal: 42.7 MB of zeros baked into a graph that
            # is otherwise under 2 MB — 95% of the shipped file, and it was
            # measured that way before this line was written as it is.
            # Constant folding is already off; this is the tracer itself, and
            # the only reliable way to stop it is to make the tensor depend on
            # an input it cannot know the value of.
            zeros = (stft_real.unsqueeze(1) * 0.0).repeat(1, n, 1, 1, 1)
            summed = zeros.scatter_add_(2, idx, masks)

            denom = m.num_bands_per_freq.repeat_interleave(m.audio_channels)
            denom = denom.to(masks.dtype).clamp(min=1e-8).view(1, 1, F, 1, 1)

            averaged = summed / denom
            masked = _complex_mul(stft_real.unsqueeze(1), averaged)
            return _apply_zero_dc(masked, m.audio_channels, m.zero_dc)

    class BSCore(torch.nn.Module):
        """BS-RoFormer (BEST).

        Simpler than the mel variant in exactly one way that matters here: its
        bands partition the spectrum instead of overlapping it, so there is no
        scatter-average — the mask multiplies the spectrogram directly. It does
        carry a `final_norm` the mel variant has no equivalent of.
        """

        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, stft_real):                  # [b, F, t, 2]
            m = self.m
            x = rearrange(stft_real, 'b f t c -> b t (f c)')
            x = m.band_split(x)
            x = _run_layers(m, x)
            x = m.final_norm(x)

            mask = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)
            mask = rearrange(mask, 'b n t (f c) -> b n f t c', c=2)

            masked = _complex_mul(stft_real.unsqueeze(1), mask)
            return _apply_zero_dc(masked, m.audio_channels, m.zero_dc)

    if arch == "MelBandRoformer":
        return MelBandCore(model)
    if arch == "BSRoformer":
        return BSCore(model)
    raise ValueError(f"no ONNX core for architecture {arch!r}")


# Largest attention score tensor a single slice may materialise.
#
# 512 MB. The exact value matters much less than having one at all — measured
# on the BEST tier, slicing cut peak RSS from 30.9 GB (where onnxruntime failed
# with "bad allocation") to 11.8 GB, while halving the budget again moved it
# only to 11.4 GB. See _SlicedAttend for why the remainder does not shift.
_SCORE_BUDGET_BYTES = 512 * 1024 * 1024


def _make_sliced_attend(torch):
    class _SlicedAttend(torch.nn.Module):
        """Attention that never materialises more than a bounded slice of scores.

        **This exists because the exported graph cannot use flash attention and
        the model it replaces could.** `Attend.flash` dispatches to
        `scaled_dot_product_attention`, which tiles the computation and never
        holds the full [batch, heads, seq, seq] score tensor. That path cannot
        be traced to a portable ONNX graph, so the export uses the plain
        formulation beside it — and the plain formulation holds the whole thing.

        The numbers, for the BEST tier: the time-transformer packs bands into
        the batch, giving 62 x 8 heads x 1876 x 1876 x 4 bytes = 7 GB for ONE
        score tensor, with softmax needing another. Measured peak RSS was
        30.9 GB and onnxruntime failed with "bad allocation" on a 128 GB
        machine once anything else was running. Disabling ORT's memory arena
        recovered 1.3 GB of that — it is not an allocator problem.

        Attention is independent per batch element, so computing it in slices
        is exactly equal, not an approximation. Tracing unrolls the loop, which
        costs graph nodes (the graph carries no weights, so the file stays
        small).

        **What this does and does not buy, measured.** Peak RSS on the BEST
        tier went 30.9 GB -> 11.8 GB, and the run stopped failing. It does NOT
        scale down further: halving the budget again gave 11.4 GB, and making
        every slice the same shape gave 11.4 GB. onnxruntime keeps all the
        unrolled slices' score buffers live rather than reusing one, so what
        slicing actually removed was the full-size softmax duplicate, not the
        scores themselves — those stay at bands x heads x frames^2 x 4 = 7 GB
        in total however they are cut. Getting below that needs the slices to
        be ONE reused buffer, i.e. real ONNX control flow (Loop/Scan), which
        the TorchScript exporter will not produce from traced Python.

        For reference, the torch model this replaced peaked at 2.7 GB, because
        `scaled_dot_product_attention` never forms the matrix at all.

        Only the long-sequence axis needs this. The freq-transformer's scores
        are 1876 x 8 x 62 x 62 — 230 MB, under budget, so it takes the
        single-shot path and pays nothing for this class existing.
        """

        def __init__(self, inner, budget_bytes: int):
            super().__init__()
            # Kept as a child module so its `scale` travels with it; its own
            # forward is never called.
            self.inner = inner
            self.budget = budget_bytes

        def _attend(self, q, k, v):
            scale = getattr(self.inner, "scale", None) or (q.shape[-1] ** -0.5)
            # matmul rather than einsum: identical arithmetic, and MatMul is the
            # op onnxruntime's own attention fusions look for.
            sim = torch.matmul(q, k.transpose(-1, -2)) * scale
            attn = sim.softmax(dim=-1)
            return torch.matmul(attn, v)

        def forward(self, q, k, v):
            batch, heads, i = q.shape[0], q.shape[1], q.shape[-2]
            j = k.shape[-2]
            per_item = heads * i * j * 4
            if per_item * batch <= self.budget:
                return self._attend(q, k, v)

            step = max(1, self.budget // max(per_item, 1))
            parts = [self._attend(q[s: s + step], k[s: s + step], v[s: s + step])
                     for s in range(0, batch, step)]
            return torch.cat(parts, dim=0)

    return _SlicedAttend


def _prepare_for_export(model) -> Dict[str, int]:
    """Put the model in the one state that traces to a correct, weightless graph.

    Two changes, both of which are silent correctness bugs if skipped.

    **Flash attention off.** The flash path branches on
    `torch.cuda.is_available()` and dispatches into a fused kernel. The einsum
    path beside it is the same arithmetic in ops that export cleanly.

    **Rotary frequency caching off.** `rotary-embedding-torch` memoises the
    table it builds for a given sequence length and, on a cache hit, returns
    `self.cached_freqs[...].detach()` — a tensor with no history. The tracer
    records that as a literal constant, so the rotary tables get BAKED INTO the
    graph instead of appearing as initializers.

    That matters for two separate reasons. It bakes checkpoint data into a file
    this project ships, which is the one thing `NOTICE-separation-models.md`
    says XLETH does not do — and these tables are not architecture constants
    that would be exempt: BALANCED's differ from a freshly constructed model's
    by 1.6e-4, far outside float32 noise, so they carry something the training
    put there. And it silently pins the graph to whichever checkpoint was
    loaded at export time, which is a trap for anyone re-exporting later.

    With caching off, `freqs` flows through the einsum and lands as a named
    initializer like every other tensor, filled from the user's own download.
    """
    import torch

    counts = {"flash": 0, "rotary": 0, "sliced": 0}
    sliced_cls = _make_sliced_attend(torch)

    for module in model.modules():
        if getattr(module, "flash", False):
            module.flash = False
            counts["flash"] += 1

        # Swap the attention implementation on anything holding one. Replacing
        # the child module is enough: Attention.forward calls `self.attend(q,
        # k, v)` and does not care what answers.
        inner = getattr(module, "attend", None)
        if isinstance(inner, torch.nn.Module) and not isinstance(inner, sliced_cls):
            module.attend = sliced_cls(inner, _SCORE_BUDGET_BYTES)
            counts["sliced"] += 1

        if hasattr(module, "cache_if_possible") and hasattr(module, "freqs"):
            module.cache_if_possible = False
            # A cache populated by an earlier forward would still be returned
            # by the `exists(self.cached_freqs)` branch on some versions.
            if getattr(module, "cached_freqs", None) is not None:
                module.cached_freqs_seq_len = type(module.cached_freqs_seq_len)(0) \
                    if hasattr(module.cached_freqs_seq_len, "zero_") \
                    else 0
            counts["rotary"] += 1

    return counts


def core_input_shape(model, n_frames: int, batch: int = 1) -> Tuple[int, int, int, int]:
    """The `[b, F, t, 2]` the core expects, derived from the model itself."""
    n_fft = model.stft_kwargs["n_fft"]
    freqs = n_fft // 2 + 1
    return (batch, freqs * model.audio_channels, n_frames, 2)


def build_core(model):
    """A traced-ready spectrogram→spectrogram module for `model`, in eval mode."""
    core = _make_core(model)
    _prepare_for_export(model)
    core.eval()
    return core


# ── Export ───────────────────────────────────────────────────────────────


# The tracer names an initializer after the attribute path it came from, and
# the core wraps the model as `self.m`, so `m.band_split.…` is the graph's name
# for the checkpoint's `band_split.…`.
_CORE_PREFIX = "m."


def _alias_groups(model) -> Dict[str, set]:
    """`state_dict` key → every key that is interchangeable with it.

    Two separate things collapse initializers, and the completeness check has
    to see through both or it reports baked-in constants that are not there:

    **Shared modules.** Both Roformers build ONE time-rotary and ONE
    freq-rotary embedding and hand the same instance to every layer, so 2
    parameters are reachable under 24 `state_dict` keys.

    **Value deduplication by the ONNX exporter.** Those two rotary embeddings
    are constructed identically (`RotaryEmbedding(dim=dim_head)` twice), so
    their tables hold the SAME numbers, and the exporter emits one initializer
    for both. Identity-based grouping still reports the second one missing.

    Grouping by CONTENT covers both: keys whose bytes are equal are
    interchangeable, which is exactly the property the weight writer relies on
    when it fills one initializer from one named checkpoint entry.
    """
    import hashlib
    import itertools

    by_content: Dict[Any, list] = {}
    for name, tensor in itertools.chain(
        model.named_parameters(remove_duplicate=False),
        model.named_buffers(remove_duplicate=False),
    ):
        array = tensor.detach().cpu().numpy()
        digest = hashlib.sha1(array.tobytes()).hexdigest()
        by_content.setdefault((str(array.dtype), array.shape, digest), []).append(name)

    groups: Dict[str, set] = {}
    for names in by_content.values():
        shared = set(names)
        for name in names:
            groups[name] = shared
    return groups


def checkpoint_key(initializer_name: str) -> str:
    """The checkpoint key an ONNX initializer name corresponds to."""
    if initializer_name.startswith(_CORE_PREFIX):
        return initializer_name[len(_CORE_PREFIX):]
    return initializer_name


def export_weightless_graph(
    model,
    out_path: Path | str,
    n_frames: int,
    opset: int = 17,
    external_data_name: Optional[str] = None,
) -> Dict[str, Any]:
    """Trace `model`'s core to ONNX and strip every weight out of the result.

    Returns a summary including `initializers` — the ordered list of
    `{name, key, shape, dtype, offset, bytes}` that `weights.py` fills in on
    the user's machine. The file written at `out_path` holds the graph only;
    the weight file it references does not exist yet and is built at
    model-install time from the checkpoint the user downloads.

    Raises if the partition below is not exact, because a graph that silently
    kept one weight inline is a graph that redistributes it.
    """
    import onnx
    import torch
    from onnx import numpy_helper

    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    data_name = external_data_name or (out_path.stem + ".weights")

    core = build_core(model)
    shape = core_input_shape(model, n_frames)
    dummy = torch.zeros(shape, dtype=torch.float32)

    with torch.inference_mode():
        torch.onnx.export(
            core,
            (dummy,),
            str(out_path),
            input_names=["spectrogram"],
            output_names=["masked"],
            opset_version=opset,
            # OFF, and this is the load-bearing setting in the whole export.
            #
            # Constant folding rewrites `Transpose(W) -> MatMul` into a MatMul
            # against a pre-transposed anonymous initializer called something
            # like `onnx::MatMul_10061`. That is faster, and it destroys the
            # correspondence between initializers and checkpoint keys that the
            # weightless design needs: measured on the BEST tier, folding left
            # 0 of 246 large initializers matching a checkpoint name, while
            # this setting leaves 676 of 676 matching AND byte-identical.
            #
            # Nothing is lost at runtime. onnxruntime's own graph optimiser
            # performs the same folding at session load, on the user's machine,
            # against the weights they downloaded.
            do_constant_folding=False,
            dynamo=False,
            # Static shapes throughout. Both tiers run a fixed chunk size by
            # construction (the config's `audio.chunk_size`), so a dynamic time
            # axis would buy nothing and costs onnxruntime the shape-dependent
            # kernel choices that are most of the CPU win this move is for.
            dynamic_axes=None,
        )

    graph = onnx.load(str(out_path))
    state_keys = set(model.state_dict().keys())
    aliases = _alias_groups(model)

    # An initializer is either something the user's checkpoint supplies, or a
    # constant the ARCHITECTURE computes (band layouts, the DC mask, reshape
    # targets). The first kind is stripped; the second kind stays, because it
    # derives from the vendored MIT code rather than from anyone's weights.
    #
    # The split is by NAME rather than by size, which makes it exact and
    # checkable instead of a heuristic about how big a weight tends to be.
    initializers: List[Dict[str, Any]] = []
    inline: List[str] = []
    offset = 0

    for tensor in graph.graph.initializer:
        key = checkpoint_key(tensor.name)
        if key not in state_keys:
            inline.append(tensor.name)
            continue

        array = numpy_helper.to_array(tensor)
        entry = {
            "name": tensor.name,
            "key": key,
            "shape": list(array.shape),
            "dtype": str(array.dtype),
            "offset": offset,
            "bytes": int(array.nbytes),
        }
        group = aliases.get(key, {key})
        if len(group) > 1:
            # Recorded so the install-time writer can check that the checkpoint
            # really does hold the same values under every alias before
            # trusting one of them.
            entry["aliases"] = sorted(group - {key})
        initializers.append(entry)
        _make_external(tensor, data_name, offset, array.nbytes)
        offset += array.nbytes

    # Shared submodules make `state_dict` list one tensor under several names.
    # Both Roformers build ONE time-rotary and ONE freq-rotary embedding and
    # hand the same instance to every layer, so 2 parameters appear under 24
    # keys. The tracer emits one initializer for the object, named after
    # whichever path it met first, and the other 23 names never appear —
    # correctly. Comparing raw key sets here reports 23 phantom "baked-in
    # constants" and refuses a perfectly good export.
    covered = set()
    for item in initializers:
        covered |= aliases.get(item["key"], {item["key"]})

    missing = state_keys - covered
    if missing:
        raise RuntimeError(
            f"{len(missing)} checkpoint tensors never became initializers, so the "
            f"graph has them baked in as constants: {sorted(missing)[:5]}. "
            "Export cannot ship this — see _prepare_for_export.")

    onnx.save(graph, str(out_path))

    return {
        "path": str(out_path),
        "externalDataName": data_name,
        "inputShape": list(shape),
        "opset": opset,
        "initializers": initializers,
        "inlineConstantNames": inline,
        "totalWeightBytes": offset,
    }


def _make_external(tensor, data_name: str, offset: int, nbytes: int) -> None:
    """Empty a tensor of its bytes and point it at the external weight file."""
    import onnx

    tensor.ClearField("raw_data")
    for field in ("float_data", "int32_data", "int64_data",
                  "double_data", "uint64_data"):
        tensor.ClearField(field)

    tensor.data_location = onnx.TensorProto.EXTERNAL
    del tensor.external_data[:]
    for key, value in (("location", data_name),
                       ("offset", str(offset)),
                       ("length", str(nbytes))):
        entry = tensor.external_data.add()
        entry.key = key
        entry.value = value
