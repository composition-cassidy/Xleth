# Vendored source — provenance and licence

Files in this directory are copies of third-party source, pinned to a commit.
Nothing here is XLETH's own work, and nothing here has been modified beyond the
single import rewrite recorded below.

## `mel_band_roformer.py`, `attend.py`

| | |
| --- | --- |
| Upstream | [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) |
| Path upstream | `models/bs_roformer/mel_band_roformer.py`, `models/bs_roformer/attend.py` |
| Pinned commit | `e491b540cac3` (mel_band_roformer.py, 2026-07-27), `837f766c0b05` (attend.py, 2024-08-12) |
| Licence | MIT |
| Original architecture | [lucidrains/BS-RoFormer](https://github.com/lucidrains/BS-RoFormer) (MIT) — MSST's copy descends from it |
| Paper | Wang et al., *Mel-Band RoFormer for Music Source Separation*, [arXiv:2310.01809](https://arxiv.org/abs/2310.01809) |

### Edits made

Exactly one, in `mel_band_roformer.py`:

```diff
-from models.bs_roformer.attend import Attend
+from .attend import Attend  # XLETH: vendored — was `from models.bs_roformer.attend import Attend`
```

The vendored tree is not a Python package rooted at `models/`, so the absolute
import cannot resolve. Nothing else — no reformatting, no dead-code removal, no
"while I'm in here" tidying. A vendored file that has been touched is a file
whose behaviour can no longer be assumed to match upstream, and the whole point
of pinning it is that it does.

### Why vendored rather than `pip install bs-roformer`

Measured, not assumed. Loading `becruily_deux.ckpt` into a model built from the
model's own YAML:

| Implementation | Result |
| --- | --- |
| `bs-roformer` 1.2.4 (PyPI, latest) | 1002 missing, 240 unexpected parameters |
| `bs-roformer` 1.0.6 / 1.0.4 | 1002 missing, 240 unexpected |
| `bs-roformer` 0.9.2 | 930 missing, 240 unexpected |
| **MSST @ `e491b540cac3` (this copy)** | **1188 / 1188, 0 mismatches, strict load OK** |

Upstream added hyper-connections around every attention and feed-forward block
(`branch.*`, `dynamic_alpha_fn`, `static_alpha`, …). The failure is loud — a
`load_state_dict` error, not a quiet quality loss — but there is no released
version of the package that works, so pinning a version number would not have
helped.

`PoPE_pytorch` is imported inside a `try/except` upstream and is not installed
here; the fallback path is upstream's own.

## `bs_roformer.py`

| | |
| --- | --- |
| Upstream | [ZFTurbo/Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training) |
| Path upstream | `models/bs_roformer/bs_roformer.py` |
| Pinned commit | `e491b540cac3a91ba0d438984adab3cdcaf527e6` — the SAME commit `mel_band_roformer.py` is pinned to, so both files come from one snapshot of the upstream tree |
| Licence | MIT |
| Original architecture | [lucidrains/BS-RoFormer](https://github.com/lucidrains/BS-RoFormer) (MIT) |
| Paper | Wang et al., *Mel-Band RoFormer for Music Source Separation*, [arXiv:2310.01809](https://arxiv.org/abs/2310.01809) — BS-Roformer is the fixed-frequency-band predecessor described in the same lineage |

### Edits made

Exactly one, the same shape as `mel_band_roformer.py`'s:

```diff
-from models.bs_roformer.attend import Attend
+from .attend import Attend  # XLETH: vendored — was `from models.bs_roformer.attend import Attend`
```

`attend.py` is shared between both files unmodified — its `Attend(dropout, flash,
scale)` signature is the one `bs_roformer.py` calls, and it needed no separate
pin: the commit already vendored here (`837f766c0b05`) predates both files'
dependence on it and neither has changed the call shape since.

### Verified against the real weight, not just imported

Loaded `bs_roformer_ft1_anvuew_sdr_12.55.ckpt` (anvuew, Hugging Face, commit
`24988f47270cb3529b62c4f3bbb8234f4586de9b`) against a `BSRoformer` built from
the checkpoint's own `config.yaml`: **0 missing, 0 unexpected keys, strict
load OK** on the first attempt — no vendoring problem like BALANCED's (where
every released `bs-roformer` PyPI version failed to load `becruily_deux.ckpt`).
Ran a real separation on a synthetic 30 s stereo clip; Vocals + Instrumental
summed back to the mix within 1.5e-8. See
`xleth_separation/models.json`'s `bs_roformer_ft1_anvuew` entry for the
measured timings.

This vendoring is unconditionally MIT regardless of the weight's own license
status — see `NOTICE-separation-models.md` for why the BEST tier's *weight*
is `PENDING-AUDIT` even though this code is clean.
