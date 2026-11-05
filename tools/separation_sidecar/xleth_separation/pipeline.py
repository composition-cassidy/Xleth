"""The separation pipeline — what one job actually does.

Kept apart from app.py so the sequence (acquire → load → read → infer → write)
can be read, and tested, without a web server in the way.

The sequence is the same for every architecture; only the separator differs.
`build_separator` is the one place that branches on `spec.arch`, and both
separators present the same three things to this file: a `device`, a
`plan(n)`, and a `separate(mix, on_chunk, cancel)`. Adding a tier should mean
adding a module and a line here, not threading a second shape through the
progress and cancellation logic.
"""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Any, Callable, List, Optional, Protocol

from .audio_io import duration_seconds, load_audio, save_audio
from .debleed import can_de_bleed, de_bleed
from .ensemble import average_stems
from .jobs import Job, StemResult
from .manifest import ModelSpec, assert_license_cleared
from .mdx import MdxSeparator, SeparationCancelled
from .store import DownloadCancelled, ModelStore

_SAFE = re.compile(r"[^A-Za-z0-9._ -]+")


def safe_stem_name(text: str, fallback: str = "source") -> str:
    cleaned = _SAFE.sub("_", (text or "").strip()).strip("._ ")
    return cleaned[:80] or fallback


class Separator(Protocol):
    """What the pipeline needs from any architecture."""

    device: str
    sample_rate: int

    def plan(self, n_samples: int) -> dict: ...

    def separate(self, mix, on_chunk=None, cancel=None) -> dict: ...


def build_separator(
    spec: ModelSpec,
    paths: dict,
    prefer_device: Optional[str] = None,
    on_install_progress: Optional[Callable[[int, int], None]] = None,
) -> Any:
    """Construct the separator for `spec`'s architecture.

    `paths` is the store's role → path map: every architecture takes its
    weights from role 'weights', and one that needs a config takes it from
    role 'config' rather than reconstructing the filename.

    `on_install_progress(done, total)` is reported by the Roformer tiers while
    they write their weight file — the one-time step that fills the shipped
    weightless graph from the checkpoint. It is ~0.3 s on an SSD and several
    hundred MB of writing on anything slower, and it happens inside the
    "loading" phase, so without this the bar would sit still through it.
    """
    if spec.arch == "mdx_net":
        return MdxSeparator(spec, paths["weights"], prefer_device=prefer_device)

    if spec.arch == "mel_band_roformer":
        # Imported here, not at module scope, so that an import error in one
        # tier's module cannot stop mdx_net from working. It no longer pulls in
        # a heavy dependency tree — the vendored PyTorch model it used to build
        # is now an exported graph — but the isolation is still worth keeping.
        from .roformer import MelBandRoformerSeparator

        return MelBandRoformerSeparator(
            spec, paths["weights"], paths["config"], prefer_device=prefer_device,
            on_install_progress=on_install_progress)

    if spec.arch == "bs_roformer":
        from .bs_roformer import BSRoformerSeparator

        return BSRoformerSeparator(
            spec, paths["weights"], paths["config"], prefer_device=prefer_device,
            on_install_progress=on_install_progress)

    raise ValueError(f"model '{spec.id}': no separator for arch '{spec.arch}'")


def device_for_arch(arch: str) -> str:
    """Best device for `arch`.

    All three tiers infer in onnxruntime now, so this is one question with one
    answer and the `arch` argument is advisory. It used to be genuinely
    per-arch: MDX-Net ran in onnxruntime and the Roformer tiers in torch, so a
    machine with a CUDA onnxruntime beside a CPU-only torch wheel — the
    ordinary result of following this project's own requirements.txt — ran
    FAST on the GPU and BALANCED on the CPU, and one global answer would have
    been wrong about the second by a factor of six.

    The signature is kept because callers store the result PER MODEL and the
    next architecture added may reintroduce the split.
    """
    from .ort_util import available_device
    return available_device()


def _maybe_de_bleed(job: Job, stems: dict, sample_rate: int, apply_debleed: bool) -> dict:
    """Shared by both the single-model and ensemble paths: DE-BLEED only
    knows how to clean exactly two stems, and runs identically after either
    kind of job, right before writing — it never looks at how the stems it
    is handed were produced."""
    if not apply_debleed:
        return stems
    if not can_de_bleed(stems):
        job.warnings.append(
            f"DE-BLEED needs exactly two stems, got {len(stems)}; skipped")
        return stems
    job.warnings.append("DE-BLEED applied")
    return de_bleed(stems, sample_rate)


def _write_stems(job: Job, stems: dict, output_dir: Path, sample_rate: int) -> None:
    """Write every stem in `stems` to `output_dir` and record it on `job`.

    Pulled out of run_separation so run_ensemble_separation writes its
    averaged stems through the exact same path — naming, phase reporting and
    all — rather than a second, easily-drifting copy of this loop.
    """
    job.set_phase("writing", 0.0, "writing stems")
    base = safe_stem_name(job.label or Path(job.input_path).stem)
    written = len(stems)
    for i, (name, data) in enumerate(stems.items()):
        path = output_dir / f"{base} [{name}].wav"
        save_audio(path, data, sample_rate)
        job.stems.append(StemResult(
            name=name,
            path=str(path),
            sample_rate=sample_rate,
            duration_sec=duration_seconds(data, sample_rate),
        ))
        job.set_phase_progress((i + 1) / max(1, written), f"wrote {name}")
    job.set_phase("writing", 1.0, f"{written} stems")


def run_separation(
    job: Job,
    spec: ModelSpec,
    store: ModelStore,
    batch_size: int = 1,
    prefer_device: Optional[str] = None,
    apply_debleed: bool = False,
) -> None:
    """Execute `job`. Raises on failure; JobRegistry.run turns that into state.

    Cancellation is cooperative and checked at every boundary that can take
    real time: inside the download loop, inside the hash, and between
    inference chunks. The longest a Cancel click can take to land is one
    chunk — a few seconds on the FAST tier, up to twenty on BALANCED, whose
    chunks are 13 s of audio each.
    """
    assert_license_cleared(spec)

    output_dir = Path(job.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── 1. Acquire the weights ───────────────────────────────────────────
    status = store.status(spec)
    job.cold_store = not status.present
    # Budget from what is actually MISSING, not from the model's total size.
    # A store holding the 435 MB checkpoint but missing its 1.2 kB config is
    # cold — but it is 1.2 kB cold, and weighting the bar for 435 MB would
    # leave it parked at zero for a phase that takes no time at all.
    job.download_bytes = status.missing_bytes
    job.model_bytes = spec.total_bytes
    job.stem_count = len(spec.stem_names) or 2

    if job.cold_store:
        job.set_phase("downloading", 0.0, f"fetching {spec.name}")
    else:
        job.set_phase("verifying", 0.0, spec.name)

    acquire_started = time.time()

    def store_progress(phase: str, fraction: float, detail: str) -> None:
        job.set_phase(phase, fraction, detail)
        if phase == "downloading" and job.download_bytes:
            # Measure the connection rather than assuming one. This feeds the
            # phase WEIGHTING (see jobs.phase_costs), never an ETA.
            job.observe_download_rate(fraction * spec.total_bytes, since=acquire_started)

    paths = store.ensure(spec, on_progress=store_progress, cancel=job.cancel_event)

    if job.cancel_event.is_set():
        raise DownloadCancelled("cancelled before load")

    # ── 2. Load the model ────────────────────────────────────────────────
    job.set_phase("loading", 0.0, f"loading {spec.name}")
    separator = build_separator(
        spec, paths, prefer_device=prefer_device,
        on_install_progress=lambda done, total: job.set_phase_progress(
            done / max(1, total), f"preparing {spec.name}"))
    job.device = separator.device
    job.warnings.extend(getattr(separator, "warnings", None)
                        or getattr(separator, "shape_warnings", []))
    job.set_phase("loading", 1.0, f"{spec.name} on {separator.device}")

    # ── 3. Read the input ────────────────────────────────────────────────
    mix, original_rate = load_audio(job.input_path, separator.sample_rate)
    job.duration_sec = duration_seconds(mix, separator.sample_rate)
    if original_rate != separator.sample_rate:
        job.warnings.append(
            f"input resampled {original_rate} → {separator.sample_rate} Hz for this model")

    # Seed the ETA from the manifest's per-device figures FOR THIS MODEL, and
    # for THIS LENGTH. It is a starting point only — observe_throughput
    # replaces it with measurement below — but the seed still has to be the
    # right order of magnitude, and it is wrong in two independent ways if you
    # take a shortcut: the two tiers differ by 9x on the same CPU, and a run's
    # fixed cost (two chunks of reflected padding, 40 s on BALANCED/CPU) is
    # most of the wall clock for the short samples a Sandbox mostly holds.
    job.rate_estimate = spec.effective_seconds_per_second(job.duration_sec, separator.device)
    if not spec.speed_is_measured(separator.device):
        job.warnings.append(
            f"no measured throughput for {spec.name} on {separator.device}; the first "
            "ETA is an estimate and is replaced once a chunk completes")

    if job.cancel_event.is_set():
        raise SeparationCancelled("cancelled before inference")

    # ── 4. Infer ─────────────────────────────────────────────────────────
    plan = separator.plan(mix.shape[1])
    job.set_phase("separating", 0.0,
                  f"0 / {plan['chunks']} chunks · {separator.device}")
    # Input-audio seconds "finished" per chunk — the input's duration divided
    # by the chunk count, not the model's step size.
    #
    # Those differ, and the difference is not small. An overlapped model's
    # chunks share their overlap, and both architectures pad the ends with
    # material the model still has to process: 13 s at each end for BALANCED.
    # Measuring throughput against the step makes the rate look better than it
    # is, by exactly the padding ratio — 7% optimistic on a three-minute song
    # and 40% on a twenty-second one, worst precisely where a user is watching
    # closely. Dividing the real duration by the real chunk count makes the
    # measured rate mean the same thing as the manifest's `speed` figure:
    # wall-seconds per second of the audio the user handed us.
    audio_per_chunk = job.duration_sec / max(1, plan["chunks"])
    infer_started = time.time()

    def on_chunk(done: int, total: int) -> None:
        job.set_phase_progress(done / max(1, total),
                               f"{done} / {total} chunks · {separator.device}")
        job.observe_throughput(done * audio_per_chunk, since=infer_started)

    stems = separator.separate(mix, batch_size=batch_size,
                               on_chunk=on_chunk, cancel=job.cancel_event)

    if job.cancel_event.is_set():
        raise SeparationCancelled("cancelled after inference")

    # ── 5. DE-BLEED (optional) and write ────────────────────────────────────
    stems = _maybe_de_bleed(job, stems, separator.sample_rate, apply_debleed)
    _write_stems(job, stems, output_dir, separator.sample_rate)


def run_ensemble_separation(
    job: Job,
    specs: List[ModelSpec],
    store: ModelStore,
    batch_size: int = 1,
    prefer_device: Optional[str] = None,
    apply_debleed: bool = False,
) -> None:
    """Run two DIFFERENT models on the same input, sequentially, and average
    their common stems. See ensemble.average_stems for the averaging itself.

    Deliberately sequential rather than parallel: two inference runs
    contending for the same GPU or the same CPU cores is slower than the same
    two run back to back, and it removes a whole failure mode (two models
    racing to write progress into one job) for a feature whose bar is
    correctness, not speed.

    Every phase's cost is budgeted from the SUM of both models' figures —
    download, verify and load really are twice the work, and reporting a
    single model's share would leave the bar parked at 50% for the second
    half of every phase. This reuses jobs.py's existing phase mechanism
    exactly as run_separation does; nothing in jobs.py needed to change,
    because a job still has one phase, one progress fraction and one ETA —
    what differs here is only how this function computes the numbers it
    feeds into them.
    """
    if len(specs) != 2:
        raise ValueError(f"ensemble mode takes exactly two models, got {len(specs)}")
    for spec in specs:
        assert_license_cleared(spec)

    output_dir = Path(job.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── 1. Acquire both models' weights ─────────────────────────────────────
    statuses = [store.status(spec) for spec in specs]
    job.cold_store = any(not st.present for st in statuses)
    job.download_bytes = sum(st.missing_bytes for st in statuses)
    job.model_bytes = sum(spec.total_bytes for spec in specs)
    job.stem_count = 2  # the ensemble reports the stems common to both models

    job.set_phase("downloading" if job.cold_store else "verifying", 0.0,
                  f"{specs[0].name} + {specs[1].name}")
    acquire_started = time.time()

    def progress_for(index: int):
        def _progress(phase: str, fraction: float, detail: str) -> None:
            combined = (index + fraction) / len(specs)
            job.set_phase(phase, combined, detail)
            if phase == "downloading" and job.download_bytes:
                job.observe_download_rate(combined * job.model_bytes, since=acquire_started)
        return _progress

    all_paths = []
    for i, spec in enumerate(specs):
        all_paths.append(store.ensure(spec, on_progress=progress_for(i), cancel=job.cancel_event))
    if job.cancel_event.is_set():
        raise DownloadCancelled("cancelled before load")

    # ── 2. Load both models ─────────────────────────────────────────────────
    job.set_phase("loading", 0.0, "loading models")
    separators = []
    for i, (spec, paths) in enumerate(zip(specs, all_paths)):
        sep = build_separator(spec, paths, prefer_device=prefer_device)
        job.warnings.extend(getattr(sep, "warnings", None) or getattr(sep, "shape_warnings", []))
        separators.append(sep)
        job.set_phase("loading", (i + 1) / len(specs), f"{spec.name} on {sep.device}")
    # Both devices, not just the first — a CUDA FAST paired with a CPU BEST
    # is a real, expected combination, and reporting only one would repeat
    # the exact single-device lie the per-architecture health check exists
    # to avoid.
    job.device = "+".join(dict.fromkeys(sep.device for sep in separators))

    # ── 3. Read the input ONCE, at the first model's rate. Only re-read (and
    #    resample again) for the second model if its OWN rate differs — true
    #    of every pairing wired today, but not assumed. ─────────────────────
    mix, original_rate = load_audio(job.input_path, separators[0].sample_rate)
    job.duration_sec = duration_seconds(mix, separators[0].sample_rate)
    if original_rate != separators[0].sample_rate:
        job.warnings.append(
            f"input resampled {original_rate} → {separators[0].sample_rate} Hz for "
            f"{specs[0].name}")

    # Seed the ETA from the SUM of both models' per-device figures — the real
    # wall clock is (very nearly) both runs back to back, so the combined
    # rate is the sum of the two, not an average of them.
    job.rate_estimate = sum(
        spec.effective_seconds_per_second(job.duration_sec, sep.device)
        for spec, sep in zip(specs, separators))

    if job.cancel_event.is_set():
        raise SeparationCancelled("cancelled before inference")

    # ── 4. Infer, one model at a time ───────────────────────────────────────
    infer_started = time.time()
    results = []
    for i, (spec, sep) in enumerate(zip(specs, separators)):
        model_mix = mix
        if sep.sample_rate != separators[0].sample_rate:
            model_mix, _ = load_audio(job.input_path, sep.sample_rate)
            job.warnings.append(
                f"{spec.name} runs at {sep.sample_rate} Hz, resampled separately "
                f"from {specs[0].name}'s {separators[0].sample_rate} Hz")

        plan = sep.plan(model_mix.shape[1])
        audio_per_chunk = job.duration_sec / max(1, plan["chunks"])
        job.set_phase("separating", i / len(specs),
                      f"{spec.tier or spec.id}: 0 / {plan['chunks']} chunks · {sep.device}")

        def on_chunk(done: int, total: int, i=i, spec=spec, sep=sep,
                    audio_per_chunk=audio_per_chunk) -> None:
            job.set_phase_progress(
                (i + done / max(1, total)) / len(specs),
                f"{spec.tier or spec.id}: {done} / {total} chunks · {sep.device}")
            # Credit this model's share of the audio as "done" against the
            # COMBINED rate seeded above, so the two runs contribute to one
            # ETA instead of each overwriting the other's.
            job.observe_throughput(i * job.duration_sec + done * audio_per_chunk,
                                   since=infer_started)

        stems = sep.separate(model_mix, batch_size=batch_size,
                             on_chunk=on_chunk, cancel=job.cancel_event)
        results.append((spec, sep, stems))

        if job.cancel_event.is_set():
            raise SeparationCancelled("cancelled after inference")

    # ── 5. Average, DE-BLEED (optional), and write ──────────────────────────
    (spec_a, sep_a, stems_a), (spec_b, sep_b, stems_b) = results
    averaged, dropped = average_stems(stems_a, sep_a.sample_rate, stems_b, sep_b.sample_rate)
    if dropped:
        job.warnings.append(
            "stems present in only one model could not be averaged and were "
            f"dropped from the ensemble: {', '.join(dropped)}")

    output_rate = sep_a.sample_rate
    averaged = _maybe_de_bleed(job, averaged, output_rate, apply_debleed)
    _write_stems(job, averaged, output_dir, output_rate)
