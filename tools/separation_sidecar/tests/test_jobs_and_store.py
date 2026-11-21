"""Job lifecycle, progress honesty, cancellation, and the store's checksum
gate. Stdlib only — no model download, no inference."""

import dataclasses
import hashlib
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.jobs import JobRegistry  # noqa: E402
from xleth_separation.manifest import load_manifest  # noqa: E402
from xleth_separation.store import ChecksumMismatch, ModelStore, sha256_file  # noqa: E402


def make_registry_job(registry, **kw):
    defaults = dict(model_id="m", tier="fast", input_path="in.wav",
                    output_dir="out", label="test")
    defaults.update(kw)
    return registry.create(**defaults)


# ── Progress ─────────────────────────────────────────────────────────────

def test_download_is_inside_the_progress_on_a_cold_store():
    """A first run spends most of its wall clock fetching the weight. A bar
    that sits at 0% for all of it is the dishonest version."""
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = True
    job.set_phase("downloading", 0.5)
    assert 0.0 < job.overall < 0.35


def test_warm_store_skips_straight_into_the_work():
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = False
    job.set_phase("downloading", 1.0)
    assert job.overall == pytest.approx(0.0)
    job.set_phase("separating", 0.5)
    assert 0.4 < job.overall < 0.6


def test_progress_is_monotonic_across_the_phase_sequence():
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = True
    seen = []
    for phase in ("downloading", "verifying", "loading", "separating", "writing"):
        for frac in (0.0, 0.5, 1.0):
            job.set_phase(phase, frac)
            seen.append(job.overall)
    assert seen == sorted(seen), "overall progress must never go backwards"
    assert seen[-1] == pytest.approx(1.0)


def test_eta_is_none_until_there_is_something_honest_to_say():
    r = JobRegistry()
    job = make_registry_job(r)
    job.started_at = time.time()
    job.set_phase("downloading", 0.5)
    # Download time depends on the user's connection; we do not guess at it.
    assert job.eta_seconds() is None

    job.set_phase("separating", 0.5)
    assert job.eta_seconds() is None, "no duration yet — nothing to scale"

    job.duration_sec = 100.0
    job.rate_estimate = 0.5
    assert job.eta_seconds() == pytest.approx(25.0)  # 50s of audio left * 0.5


def test_measured_throughput_replaces_the_manifest_estimate():
    r = JobRegistry()
    job = make_registry_job(r)
    job.duration_sec = 10.0
    job.rate_estimate = 99.0       # a deliberately terrible seed
    job.started_at = time.time() - 2.0
    assert not job.measured
    job.observe_throughput(4.0)    # 4s of audio in ~2s wall
    assert job.measured
    assert job.rate_estimate == pytest.approx(0.5, abs=0.05)


# ── Lifecycle ────────────────────────────────────────────────────────────

def test_a_raising_job_lands_in_a_terminal_state():
    """A job that raised and stayed 'running' would hang the UI's poll
    forever, which is the failure mode this guards."""
    r = JobRegistry()
    job = make_registry_job(r)

    def boom(_):
        raise ValueError("nope")

    r.run(job, boom).join(timeout=5)
    assert job.state == "error"
    assert "nope" in job.error
    assert job.finished_at is not None


def test_cancellation_is_observed_by_the_worker():
    r = JobRegistry()
    job = make_registry_job(r)
    entered = threading.Event()

    def slow(j):
        entered.set()
        for _ in range(200):
            if j.cancel_event.is_set():
                return
            time.sleep(0.01)
        raise AssertionError("worker never saw the cancel flag")

    t = r.run(job, slow)
    assert entered.wait(2)
    assert r.cancel(job.id)
    t.join(timeout=5)
    assert job.state == "cancelled"


def test_cancel_is_a_no_op_on_a_finished_job():
    r = JobRegistry()
    job = make_registry_job(r)
    r.run(job, lambda _: None).join(timeout=5)
    assert job.state == "done"
    assert r.cancel(job.id) is False


def test_history_never_evicts_a_running_job():
    r = JobRegistry(max_history=2)
    blocker = make_registry_job(r, label="blocker")
    release = threading.Event()
    r.run(blocker, lambda _: release.wait(5))

    for i in range(5):
        j = make_registry_job(r, label=f"done-{i}")
        r.run(j, lambda _: None).join(timeout=5)

    assert r.get(blocker.id) is not None, "a running job must stay reachable"
    release.set()


def test_finished_jobs_survive_long_enough_to_be_polled():
    r = JobRegistry()
    job = make_registry_job(r)
    r.run(job, lambda _: None).join(timeout=5)
    assert r.get(job.id).state == "done"


# ── Derived phase weighting ──────────────────────────────────────────────

def cold_job(registry, *, duration, rate, size):
    job = make_registry_job(registry)
    job.cold_store = True
    job.duration_sec = duration
    job.rate_estimate = rate
    job.download_bytes = job.model_bytes = size
    return job


def test_the_download_share_tracks_the_real_costs_not_a_constant():
    """The old weighting gave the download a flat 35%, fitted to a 66 MB weight
    in front of a 0.33x-realtime separation. The BALANCED tier is 435 MB in
    front of a 3.09x one.

    Note which way this goes: BALANCED's download is 6.6x the bytes but its
    inference is 9x the work, so the download's SHARE of the bar is smaller,
    not larger. That is the point — a share is a ratio, and the constant was
    wrong for both tiers in the same direction, over-weighting the download by
    three to four times and parking the bar mid-run.
    """
    r = JobRegistry()
    fast = cold_job(r, duration=180.0, rate=0.33, size=66_759_214)
    balanced = cold_job(r, duration=180.0, rate=3.09, size=435_006_815)

    fast_share = fast._spans["downloading"][1]
    balanced_share = balanced._spans["downloading"][1]

    for share in (fast_share, balanced_share):
        assert 0.0 < share < 0.35, "the old constant over-weighted both tiers"

    assert balanced_share < fast_share
    # Each share is that phase's estimated seconds over the run's.
    for job, share in ((fast, fast_share), (balanced, balanced_share)):
        costs = job.phase_costs()
        assert share == pytest.approx(costs["downloading"] / sum(costs.values()))


def test_a_slower_machine_shifts_the_bar_towards_inference():
    """Same model, same connection, a CPU instead of a GPU: the separation is
    the overwhelming majority of the wait, and the bar has to say so."""
    r = JobRegistry()
    on_gpu = cold_job(r, duration=180.0, rate=0.47, size=435_006_815)
    on_cpu = cold_job(r, duration=180.0, rate=3.09, size=435_006_815)
    assert on_cpu._spans["downloading"][1] < on_gpu._spans["downloading"][1]


def test_a_warm_store_gives_the_download_no_width_at_all():
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = False
    job.duration_sec = 60.0
    job.rate_estimate = 3.09
    job.download_bytes = 0
    job.model_bytes = 435_006_815
    lo, hi = job._spans["downloading"]
    assert hi == pytest.approx(lo), "nothing to fetch must occupy no bar"
    job.set_phase("separating", 0.5)
    assert job.overall > 0.3


def test_only_the_missing_bytes_are_budgeted_for():
    """A store holding the 435 MB checkpoint but missing its 1.2 kB config is
    cold — but it is 1.2 kB cold. Budgeting the model's total would park the
    bar at zero for a phase that takes no time."""
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = True
    job.duration_sec = 180.0
    job.rate_estimate = 3.09
    job.model_bytes = 435_006_815
    job.download_bytes = 1175
    assert job._spans["downloading"][1] < 0.01


def test_falls_back_to_the_fixed_tables_when_the_duration_is_unknown():
    """Without the input length the inference cost is zero and the download
    would swallow the whole bar. The old tables are at least a shape someone
    measured once."""
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = True
    job.download_bytes = job.model_bytes = 435_006_815
    assert job.phase_costs() is None
    assert job._spans["downloading"] == (0.00, 0.35)


def test_a_measured_download_rate_replaces_the_seed():
    r = JobRegistry()
    job = make_registry_job(r)
    assert job.download_rate is None
    # Too little, too soon: a rate computed from the first few blocks says
    # more about TLS setup than about the link.
    job.observe_download_rate(1024, since=time.time() - 2.0)
    assert job.download_rate is None
    job.observe_download_rate(20 * 1024 * 1024, since=time.time() - 2.0)
    assert job.download_rate == pytest.approx(10 * 1024 * 1024, rel=0.1)


def test_progress_never_retreats_when_the_estimate_improves():
    """The spans are re-derived from facts arriving mid-run, and a
    re-derivation can place the current point behind the last one. A bar
    sliding backwards reads as "something went wrong", not as "the estimate
    got better"."""
    r = JobRegistry()
    job = make_registry_job(r)
    job.cold_store = True
    job.duration_sec = 180.0
    job.rate_estimate = 3.09
    job.download_bytes = job.model_bytes = 435_006_815

    job.set_phase("downloading", 1.0)
    peak = job.overall
    # A fast connection turns out to make the download a much smaller share.
    job.download_rate = 200 * 1024 * 1024
    assert job.overall >= peak


def test_phase_costs_are_seconds_and_add_up_to_the_estimated_run():
    r = JobRegistry()
    job = make_registry_job(r)
    job.duration_sec = 60.0
    job.rate_estimate = 3.09
    job.download_bytes = job.model_bytes = 435_006_815
    job.download_rate = 10 * 1024 * 1024
    costs = job.phase_costs()
    assert costs["downloading"] == pytest.approx(435_006_815 / (10 * 1024 * 1024), rel=0.01)
    assert costs["separating"] == pytest.approx(60.0 * 3.09)
    assert sum(costs.values()) > costs["separating"]


# ── Store ────────────────────────────────────────────────────────────────

def fake_download(payload):
    """Stand in for the network. Signature matches ModelStore._download bound
    to an instance: (model_file, dest, meter, cancel)."""
    def _download(_mf, dest, _meter, _cancel):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
    return _download


def respec(spec, **files):
    """Copy `spec` with some of its files' bytes replaced by real payloads, so
    the store's checksum gate can be exercised without a 435 MB download."""
    new_files = []
    for f in spec.files:
        if f.role in files:
            payload = files[f.role]
            new_files.append(dataclasses.replace(
                f, sha256=hashlib.sha256(payload).hexdigest(), size_bytes=len(payload)))
        else:
            new_files.append(f)
    return dataclasses.replace(spec, files=new_files)


def only_roles(spec, *roles):
    return dataclasses.replace(spec, files=[f for f in spec.files if f.role in roles])


def test_store_reports_absent_without_a_receipt(tmp_path):
    spec = load_manifest().model_for_tier("fast")
    store = ModelStore(tmp_path)
    assert store.status(spec).present is False

    path = store.model_path(spec)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"not the model")
    # Present on disk but unproven — must NOT read as present, or a corrupt
    # file would be handed straight to onnxruntime.
    assert store.status(spec).present is False


def test_store_refuses_bytes_that_do_not_match_the_checksum(tmp_path, monkeypatch):
    spec = load_manifest().model_for_tier("fast")
    store = ModelStore(tmp_path)
    monkeypatch.setattr(store, "_download", fake_download(b"wrong bytes"))
    with pytest.raises(ChecksumMismatch):
        store.ensure(spec)
    assert not store.model_path(spec).exists(), "a bad download must not be left behind"


def test_store_accepts_bytes_that_match(tmp_path, monkeypatch):
    payload = b"pretend weights"
    spec = respec(load_manifest().model_for_tier("fast"), weights=payload)

    store = ModelStore(tmp_path)
    monkeypatch.setattr(store, "_download", fake_download(payload))
    paths = store.ensure(spec)
    assert paths["weights"].exists()
    assert sha256_file(paths["weights"]) == spec.weights.sha256
    # Second call is a cheap receipt hit, not another download.
    assert store.status(spec).present is True


def test_a_multi_file_model_is_absent_until_every_file_is_present(tmp_path, monkeypatch):
    """The 1.2 kB config decides whether the 435 MB weight is used correctly.
    A store holding one without the other is not a usable model."""
    weights, config = b"tensors", b"audio: {chunk_size: 573300}\n"
    spec = respec(load_manifest().model_for_tier("balanced"),
                  weights=weights, config=config)
    store = ModelStore(tmp_path)

    payloads = {"weights": weights, "config": config}

    def download(mf, dest, _meter, _cancel):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payloads[mf.role])

    monkeypatch.setattr(store, "_download", download)

    # Fetch the weight only, leaving the config missing.
    store.ensure(only_roles(spec, "weights"))
    status = store.status(spec)
    assert status.present is False
    assert status.missing_bytes == len(config)
    assert [f.role for f in status.files if f.present] == ["weights"]

    paths = store.ensure(spec)
    assert set(paths) == {"weights", "config"}
    assert store.status(spec).present is True
    assert store.status(spec).missing_bytes == 0


def test_store_refuses_to_fetch_an_unaudited_weight(tmp_path):
    from xleth_separation.manifest import LicenseNotCleared, ModelLicense

    spec = load_manifest().model_for_tier("fast")
    pending = dataclasses.replace(spec, license=ModelLicense(status="PENDING-AUDIT"))
    store = ModelStore(tmp_path)
    with pytest.raises(LicenseNotCleared):
        store.ensure(pending)


def test_store_does_not_second_guess_the_acknowledgement_gate(tmp_path, monkeypatch):
    """Acknowledgement is enforced at the HTTP door, where the answer can still
    change what happens. By the time the store is fetching, the question has
    been asked — re-asking here would only mean it could never be answered."""
    payloads = {"weights": b"tensors", "config": b"audio: {}\n"}
    spec = respec(load_manifest().model_for_tier("balanced"), **payloads)
    assert spec.license.requires_acknowledgement is True

    store = ModelStore(tmp_path)

    def download(mf, dest, _meter, _cancel):
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payloads[mf.role])

    monkeypatch.setattr(store, "_download", download)
    assert set(store.ensure(spec)) == {"weights", "config"}
