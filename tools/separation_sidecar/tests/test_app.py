"""HTTP-surface tests.

These run WITHOUT torch or onnxruntime installed, which is itself part of the
contract: /health must be able to report a broken install rather than being
the thing that crashes.
"""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.app import SidecarConfig, create_app  # noqa: E402

MANIFEST = Path(__file__).resolve().parents[1] / "xleth_separation" / "models.json"
TOKEN = "test-token"


@pytest.fixture
def client(tmp_path):
    app = create_app(SidecarConfig(
        models_dir=tmp_path / "models", work_dir=tmp_path / "work", token=TOKEN))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def auth():
    return {"X-Xleth-Token": TOKEN}


def test_health_is_unauthenticated_and_survives_a_partial_install(client):
    res = client.get("/health")
    assert res.status_code == 200
    body = res.json()
    assert "device" in body and "torch" in body and "onnxruntime" in body
    assert body["authRequired"] is True


def test_endpoints_require_the_token(client):
    assert client.get("/models").status_code == 401
    assert client.get("/jobs").status_code == 401
    assert client.post("/separate", json={"inputPath": "x"}).status_code == 401


def test_models_lists_the_manifest_and_store_state(client, auth):
    body = client.get("/models", headers=auth).json()
    ids = [m["id"] for m in body["models"]]
    assert "mdx_kim_vocal_2" in ids

    kim = next(m for m in body["models"] if m["id"] == "mdx_kim_vocal_2")
    assert kim["store"]["present"] is False          # nothing downloaded yet
    assert kim["license"]["cleared"] is True
    assert kim["license"]["attribution"]

    tiers = {t["id"]: t for t in body["tiers"]}
    assert tiers["fast"]["enabled"] is True
    assert tiers["balanced"]["enabled"] is True
    assert tiers["best"]["enabled"] is True

    best = next(m for m in body["models"] if m["id"] == "bs_roformer_ft1_anvuew")
    assert best["license"]["cleared"] is True
    assert best["license"]["status"] == "CLEARED"


def test_models_reports_the_best_tier_and_its_conditions(client, auth):
    """Mirrors test_models_reports_the_balanced_tier_and_its_conditions below —
    BEST is CLEARED (GPL-3.0 permits commercial use, so no non-commercial
    flag), but still gates on acknowledgement: the audit could not get an
    explicit third-party-use statement from anvuew, only establish that
    XLETH's own posture (open source, never bundles the weight) does not
    create the problem GPL-3.0 exists to prevent — see NOTICE-separation-
    models.md's "Resolution" section. That residual is the user's to see,
    not just the audit record's."""
    body = client.get("/models", headers=auth).json()
    best = next(m for m in body["models"] if m["id"] == "bs_roformer_ft1_anvuew")

    assert best["license"]["cleared"] is True
    assert best["license"]["requiresAcknowledgement"] is True
    assert best["license"]["commercialUse"] is True
    assert best["license"]["spdx"] == "GPL-3.0"
    assert best["license"]["acknowledgement"]
    assert "anvuew" in best["license"]["attribution"]


def test_models_reports_the_balanced_tier_and_its_conditions(client, auth):
    """The strip renders its tier buttons and its licence footnote from this
    payload. A condition that never reaches the UI is one the user never
    agreed to."""
    body = client.get("/models", headers=auth).json()
    deux = next(m for m in body["models"] if m["id"] == "mel_roformer_becruily_deux")

    assert deux["license"]["cleared"] is True
    assert deux["license"]["requiresAcknowledgement"] is True
    assert deux["license"]["commercialUse"] is False
    assert deux["license"]["spdx"] == "CC-BY-NC-4.0"
    assert deux["license"]["acknowledgement"]
    assert "becruily" in deux["license"]["attribution"]

    # Both files, so the strip can show what a cold run will fetch.
    assert {f["role"] for f in deux["files"]} == {"weights", "config"}
    assert deux["sizeBytes"] > 435_000_000
    assert deux["stemNames"] == ["Vocals", "Instrumental"]


def test_models_reports_per_architecture_devices(client, auth):
    """MDX-Net infers in onnxruntime and Mel-Band RoFormer in torch, and this
    project's requirements pin CPU torch next to a CUDA-capable onnxruntime.
    One global device field would be right about FAST and wrong about BALANCED
    by a factor of six."""
    body = client.get("/models", headers=auth).json()
    assert set(body["archs"]) == {"mdx_net", "mel_band_roformer", "bs_roformer"}
    for model in body["models"]:
        assert "device" in model and "runtimeOk" in model


def test_separate_rejects_a_missing_input(client, auth):
    res = client.post("/separate", headers=auth,
                      json={"inputPath": "no-such-file.wav", "tier": "fast"})
    assert res.status_code == 400
    assert "not found" in res.json()["detail"]


def test_separate_refuses_an_unaudited_model(tmp_path, auth):
    """The license gate is a control, not a comment: a PENDING-AUDIT weight is
    refused at the door with a 403 the UI can explain."""
    raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
    raw["models"][0]["license"]["status"] = "PENDING-AUDIT"
    patched = tmp_path / "models.json"
    patched.write_text(json.dumps(raw), encoding="utf-8")

    app = create_app(SidecarConfig(models_dir=tmp_path / "m", work_dir=tmp_path / "w",
                                   token=TOKEN, manifest_path=patched))
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    with TestClient(app) as c:
        res = c.post("/separate", headers=auth, json={"inputPath": str(wav), "tier": "fast"})
    assert res.status_code == 403
    assert "PENDING-AUDIT" in res.json()["detail"]


# ── ENSEMBLE ─────────────────────────────────────────────────────────────

def test_separate_ensemble_rejects_the_wrong_count(client, auth, tmp_path):
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav), "ensembleModelIds": ["mdx_kim_vocal_2"]})
    assert res.status_code == 400
    assert "exactly two" in res.json()["detail"]


def test_separate_ensemble_rejects_the_same_model_twice(client, auth, tmp_path):
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav),
        "ensembleModelIds": ["mdx_kim_vocal_2", "mdx_kim_vocal_2"]})
    assert res.status_code == 400
    assert "two different models" in res.json()["detail"]


def test_separate_ensemble_rejects_an_unknown_model_id(client, auth, tmp_path):
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav),
        "ensembleModelIds": ["mdx_kim_vocal_2", "no-such-model"]})
    assert res.status_code == 400


def test_separate_ensemble_refuses_if_either_half_is_unaudited(auth, tmp_path):
    """An ensemble is only as cleared as its more restricted half — pairing a
    cleared model with an unaudited one must not let the audited half smuggle
    the unaudited one through. All three real tiers are CLEARED today, so
    this forces one back to PENDING-AUDIT on a patched manifest to exercise
    the rule itself rather than depend on any one tier's current status."""
    raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
    kim = next(m for m in raw["models"] if m["id"] == "mdx_kim_vocal_2")
    kim["license"]["status"] = "PENDING-AUDIT"
    patched = tmp_path / "models.json"
    patched.write_text(json.dumps(raw), encoding="utf-8")

    app = create_app(SidecarConfig(models_dir=tmp_path / "m", work_dir=tmp_path / "w",
                                   token=TOKEN, manifest_path=patched))
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    with TestClient(app) as c:
        res = c.post("/separate", headers=auth, json={
            "inputPath": str(wav),
            "ensembleModelIds": ["mdx_kim_vocal_2", "mel_roformer_becruily_deux"]})
    assert res.status_code == 403
    assert "PENDING-AUDIT" in res.json()["detail"]


def test_separate_ensemble_creates_one_combined_job(client, auth, tmp_path, monkeypatch):
    """FAST + BALANCED are both cleared and different architectures — the
    pairing the brief calls out as the good case. The pipeline itself needs
    real weights, so it is stubbed here; this test is about the JOB app.py
    hands back, not about a real separation running."""
    import xleth_separation.app as app_module

    started = {}
    monkeypatch.setattr(app_module, "run_ensemble_separation",
                        lambda job, specs, *a, **kw: started.setdefault("specs", specs))

    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav),
        "ensembleModelIds": ["mdx_kim_vocal_2", "mel_roformer_becruily_deux"],
        "acknowledgeLicense": True,
    })
    assert res.status_code == 202
    body = res.json()
    assert body["tier"] == "ensemble"
    assert "mdx_kim_vocal_2" in body["modelId"]
    assert "mel_roformer_becruily_deux" in body["modelId"]


# ── DE-BLEED ─────────────────────────────────────────────────────────────

def test_separate_accepts_the_debleed_flag_without_a_model_change(client, auth, tmp_path, monkeypatch):
    """DE-BLEED is orthogonal to which model ran — a single-tier request with
    deBleed:true must still resolve the FAST tier normally and just carry the
    flag through to the pipeline call."""
    import xleth_separation.app as app_module

    seen = {}
    monkeypatch.setattr(app_module, "run_separation",
                        lambda job, spec, store, **kw: seen.setdefault("kw", kw))

    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth,
                      json={"inputPath": str(wav), "tier": "fast", "deBleed": True})
    assert res.status_code == 202
    assert res.json()["tier"] == "fast"


def test_unknown_job_is_a_404(client, auth):
    assert client.get("/jobs/nope", headers=auth).status_code == 404
    assert client.post("/jobs/nope/cancel", headers=auth).status_code == 404


def test_jobs_starts_empty(client, auth):
    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


@pytest.fixture
def no_runtime(monkeypatch):
    """Force the "incomplete install" condition regardless of what is actually
    installed. Setting a sys.modules entry to None makes `import x` raise
    ImportError, so this reproduces the missing-package state on a machine
    where torch and onnxruntime ARE present — the gate tests below must not
    silently become no-ops just because the dev box got its dependencies."""
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    monkeypatch.setitem(sys.modules, "torch", None)


def test_separate_refuses_when_the_runtime_cannot_finish_the_job(
        client, auth, tmp_path, no_runtime):
    """Regression: a sidecar with fastapi but no onnxruntime starts and serves
    happily, accepted the job, downloaded 66 MB of weights, and only THEN died
    importing onnxruntime. The gate costs one dict lookup and saves all of it."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={"inputPath": str(wav), "tier": "fast"})
    assert res.status_code == 503
    assert "onnxruntime" in res.json()["detail"]
    # No job may have been created — the whole point is that nothing started.
    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


def test_health_names_every_missing_package_not_just_the_first(client, no_runtime):
    body = client.get("/health").json()
    assert body["ok"] is False
    assert set(body["missing"]) == {"onnxruntime", "torch"}
    assert "onnxruntime" in body["error"] and "torch" in body["error"]


def test_health_is_ok_when_the_runtime_is_complete(client):
    """The mirror of the two above. On a machine with the dependencies
    installed this asserts the gate OPENS — a gate that is always shut would
    pass every test above and ship a permanently broken feature."""
    pytest.importorskip("onnxruntime")
    pytest.importorskip("torch")
    body = client.get("/health").json()
    assert body["ok"] is True
    assert body["missing"] == []
    assert body["device"] in {"cuda", "directml", "cpu"}


# ── The acknowledgement gate ─────────────────────────────────────────────
#
# These deliberately run under `no_runtime`. The gate is checked BEFORE the
# runtime pre-flight, so a refused request stops at 409 and an accepted one
# falls through to 503 — which proves the gate opened without ever letting a
# test start a 435 MB download.

def test_balanced_refuses_until_its_licence_is_acknowledged(
        client, auth, tmp_path, no_runtime):
    """CC BY-NC 4.0 carries a condition no amount of software can discharge:
    a restriction on what the user may do with the output. Running the model
    without putting that to them would make the licence block documentation
    rather than a control."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth,
                      json={"inputPath": str(wav), "tier": "balanced"})
    assert res.status_code == 409

    detail = res.json()["detail"]
    # Machine-readable, so the UI can tell this apart from a hard refusal and
    # ask the question rather than reporting a failure.
    assert detail["code"] == "license-acknowledgement-required"
    assert detail["modelId"] == "mel_roformer_becruily_deux"
    assert detail["spdx"] == "CC-BY-NC-4.0"
    assert detail["licenseUrl"]
    assert "non-commercial" in detail["message"].lower()

    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


def test_balanced_proceeds_once_acknowledged(client, auth, tmp_path, no_runtime):
    """The mirror of the test above. A gate that never opens would pass every
    other test here and ship a permanently dead tier."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav), "tier": "balanced", "acknowledgeLicense": True})
    # Past the licence gate, stopped by the (forced) missing runtime.
    assert res.status_code == 503
    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


def test_best_refuses_until_its_licence_is_acknowledged(client, auth, tmp_path, no_runtime):
    """BEST is CLEARED (GPL-3.0), but the audit could only establish that
    XLETH's own posture — open source, never bundling the weight — doesn't
    create the problem GPL-3.0 exists to prevent; it never got an explicit
    third-party-use statement from anvuew. See NOTICE-separation-models.md's
    "Resolution" section. That residual reaches the user the same way
    BALANCED's non-commercial condition does — a click-through, not a
    footnote."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth,
                      json={"inputPath": str(wav), "tier": "best"})
    assert res.status_code == 409

    detail = res.json()["detail"]
    assert detail["code"] == "license-acknowledgement-required"
    assert detail["modelId"] == "bs_roformer_ft1_anvuew"
    assert detail["spdx"] == "GPL-3.0"
    assert detail["licenseUrl"]
    assert "anvuew" in detail["message"]

    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


def test_best_proceeds_once_acknowledged(client, auth, tmp_path, no_runtime):
    """The mirror of the test above."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav), "tier": "best", "acknowledgeLicense": True})
    # Past the licence gate, stopped by the (forced) missing runtime.
    assert res.status_code == 503
    assert client.get("/jobs", headers=auth).json() == {"jobs": []}


def test_the_acknowledgement_gate_does_not_apply_to_the_fast_tier(
        client, auth, tmp_path, no_runtime):
    """If every model asked, the question would stop meaning anything on the
    one that has to."""
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth,
                      json={"inputPath": str(wav), "tier": "fast"})
    assert res.status_code == 503, "MIT model must not be gated on a click-through"


def test_an_unaudited_model_is_refused_even_when_acknowledged(tmp_path, auth):
    """Acknowledgement answers a question we chose to ask. It cannot answer one
    nobody has closed — a caller must not be able to click past the audit."""
    raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
    deux = next(m for m in raw["models"] if m["id"] == "mel_roformer_becruily_deux")
    deux["license"]["status"] = "PENDING-AUDIT"
    patched = tmp_path / "models.json"
    patched.write_text(json.dumps(raw), encoding="utf-8")

    app = create_app(SidecarConfig(models_dir=tmp_path / "m", work_dir=tmp_path / "w",
                                   token=TOKEN, manifest_path=patched))
    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    with TestClient(app) as c:
        res = c.post("/separate", headers=auth, json={
            "inputPath": str(wav), "tier": "balanced", "acknowledgeLicense": True})
    assert res.status_code == 403
    assert "PENDING-AUDIT" in res.json()["detail"]


# ── Per-architecture runtime gating ──────────────────────────────────────

def test_a_missing_roformer_package_does_not_break_the_fast_tier(
        client, auth, tmp_path, monkeypatch):
    """The tiers depend on different packages and have to fail independently.
    Someone who installed the base requirements can run FAST; BALANCED
    additionally needs the Mel-Band RoFormer stack. Gating FAST on einops would
    break a working feature to report a missing one."""
    pytest.importorskip("onnxruntime")
    pytest.importorskip("torch")
    for module in ("einops", "librosa", "rotary_embedding_torch"):
        monkeypatch.setitem(sys.modules, module, None)

    body = client.get("/health").json()
    assert body["ok"] is True, "the core runtime is complete"
    assert body["archs"]["mdx_net"]["ok"] is True
    assert body["archs"]["mel_band_roformer"]["ok"] is False
    assert "einops" in body["archs"]["mel_band_roformer"]["missing"]

    wav = tmp_path / "in.wav"
    wav.write_bytes(b"RIFF....WAVE")
    res = client.post("/separate", headers=auth, json={
        "inputPath": str(wav), "tier": "balanced", "acknowledgeLicense": True})
    assert res.status_code == 503
    assert "einops" in res.json()["detail"]


def test_health_reports_a_device_per_architecture(client):
    pytest.importorskip("onnxruntime")
    pytest.importorskip("torch")
    archs = client.get("/health").json()["archs"]
    assert set(archs) == {"mdx_net", "mel_band_roformer", "bs_roformer"}
    for name, entry in archs.items():
        if entry["ok"]:
            assert entry["device"] in {"cuda", "directml", "cpu"}, name
