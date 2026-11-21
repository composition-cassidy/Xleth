"""ENSEMBLE — average the stems of two separately-run models.

Sequential runs, no new model code, no weight merging. Two different
architectures agreeing on the same time-domain sample is real evidence — see
`project_sandbox_p4_2_balanced_melroformer`'s cross-tier correlation check,
which used exactly this property to validate BALANCED's wiring — and
averaging is the simplest way to spend that agreement: no parallel-run
complexity, no fourth architecture-specific code path, just two ordinary
separate() calls and a mean.

The averaging itself is one small pure function (`average_stems`), kept
separate from the job orchestration in pipeline.py so it is testable with
plain numpy arrays and no model, no torch, no manifest.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np

from .audio_io import _resample


def average_stems(
    a: Dict[str, np.ndarray],
    sr_a: int,
    b: Dict[str, np.ndarray],
    sr_b: int,
) -> Tuple[Dict[str, np.ndarray], List[str]]:
    """Sample-align and average the stems two models have in common.

    Stems present in only one of the two dicts cannot be averaged — passing
    one through unaveraged under an "ensemble" name would misrepresent what
    it is — so they are reported as `dropped` instead of included.

    Alignment is by NAME (both current tiers already agree on "Vocals" /
    "Instrumental"), by SAMPLE RATE (resampled to `a`'s rate if they differ —
    arbitrary but consistent, and a no-op today since every wired model runs
    at 44100), and by LENGTH (trimmed to the shorter of the two — a real
    difference of a handful of samples can come from two models' own
    edge-padding trims disagreeing by less than one hop).
    """
    common = [name for name in a if name in b]
    dropped = [name for name in a if name not in b] + [name for name in b if name not in a]

    averaged: Dict[str, np.ndarray] = {}
    for name in common:
        xa = np.asarray(a[name], dtype=np.float32)
        xb = np.asarray(b[name], dtype=np.float32)
        if sr_b != sr_a:
            xb = _resample(xb, sr_b, sr_a)
        n = min(xa.shape[-1], xb.shape[-1])
        averaged[name] = ((xa[..., :n] + xb[..., :n]) * 0.5).astype(np.float32)

    return averaged, dropped
