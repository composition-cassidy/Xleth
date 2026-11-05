"""Manifest + license-gate tests. Pure stdlib — no torch, no onnxruntime, no
network, so these run on any machine including CI."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.manifest import (  # noqa: E402
    LICENSE_CLEARED,
    LICENSE_CLEARED_NONCOMMERCIAL,
    LicenseNotAcknowledged,
    LicenseNotCleared,
    ManifestError,
    assert_license_acknowledged,
    assert_license_cleared,
    load_manifest,
)

MANIFEST = Path(__file__).resolve().parents[1] / "xleth_separation" / "models.json"


def patched_manifest(tmp_path, mutate):
    raw = json.loads(MANIFEST.read_text(encoding="utf-8"))
    mutate(raw)
    path = tmp_path / "models.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    return path


def model_raw(raw, model_id):
    return next(m for m in raw["models"] if m["id"] == model_id)


def test_shipped_manifest_loads():
    m = load_manifest()
    assert m.models, "manifest must declare at least one model"
    assert "fast" in m.tiers


# ── FAST: MDX-Net Kim Vocal 2 ────────────────────────────────────────────

def test_tier_1_is_kim_vocal_2_with_the_resolved_url_and_hash():
    """The URL and checksum are resolved at build time and pinned. If this
    test starts failing, someone edited them — which is exactly the moment to
    ask whether the new bytes were audited."""
    m = load_manifest()
    spec = m.model_for_tier("fast")
    assert spec.id == "mdx_kim_vocal_2"
    weights = spec.weights
    assert weights.name == "Kim_Vocal_2.onnx"
    assert weights.url == (
        "https://github.com/TRvlvr/model_repo/releases/download/"
        "all_public_uvr_models/Kim_Vocal_2.onnx")
    assert weights.sha256 == (
        "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b")
    assert weights.size_bytes == 66_759_214


def test_tier_1_architecture_constants():
    """n_fft and hop cannot be recovered from the ONNX graph — a wrong value
    here produces a quietly worse separation rather than an error, so they are
    pinned by test as well as by manifest."""
    spec = load_manifest().model_for_tier("fast")
    assert spec.params["n_fft"] == 7680
    assert spec.params["hop"] == 1024
    assert spec.params["dim_f"] == 3072
    assert spec.params["dim_t"] == 256
    assert spec.params["dim_c"] == 4
    assert spec.sample_rate == 44100


def test_tier_1_stems_are_primary_plus_residual():
    """The instrumental is the residual, which is why the FAST tier's two
    stems sum back to the mix and the BALANCED tier's do not."""
    spec = load_manifest().model_for_tier("fast")
    assert spec.stem_mode == "primary_plus_residual"
    assert spec.stem_names == ["Vocals", "Instrumental"]


# ── BALANCED: Mel-Band RoFormer "deux" ───────────────────────────────────

def test_balanced_is_becruily_deux_with_commit_pinned_urls_and_hashes():
    """Pinned to a COMMIT, not to main: /resolve/main/ follows a force-push,
    and the point of hardcoding these is that upstream cannot change what we
    run without us noticing."""
    spec = load_manifest().model_for_tier("balanced")
    assert spec.id == "mel_roformer_becruily_deux"
    assert spec.arch == "mel_band_roformer"

    weights = spec.file("weights")
    assert weights.name == "becruily_deux.ckpt"
    assert weights.sha256 == (
        "10255c02295bf3e3865d4ee50ff752d7b19b124ed5fd93b147babc4333eda3aa")
    assert weights.size_bytes == 435_006_815

    config = spec.file("config")
    assert config.name == "config_deux_becruily.yaml"
    assert config.sha256 == (
        "bb3ea9bce37ca96d63568490d5a92d7e41df3d7726788b6970c10d89eb62d902")

    for f in (weights, config):
        assert "/resolve/2da74427d682a3df47a774378fc24d7a1a0cdaad/" in f.url, (
            "Hugging Face URLs must be pinned to a commit, not a branch")


def test_balanced_ships_its_own_config_alongside_the_weight():
    """The checkpoint is raw tensors. Without the YAML there is no way to know
    how they are wired, and every Mel-RoFormer checkpoint's YAML differs — so
    the config is a first-class, checksummed file rather than something
    paraphrased into the manifest."""
    spec = load_manifest().model_for_tier("balanced")
    assert spec.has_file("config")
    assert {f.role for f in spec.files} == {"weights", "config"}


def test_balanced_expects_this_models_own_chunking():
    """573300, not the 352800 that nearly every other Mel-RoFormer config
    uses. Substituting another model's yaml runs without error and separates
    worse, so the number this checkpoint was trained with is pinned here."""
    spec = load_manifest().model_for_tier("balanced")
    expects = spec.params["expects"]
    assert expects["chunk_size"] == 573300
    assert expects["stft_hop_length"] == 441
    assert expects["num_overlap"] == 2
    # The whole reason the chunked overlap-add is safe.
    assert expects["chunk_size"] % expects["stft_hop_length"] == 0


def test_balanced_stems_are_model_outputs_not_a_residual():
    spec = load_manifest().model_for_tier("balanced")
    assert spec.stem_mode == "model_outputs"
    assert spec.stem_names == ["Vocals", "Instrumental"]


def test_speed_figures_are_per_model_and_declare_what_was_measured():
    """The two tiers differ by 9x on the same CPU. Seeding one ETA from the
    other promises a three-minute song in one minute and delivers nine."""
    m = load_manifest()
    fast = m.model_for_tier("fast")
    balanced = m.model_for_tier("balanced")

    assert balanced.seconds_per_second("cpu") > 5 * fast.seconds_per_second("cpu")
    assert balanced.speed_is_measured("cpu") is True
    # Not measured, and the manifest says so rather than implying otherwise.
    assert balanced.speed_is_measured("cuda") is False
    assert fast.speed_is_measured("cuda") is True

    # DirectML is a real device for this tier now, with its own derived seed.
    #
    # It was not before: the Roformer tiers inferred in torch, which has no
    # DirectML backend here, so `directml` was an unknown key that fell back to
    # the CPU figure. Since they moved to onnxruntime the same DirectML GPU
    # that serves FAST serves them too, and the manifest carries a figure for
    # it — derived from FAST's measured cpu->directml ratio, and declared
    # unmeasured.
    assert balanced.seconds_per_second("directml") < balanced.seconds_per_second("cpu")
    assert balanced.speed_is_measured("directml") is False

    # A genuinely unknown device must still produce a usable seed, not a crash.
    assert balanced.seconds_per_second("nosuchdevice") == balanced.seconds_per_second("cpu")


# ── The license gate ─────────────────────────────────────────────────────

def test_license_gate_refuses_an_unaudited_model(tmp_path):
    path = patched_manifest(
        tmp_path,
        lambda raw: model_raw(raw, "mdx_kim_vocal_2")["license"].update(
            {"status": "PENDING-AUDIT"}))

    spec = load_manifest(path).model("mdx_kim_vocal_2")
    assert not spec.license.cleared
    with pytest.raises(LicenseNotCleared):
        assert_license_cleared(spec)


def test_license_gate_permits_a_cleared_model():
    spec = load_manifest().model_for_tier("fast")
    assert spec.license.status == LICENSE_CLEARED
    assert spec.license.attribution, "a cleared model must carry its credit line"
    assert_license_cleared(spec)  # must not raise


# ── The acknowledgement gate ─────────────────────────────────────────────

def test_balanced_is_cleared_only_for_non_commercial_use():
    """CC BY-NC 4.0. Cleared to run, and cleared for nothing else — which is a
    different thing from CLEARED and is recorded as such."""
    spec = load_manifest().model_for_tier("balanced")
    lic = spec.license
    assert lic.status == LICENSE_CLEARED_NONCOMMERCIAL
    assert lic.cleared is True, "non-commercial clearance still permits inference"
    assert lic.spdx == "CC-BY-NC-4.0"
    assert lic.commercial_use is False
    assert lic.requires_acknowledgement is True
    assert lic.attribution and "becruily" in lic.attribution
    assert_license_cleared(spec)  # must not raise


def test_acknowledgement_is_required_before_the_balanced_model_runs():
    spec = load_manifest().model_for_tier("balanced")
    with pytest.raises(LicenseNotAcknowledged) as exc:
        assert_license_acknowledged(spec, acknowledged=False)
    # The user has to be able to read what they are agreeing to.
    assert "CC BY-NC 4.0" in exc.value.prompt
    assert "non-commercial" in exc.value.prompt.lower()

    assert_license_acknowledged(spec, acknowledged=True)  # must not raise


def test_a_model_without_conditions_needs_no_acknowledgement():
    """The gate must not become a click-through on every model, or it stops
    meaning anything on the one that needs it."""
    spec = load_manifest().model_for_tier("fast")
    assert spec.license.requires_acknowledgement is False
    assert_license_acknowledged(spec, acknowledged=False)  # must not raise


def test_manifest_rejects_noncommercial_clearance_without_an_acknowledgement(tmp_path):
    """A condition the user is never shown is not a condition they agreed to,
    so the manifest cannot express one."""
    path = patched_manifest(
        tmp_path,
        lambda raw: model_raw(raw, "mel_roformer_becruily_deux")["license"].update(
            {"requires_acknowledgement": False}))
    with pytest.raises(ManifestError):
        load_manifest(path)


def test_manifest_rejects_an_acknowledgement_gate_with_nothing_to_show(tmp_path):
    path = patched_manifest(
        tmp_path,
        lambda raw: model_raw(raw, "mel_roformer_becruily_deux")["license"].update(
            {"acknowledgement": ""}))
    with pytest.raises(ManifestError):
        load_manifest(path)


# ── Structural validation ────────────────────────────────────────────────

def test_manifest_rejects_a_bad_checksum(tmp_path):
    path = patched_manifest(
        tmp_path,
        lambda raw: model_raw(raw, "mdx_kim_vocal_2")["files"][0].update(
            {"sha256": "not-a-hash"}))
    with pytest.raises(ManifestError):
        load_manifest(path)


def test_manifest_rejects_a_model_with_no_weights_file(tmp_path):
    def drop_weights(raw):
        model = model_raw(raw, "mel_roformer_becruily_deux")
        model["files"] = [f for f in model["files"] if f["role"] != "weights"]

    with pytest.raises(ManifestError):
        load_manifest(patched_manifest(tmp_path, drop_weights))


def test_manifest_rejects_duplicate_file_roles(tmp_path):
    def duplicate(raw):
        model = model_raw(raw, "mel_roformer_becruily_deux")
        model["files"].append(dict(model["files"][0]))

    with pytest.raises(ManifestError):
        load_manifest(patched_manifest(tmp_path, duplicate))


def test_manifest_rejects_an_enabled_tier_pointing_at_nothing(tmp_path):
    path = patched_manifest(tmp_path,
                            lambda raw: raw["tiers"]["best"].update(
                                {"enabled": True, "model_id": None}))
    with pytest.raises(ManifestError):
        load_manifest(path)


def test_best_is_cleared_but_still_requires_acknowledgement():
    """BS-Roformer FT1 (anvuew) loads, chunks and separates correctly — see
    NOTICE-separation-models.md. The license was CLEARED 2026-08-28 by the
    project owner on the strength of XLETH's own posture (open source, never
    bundles the weight — see the doc's "Resolution" section), not because
    anvuew ever gave an explicit third-party-use statement the way UVR and
    becruily did. That residual ambiguity is why this stays gated on
    acknowledgement rather than clearing outright like FAST."""
    m = load_manifest()
    assert m.tiers["best"].enabled is True
    spec = m.model_for_tier("best")
    assert spec.id == "bs_roformer_ft1_anvuew"
    assert spec.arch == "bs_roformer"
    assert spec.license.status == LICENSE_CLEARED
    assert spec.license.cleared is True
    assert spec.license.commercial_use is True
    assert spec.license.requires_acknowledgement is True
    assert spec.license.attribution and "anvuew" in spec.license.attribution
    assert_license_cleared(spec)  # must not raise


def test_acknowledgement_is_required_before_the_best_model_runs():
    spec = load_manifest().model_for_tier("best")
    with pytest.raises(LicenseNotAcknowledged) as exc:
        assert_license_acknowledged(spec, acknowledged=False)
    assert "GPL-3.0" in exc.value.prompt
    assert "anvuew" in exc.value.prompt

    assert_license_acknowledged(spec, acknowledged=True)  # must not raise


def test_best_stems_are_primary_plus_residual_like_fast():
    """BS-Roformer FT1 predicts one stem (num_stems=1, target_instrument
    vocals) — the instrumental is the residual, not a second model output.
    It does NOT follow BALANCED's model_outputs convention."""
    spec = load_manifest().model_for_tier("best")
    assert spec.stem_mode == "primary_plus_residual"
    assert spec.stem_names == ["Vocals", "Instrumental"]


def test_best_architecture_constants():
    spec = load_manifest().model_for_tier("best")
    expects = spec.params["expects"]
    assert expects["chunk_size"] == 960_000
    assert expects["stft_hop_length"] == 512
    assert expects["num_overlap"] == 4


def test_the_fixed_cost_of_a_run_is_modelled_not_ignored():
    """Both architectures pad the input with reflected audio and run the model
    on it — 13 s of it for BALANCED, two whole extra chunks. On a 5-second
    sample that padding IS the job, and a pure per-second rate says the run
    takes 15 s when it takes 55."""
    balanced = load_manifest().model_for_tier("balanced")
    assert balanced.fixed_seconds("cpu") == pytest.approx(46.2)

    # 32.31 s input, measured end to end at 160.8 s on this CPU through the
    # ONNX path (it was 141.0 s under torch; the move off torch cost ~14%).
    #
    # BENCHMARK THIS ON AN IDLE MACHINE. The same measurement taken while two
    # other jobs were running read 357.5 s and sent an afternoon chasing a
    # phantom 2.5x regression. Both of this file's speed figures have been
    # wrong that way once.
    assert balanced.estimated_seconds(32.31, "cpu") == pytest.approx(160.8, rel=0.05)
    # Without the fixed term the same estimate is out by a third.
    marginal_only = 32.31 * balanced.seconds_per_second("cpu")
    assert marginal_only < 0.75 * 160.8


def test_the_fixed_cost_dominates_a_short_sample_and_fades_on_a_long_one():
    """Which is why it is a separate term and not folded into the rate."""
    balanced = load_manifest().model_for_tier("balanced")
    short = balanced.effective_seconds_per_second(5.0, "cpu")
    long = balanced.effective_seconds_per_second(600.0, "cpu")
    assert short > 3 * long, "a five-second sample must not be quoted a ten-minute rate"
    # On a short sample the padding IS the job.
    assert balanced.fixed_seconds("cpu") > 0.7 * balanced.estimated_seconds(5.0, "cpu")
    # However long the input, the rate can never fall below the marginal one.
    assert long > balanced.seconds_per_second("cpu")


def test_the_fast_tier_does_not_double_count_its_padding():
    """MDX-Net's padding is a single 5.75 s chunk, and the 18 s input its
    figures were measured on already carried it. A fixed term here would bill
    for it twice."""
    fast = load_manifest().model_for_tier("fast")
    assert fast.fixed_seconds("cpu") == 0.0
    assert fast.estimated_seconds(18.0, "cpu") == pytest.approx(18.0 * 0.33)


def test_a_zero_length_input_still_yields_a_usable_rate():
    """Guard against a division by zero on the path where the renderer did not
    send a duration."""
    balanced = load_manifest().model_for_tier("balanced")
    assert balanced.effective_seconds_per_second(0.0, "cpu") > 0
