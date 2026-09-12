# XLETH separation sidecar

A local FastAPI service that runs source-separation models out of process and
hands finished stems back as WAV files. Phase 4 of the Sample Sandbox.

Two tiers are wired:

| Tier | Model | Runtime | Licence | Speed (this machine) |
| --- | --- | --- | --- | --- |
| FAST | MDX-Net Kim Vocal 2 | onnxruntime | MIT | 0.33x realtime CPU, 0.05x CUDA |
| BALANCED | Mel-Band RoFormer "deux" (becruily) | torch | **CC BY-NC 4.0** | 3.09x realtime CPU + 40 s fixed |

BEST is deliberately inert until P4-3 lands its model.

**The two tiers run on different runtimes, and that is the single most
misleading thing about this service if you forget it.** MDX-Net infers in
onnxruntime; Mel-Band RoFormer infers in torch. `requirements.txt` pins CPU
torch (the FAST tier only needs it for an STFT), so on a stock install FAST
runs on your GPU and BALANCED runs on your CPU — a three-minute song in ten
minutes. Nothing is broken when that happens; it is what the packages you
installed can do. `/health` and `/models` report a device *per architecture*
for exactly this reason, and so does the separation strip.

**The BALANCED weight is CC BY-NC 4.0.** It is cleared to run and cleared for
nothing else. `/separate` refuses it with a 409 until the caller passes
`acknowledgeLicense`, and the UI puts the condition to the user before the
first run. See "The license gate" below and `NOTICE-separation-models.md`.

---

## Why a sidecar

The models live in the PyTorch / ONNX ecosystem; the XLETH engine is C++/JUCE
running under a forked system Node. Embedding a second ML runtime in the audio
engine — for an operation that is offline, minutes long, and never real-time —
would buy nothing and cost a great deal. A separate process also means a model
that hard-crashes takes down only itself.

This was a locked runtime decision, not an open question: **Python + FastAPI
sidecar, NOT ONNX in-engine.**

## Install

```bash
cd tools/separation_sidecar
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
```

The Electron launcher looks for `tools/separation_sidecar/.venv` first, then
`py -3`, then `python3` / `python` on PATH. Set `XLETH_PYTHON` to override.

### GPU — two independent questions

**For the FAST tier (onnxruntime).** `requirements.txt` pins the CPU build.
Swap it for **one** of:

| Package                   | Provider                | Throughput (RTX 4080) |
| ------------------------- | ----------------------- | --------------------- |
| `onnxruntime`             | CPU                     | ~0.33x realtime       |
| `onnxruntime-gpu==1.24.4` | `CUDAExecutionProvider` | ~0.05x realtime       |
| `onnxruntime-directml`    | `DmlExecutionProvider`  | between the two       |

Mutually exclusive: installing two leaves whichever landed last on `sys.path`,
making the active provider a coin flip.

**Two CUDA traps, both of which fail silently to CPU rather than erroring.**

1. *Version pairing.* Each `onnxruntime-gpu` release targets one CUDA major —
   1.24.x wants CUDA 12, 1.29.x wants CUDA 13. pip installs 1.29 by default,
   but there are no Windows wheels for the CUDA 13 runtime
   (`nvidia-cublas-cu13` and `nvidia-cuda-runtime-cu13` are 0.0.1 placeholder
   sdists on PyPI *and* on pypi.nvidia.com, and there is no cp314 `torch`
   cu130 wheel either). On Windows, pin **1.24.4** with the `cu12` packages.
2. *DLL discovery.* A system CUDA Toolkit ships cuBLAS but **not** cuDNN, so
   `nvidia-cudnn-cu12` is required. And putting it on the DLL search path via
   `os.add_dll_directory` is not sufficient: onnxruntime loads
   `onnxruntime_providers_cuda.dll` through a plain `LoadLibrary`, which does
   not consult user-added directories. `mdx.py`'s `_register_cuda_dll_dirs()`
   therefore also **ctypes-loads** those DLLs so they resolve by name. Without
   it: `cudnn64_9.dll ... missing (Error 126)`, then a quiet fall back to CPU.

Because both failures are silent, **check the device rather than assuming it**:
`GET /health`, or the device chip in the separation strip. A run reporting
`cpu` on a GPU machine means one of the two traps above bit.

**For the BALANCED tier (torch).** None of the above applies — the Roformer
tiers never touch onnxruntime. The default `torch` wheel on Windows is
CPU-only, so BALANCED runs on the CPU until you install a CUDA build:

```bash
pip install torch --index-url https://download.pytorch.org/whl/cu126
```

Check it took, rather than assuming; this failure is silent too:

```bash
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

A CUDA onnxruntime does **nothing** for this tier, and a CUDA torch does
nothing for the FAST tier's inference. They are separate installs answering
separate questions, and `/health`'s `archs` block reports them separately.

## Run

Normally the Electron main process starts this for you, lazily, on the first
separation. To run it by hand:

```bash
python -m xleth_separation --port 0 --token dev-token
```

It prints one machine-readable line once it is genuinely accepting
connections:

```
XLETH_SIDECAR_READY {"port": 51234, "pid": 9876, "device": "cuda", "host": "127.0.0.1"}
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
  it". Omitting it for the BALANCED tier gets a **409** whose body is an object
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
```

A file counts as present only when its bytes hash to the sha256 the manifest
names, and a MODEL is present only when every one of its files is. A truncated
download, a mirror that quietly served a different revision, or a half-written
file from a killed process all read as "not present" and are re-fetched. Each
download lands at `<name>.part` and is renamed into place only after the hash
matches, so the real name never holds a bad file.

**A model is a list of files, not one blob.** MDX-Net is a single
self-describing `.onnx`. Mel-Band RoFormer is 435 MB of raw tensors plus a
1.2 kB YAML that says what shape they go in — and that YAML is checksummed
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
   3.09x one; no constant is right for both, and being wrong parks the bar for
   minutes. Every phase is costed in seconds — from the model's own manifest
   figures and the bytes actually missing from the store — and the spans are
   those costs normalised. When the input length is unknown the old fixed
   tables are used rather than a number nobody measured.
3. **The download rate is measured, not assumed.** It is the one input that
   varies a hundredfold between machines, so it seeds at a placeholder and is
   replaced as soon as a megabyte has moved. It feeds the phase *weighting*
   only; download time still gets no ETA, because a rate measured over five
   seconds of a five-minute transfer is a fine weight and a bad promise.
4. **Speed figures are per model, per device, and say whether they were
   measured.** The same CPU runs FAST at 0.33x realtime and BALANCED at 3.09x.
   The manifest's `speed.measured` block records which figures came from a
   stopwatch; a job seeded from an unmeasured one adds a warning saying so.
5. **A run's fixed cost is modelled separately from its per-second cost.** Both
   architectures pad the input with reflected audio and run the model on it —
   13 s of it for BALANCED, two whole extra chunks, ~40 s of CPU inference that
   a five-second sample pays in full. A pure per-second rate says that job takes
   15 s when it takes 55. Measured end to end: a 32.31 s input predicted at
   40 + 32.31x3.09 = 139.8 s, observed 141.0 s.
6. **Cancellation is checked between chunks and between download blocks.** The
   longest a Cancel can take to land is one chunk — a few seconds on FAST, up
   to twenty on BALANCED, whose chunks are 13 s of audio each.

The overall bar also **ratchets**: the spans are re-derived as facts arrive
mid-run, and a re-derivation can place the current point slightly behind the
last one. A retreating bar reads as "something went wrong", not as "the
estimate improved", so it is held. The ETA is a separate number and moves
freely in both directions.

## Tests

```bash
python -m pytest tests -q          # needs: pytest, httpx2
```

They run **with or without torch and onnxruntime installed**, and assert the
right thing either way: the runtime-gate tests hide those modules through
`sys.modules` so the "incomplete install" path is still exercised on a fully
provisioned machine, and `test_health_is_ok_when_the_runtime_is_complete`
asserts the gate actually OPENS when it should — a gate that were always shut
would pass every other test here and ship a permanently broken feature.

They do no network I/O and download no models — including the BALANCED
tier's: `tests/test_roformer_config.py` transcribes the config's numbers rather
than fetching the file, so the chunking arithmetic is tested on a plane and the
435 MB checkpoint never comes near CI. `roformer.py` must import without torch,
einops or librosa, and that test file is the regression check for it.

## Layout

| File          | Role                                                     |
| ------------- | -------------------------------------------------------- |
| `models.json` | The manifest. URLs, checksums, arch constants, licenses. |
| `manifest.py` | Load + validate + enforce the licence and acknowledgement gates. |
| `store.py`    | Versioned, checksummed, multi-file model store.           |
| `mdx.py`      | MDX-Net inference (ONNX weights, torch STFT/iSTFT).      |
| `roformer.py` | Mel-Band RoFormer inference (torch weights + the model's own YAML). |
| `vendor/`     | Pinned third-party model architecture. See its VENDOR-NOTICE.md. |
| `audio_io.py` | Load / resample / save.                                  |
| `jobs.py`     | Job registry, progress model, cancellation.              |
| `pipeline.py` | What one job does, end to end.                           |
| `app.py`      | FastAPI routes.                                          |
| `__main__.py` | Entry point + the READY handshake.                       |
