# XLETH separation sidecar

A local FastAPI service that runs source-separation models out of process and
hands finished stems back as WAV files. Phase 4 of the Sample Sandbox.

Three tiers are wired:

| Tier | Model | Licence | CPU cost (this machine) |
| --- | --- | --- | --- |
| FAST | MDX-Net Kim Vocal 2 | MIT | 0.33 s per second of audio |
| BALANCED | Mel-Band RoFormer "deux" (becruily) | **CC BY-NC 4.0** | 3.55 s/s, ~10 GB |
| BEST | BS-Roformer FT1 (anvuew) | GPL-3.0 | 6.79 s/s, ~12 GB |

**All three infer in onnxruntime.** That is the single most important thing to
know about this service, and it is recent: the Roformer tiers used to run
PyTorch models, and the split between the two runtimes was the source of most
of the confusion here. See "The move off torch" below.

**The BALANCED weight is CC BY-NC 4.0.** It is cleared to run and cleared for
nothing else. `/separate` refuses it with a 409 until the caller passes
`acknowledgeLicense`, and the UI puts the condition to the user before the
first run. BEST is GPL-3.0 and also requires acknowledgement. See
"The license gate" below and `NOTICE-separation-models.md`.

---

## Why a sidecar

The models live in the ONNX / PyTorch ecosystem; the XLETH engine is C++/JUCE
running under a forked system Node. Embedding a second ML runtime in the audio
engine — for an operation that is offline, minutes long, and never real-time —
would buy nothing and cost a great deal. A separate process also means a model
that hard-crashes takes down only itself.

This was a locked runtime decision, not an open question: **Python + FastAPI
sidecar, NOT ONNX in-engine.**

## Install

**There is nothing to install.** XLETH ships its own Python runtime — a
relocatable CPython with exactly these dependencies in it, ~143 MB, built by
`tools/build_sidecar_runtime.py` and copied beside the app by electron-builder.
`ui/electron-main/separation.js` prefers it over anything on the user's PATH.

To build it in a source checkout:

```bash
cd tools/separation_sidecar
python tools/build_sidecar_runtime.py
```

To work against your own interpreter instead:

```bash
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

The launcher looks for `runtime/python.exe`, then `.venv`, then `py -3`, then
`python3` / `python` on PATH. Set `XLETH_PYTHON` to override everything.

### GPU

One question now, not two. Install exactly one onnxruntime build — they are
mutually exclusive, and two leaves the active provider a coin flip:

| Package | Provider |
| --- | --- |
| `onnxruntime` | CPU (what ships) |
| `onnxruntime-gpu==1.24.4` | `CUDAExecutionProvider` |
| `onnxruntime-directml` | `DmlExecutionProvider` |

`requirements.txt` documents the two CUDA traps in full — version pairing and
DLL discovery — and both fail SILENTLY to CPU rather than erroring. So **check
the device rather than assuming it**: `GET /health`, or the device chip in the
separation strip. A run reporting `cpu` on a GPU machine means one of them bit.

## The move off torch

The Roformer tiers used to build the vendored PyTorch model and run its
`forward` end to end. They now run exported ONNX graphs. The reason was size:

| | with torch | now |
| --- | --- | --- |
| torch | 533 MB | — |
| torch's sympy / networkx | 100 MB | — |
| librosa's stack (scipy, llvmlite, numba, sklearn) | 330 MB | — |
| onnxruntime + numpy + the rest | ~105 MB | ~105 MB |
| CPython itself | ~30 MB | ~30 MB |
| **total** | **~1.1 GB** | **143 MB** |

1.1 GB is not something you put in an installer for a feature people are trying
out; 143 MB is. That is the whole case for this change, and it is a size
argument rather than a performance one — see "What it cost" below, which is not
flattering.

Three consequences worth knowing:

* **The GPU question is no longer split.** It used to be that a CUDA
  onnxruntime did nothing for BALANCED and a CUDA torch did nothing for FAST,
  so two tiers could honestly report different devices on one machine.
* **librosa is gone even though BALANCED still uses a mel filterbank.** The
  filterbank is computed at model construction and is a constant, so it is
  baked into the exported graph as ops. Same for the rotary tables and the band
  layout.
* **The STFT pair moved to numpy** (`dsp.py`), because ONNX has an `STFT` op
  and no inverse at all. One implementation serves all three tiers;
  `tests/test_dsp.py` holds it to torch's output on each tier's real
  parameters.

### What it cost: memory, and some speed

The move is not free, and the bill is mostly RAM. Measured on an idle machine:

| | torch (before) | ONNX (now) |
| --- | --- | --- |
| BALANCED, one 13.0 s chunk | 17.7 s, 2.80 GB | 23.1 s, **9.5 GB** |
| BEST, one 21.8 s chunk | 27.1 s, 2.68 GB | 37.0 s, **11.8 GB** |
| BALANCED, 32.31 s input end to end | 141.0 s | **160.8 s** (1.14x), peak 17.9 GB |

**Benchmark these on an IDLE machine.** The same end-to-end run measured 357.5 s
with two other jobs on the box, and an earlier round of per-chunk numbers came
out with onnxruntime apparently 1.24-1.26x *faster* than torch for the same
reason. Both were wrong, both were briefly believed, and the second one reached
this README and `models.json` before it was caught.

**Why.** torch dispatches attention to `scaled_dot_product_attention`, which
tiles the computation and never forms the score matrix. That path cannot be
traced into a portable ONNX graph, so the exported graph uses the plain
formulation, and for BEST the scores are 62 bands x 8 heads x 1876 x 1876 x 4
bytes = 7 GB. Before `_SlicedAttend` bounded it, peak was 30.9 GB and
onnxruntime failed outright with "bad allocation".

**What did not help**, each measured rather than assumed: disabling ORT's CPU
memory arena (-1.3 GB, +24% time), sequential execution mode (no change),
halving the slice budget (11.8 -> 11.4 GB), making every slice the same shape
(no change). ORT keeps all the unrolled slices' buffers live, so the scores
stay at ~7 GB however they are cut. Going lower needs real ONNX control flow
(Loop/Scan) so the slices share one buffer, which the TorchScript exporter will
not produce from traced Python.

**Practical effect.** A full BALANCED run peaked at 17.9 GB, so 32 GB is
comfortable and 16 GB is tight but workable; 8 GB cannot run the Roformer
tiers. The FAST tier is unaffected — it was always an
ONNX graph and is small. If that trade ever needs revisiting, the options are
ONNX control flow for the attention, or keeping torch for the Roformer tiers
and giving up the bundled runtime.

### The graphs ship without weights

`xleth_separation/graphs/*.onnx` are ~3 MB each: ops, shapes and band layout,
and **no weights**. The user's machine still downloads the author's own `.ckpt`
exactly as before, and `weights.py` writes those tensors into the graph's
external-data file at install time (~0.3 s), reading the checkpoint with a
pure-numpy reader in `ckpt.py`.

That is not an optimisation, it is the licensing posture.
`NOTICE-separation-models.md` rests the clearance for all three tiers on XLETH
never redistributing a weight, and names bundling one as the thing that would
reopen the GPL-3.0 question for BEST. An ONNX file with the weights baked in
would be a redistributed derivative of that checkpoint. A graph with holes in
it is not.

`tools/export_roformer_onnx.py` produces the graphs and refuses to write one
that kept a checkpoint tensor inline; `tests/test_onnx_parity.py` re-checks the
shipped artefact.

### Re-exporting

Re-export when the vendored architecture changes, when a tier's config changes
its chunk size or hop, or when `onnx_export.py` changes:

```bash
python tools/export_roformer_onnx.py
set XLETH_ONNX_PARITY=1 && python -m pytest tests/test_onnx_parity.py -q -s
```

Both need torch and `onnx` installed, which is a maintainer's problem and not a
user's.

## Run

Normally the Electron main process starts this for you, lazily, on the first
separation. To run it by hand:

```bash
python -m xleth_separation --port 0 --token dev-token
```

It prints one machine-readable line once it is genuinely accepting
connections:

```
XLETH_SIDECAR_READY {"port": 51234, "pid": 9876, "device": "cpu", "host": "127.0.0.1"}
```

## API

| Method | Path                 | Notes                                            |
| ------ | -------------------- | ------------------------------------------------ |
| GET    | `/health`            | Unauthenticated. Per-architecture device + missing packages |
| GET    | `/models`            | Manifest + per-model store presence, device, speed, license |
| POST   | `/separate`          | Starts a job, returns 202 immediately             |
| GET    | `/jobs` / `/jobs/{id}`| Poll for progress                                |
| POST   | `/jobs/{id}/cancel`  | Cooperative cancel                                |
| DELETE | `/jobs/{id}`         | Cancel and forget                                 |
| POST   | `/shutdown`          | Graceful stop                                     |

Everything except `/health` requires the shared secret in `X-Xleth-Token`.
The server binds to loopback only, but "it's only localhost" is not an access
control: any local process — including a page in any browser on the machine —
can reach a loopback port, and this process reads and writes arbitrary
filesystem paths on behalf of its caller.

`/separate` returns before the work is done, on purpose. Separation takes
minutes on CPU, and a request that blocked that long would hit every timeout
between here and the renderer.

`/separate` takes two fields worth knowing about beyond the obvious:

* `acknowledgeLicense` — the caller's answer to a model whose licence carries a
  condition. Sent per request rather than remembered here: the sidecar is a
  stateless worker any local process can reach, and "somebody accepted this
  once" is not the same claim as "the person who pressed the button accepted
  it". Omitting it for BALANCED or BEST gets a **409** whose body is an object
  (`code`, `modelId`, `spdx`, `licenseUrl`, `message`) rather than prose, so the
  caller can ask the question and retry instead of reporting a failure.
* `durationSec` — the input's length, which the renderer knows before the job
  starts and the sidecar cannot know until it has read the file. Optional, and
  it is what lets the progress split be *derived* rather than guessed. See
  "Honest progress".

## Model store

```
<userData>/xleth-separation/models/<store_version>/<model_id>/<name>
                                                             <name>.json   ← receipt
                                                             <model_id>.onnx      ← filled graph
                                                             <model_id>.weights   ← written at install
```

A file counts as present only when its bytes hash to the sha256 the manifest
names, and a MODEL is present only when every one of its files is. A truncated
download, a mirror that quietly served a different revision, or a half-written
file from a killed process all read as "not present" and are re-fetched. Each
download lands at `<name>.part` and is renamed into place only after the hash
matches, so the real name never holds a bad file. `weights.py` applies the same
discipline to the file it builds.

**A model is a list of files, not one blob.** MDX-Net is a single
self-describing `.onnx`. The Roformer tiers are hundreds of MB of raw tensors
plus a YAML that says what shape they go in — and that YAML is checksummed
exactly like the weight. It is small, but it is the file that decides whether
the weight is used *correctly*, and a wrong one separates worse without ever
erroring. Progress across a multi-file fetch is weighted by bytes, so the
1.2 kB config cannot jump the bar.

URLs and checksums are **resolved at build time and hardcoded** in
`xleth_separation/models.json`. There is no runtime dependency on any upstream
manifest — an offline install still works, and an upstream edit cannot silently
change which weights we run.

## The license gate

Every model in the manifest carries a `license` block with a `status`. Anything
other than a CLEARED status is refused — at the HTTP door (403), before
download, and before inference. The flag is a control, not a comment; an
unreviewed weight fails closed.

There are **two** gates, and they fail differently on purpose:

| | Refuses when | HTTP | Who can fix it |
| --- | --- | --- | --- |
| Clearance | `license.status` is not `CLEARED` or `CLEARED-NONCOMMERCIAL` | 403 | Us — the audit is not closed |
| Acknowledgement | `license.requires_acknowledgement` and the request did not carry `acknowledgeLicense` | 409 | The user — it is a question, and the UI can ask it |

The BALANCED model is `CLEARED-NONCOMMERCIAL`: CC BY-NC 4.0, cleared to run and
cleared for nothing else. Attribution is a condition software can discharge, and
does, by showing the credit line. Non-commercial use is not — it restricts what
the person using the *output* may do with it, and no amount of UI satisfies that
on their behalf. Hence the acknowledgement, asked before the 435 MB download
rather than after it.

The manifest loader **refuses** to express `CLEARED-NONCOMMERCIAL` without
`requires_acknowledgement`. A condition the user is never shown is not a
condition they agreed to.

Acknowledgement cannot be used to click past clearance: an unaudited model is
403 whether or not the caller acknowledged anything.

See `NOTICE-separation-models.md` for the audit record, and
`xleth_separation/vendor/VENDOR-NOTICE.md` for the separate licence question
of the *code* that runs the weights.

## Honest progress

Six commitments, each tested (`tests/test_jobs_and_store.py`,
`tests/test_manifest.py`):

1. **The download is inside the progress bar, not a stall before it.** A first
   run on a cold store spends most of its wall clock fetching the weight.
2. **The phase split is DERIVED from estimated seconds, not a constant.** It
   used to be a fixed table giving the download 35%, fitted to a 66 MB weight
   in front of a 0.33x-realtime separation. BALANCED is 435 MB in front of a
   much slower one; no constant is right for both, and being wrong parks the
   bar for minutes. Every phase is costed in seconds — from the model's own
   manifest figures and the bytes actually missing from the store — and the
   spans are those costs normalised. When the input length is unknown the old
   fixed tables are used rather than a number nobody measured.
3. **The download rate is measured, not assumed.** It is the one input that
   varies a hundredfold between machines, so it seeds at a placeholder and is
   replaced as soon as a megabyte has moved. It feeds the phase *weighting*
   only; download time still gets no ETA, because a rate measured over five
   seconds of a five-minute transfer is a fine weight and a bad promise.
4. **Speed figures are per model, per device, and say whether they were
   measured.** The manifest's `speed.measured` block records which figures came
   from a stopwatch; a job seeded from an unmeasured one adds a warning saying
   so.
5. **A run's fixed cost is modelled separately from its per-second cost.** Both
   Roformer architectures pad the input with reflected audio and run the model
   on it — two whole extra chunks for BALANCED, tens of seconds of CPU that a
   five-second sample pays in full. A pure per-second rate says that job takes
   15 s when it takes 55.
6. **Cancellation is checked between chunks and between download blocks.** The
   longest a Cancel can take to land is one chunk.

The overall bar also **ratchets**: the spans are re-derived as facts arrive
mid-run, and a re-derivation can place the current point slightly behind the
last one. A retreating bar reads as "something went wrong", not as "the
estimate improved", so it is held. The ETA is a separate number and moves
freely in both directions.

## Tests

```bash
python -m pytest tests -q          # needs: pytest, httpx2
```

They run **without torch, onnxruntime or any model present**, and assert the
right thing either way: the runtime-gate tests hide modules through
`sys.modules` so the "incomplete install" path is still exercised on a fully
provisioned machine, and `test_health_is_ok_when_the_runtime_is_complete`
asserts the gate actually OPENS when it should — a gate that was always shut
would pass every other test here and ship a permanently broken feature.

Two suites are opt-in because they need things a normal checkout does not have:

| Suite | Needs | Run it when |
| --- | --- | --- |
| `test_dsp.py` | torch | `dsp.py` changes |
| `test_onnx_parity.py` | torch, `onnx`, the real checkpoints, `XLETH_ONNX_PARITY=1` | the graphs are re-exported, or the vendored architecture changes |

`test_dsp.py` skipping is the NORMAL state — torch is not a runtime dependency
any more, so a stock install runs everything except it. It is the evidence that
the numpy STFT pair reproduces what torch did, and it is run on a machine that
still has torch.

The rest do no network I/O and download no models — including the Roformer
tiers': `tests/test_roformer_config.py` transcribes the config's numbers rather
than fetching the file, so the chunking arithmetic is tested on a plane and the
435 MB checkpoint never comes near CI.

## Layout

| File          | Role                                                     |
| ------------- | -------------------------------------------------------- |
| `models.json` | The manifest. URLs, checksums, arch constants, licenses. |
| `manifest.py` | Load + validate + enforce the licence and acknowledgement gates. |
| `store.py`    | Versioned, checksummed, multi-file model store.           |
| `dsp.py`      | STFT / iSTFT in numpy. Replaces torch's, conventions included. |
| `ort_util.py` | onnxruntime sessions, provider choice, CUDA DLL handling. |
| `mdx.py`      | MDX-Net inference (ONNX weights).                        |
| `roformer.py` | Mel-Band RoFormer (BALANCED) — config, stems, chunk geometry. |
| `bs_roformer.py` | BS-Roformer (BEST) — same, plus the residual stem convention. |
| `roformer_engine.py` | The ONNX session and chunked overlap-add both Roformers share. |
| `graphs/`     | The shipped weightless ONNX graphs and their weight manifests. |
| `ckpt.py`     | Read a PyTorch `.ckpt` into numpy arrays, without torch.  |
| `weights.py`  | Fill a weightless graph from the user's checkpoint.       |
| `onnx_export.py` | Dev-time. Trace a Roformer to ONNX and strip its weights. |
| `vendor/`     | Pinned third-party model architecture, needed only to export. |
| `audio_io.py` | Load / resample / save.                                  |
| `debleed.py`  | Optional ratio-mask cleanup pass over a two-stem result.  |
| `ensemble.py` | Average two models' stems.                                |
| `jobs.py`     | Job registry, progress model, cancellation.               |
| `pipeline.py` | What one job does, end to end.                            |
| `app.py`      | FastAPI routes.                                           |
| `__main__.py` | Entry point + the READY handshake.                        |
| `tools/`      | Dev-time scripts: build the runtime, export the graphs.   |
