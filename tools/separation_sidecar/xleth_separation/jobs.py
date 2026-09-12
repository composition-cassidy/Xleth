"""Job registry — one separation run, its progress, and its cancel switch.

A job runs on a worker thread and is polled over HTTP. That shape (poll, not
stream) is deliberate: it matches how every other long operation in XLETH
reports itself (audio/video export both poll at 100 ms from the Electron main
process), so the sidecar needs no special client and survives a renderer
reload without losing the run.

Honest progress is the requirement this module exists to meet. "Honest" here
means three specific things:

  1. The download is INSIDE the progress, not a silent stall before it. A
     first run on a cold store spends most of its wall clock fetching 65 MB,
     and a bar that sits at 0% for that whole time is a lie by omission.
  2. The ETA starts from a per-device estimate in the manifest and is REPLACED
     by measured throughput as soon as there is any. A machine we have never
     profiled converges within a couple of chunks instead of being wrong for
     the whole run.
  3. Cancellation is checked between chunks and between download blocks, so
     "Cancel" means the job stops now, not when the current stage finishes.
"""

from __future__ import annotations

import threading
import time
import traceback
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

# ── Phase weighting ─────────────────────────────────────────────────────────
#
# Phases are laid out as (start, end) spans of the overall 0..1 progress. The
# spans used to be two hardcoded tables, and the cold one gave the download
# 35%. That number was fitted to the FAST tier: a 66 MB weight in front of a
# CPU separation running at 0.33x realtime.
#
# The BALANCED tier broke it in both directions at once — 435 MB to fetch
# (6.6x the bytes) and 3.09x realtime to run (9x the compute). A constant
# cannot be right for both, and being wrong here is not cosmetic: a bar that
# sits at 35% through nine minutes of inference is the same lie as one that
# sits at 0% through a five-minute download.
#
# So the spans are DERIVED, from each phase's estimated cost in seconds, using
# the model's own manifest figures. The bar then means what a progress bar
# should mean: the fraction of estimated wall clock that is behind you. Every
# input is either a measured constant, a manifest figure, or replaced by live
# measurement as the job runs — and when the inputs are not known yet, the old
# fixed tables are used instead of inventing them.
#
# These three are throughput floors, not guesses about the machine. Hashing and
# reading a model off disk vary by maybe 2x across the hardware this runs on,
# which moves a span by a percent or two; the download rate varies by a hundred
# times, which is exactly why it is replaced by measurement the moment the
# first megabyte lands (observe_download_rate).
HASH_BYTES_PER_SEC = 400 * 1024 * 1024      # sha256 over a warm page cache
LOAD_BYTES_PER_SEC = 300 * 1024 * 1024      # deserialise + build the graph
DEFAULT_DOWNLOAD_BYTES_PER_SEC = 8 * 1024 * 1024   # seed only; measured over

# Writing stems is proportional to the audio, and cheap: a float WAV per stem.
WRITE_SECONDS_PER_AUDIO_SECOND = 0.01

PHASE_ORDER = ("downloading", "verifying", "loading", "separating", "writing")

# Fallbacks, used only when there is not enough known to derive anything —
# principally a job whose input duration nobody told us. These are the tables
# that used to be unconditional.
PHASE_SPANS_COLD = {
    "queued": (0.00, 0.00),
    "downloading": (0.00, 0.35),
    "verifying": (0.35, 0.40),
    "loading": (0.40, 0.45),
    "separating": (0.45, 0.95),
    "writing": (0.95, 1.00),
}

PHASE_SPANS_WARM = {
    "queued": (0.00, 0.00),
    "downloading": (0.00, 0.00),
    "verifying": (0.00, 0.02),
    "loading": (0.02, 0.06),
    "separating": (0.06, 0.95),
    "writing": (0.95, 1.00),
}

TERMINAL_STATES = {"done", "cancelled", "error"}


def spans_from_costs(costs: Dict[str, float]) -> Dict[str, tuple]:
    """Turn per-phase estimated seconds into cumulative 0..1 spans.

    A phase costing nothing (no download on a warm store) gets a zero-width
    span rather than being dropped, so `overall` can still look it up.
    """
    total = sum(max(0.0, costs.get(p, 0.0)) for p in PHASE_ORDER)
    if total <= 0:
        return dict(PHASE_SPANS_WARM)
    spans: Dict[str, tuple] = {"queued": (0.0, 0.0)}
    cursor = 0.0
    for phase in PHASE_ORDER:
        width = max(0.0, costs.get(phase, 0.0)) / total
        spans[phase] = (cursor, min(1.0, cursor + width))
        cursor += width
    return spans


@dataclass
class StemResult:
    name: str
    path: str
    sample_rate: int
    duration_sec: float

    def to_dict(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "path": self.path,
            "sampleRate": self.sample_rate,
            "durationSec": self.duration_sec,
        }


@dataclass
class Job:
    id: str
    model_id: str
    tier: str
    input_path: str
    output_dir: str
    label: str = ""

    state: str = "queued"           # queued|running|done|cancelled|error
    phase: str = "queued"
    phase_progress: float = 0.0
    detail: str = ""
    device: str = "cpu"

    created_at: float = field(default_factory=time.time)
    started_at: Optional[float] = None
    finished_at: Optional[float] = None

    # Set once the audio is read, so the ETA has something to scale.
    duration_sec: float = 0.0
    # Wall-seconds per audio-second, seeded from the manifest and replaced by
    # measurement. None until we have either.
    rate_estimate: Optional[float] = None
    measured: bool = False

    stems: List[StemResult] = field(default_factory=list)
    error: Optional[str] = None
    warnings: List[str] = field(default_factory=list)

    cold_store: bool = True
    # Bytes this run has to fetch, and the model's total size on disk. Set by
    # the pipeline from the store's own status, so a store that already holds
    # the 435 MB weight but lost its 1.2 kB config does not budget for 435 MB
    # of downloading it is not going to do.
    download_bytes: int = 0
    model_bytes: int = 0
    stem_count: int = 2
    # Observed download throughput, bytes/sec. None until a download is far
    # enough along to have measured any.
    download_rate: Optional[float] = None

    cancel_event: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _peak: float = 0.0

    # ── Progress ─────────────────────────────────────────────────────────

    def phase_costs(self) -> Optional[Dict[str, float]]:
        """Estimated seconds per phase, or None if too little is known.

        Returns None — rather than a plausible-looking dict — when the input
        duration is unknown, because without it the inference cost is zero and
        the download would swallow the whole bar. The caller falls back to the
        fixed tables, which are at least a shape someone once measured.
        """
        if not self.duration_sec or not self.rate_estimate:
            return None
        rate = self.download_rate or DEFAULT_DOWNLOAD_BYTES_PER_SEC
        return {
            "downloading": self.download_bytes / rate,
            "verifying": self.model_bytes / HASH_BYTES_PER_SEC,
            "loading": 1.0 + self.model_bytes / LOAD_BYTES_PER_SEC,
            "separating": self.duration_sec * self.rate_estimate,
            "writing": self.duration_sec * WRITE_SECONDS_PER_AUDIO_SECOND * self.stem_count,
        }

    @property
    def _spans(self) -> Dict[str, tuple]:
        costs = self.phase_costs()
        if costs is not None:
            return spans_from_costs(costs)
        return PHASE_SPANS_COLD if self.cold_store else PHASE_SPANS_WARM

    @property
    def overall(self) -> float:
        if self.state == "done":
            return 1.0
        lo, hi = self._spans.get(self.phase, (0.0, 0.0))
        value = max(0.0, min(1.0, lo + (hi - lo) * max(0.0, min(1.0, self.phase_progress))))
        # Ratchet. The spans are re-derived from facts that arrive DURING the
        # run — a measured download rate, then measured inference throughput —
        # and a re-derivation can place the current point slightly behind where
        # the last one did. Letting the bar slide backwards would be a worse
        # lie than the small optimism of holding it: a user reads a retreating
        # bar as "something went wrong", not as "the estimate improved". The
        # ETA is a separate number and is free to move in both directions.
        self._peak = max(self._peak, value)
        return self._peak

    def set_phase(self, phase: str, progress: float = 0.0, detail: str = "") -> None:
        with self._lock:
            self.phase = phase
            self.phase_progress = progress
            if detail:
                self.detail = detail

    def set_phase_progress(self, progress: float, detail: str = "") -> None:
        with self._lock:
            self.phase_progress = progress
            if detail:
                self.detail = detail

    def eta_seconds(self) -> Optional[float]:
        """Seconds remaining, or None when there is nothing honest to say.

        Only the separation phase gets an ETA. Download time depends on the
        user's connection, which we would be guessing at; reporting MB/s and
        no ETA is the truthful version of that.
        """
        if self.state in TERMINAL_STATES:
            return None
        if self.phase != "separating" or not self.duration_sec or not self.rate_estimate:
            return None
        remaining_audio = self.duration_sec * (1.0 - max(0.0, min(1.0, self.phase_progress)))
        return max(0.0, remaining_audio * self.rate_estimate)

    def observe_throughput(self, audio_seconds_done: float,
                           since: Optional[float] = None) -> None:
        """Fold real throughput into the ETA. Called as chunks complete.

        `since` defaults to the job's start, but the pipeline passes the
        moment INFERENCE started instead. Including the model download in the
        throughput figure would make the ETA wildly pessimistic on a cold
        first run and then wrong again on every warm one.
        """
        start = since if since is not None else self.started_at
        if not start or audio_seconds_done <= 0:
            return
        elapsed = time.time() - start
        if elapsed <= 0:
            return
        with self._lock:
            self.rate_estimate = elapsed / audio_seconds_done
            self.measured = True

    def observe_download_rate(self, bytes_done: float, since: float) -> None:
        """Fold real download throughput into the phase weighting.

        The one input to the progress split that cannot be estimated from
        hardware — a connection is anywhere from 1 to 100 MB/s — so it is the
        one that gets measured hardest. Ignored below a megabyte: the first
        few blocks are dominated by connection setup, and a rate computed from
        them says more about TLS than about the link.

        This does NOT produce a download ETA. That remains deliberately absent
        (see eta_seconds) — a rate measured over five seconds of a five-minute
        transfer is a fine weight and a bad promise.
        """
        elapsed = time.time() - since
        if elapsed <= 0.5 or bytes_done < 1024 * 1024:
            return
        with self._lock:
            self.download_rate = bytes_done / elapsed

    # ── Serialisation ────────────────────────────────────────────────────

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "state": self.state,
            "phase": self.phase,
            "phaseProgress": round(self.phase_progress, 4),
            "progress": round(self.overall, 4),
            "detail": self.detail,
            "device": self.device,
            "modelId": self.model_id,
            "tier": self.tier,
            "label": self.label,
            "durationSec": round(self.duration_sec, 3),
            "etaSeconds": (round(self.eta_seconds(), 1)
                           if self.eta_seconds() is not None else None),
            "etaMeasured": self.measured,
            # What the ETA is actually built from, so the UI can say "3.1x
            # realtime on cpu" rather than only counting down. On the BALANCED
            # tier that number is the difference between a user waiting and a
            # user assuming the app has hung.
            "secondsPerSecond": (round(self.rate_estimate, 3)
                                 if self.rate_estimate else None),
            "downloadBytes": self.download_bytes,
            "downloadRateBytesPerSec": (round(self.download_rate)
                                        if self.download_rate else None),
            "elapsedSeconds": round(
                (self.finished_at or time.time()) - (self.started_at or self.created_at), 1),
            "stems": [s.to_dict() for s in self.stems],
            "error": self.error,
            "warnings": list(self.warnings),
            "cancelRequested": self.cancel_event.is_set(),
        }


class JobRegistry:
    """Thread-safe job table with a bounded history.

    Finished jobs are kept so a poll that arrives after completion still finds
    the result (and its stem paths) instead of a 404 — the renderer polls on an
    interval and will always land at least one poll after the end.
    """

    def __init__(self, max_history: int = 32):
        self._jobs: Dict[str, Job] = {}
        self._order: List[str] = []
        self._max_history = max_history
        self._lock = threading.Lock()

    def create(self, **kwargs: Any) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], **kwargs)
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            self._evict_locked()
        return job

    def _evict_locked(self) -> None:
        while len(self._order) > self._max_history:
            for i, jid in enumerate(self._order):
                if self._jobs[jid].state in TERMINAL_STATES:
                    self._order.pop(i)
                    self._jobs.pop(jid, None)
                    break
            else:
                # Every retained job is still running — never evict one of
                # those, a running job with no handle is unstoppable.
                return

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> List[Job]:
        with self._lock:
            return [self._jobs[j] for j in self._order if j in self._jobs]

    def active(self) -> List[Job]:
        return [j for j in self.list() if j.state not in TERMINAL_STATES]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job is None or job.state in TERMINAL_STATES:
            return False
        job.cancel_event.set()
        job.detail = "cancelling…"
        return True

    def cancel_all(self) -> int:
        return sum(1 for j in self.active() if self.cancel(j.id))

    def run(self, job: Job, work: Callable[[Job], None]) -> threading.Thread:
        """Start `work(job)` on a daemon thread, translating its outcome into
        job state. Every exit path lands in a terminal state — a job that
        raised and stayed 'running' would hang the UI's poll forever."""

        def _entry() -> None:
            job.started_at = time.time()
            job.state = "running"
            try:
                work(job)
                if job.cancel_event.is_set():
                    job.state = "cancelled"
                    job.detail = "cancelled"
                else:
                    job.state = "done"
                    job.phase = "writing"
                    job.phase_progress = 1.0
                    job.detail = "complete"
            except BaseException as exc:  # noqa: BLE001 — every failure is the job's
                if job.cancel_event.is_set():
                    job.state = "cancelled"
                    job.detail = "cancelled"
                else:
                    job.state = "error"
                    job.error = f"{type(exc).__name__}: {exc}"
                    job.detail = "failed"
                    traceback.print_exc()
            finally:
                job.finished_at = time.time()

        thread = threading.Thread(target=_entry, name=f"separate-{job.id}", daemon=True)
        thread.start()
        return thread
