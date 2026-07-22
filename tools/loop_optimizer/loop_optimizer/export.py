"""``candidates.json`` — the arm set the blind A/B rater auditions.

The report answers "does the metric suite agree with the human?" numerically.
On 19 of the 26 corpus samples the top candidate beats gold on tuning and on
every seam metric at once, which is either a real result or a sign that the
metrics measure something the ear does not care about. Only listening settles
that, so this module writes the arms out in a form Loop Lab can load and play
through the real sampler.

Three provenances per sample:

``optimizer``
    The top-K candidates, in rank order, exactly as the report ranks them.
``gold``
    The human-authored loop, unmodified.
``naive``
    A deliberately period-UNALIGNED loop inside the gold region, with
    ``xfade = len/8``. The anchor: a rater who cannot hear it lose to gold is
    not hearing loop quality, and every optimizer-vs-gold verdict in the same
    session should be read with that in mind.

Loop points are written in the FILE sample domain, matching ``gold_loop`` in
dataset.json and the WAV that ships beside it. Everything measured here happens
in the engine domain; :meth:`IngestedSample.engine_to_file` is the only thing
that crosses between the two, exactly as ``convertGold`` does on the export
side (ui/electron-main/loopLabExport.js). A loop therefore makes one rounding
trip engine -> file -> engine before it is heard, worth at most a sample either
way at 44.1k -> 48k, which is well under the tolerances every metric here is
quoted to.

The naive arm is derived deterministically — its "arbitrary" start comes from a
stable hash of the sample id, not from an RNG — so re-running ``export`` on the
same corpus reproduces the same file byte for byte.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

from .analysis import METRIC_NAMES, SampleResult
from .corpus import GoldLoop
from .engine_emu import LoopConfig, resolve
from .ingest import IngestedSample
from .perceptual import (
    PerceptualMetrics,
    _filterbank_for,
    measure_perceptual,
    source_reference,
)

#: Naive crossfade width, as a fraction of the loop length. Chosen by the task
#: brief, not by measurement: it is what an implementation that never thought
#: about periods would reach for.
NAIVE_XFADE_DIVISOR = 8

#: The naive loop starts this far into the gold region and ends this far short
#: of its end, as fractions of the region. Ranges, not constants: the exact
#: value is drawn per sample from a hash of the sample id so the baseline is not
#: one hand-picked offset applied to the whole corpus.
NAIVE_HEAD_FRAC = (0.10, 0.30)
NAIVE_TAIL_FRAC = (0.05, 0.15)

#: How far from a whole period multiple the naive length must land, in periods.
#: A length that happens to be period-aligned would make the anchor a decent
#: loop and defeat its purpose.
NAIVE_MIN_PHASE_ERROR = 0.15


def _stable_frac(key: str, salt: str) -> float:
    """FNV-1a over ``salt + key``, mapped to [0, 1). Deterministic across runs.

    Python's ``hash()`` is salted per process and would make the naive arm move
    between runs, so the hash is spelled out here.
    """
    h = 2166136261
    for byte in f"{salt}\x00{key}".encode("utf-8"):
        h = ((h ^ byte) * 16777619) & 0xFFFFFFFF
    return h / 4294967296.0


def _lerp_frac(key: str, salt: str, lo: float, hi: float) -> float:
    return lo + (hi - lo) * _stable_frac(key, salt)


def _six_metrics(metrics: PerceptualMetrics) -> dict[str, float]:
    """Just the headline metrics. The sub-terms and context are not metrics."""
    return {name: getattr(metrics, name) for name in METRIC_NAMES}


def _to_file_loop(sample: IngestedSample, cfg: LoopConfig) -> dict[str, int]:
    """Engine-domain :class:`LoopConfig` -> FILE-domain ``{start, end, xfade}``."""
    n = sample.file_num_frames
    conv = lambda v: int(round(sample.engine_to_file(v)))  # noqa: E731
    return {
        "start": max(0, min(n, conv(cfg.loop_start))),
        "end": max(0, min(n, conv(cfg.loop_end))),
        "xfade": max(0, conv(cfg.crossfade_samples)),
    }


def _arm(
    sample: IngestedSample,
    arm_id: str,
    provenance: str,
    cfg: LoopConfig,
    metrics: PerceptualMetrics,
    eff_xfade: int,
    rank: int | None = None,
) -> dict[str, Any]:
    return {
        "arm_id": arm_id,
        "provenance": provenance,
        "rank": rank,
        # FILE domain — the contract with dataset.json and with the rater.
        "loop": _to_file_loop(sample, cfg),
        # Engine domain, informational: what was actually measured. The rater
        # re-derives its own engine-domain values from `loop` and the region's
        # real rate rather than trusting these.
        "loop_engine": {
            "start": cfg.loop_start,
            "end": cfg.loop_end,
            "xfade": cfg.crossfade_samples,
        },
        "metrics": _six_metrics(metrics),
        "engine": {
            # The crossfade the engine's clamp actually applies. Equal to the
            # request for every optimizer candidate by construction; gold and
            # naive are hand-shaped and may well be cut down.
            "eff_xfade": eff_xfade,
            "wrap_advance": metrics.wrap_advance,
            "period_multiple": metrics.period_multiple,
        },
    }


def naive_loop(
    sample_id: str,
    gold: GoldLoop,
    period: float,
    num_samples: int,
) -> LoopConfig | None:
    """Build the period-UNALIGNED anchor loop inside ``gold`` (engine domain).

    Returns ``None`` when the gold region is too short to fit a loop that is
    both inside it and unmistakably off-period — better no anchor than one whose
    badness comes from being three periods long rather than from misalignment.
    """
    region = gold.end - gold.start
    if not (math.isfinite(period) and period > 1.0) or region < 6 * period:
        return None

    head = int(round(_lerp_frac(sample_id, "naive-head", *NAIVE_HEAD_FRAC) * region))
    tail = int(round(_lerp_frac(sample_id, "naive-tail", *NAIVE_TAIL_FRAC) * region))
    start = gold.start + head
    end = gold.end - tail

    # Force the length off-period. `phase` is how far the length sits from the
    # nearest whole multiple, in periods; nudging `end` by half a period moves a
    # near-aligned length to maximally misaligned without leaving the region
    # (the tail margin above is at least 0.05 * region >= 0.3 periods of room).
    length = end - start
    phase = abs(length / period - round(length / period))
    if phase < NAIVE_MIN_PHASE_ERROR:
        end = min(gold.end, end + int(round(0.5 * period)))
        length = end - start

    if length < 2 * period or end > num_samples or start < 0:
        return None
    return LoopConfig(
        loop_start=start,
        loop_end=end,
        crossfade_samples=length // NAIVE_XFADE_DIVISOR,
    )


def build_sample_payload(result: SampleResult, top_k: int) -> dict[str, Any]:
    """One sample's entry in candidates.json: its arms plus the context to read them."""
    sample = result.sample
    notes = list(result.notes)
    arms: list[dict[str, Any]] = []

    for rank, sc in enumerate(result.ranked[: max(0, top_k)], start=1):
        arms.append(
            _arm(
                sample,
                arm_id=f"optimizer_{rank}",
                provenance="optimizer",
                cfg=sc.candidate.to_config(),
                metrics=sc.metrics,
                eff_xfade=sc.eff_xfade,
                rank=rank,
            )
        )
    if not result.ranked:
        notes.append("no optimizer candidate to audition")

    gold_cmp = result.gold
    if gold_cmp is not None:
        gold_engine = gold_cmp.gold_engine
        gold_cfg = LoopConfig(
            loop_start=gold_engine.start,
            loop_end=gold_engine.end,
            crossfade_samples=gold_engine.xfade,
        )
        arms.append(
            _arm(
                sample,
                arm_id="gold",
                provenance="gold",
                cfg=gold_cfg,
                metrics=gold_cmp.gold_metrics,
                eff_xfade=gold_cmp.gold_eff_xfade,
            )
        )

        naive_cfg = naive_loop(
            result.entry.sample_id, gold_engine, result.period, sample.num_samples
        )
        if naive_cfg is None:
            notes.append("gold region too short for a naive anchor; none emitted")
        else:
            naive_eff = resolve(naive_cfg, sample.num_samples, sample.sample_rate)
            fb, n_fft = _filterbank_for(result.period, sample.sample_rate)
            ref = source_reference(sample.x, result.period, sample.sample_rate, fb, n_fft)
            arms.append(
                _arm(
                    sample,
                    arm_id="naive",
                    provenance="naive",
                    cfg=naive_cfg,
                    metrics=measure_perceptual(
                        sample.x, naive_cfg, result.period, sample.sample_rate, ref
                    ),
                    eff_xfade=naive_eff.eff_xfade,
                )
            )
    else:
        notes.append("no gold loop; nothing to compare against and no anchor")

    return {
        "sample_id": result.entry.sample_id,
        "file": str(result.entry.raw.get("file", "")),
        "class": result.entry.sample_class,
        "behavior_family": result.entry.behavior_family,
        "root_note": result.entry.root_note,
        "file_sample_rate": sample.file_sample_rate,
        "file_num_samples": sample.file_num_frames,
        "engine_sample_rate": sample.sample_rate,
        "period_engine": float(result.period) if np.isfinite(result.period) else None,
        "window": {"start": result.window.start, "end": result.window.end},
        "arms": arms,
        "notes": notes,
    }


def build_payload(
    results: list[SampleResult],
    dataset_path,
    selection: str,
    rank_by: str,
    top_k: int,
) -> dict[str, Any]:
    """The whole candidates.json document."""
    return {
        "schema": "xleth.loop-optimizer.candidates/1",
        "dataset": str(dataset_path),
        "selection": selection,
        "rank_by": rank_by,
        "top_k": top_k,
        "metric_names": list(METRIC_NAMES),
        "samples": [build_sample_payload(r, top_k) for r in results],
    }
