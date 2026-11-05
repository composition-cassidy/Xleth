# Separation model licenses — audit record

Every model the sidecar can run carries a `license.status` in
`xleth_separation/models.json`. Anything other than a CLEARED status is refused
at the HTTP door, before download, and before inference. This file is the
written record behind each status.

There are two CLEARED statuses, and the difference matters:

| Status | Meaning |
| --- | --- |
| `CLEARED` | The audit is closed and the answer is an unconditional yes. |
| `CLEARED-NONCOMMERCIAL` | The audit is closed and the answer is yes **for non-commercial use only**. The model additionally sets `requires_acknowledgement`, and `/separate` refuses it with a 409 until the caller passes `acknowledgeLicense` — so the condition reaches the person running it, not just this file. |

`CLEARED-NONCOMMERCIAL` without `requires_acknowledgement` is rejected by the
manifest loader. A condition the user is never shown is not a condition they
agreed to.

Audits performed 2026-08-26 (FAST) and 2026-08-27 (BALANCED).

---

## "XLETH does not redistribute the weight" after the ONNX change (2026-09-18)

Every clearance below rests on that claim, and each one states it. The
Roformer tiers moved from PyTorch to exported ONNX graphs on this date, so it
is worth recording precisely what changed and why the claim still holds.

**What ships.** `xleth_separation/graphs/*.onnx`, ~2 MB each. They contain the
graph only: operators, tensor shapes, and the constants the ARCHITECTURE
computes — the mel band layout, the DC mask, reshape targets. All of that
derives from the vendored model code under `xleth_separation/vendor/`, which is
MIT and whose own licence question is recorded in `vendor/VENDOR-NOTICE.md`.
Every tensor that comes from a checkpoint is an empty external-data reference
with no bytes behind it.

**What does not ship.** The weights. The user's machine downloads the author's
own `.ckpt` from the author's own repository, exactly as before and from the
same pinned URLs recorded below, and `weights.py` writes those tensors into the
graph's external-data file locally at install time. Nothing about the download
path, the URLs, the checksums or the licence gates changed.

**Why this was not done the easy way.** Exporting a graph WITH its weights
baked in, and hosting that, is the obvious implementation and it was rejected:
a populated ONNX file is a derivative of the checkpoint, and distributing it
would be redistribution — the precise thing the resolution for the BEST tier
says would reopen its audit. The weightless design exists to avoid that, not to
save space.

**How it is enforced rather than intended.**
`onnx_export.export_weightless_graph` refuses to write a graph in which any
checkpoint tensor survived as an initializer or an inlined constant, and
`tests/test_onnx_parity.py::test_the_shipped_graph_carries_no_weights` re-opens
the committed artefact and asserts the same thing — the export is not what
reaches a user, the committed file is.

One detail found during the work, recorded because it is the kind of thing that
would otherwise be missed: the rotary-embedding tables were initially baked in
as constants, because the library caches them and returns a detached tensor the
tracer captures as a literal. They are ~3 kB, they are NOT architecture
constants (BALANCED's differ from a freshly constructed model's by 1.6e-4), and
they are now exported as ordinary initializers filled from the user's
checkpoint. See `_prepare_for_export` in `onnx_export.py`.

---

## MDX-Net "Kim Vocal 2" — Tier 1 (FAST)

**Status: CLEARED** · MIT, conditional on attribution.

| | |
| --- | --- |
| File | `Kim_Vocal_2.onnx` |
| SHA-256 | `ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b` |
| Size | 66,759,214 bytes |
| URL | `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx` |
| Model author | KimberleyJSN (Kimberley Jensen) |
| Distributor | Ultimate Vocal Remover (Anjok07 et al.) |

### Required attribution

> MDX-Net "Kim Vocal 2" — model by KimberleyJSN, distributed by Ultimate Vocal
> Remover (MIT).

This string lives in the manifest's `license.attribution` and is rendered in
the Sample Sandbox separation strip whenever the model catalog is loaded.
Showing it is what actually satisfies the license condition — if that line is
ever removed from the UI, this status is no longer accurate.

### How the URL and checksum were resolved

Kim Vocal 2 has no standalone Hugging Face page; it ships through UVR 5's
Download Center. Resolution path:

1. UVR's public download-center manifest
   (`TRvlvr/application_data` → `filelists/download_checks.json`) maps the
   Download Center entry **"MDX-Net Model: Kim Vocal 2"** to the filename
   `Kim_Vocal_2.onnx`.
2. The Download Center serves those files from the `all_public_uvr_models`
   release of `TRvlvr/model_repo` — the URL pinned above.
3. UVR's own manifest carries no checksum (it hashes weights after download,
   only to look up architecture params). The SHA-256 was taken from the
   Hugging Face LFS pointer metadata of two independent mirrors of that same
   release — `seanghay/uvr_models` and `Blane187/all_public_uvr_models` — which
   agree on both the digest and the byte count.

**Resolved at build time, hardcoded, and asserted by test**
(`tests/test_manifest.py::test_tier_1_is_kim_vocal_2_with_the_resolved_url_and_hash`).
There is no runtime dependency on UVR's manifest. If that test ever starts
failing, someone edited the URL or the hash — which is exactly the moment to
ask whether the new bytes were audited.

### Findings

1. Ultimate Vocal Remover GUI is **MIT licensed**, and its README states its
   core developers trained all models shipped in the package except the Demucs
   v3/v4 4-stem models.
2. The README grants third-party application use directly: *"For all
   third-party application developers who wish to use our models, please honor
   the MIT license by providing credit to UVR and its developers."* That is
   precisely this use case, and the condition is attribution.
3. **XLETH does not redistribute the weight.** It is fetched on demand, by the
   end user's own machine, from UVR's own public distribution channel.
   Redistribution terms are therefore not engaged by shipping XLETH at all —
   the packaged app contains the sidecar source and the manifest, never the
   weights.
4. The attribution requirement is met by the string above, surfaced in the UI
   and recorded here.

### Conclusion

Cleared for use. Two independent obligations are satisfied: the MIT credit
condition (attribution shown in-product) and the redistribution question
(moot — nothing is redistributed).

---

## Mel-Band RoFormer "deux" — Tier 2 (BALANCED)

**Status: CLEARED-NONCOMMERCIAL** · CC BY-NC 4.0, conditional on attribution
**and** on non-commercial use.

| | |
| --- | --- |
| Weights | `becruily_deux.ckpt` |
| SHA-256 | `10255c02295bf3e3865d4ee50ff752d7b19b124ed5fd93b147babc4333eda3aa` |
| Size | 435,006,815 bytes (217.3M parameters) |
| Config | `config_deux_becruily.yaml` |
| SHA-256 | `bb3ea9bce37ca96d63568490d5a92d7e41df3d7726788b6970c10d89eb62d902` |
| Size | 1,175 bytes |
| Repository | <https://huggingface.co/becruily/mel-band-roformer-deux> |
| Pinned commit | `2da74427d682a3df47a774378fc24d7a1a0cdaad` |
| Licence | CC BY-NC 4.0 (`cc-by-nc-4.0` in the model card's front matter) |
| Author | becruily |
| Reported SDR | instrumental 17.5466, vocals 11.3695 (author's own figures) |

### Required attribution

> Mel-Band RoFormer "deux" — model by becruily, CC BY-NC 4.0.
> Non-commercial use only.

Rendered in the Sample Sandbox separation strip alongside the FAST tier's
credit, and repeated in the acknowledgement the user has to accept before the
first run. If either is removed from the UI, this status is no longer accurate.

### How the URLs and checksums were resolved

Both files come from the author's own Hugging Face repository, and both URLs
are pinned to **commit `2da74427`** rather than to `main` — `/resolve/main/`
follows a force-push, and the point of hardcoding a checksum is that upstream
cannot change what we run without us noticing.

The checkpoint's SHA-256 was taken from two independent sources that agree:
the git-LFS pointer served by `/raw/` (`oid sha256:10255c02…`, `size
435006815`) and the `X-Linked-ETag` header on the `/resolve/` redirect. It was
then confirmed a third time by hashing the downloaded file. The YAML is not an
LFS object; it was hashed directly, and the byte-identical result was obtained
from both the `/raw/` and `/resolve/` endpoints.

Asserted by test
(`tests/test_manifest.py::test_balanced_is_becruily_deux_with_commit_pinned_urls_and_hashes`),
including the commit pin.

### Findings

1. The model card declares `license: cc-by-nc-4.0` and carries **no additional
   grant**. The README is three lines: the licence, the architecture, and the
   author's SDR figures. There is no separate LICENSE file, no commercial-use
   exception, and no contact route offered in-repo.
2. CC BY-NC 4.0 imposes two conditions: **attribution** (BY) and
   **non-commercial use** (NC). NC is defined in the licence as use "not
   primarily intended for or directed toward commercial advantage or monetary
   compensation."
3. **XLETH does not redistribute the weight.** The manifest points at the
   author's own repository at a pinned commit, and the end user's machine
   fetches it directly; the packaged app contains the sidecar source and the
   manifest, never the weights. The Share-related terms are therefore not
   engaged — the same posture as the FAST tier.
4. **The NC condition is different in kind from attribution, and this is the
   crux of the audit.** Attribution is something the software can discharge,
   and does, by showing the credit line. NC is not: it is a restriction on what
   the person using the output may do with it, and no amount of UI satisfies it
   on their behalf. That is why this model is `CLEARED-NONCOMMERCIAL` rather
   than `CLEARED`, and why running it requires an explicit acknowledgement
   rather than only a credit line.

### Open question for the project owner

**Not settled by this audit, and not a legal opinion.**

If XLETH is sold, or is used to produce work that is sold, then shipping a
feature whose purpose is to invoke this weight is at minimum within reach of
the NC condition — even though XLETH never redistributes it, and even though
the licensee of the *use* is arguably the end user rather than the application.
Whether that matters depends on facts this audit does not have: how XLETH is
distributed, whether it is paid, and what its users do with the stems.

The acknowledgement gate places that decision with the person who knows the
answer, at the moment they press the button. It does not resolve the question,
and it should not be read as doing so. If XLETH ships commercially and this
tier is to stay, the options are, in rough order of cost:

1. Ask becruily for a commercial grant, and record it here.
2. Keep the tier, keep the gate, and accept that some users' work will be
   commercial. This is the current posture and it carries residual risk.
3. Restrict the BALANCED tier to a non-commercial build, or drop it and put a
   permissively-licensed Mel-RoFormer in its place.

### Conclusion

Cleared for **non-commercial** use, conditional on attribution and on the
acknowledgement gate remaining in place. The gate is enforced by
`assert_license_acknowledged` and tested at both the manifest and HTTP layers;
the manifest loader refuses to express this status without it.

---

## The inference code, separately

The weights are one licence question and the code that runs them is another.
The BALANCED tier's architecture is **vendored**, not pip-installed, because no
released version of lucidrains' `bs-roformer` package can load this checkpoint.
The vendored files are MIT and pinned to a commit; provenance, the exact edit
made, and the measurements behind that decision are in
`xleth_separation/vendor/VENDOR-NOTICE.md`.

---

## BS-Roformer FT1 (anvuew) — Tier 3 (BEST)

**Status: CLEARED** (2026-08-28, resolved by the project owner — see
"Resolution" below) **· requires acknowledgement**, same shape as BALANCED's
non-commercial gate. The code was already wired and verified; what changed is
the licence call, not the implementation.

| | |
| --- | --- |
| Weights | `bs_roformer_ft1_anvuew_sdr_12.55.ckpt` |
| SHA-256 | `60347271e8493fdff28ef558c3b2297afb869a1f4462594ed548038264bec395` |
| Size | 204,493,312 bytes |
| Config | `config.yaml` |
| SHA-256 | `033e57abee226a480ef410e0631b9fe00e8b7bc9a3bb5fe55659d0b43a238701` |
| Size | 1,969 bytes |
| Repository | <https://huggingface.co/anvuew/BS-RoFormer> |
| Pinned commit | `24988f47270cb3529b62c4f3bbb8234f4586de9b` |
| Declared licence | `gpl-3.0` (the repo's only metadata tag) |
| Author | Hugging Face handle `anvuew`; no further identity disclosed |
| Reported SDR | 12.55 (from the filename; the card gives no other figures) |

Unlike the two tiers above, this section does not end in a clean CLEARED
status. It is written up anyway, in the same format, because "we looked and it
was unclear" is itself the audit record — the alternative is a silent gap
where nobody can tell whether this was checked at all.

### Why PENDING-AUDIT

1. **The card is two lines of substance.** The entire repository content
   beyond the weight and its config is a YAML front-matter block
   (`license: gpl-3.0`) and one line of body text — `dataset by bascurtiz`,
   linking that person's GitHub. There is no model description, no statement
   of what the licence is meant to cover, and critically, no third-party-use
   permission of the kind both tiers above got explicitly (UVR's README
   inviting third-party app developers by name; becruily's card stating a
   single clean condition). Silence is not a grant.
2. **GPL-3.0 on a weight with no accompanying code is an unresolved
   category.** GPL-3.0 is a copyleft licence written for source code —
   distribution and modification of a *program*. This repository ships no
   program: a `.ckpt` of raw tensors and a YAML that describes their shape.
   Whether the tag is meant to cover redistribution of the checkpoint,
   unpublished training code, or is simply Hugging Face's upload-form default
   is not stated and cannot be inferred from what is here.
3. **The one attribution present names a different party for a different
   thing.** "dataset by bascurtiz" credits the *training data*, not the
   weights, and says nothing about who holds rights in the trained checkpoint
   or on what terms. That leaves a third interest this audit cannot resolve
   from the repository alone.
4. **The two-strike fallback does not clear the bar either.** The brief named
   unwa's (Hugging Face handle `pcunwa`) `BS-Roformer-Leap`, specifically its
   `Xe` checkpoint pair (`bs_leap_xe_voc.ckpt` / `bs_leap_xe_inst.ckpt`). Its
   README is a single decorative GIF — no licence field, no text at all. An
   undeclared licence defaults to full copyright reservation, which is
   *stricter* than GPL-3.0, not safer. Substituting it would not have closed
   this audit; it would have swapped one open question for a worse one. It
   was investigated and set aside, not adopted.
5. **The bar being missed is the one this project already set twice.** Both
   FAST and BALANCED closed on an explicit, on-the-record statement from the
   model's own author about permitted third-party use. Neither BS-Roformer
   candidate offers that. Per the same standard, this is grounds to leave the
   audit open, not to infer permission from a bare SPDX tag.

### What is NOT blocked by this

The inference code is clean and verified independently of the weight's
licence question. The vendored `BSRoformer` architecture (MIT, pinned to the
same MSST commit as BALANCED's Mel-Band RoFormer — see
`xleth_separation/vendor/VENDOR-NOTICE.md`) loaded the real checkpoint
**strict, with zero missing and zero unexpected keys, on the first attempt** —
no vendoring problem like BALANCED's, where every released `bs-roformer` PyPI
version failed. A real separation run on a synthetic 30 s stereo clip produced
correct output: Vocals + Instrumental summed back to the mix within 1.5e-8.
Measured CPU timings are in `xleth_separation/models.json`.

XLETH would not redistribute this weight either way — the manifest points at
the author's own repository, pinned to a commit, the same posture as both
other tiers. That does not resolve what GPL-3.0 means for a binary weight with
no accompanying source, which is the actual open question.

### Enforcement

`license.status` is `PENDING-AUDIT` in `models.json`, which is not in
`CLEARED_STATUSES`. The BEST tier is otherwise fully wired — `tiers.best.enabled`
is `true` and its `model_id` resolves to a real, checksummed model — so
`/separate` reaches `assert_license_cleared` and refuses with a 403 exactly
the way it would refuse any other unaudited weight. Flipping this tier on
once the audit closes (a plain-language answer from anvuew, or a
better-documented checkpoint in its place) needs no code change: only
`license.status` in `models.json` and this file.

### What would close it

In rough order of cost, matching the options this project already wrote down
for BALANCED's open question:

1. Ask anvuew what the `gpl-3.0` tag is intended to cover, and get a
   plain-language answer about third-party embedding — record it here.
2. Find or commission a BS-Roformer checkpoint with an explicit,
   author-stated permission, the same bar FAST and BALANCED cleared.
3. Ship BEST without a bundled weight: let a user who has already resolved
   the licensing question for themselves point the sidecar at their own
   checkpoint. Out of scope for this pass, noted for later.

### Resolution (2026-08-28)

None of the three options above happened — nobody has heard back from
anvuew, no alternative checkpoint was found, and bring-your-own-weight
wasn't built. What changed instead is context this audit didn't have:

- **XLETH is, and will remain, open source.** The current beta is free on
  GitHub, and after the full release it stays freely open source — a paid
  tier is a purchase of the same codebase (build it yourself for free, or
  buy a build), not a closed proprietary fork. GPL-3.0's copyleft terms
  exist to stop a closed derivative hiding behind a GPL component; that
  scenario does not apply here.
- **The weight is still never bundled.** Restated from the findings above,
  because it is the load-bearing fact either way: the sidecar downloads the
  checkpoint from anvuew's own Hugging Face repository, pinned to a commit,
  onto the end user's own machine. XLETH's own repository and any packaged
  build never contain it.
- **GPL-3.0 permits commercial use.** Unlike BALANCED, there is no
  non-commercial condition to carry forward.

This does NOT retroactively resolve findings 1–3 above — there is still no
explicit third-party-use statement from anvuew beyond the bare SPDX tag, and
that ambiguity is real. What it does is establish that the specific way
XLETH uses this weight (open-source project, runtime download, no
bundling) does not create the failure mode GPL-3.0 is meant to prevent, on
the project owner's own read of the situation — not a legal opinion, and
not one this project is positioned to give.

`license.status` is now `CLEARED` in `models.json`, with
`requires_acknowledgement: true` carrying the residual ambiguity to the
user the same way BALANCED's non-commercial condition does — a one-time
in-app disclaimer before the model first runs, quoting GPL-3.0, the
author's Hugging Face handle, and the fact that XLETH does not redistribute
the weight. If XLETH's posture ever changes (a closed edition, bundling the
weight directly, or dropping the open-source commitment above), this
resolution stops applying and the audit should be reopened.

