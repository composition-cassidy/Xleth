"""FastAPI application for the XLETH separation sidecar.

Transport contract with the Electron main process:

  GET  /health                  liveness + which device we actually got
  GET  /models                  manifest + per-model store status + tier table
  POST /separate                start a job, returns it immediately (202)
  GET  /jobs                    every job this process remembers
  GET  /jobs/{id}               one job (poll this)
  POST /jobs/{id}/cancel        request cancellation
  DELETE /jobs/{id}             cancel and forget
  POST /shutdown                stop the process

Two things are deliberate and worth not undoing:

  * The server binds to 127.0.0.1 and requires a shared token in
    `X-Xleth-Token`. This process reads and writes arbitrary filesystem paths
    on behalf of its caller; any other local process (including a web page in
    any browser on the machine) can reach a loopback port, so "it's only
    localhost" is not by itself an access control.

  * /separate returns before the work is done. Separation takes minutes on
    CPU, and a request that blocked for that long would hit every proxy,
    client and OS timeout between here and the renderer.
"""

from __future__ import annotations

import os
import signal
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from . import ort_util
from .jobs import JobRegistry
from .manifest import (LicenseNotAcknowledged, LicenseNotCleared, Manifest,
                       ManifestError, load_manifest)
from .ort_util import available_device
from .pipeline import device_for_arch, run_ensemble_separation, run_separation
from .store import ModelStore

SIDECAR_VERSION = "1.1.0"

# Python modules each architecture needs beyond the core set.
#
# The three tiers now converge on one runtime. They used to diverge sharply:
# the Roformer tiers built a PyTorch model and needed torch, einops, librosa,
# rotary-embedding-torch and beartype on top of the FAST tier's onnxruntime.
# Those tiers now run exported ONNX graphs with their architecture — mel band
# layout included — baked in as ops, so the whole of that stack is gone.
#
# The structure stays per-arch even though two entries are now identical,
# because the ability to fail independently is the point: a tier whose
# dependency is missing must not take the others down with it, and the next
# architecture added here may well reintroduce a divergence.
ARCH_MODULES = {
    "mdx_net": ("onnxruntime",),
    # YAML because these two read the model's own config file; the graph
    # supplies everything else.
    "mel_band_roformer": ("onnxruntime", "yaml"),
    "bs_roformer": ("onnxruntime", "yaml"),
}


def _missing_modules(names) -> List[str]:
    missing = []
    for name in names:
        try:
            __import__(name)
        except ImportError:
            missing.append(name)
    return missing


class SidecarConfig:
    def __init__(
        self,
        models_dir: Path | str,
        work_dir: Path | str,
        token: Optional[str] = None,
        manifest_path: Optional[Path | str] = None,
        batch_size: int = 1,
        prefer_device: Optional[str] = None,
    ):
        self.models_dir = Path(models_dir).expanduser()
        self.work_dir = Path(work_dir).expanduser()
        self.token = token
        self.manifest_path = Path(manifest_path) if manifest_path else None
        self.batch_size = max(1, int(batch_size))
        self.prefer_device = prefer_device


class SeparateRequest(BaseModel):
    input_path: str = Field(alias="inputPath")
    output_dir: Optional[str] = Field(default=None, alias="outputDir")
    tier: Optional[str] = None
    model_id: Optional[str] = Field(default=None, alias="modelId")
    label: Optional[str] = None
    batch_size: Optional[int] = Field(default=None, alias="batchSize")
    device: Optional[str] = None
    # The caller's answer to a model whose licence carries a condition. It has
    # to travel with the request rather than being remembered here: the sidecar
    # is a stateless worker that any local process can reach, and "somebody
    # accepted this once" is not the same claim as "the person who pressed the
    # button accepted it".
    acknowledge_license: bool = Field(default=False, alias="acknowledgeLicense")
    # Input length, known to the renderer before the job starts. Optional, and
    # the pipeline overwrites it with the true value once the audio is read —
    # but having it UP FRONT is what lets the progress split be derived rather
    # than guessed, because the inference cost is the term it needs (see
    # jobs.phase_costs). Without it the bar falls back to fixed weights.
    duration_sec: Optional[float] = Field(default=None, alias="durationSec")
    # ENSEMBLE (advanced toggle): exactly two model ids, run sequentially and
    # averaged — see ensemble.average_stems and pipeline.run_ensemble_separation.
    # A list rather than two named fields because the UI offers "any two wired
    # tiers", not a fixed pair, and a list is what generalises to that without
    # inventing modelIdA/modelIdB. Present and non-empty means ensemble mode;
    # `tier`/`model_id` above are ignored when it is.
    ensemble_model_ids: Optional[List[str]] = Field(default=None, alias="ensembleModelIds")
    # DE-BLEED (advanced toggle): an optional post-pass, orthogonal to which
    # mode produced the stems — see debleed.de_bleed. Composes with either a
    # single-tier run or an ensemble one.
    de_bleed: bool = Field(default=False, alias="deBleed")

    model_config = {"populate_by_name": True, "protected_namespaces": ()}


def create_app(config: SidecarConfig) -> FastAPI:
    app = FastAPI(title="XLETH Separation Sidecar", version=SIDECAR_VERSION)

    manifest: Manifest = load_manifest(config.manifest_path) if config.manifest_path \
        else load_manifest()
    store = ModelStore(config.models_dir, manifest.store_version)
    registry = JobRegistry()

    config.work_dir.mkdir(parents=True, exist_ok=True)

    def require_token(x_xleth_token: Optional[str] = Header(default=None)) -> None:
        if config.token and x_xleth_token != config.token:
            raise HTTPException(status_code=401, detail="bad or missing X-Xleth-Token")

    auth = [Depends(require_token)]

    # ── Health ───────────────────────────────────────────────────────────

    @app.get("/health")
    def health() -> Dict[str, Any]:
        """Unauthenticated on purpose — it is how the launcher learns the
        process is up, and it discloses nothing a caller could not learn by
        the port being open."""
        info: Dict[str, Any] = {
            "ok": True,
            "version": SIDECAR_VERSION,
            "device": available_device(),
            "pid": os.getpid(),
            "modelsDir": str(store.root),
            "workDir": str(config.work_dir),
            "activeJobs": len(registry.active()),
            "authRequired": bool(config.token),
        }
        # Report EVERY missing runtime dependency, not just the first one
        # found. A health check that names one module at a time turns a single
        # incomplete install into as many failed runs as there are gaps.
        missing: List[str] = list(ort_util.missing_packages())
        try:
            import onnxruntime as ort
            info["onnxruntime"] = ort.__version__
            info["providers"] = list(ort.get_available_providers())
        except ImportError:
            info["onnxruntime"] = None
            info["providers"] = []

        info["missing"] = missing
        if missing:
            info["ok"] = False
            # Deliberately NOT a repo-relative path. A packaged build has no
            # `tools/` directory anywhere near it, and telling someone who
            # installed an .exe to open a file from a source tree they have
            # never cloned is worse than saying nothing.
            info["error"] = (
                "Missing Python package(s): " + ", ".join(missing)
                + ". The bundled runtime is incomplete — reinstalling XLETH "
                "restores it.")

        # Per-architecture readiness and DEVICE.
        #
        # It stays per-arch even though all three tiers now share one runtime
        # and will normally agree. One tier being un-runnable must not present
        # as the whole feature being broken, and a model whose graph failed to
        # load is a per-arch fact.
        #
        # This block used to carry a second, larger reason: the tiers ran on
        # DIFFERENT runtimes, so a machine with a CUDA onnxruntime and a
        # CPU-only torch would run FAST on the GPU and BALANCED on the CPU, and
        # a single `device` field would have been wrong about one of them by a
        # factor of six. That divergence is gone — every tier is onnxruntime
        # now — but the shape that reported it honestly is worth keeping.
        archs: Dict[str, Any] = {}
        for arch, modules in ARCH_MODULES.items():
            arch_missing = missing + _missing_modules(modules)
            entry: Dict[str, Any] = {"missing": arch_missing, "ok": not arch_missing}
            if not arch_missing:
                try:
                    entry["device"] = device_for_arch(arch)
                except Exception as exc:  # noqa: BLE001 — reporting, never fatal
                    entry["device"] = None
                    entry["ok"] = False
                    entry["error"] = f"{type(exc).__name__}: {exc}"
            else:
                entry["device"] = None
            archs[arch] = entry
        info["archs"] = archs
        return info

    # ── Models ───────────────────────────────────────────────────────────

    @app.get("/models", dependencies=auth)
    def list_models() -> Dict[str, Any]:
        payload = manifest.to_dict()
        runtime = health()
        archs = runtime.get("archs", {})
        for entry in payload["models"]:
            spec = manifest.model(entry["id"])
            entry["store"] = store.status(spec).to_dict()
            # The device and readiness THIS model would actually get, not the
            # sidecar's headline one. It is what lets the strip put a truthful
            # "cpu · ~9m" next to BALANCED while FAST says "cuda".
            arch_info = archs.get(spec.arch, {})
            entry["device"] = arch_info.get("device")
            entry["runtimeOk"] = bool(arch_info.get("ok"))
            entry["missing"] = arch_info.get("missing") or []
            device = entry["device"]
            entry["secondsPerSecond"] = spec.seconds_per_second(device) if device else None
            entry["fixedSeconds"] = spec.fixed_seconds(device) if device else None
            entry["speedMeasured"] = spec.speed_is_measured(device) if device else False
        payload["diskUsageBytes"] = store.disk_usage()
        payload["device"] = available_device()
        payload["archs"] = archs
        return payload

    # ── Jobs ─────────────────────────────────────────────────────────────

    def _gate_license(spec, acknowledge: bool) -> None:
        """The license gate, enforced at the door as well as in the
        pipeline — a refusal here is a clean 403 the UI can explain, rather
        than a job that starts and then dies. Applied to every model in the
        request: an ensemble is only as cleared as its more restricted half."""
        if not spec.license.cleared:
            raise HTTPException(
                status_code=403,
                detail=LicenseNotCleared(spec.id, spec.license.status).args[0])

        # The acknowledgement gate. Separate from the clearance gate because
        # the two failures mean opposite things to the caller: not-cleared is
        # ours and unfixable from the UI, not-acknowledged is a question the
        # UI can put to the user and retry. The 409 and the machine-readable
        # body are what let it tell them apart without parsing prose.
        try:
            from .manifest import assert_license_acknowledged
            assert_license_acknowledged(spec, acknowledge)
        except LicenseNotAcknowledged as exc:
            raise HTTPException(status_code=409, detail={
                "code": "license-acknowledgement-required",
                "modelId": spec.id,
                "tier": spec.tier,
                "spdx": spec.license.spdx,
                "licenseUrl": spec.license.license_url,
                "attribution": spec.license.attribution,
                "message": exc.prompt,
            }) from None

    def _gate_runtime(spec) -> Dict[str, Any]:
        """Pre-flight the runtime FOR THIS ARCHITECTURE. Without this the job
        is created, downloads hundreds of MB, and only then dies importing
        einops — minutes and most of a gigabyte spent to deliver a message we
        already had. Returns the arch's own health entry so the caller can
        read its device without asking twice."""
        runtime = health()
        arch_info = runtime.get("archs", {}).get(spec.arch, {})
        if not arch_info.get("ok", runtime.get("ok")):
            arch_missing = arch_info.get("missing") or []
            if arch_info.get("error"):
                detail = arch_info["error"]
            elif arch_missing:
                detail = (f"The {spec.tier or spec.arch} tier needs Python package(s): "
                          + ", ".join(arch_missing)
                          + ". Install them from tools/separation_sidecar/requirements.txt.")
            else:
                detail = runtime.get("error", "runtime not ready")
            raise HTTPException(status_code=503, detail=detail)
        return arch_info

    @app.post("/separate", status_code=202, dependencies=auth)
    def separate(req: SeparateRequest) -> Dict[str, Any]:
        input_path = Path(req.input_path)
        if not input_path.is_file():
            raise HTTPException(status_code=400, detail=f"input not found: {input_path}")

        # ENSEMBLE mode: two model ids given explicitly. `tier`/`modelId` are
        # ignored in that case — a request naming both would be ambiguous
        # about which one the caller actually meant.
        ensemble_mode = bool(req.ensemble_model_ids)
        if ensemble_mode:
            if len(req.ensemble_model_ids) != 2:
                raise HTTPException(
                    status_code=400,
                    detail=f"ensembleModelIds needs exactly two model ids, "
                           f"got {len(req.ensemble_model_ids)}")
            try:
                specs = [manifest.model(mid) for mid in req.ensemble_model_ids]
            except ManifestError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from None
            if specs[0].id == specs[1].id:
                raise HTTPException(
                    status_code=400, detail="ensembleModelIds must name two different models")
        else:
            try:
                specs = [manifest.model(req.model_id) if req.model_id
                        else manifest.model_for_tier(req.tier or "fast")]
            except ManifestError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from None

        for spec in specs:
            _gate_license(spec, req.acknowledge_license)
        arch_infos = [_gate_runtime(spec) for spec in specs]

        output_dir = Path(req.output_dir) if req.output_dir else (config.work_dir / "stems")

        job = registry.create(
            model_id="+".join(s.id for s in specs) if ensemble_mode else specs[0].id,
            tier="ensemble" if ensemble_mode else specs[0].tier,
            input_path=str(input_path),
            output_dir=str(output_dir),
            label=req.label or input_path.stem,
        )
        # Everything the progress split needs, known before any work starts.
        # In ensemble mode every figure is the SUM across both models — see
        # run_ensemble_separation's own comment on why that is the honest
        # weighting, not an average of the two.
        devices = [info.get("device") or available_device() for info in arch_infos]
        job.device = "+".join(dict.fromkeys(devices))
        job.model_bytes = sum(s.total_bytes for s in specs)
        job.stem_count = 2 if ensemble_mode else (len(specs[0].stem_names) or 2)
        statuses = [store.status(s) for s in specs]
        job.cold_store = any(not st.present for st in statuses)
        job.download_bytes = sum(st.missing_bytes for st in statuses)
        if req.duration_sec and req.duration_sec > 0:
            job.duration_sec = float(req.duration_sec)
            job.rate_estimate = sum(
                s.effective_seconds_per_second(job.duration_sec, d)
                for s, d in zip(specs, devices))

        batch = max(1, int(req.batch_size or config.batch_size))
        device = req.device or config.prefer_device
        if ensemble_mode:
            registry.run(job, lambda j: run_ensemble_separation(
                j, specs, store, batch_size=batch, prefer_device=device,
                apply_debleed=req.de_bleed))
        else:
            registry.run(job, lambda j: run_separation(
                j, specs[0], store, batch_size=batch, prefer_device=device,
                apply_debleed=req.de_bleed))
        return job.to_dict()

    @app.get("/jobs", dependencies=auth)
    def list_jobs() -> Dict[str, Any]:
        return {"jobs": [j.to_dict() for j in registry.list()]}

    @app.get("/jobs/{job_id}", dependencies=auth)
    def get_job(job_id: str) -> Dict[str, Any]:
        job = registry.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no job '{job_id}'")
        return job.to_dict()

    @app.post("/jobs/{job_id}/cancel", dependencies=auth)
    def cancel_job(job_id: str) -> Dict[str, Any]:
        job = registry.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no job '{job_id}'")
        return {"cancelled": registry.cancel(job_id), "job": job.to_dict()}

    @app.delete("/jobs/{job_id}", dependencies=auth)
    def delete_job(job_id: str) -> Dict[str, Any]:
        job = registry.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail=f"no job '{job_id}'")
        registry.cancel(job_id)
        return {"deleted": True}

    @app.post("/shutdown", dependencies=auth)
    def shutdown() -> Dict[str, Any]:
        cancelled = registry.cancel_all()
        # Give in-flight threads a moment to notice the cancel flag, then
        # signal ourselves. Killing the process outright while a stem is
        # half-written would leave a truncated WAV the UI might still import.
        threading.Timer(0.75, lambda: os.kill(os.getpid(), signal.SIGTERM)).start()
        return {"stopping": True, "cancelledJobs": cancelled}

    app.state.manifest = manifest
    app.state.store = store
    app.state.registry = registry
    app.state.config = config
    return app


def manifest_tiers(manifest: Manifest) -> List[Dict[str, Any]]:
    return [t.to_dict() for t in manifest.tiers.values()]
