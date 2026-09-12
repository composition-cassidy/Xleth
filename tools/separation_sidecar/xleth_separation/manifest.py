"""Model manifest — load, validate, and enforce the license gate.

The manifest (models.json, next to this file) is the ONLY place a model's
download URLs, checksums and architecture constants are written down. Nothing
here reaches the network; see store.py for that.

Two things make this module more than a json.load.

**The license gate.** Every model carries `license.status`, and a model whose
status is not in CLEARED_STATUSES is refused by /separate. A PENDING-AUDIT
weight is one nobody has cleared for use yet, and running it anyway would make
the flag a comment rather than a control.

**The acknowledgement gate.** A weight can be cleared to run and still carry a
condition the person running it has to be told about — the BALANCED tier's
Mel-Band RoFormer is CC BY-NC 4.0, so it is cleared for non-commercial use and
for nothing else. Those models set `license.requires_acknowledgement`, and
/separate refuses them until the caller passes the acknowledgement explicitly.
Burying that in a README would make the condition something we technically
disclosed rather than something the user actually agreed to.

**Multi-file models.** MDX-Net ships one self-describing .onnx. Mel-Band
RoFormer ships a .ckpt of raw tensors plus a YAML that says what shape they go
in — and getting that YAML wrong does not error, it quietly separates worse.
So a model is a LIST of files, each with its own role, URL and checksum, and
the config travels with the weight instead of being paraphrased into this file.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

MANIFEST_PATH = Path(__file__).with_name("models.json")

# Statuses that permit inference. Anything else — PENDING-AUDIT, REJECTED, a
# typo — is refused, so an unreviewed weight fails closed.
#
# CLEARED-NONCOMMERCIAL is a real clearance, not a softer one: the audit is
# closed and the answer is "yes, for non-commercial use". What makes it
# different is that it always comes with requires_acknowledgement, so the
# condition reaches the user rather than only the audit record.
LICENSE_CLEARED = "CLEARED"
LICENSE_CLEARED_NONCOMMERCIAL = "CLEARED-NONCOMMERCIAL"
CLEARED_STATUSES = frozenset({LICENSE_CLEARED, LICENSE_CLEARED_NONCOMMERCIAL})

SUPPORTED_ARCHS = {"mdx_net", "mel_band_roformer", "bs_roformer"}

# Architecture constants that must be present in `params` for each arch.
#
# MDX-Net's are in the manifest because its .onnx does not carry them: dim_f
# and dim_t can be read back off the graph, but n_fft and hop cannot, and a
# wrong n_fft produces a quietly worse separation rather than an error.
#
# Mel-Band RoFormer's live in the model's OWN yaml, which we download and
# checksum alongside the weight. What stays here is a small `expects` block
# cross-checked against that yaml at load — see roformer.py. Requiring the
# real constants here as well would mean two sources of truth for numbers that
# must agree, and the yaml would still be the one the model was trained with.
REQUIRED_PARAMS = {
    "mdx_net": ("dim_f", "dim_t", "dim_c", "n_fft", "hop"),
    "mel_band_roformer": (),
    "bs_roformer": (),
}

# How a model's stems are produced. This is not cosmetic — it changes what the
# user gets.
#
#   primary_plus_residual  the model predicts ONE source and the other stem is
#                          mix-minus-that. The two sum back to the input
#                          exactly, which is a property worth having when both
#                          land as layers in the Sandbox.
#   model_outputs          the model predicts every stem itself. Usually the
#                          better separation, but the stems do NOT sum to the
#                          mix: each is an independent estimate, so their
#                          errors do not cancel.
STEM_MODE_RESIDUAL = "primary_plus_residual"
STEM_MODE_OUTPUTS = "model_outputs"
STEM_MODES = frozenset({STEM_MODE_RESIDUAL, STEM_MODE_OUTPUTS})


class ManifestError(RuntimeError):
    """The manifest itself is malformed. A programming/packaging bug."""


class LicenseNotCleared(RuntimeError):
    """A model was requested whose license audit has not been closed."""

    def __init__(self, model_id: str, status: str):
        self.model_id = model_id
        self.status = status
        super().__init__(
            f"model '{model_id}' has license status '{status}' — refusing to run it. "
            f"Close the audit and set license.status to one of "
            f"{sorted(CLEARED_STATUSES)} in models.json."
        )


class LicenseNotAcknowledged(RuntimeError):
    """A model was requested whose license condition the caller has not accepted.

    Distinct from LicenseNotCleared on purpose. Not-cleared is our problem and
    the user can do nothing about it; not-acknowledged is a question we owe the
    user, and the UI can answer it by asking them.
    """

    def __init__(self, model_id: str, prompt: str):
        self.model_id = model_id
        self.prompt = prompt
        super().__init__(prompt)


@dataclass(frozen=True)
class ModelFile:
    """One downloadable artefact belonging to a model.

    `role` is what the code asks for it by — "weights", "config". It is the
    stable name; `name` is just what it is called on disk and upstream.
    """

    role: str
    name: str
    url: str
    sha256: str
    size_bytes: int = 0
    description: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "role": self.role,
            "name": self.name,
            "sha256": self.sha256,
            "sizeBytes": self.size_bytes,
            "description": self.description,
        }


@dataclass(frozen=True)
class ModelLicense:
    status: str
    spdx: Optional[str] = None
    holder: Optional[str] = None
    model_author: Optional[str] = None
    source: Optional[str] = None
    license_url: Optional[str] = None
    attribution: Optional[str] = None
    audited_on: Optional[str] = None
    commercial_use: Optional[bool] = None
    requires_acknowledgement: bool = False
    acknowledgement: Optional[str] = None
    findings: List[str] = field(default_factory=list)

    @property
    def cleared(self) -> bool:
        return self.status in CLEARED_STATUSES

    def to_dict(self) -> Dict[str, Any]:
        return {
            "status": self.status,
            "cleared": self.cleared,
            "spdx": self.spdx,
            "holder": self.holder,
            "modelAuthor": self.model_author,
            "source": self.source,
            "licenseUrl": self.license_url,
            "attribution": self.attribution,
            "auditedOn": self.audited_on,
            "commercialUse": self.commercial_use,
            "requiresAcknowledgement": self.requires_acknowledgement,
            "acknowledgement": self.acknowledgement,
            "findings": list(self.findings),
        }


@dataclass(frozen=True)
class ModelSpec:
    id: str
    tier: str
    name: str
    arch: str
    files: List[ModelFile]
    sample_rate: int
    params: Dict[str, Any]
    stems: Dict[str, Any]
    speed: Dict[str, Any]
    license: ModelLicense
    notes: List[str] = field(default_factory=list)

    # ── Files ────────────────────────────────────────────────────────────

    def file(self, role: str) -> ModelFile:
        for f in self.files:
            if f.role == role:
                return f
        raise ManifestError(f"model '{self.id}' has no file with role '{role}'")

    def has_file(self, role: str) -> bool:
        return any(f.role == role for f in self.files)

    @property
    def weights(self) -> ModelFile:
        return self.file("weights")

    @property
    def total_bytes(self) -> int:
        return sum(f.size_bytes for f in self.files)

    # ── Stems ────────────────────────────────────────────────────────────

    @property
    def stem_mode(self) -> str:
        return str(self.stems.get("mode", STEM_MODE_RESIDUAL))

    @property
    def stem_names(self) -> List[str]:
        """Stems this model produces, in output order.

        For a residual model that is [primary, secondary]; for a multi-output
        one it is whatever the model was trained to emit, and roformer.py
        cross-checks that list against the yaml's own `training.instruments`.
        """
        if self.stem_mode == STEM_MODE_OUTPUTS:
            return [str(n) for n in self.stems.get("names", [])]
        return [str(self.stems["primary"]), str(self.stems.get("secondary", "Residual"))]

    # ── Timing ───────────────────────────────────────────────────────────

    def seconds_per_second(self, device: str) -> float:
        """Marginal wall-clock seconds per second of audio on `device`.

        Per MODEL, not per tier or per project: the BALANCED tier's RoFormer
        measures 3.09 s/s on the same CPU where the FAST tier's MDX measures
        0.33. Seeding one from the other would promise a three-minute song in
        one minute and deliver nine.

        This is the MARGINAL rate — what each additional second of input
        costs. See fixed_seconds for the part that does not scale.
        """
        value = self.speed.get(device)
        if isinstance(value, (int, float)):
            return float(value)
        fallback = self.speed.get("cpu")
        return float(fallback) if isinstance(fallback, (int, float)) else 1.0

    def fixed_seconds(self, device: str) -> float:
        """Wall-clock that a run costs regardless of how long the input is.

        Real, and on the BALANCED tier it is large. Both architectures pad the
        input with reflected audio at each end, and the model processes that
        padding: 13 s of it for a Mel-Band RoFormer chunk, which is two whole
        extra chunks — 40 s of CPU inference that a 5-second sample pays in
        full. Measured end to end: a 32 s input took 141 s where the marginal
        rate alone predicts 100.

        Without this term the estimate is right only for long inputs and wildly
        optimistic for short ones, and short is what a Sample Sandbox mostly
        holds.
        """
        fixed = self.speed.get("fixed", {})
        if isinstance(fixed, dict):
            value = fixed.get(device, fixed.get("cpu"))
            if isinstance(value, (int, float)):
                return float(value)
        return 0.0

    def estimated_seconds(self, duration_sec: float, device: str) -> float:
        """Total wall clock for `duration_sec` of audio on `device`."""
        return self.fixed_seconds(device) + max(0.0, duration_sec) * self.seconds_per_second(device)

    def effective_seconds_per_second(self, duration_sec: float, device: str) -> float:
        """`estimated_seconds` expressed as a rate, for a job of this length.

        The ETA is a rate times the audio remaining, so the fixed cost has to
        be folded into the rate to reach it. Doing it here rather than in
        jobs.py keeps the ETA arithmetic identical to the measured case — a
        measured rate is also just wall clock over audio.
        """
        if duration_sec <= 0:
            return self.seconds_per_second(device)
        return self.estimated_seconds(duration_sec, device) / duration_sec

    def speed_is_measured(self, device: str) -> bool:
        """Whether `speed[device]` came from a stopwatch or from arithmetic.

        The manifest records which. An estimate that has never been run is
        still worth having as an ETA seed, but calling it a measurement when
        it is not is the kind of small lie this whole module exists to avoid.
        """
        measured = self.speed.get("measured")
        return bool(isinstance(measured, dict) and measured.get(device))

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "tier": self.tier,
            "name": self.name,
            "arch": self.arch,
            "files": [f.to_dict() for f in self.files],
            "sizeBytes": self.total_bytes,
            "sampleRate": self.sample_rate,
            "stems": dict(self.stems),
            "stemNames": self.stem_names,
            "speed": {k: v for k, v in self.speed.items() if not k.startswith("_")},
            "notes": list(self.notes),
            "license": self.license.to_dict(),
        }


@dataclass(frozen=True)
class TierSpec:
    id: str
    label: str
    model_id: Optional[str]
    enabled: bool
    order: int = 0
    hint: Optional[str] = None
    planned: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "modelId": self.model_id,
            "enabled": self.enabled,
            "order": self.order,
            "hint": self.hint,
            "planned": self.planned,
        }


@dataclass(frozen=True)
class Manifest:
    manifest_version: int
    store_version: str
    models: Dict[str, ModelSpec]
    tiers: Dict[str, TierSpec]

    def model(self, model_id: str) -> ModelSpec:
        try:
            return self.models[model_id]
        except KeyError:
            raise ManifestError(f"unknown model id '{model_id}'") from None

    def model_for_tier(self, tier_id: str) -> ModelSpec:
        tier = self.tiers.get(tier_id)
        if tier is None:
            raise ManifestError(f"unknown tier '{tier_id}'")
        if not tier.enabled or not tier.model_id:
            raise ManifestError(
                f"tier '{tier_id}' is not wired yet"
                + (f" ({tier.planned})" if tier.planned else "")
            )
        return self.model(tier.model_id)

    def to_dict(self) -> Dict[str, Any]:
        ordered = sorted(self.tiers.values(), key=lambda t: (t.order, t.id))
        return {
            "manifestVersion": self.manifest_version,
            "storeVersion": self.store_version,
            "models": [m.to_dict() for m in self.models.values()],
            "tiers": [t.to_dict() for t in ordered],
        }


def _require(obj: Dict[str, Any], key: str, where: str) -> Any:
    if key not in obj:
        raise ManifestError(f"{where}: missing required key '{key}'")
    return obj[key]


def _parse_sha(raw: Any, where: str) -> str:
    sha = str(raw).lower()
    if len(sha) != 64 or any(c not in "0123456789abcdef" for c in sha):
        raise ManifestError(f"{where}: sha256 is not 64 hex characters")
    return sha


def _parse_files(raw: Dict[str, Any], where: str) -> List[ModelFile]:
    """Read the `files` list.

    A model with no file of role 'weights' is a manifest bug, not a model with
    an unusual layout — everything downstream asks for that role by name.
    """
    entries = _require(raw, "files", where)
    if not isinstance(entries, list) or not entries:
        raise ManifestError(f"{where}: 'files' must be a non-empty list")

    files: List[ModelFile] = []
    seen_roles = set()
    for entry in entries:
        role = str(_require(entry, "role", where + " file"))
        if role in seen_roles:
            raise ManifestError(f"{where}: duplicate file role '{role}'")
        seen_roles.add(role)
        files.append(ModelFile(
            role=role,
            name=str(_require(entry, "name", where + f" file '{role}'")),
            url=str(_require(entry, "url", where + f" file '{role}'")),
            sha256=_parse_sha(_require(entry, "sha256", where + f" file '{role}'"),
                              where + f" file '{role}'"),
            size_bytes=int(entry.get("size_bytes", 0)),
            description=entry.get("description"),
        ))

    if "weights" not in seen_roles:
        raise ManifestError(f"{where}: no file with role 'weights'")
    return files


def _parse_stems(raw: Dict[str, Any], where: str) -> Dict[str, Any]:
    stems = dict(_require(raw, "stems", where))
    mode = str(stems.get("mode", STEM_MODE_RESIDUAL))
    if mode not in STEM_MODES:
        raise ManifestError(f"{where}: unknown stems.mode '{mode}'")
    stems["mode"] = mode

    if mode == STEM_MODE_RESIDUAL:
        if "primary" not in stems:
            raise ManifestError(f"{where}: stems.primary is required for mode '{mode}'")
    else:
        names = stems.get("names")
        if not isinstance(names, list) or not names:
            raise ManifestError(f"{where}: stems.names is required for mode '{mode}'")
    return stems


def _parse_license(raw: Dict[str, Any], where: str) -> ModelLicense:
    lic_raw = _require(raw, "license", where)
    status = str(_require(lic_raw, "status", where + " license"))
    requires_ack = bool(lic_raw.get("requires_acknowledgement", False))
    acknowledgement = lic_raw.get("acknowledgement")

    # A model that demands acknowledgement with nothing to acknowledge would
    # give the UI a gate and no text to put in it — a dialog that asks the user
    # to accept the empty string.
    if requires_ack and not acknowledgement:
        raise ManifestError(
            f"{where}: license.requires_acknowledgement is set but "
            "license.acknowledgement is empty — there is nothing to show the user")

    # NonCommercial clearance without the acknowledgement gate would put the
    # only statement of the condition in a JSON file the user never opens.
    if status == LICENSE_CLEARED_NONCOMMERCIAL and not requires_ack:
        raise ManifestError(
            f"{where}: status '{LICENSE_CLEARED_NONCOMMERCIAL}' requires "
            "license.requires_acknowledgement — a condition the user is never "
            "shown is not a condition they agreed to")

    return ModelLicense(
        status=status,
        spdx=lic_raw.get("spdx"),
        holder=lic_raw.get("holder"),
        model_author=lic_raw.get("model_author"),
        source=lic_raw.get("source"),
        license_url=lic_raw.get("license_url"),
        attribution=lic_raw.get("attribution"),
        audited_on=lic_raw.get("audited_on"),
        commercial_use=lic_raw.get("commercial_use"),
        requires_acknowledgement=requires_ack,
        acknowledgement=acknowledgement,
        findings=list(lic_raw.get("findings", [])),
    )


def _parse_model(raw: Dict[str, Any]) -> ModelSpec:
    where = f"model '{raw.get('id', '<no id>')}'"
    arch = _require(raw, "arch", where)
    if arch not in SUPPORTED_ARCHS:
        raise ManifestError(f"{where}: unsupported arch '{arch}'")

    params = dict(raw.get("params", {}))
    for key in REQUIRED_PARAMS.get(arch, ()):  # per-arch: see REQUIRED_PARAMS
        if key not in params:
            raise ManifestError(f"{where}: params missing '{key}'")

    speed = {k: v for k, v in raw.get("speed", {}).items()}

    return ModelSpec(
        id=str(_require(raw, "id", where)),
        tier=str(raw.get("tier", "")),
        name=str(_require(raw, "name", where)),
        arch=arch,
        files=_parse_files(raw, where),
        sample_rate=int(raw.get("sample_rate", 44100)),
        params=params,
        stems=_parse_stems(raw, where),
        speed=speed,
        license=_parse_license(raw, where),
        notes=list(raw.get("notes", [])),
    )


def load_manifest(path: Path | str = MANIFEST_PATH) -> Manifest:
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ManifestError(f"manifest not found at {path}") from None
    except json.JSONDecodeError as exc:
        raise ManifestError(f"manifest at {path} is not valid JSON: {exc}") from None

    models: Dict[str, ModelSpec] = {}
    for entry in raw.get("models", []):
        spec = _parse_model(entry)
        if spec.id in models:
            raise ManifestError(f"duplicate model id '{spec.id}'")
        models[spec.id] = spec

    tiers: Dict[str, TierSpec] = {}
    for order, (tier_id, entry) in enumerate(raw.get("tiers", {}).items()):
        model_id = entry.get("model_id")
        enabled = bool(entry.get("enabled", False))
        if enabled and model_id not in models:
            raise ManifestError(
                f"tier '{tier_id}' is enabled but its model_id '{model_id}' is not in the manifest")
        tiers[tier_id] = TierSpec(
            id=tier_id,
            label=str(entry.get("label", tier_id.upper())),
            model_id=model_id,
            enabled=enabled,
            order=int(entry.get("order", order)),
            hint=entry.get("hint"),
            planned=entry.get("planned"),
        )

    if not models:
        raise ManifestError("manifest lists no models")

    return Manifest(
        manifest_version=int(raw.get("manifest_version", 1)),
        store_version=str(raw.get("store_version", "v1")),
        models=models,
        tiers=tiers,
    )


def assert_license_cleared(spec: ModelSpec) -> None:
    """Raise unless `spec`'s audit is closed. Called before every download and
    before every inference — the two places where an uncleared weight would
    actually be used."""
    if not spec.license.cleared:
        raise LicenseNotCleared(spec.id, spec.license.status)


def assert_license_acknowledged(spec: ModelSpec, acknowledged: bool) -> None:
    """Raise unless the caller has accepted `spec`'s licence condition.

    Checked at the HTTP door rather than deep in the pipeline: the point is to
    ask BEFORE spending 435 MB and several minutes, and a question asked after
    the work is done is not a condition, it is a receipt.
    """
    if spec.license.requires_acknowledgement and not acknowledged:
        raise LicenseNotAcknowledged(spec.id, spec.license.acknowledgement or (
            f"model '{spec.id}' requires the user to accept its licence terms"))
