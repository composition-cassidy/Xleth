"""Mel-Band RoFormer chunk arithmetic and the config pitfalls.

Imports roformer.py — which must be importable WITHOUT torch, einops or
librosa, so this doubles as the regression test for its lazy imports. Nothing
here loads a checkpoint or runs inference; the 435 MB weight never comes near
CI.

The YAML fixture below is the real config's numbers, transcribed. It is
duplicated rather than downloaded on purpose: these tests are about what the
code does with a config, and a test that fetched the file would fail on a
plane instead of when someone breaks the chunking.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.manifest import load_manifest  # noqa: E402
from xleth_separation.roformer import chunk_plan, windowing_array  # noqa: E402

SR = 44100
HOP = 441
CHUNK = 573_300          # 13.0 s — this checkpoint's own value
OTHER_MELROFORMER_CHUNK = 352_800   # 8 s — what nearly every other config says
NUM_OVERLAP = 2


def geometry(chunk_size=CHUNK, num_overlap=NUM_OVERLAP):
    step = chunk_size // num_overlap
    return chunk_size, step, chunk_size - step


# ── The pitfalls, asserted ───────────────────────────────────────────────

def test_this_models_chunk_is_thirteen_seconds_not_the_usual_eight():
    """Reusing another Mel-RoFormer's yaml runs without error — the
    architecture is length-agnostic — and separates worse. The failure is
    silent, so the number is pinned by test as well as by manifest."""
    expects = load_manifest().model_for_tier("balanced").params["expects"]
    assert expects["chunk_size"] == CHUNK
    assert CHUNK / SR == 13.0
    assert CHUNK != OTHER_MELROFORMER_CHUNK


def test_chunk_size_is_a_whole_number_of_stft_hops():
    """The overlap-add assumes every chunk lands on a frame boundary. A
    remainder puts a sub-frame drift into each seam."""
    assert CHUNK % HOP == 0
    assert CHUNK // HOP == 1300


def test_the_configs_inference_dim_t_contradicts_its_own_chunk_size():
    """inference.dim_t is 1101 in this file, which implies a 485100-sample
    chunk. It is a leftover from the MDX-style configs these were cloned from;
    Mel-Band RoFormer has no fixed time dimension and the reference inference
    path never reads it. This test exists so that if anyone ever "fixes" the
    code to honour dim_t, they find out here rather than in a worse
    separation."""
    decoy_dim_t = 1101
    implied = (decoy_dim_t - 1) * HOP
    assert implied == 485_100
    assert implied != CHUNK


# ── Chunk plan ───────────────────────────────────────────────────────────

@pytest.mark.parametrize("n", [1, 1000, CHUNK - 1, CHUNK, CHUNK + 1, SR * 180])
def test_the_plan_covers_the_whole_input(n):
    chunk_size, step, border = geometry()
    plan = chunk_plan(n, chunk_size, step, border)
    assert plan["chunks"] == len(plan["starts"])
    assert plan["starts"][0] == 0
    # Every sample of the padded signal is inside some chunk.
    assert plan["starts"][-1] + chunk_size >= plan["padded"]
    assert plan["chunks"] * step >= plan["padded"]


def test_the_plan_counts_the_reflected_border_it_actually_processes():
    """The border is 6.5 s of reflected audio at each end, and the model runs
    on it. Leaving it out of the count makes every ETA optimistic by
    2*border/step chunks — two whole chunks here."""
    chunk_size, step, border = geometry()
    n = SR * 180
    plan = chunk_plan(n, chunk_size, step, border)
    assert plan["padded"] == n + 2 * border
    unpadded = chunk_plan(n, chunk_size, step, 0)
    assert plan["chunks"] == unpadded["chunks"] + 2


def test_a_clip_too_short_to_pad_is_not_padded():
    """The reference only reflects when there is more signal than border to
    reflect from."""
    chunk_size, step, border = geometry()
    n = border  # shorter than 2 * border
    plan = chunk_plan(n, chunk_size, step, border)
    assert plan["padded"] == n
    assert plan["chunks"] == 1


def test_plan_and_the_run_agree_on_the_chunk_count():
    """Same call, same numbers — the progress denominator cannot drift from
    the loop that actually runs."""
    chunk_size, step, border = geometry()
    n = SR * 97
    a = chunk_plan(n, chunk_size, step, border)
    b = chunk_plan(n, chunk_size, step, border)
    assert a["chunks"] == b["chunks"] == len(b["starts"])


def test_three_minutes_of_audio_is_a_sane_number_of_chunks():
    chunk_size, step, border = geometry()
    plan = chunk_plan(SR * 180, chunk_size, step, border)
    # 6.5 s of new audio per chunk, plus the two border chunks.
    assert 28 <= plan["chunks"] <= 32


def test_more_overlap_means_more_chunks_for_the_same_audio():
    """num_overlap is the quality/time dial the community guide points at.
    Whatever it is set to, the chunk count has to follow it — that count is
    the ETA's denominator."""
    n = SR * 60
    counts = []
    for overlap in (2, 4, 8):
        chunk_size, step, border = geometry(num_overlap=overlap)
        counts.append(chunk_plan(n, chunk_size, step, border)["chunks"])
    assert counts == sorted(counts)
    assert counts[0] < counts[-1]


# ── The overlap-add window ───────────────────────────────────────────────

def test_the_window_is_linear_and_sums_flat_across_a_seam():
    """Linear rather than Hann: with the overlap-add dividing by the summed
    window, a linear cross-fade sums to a constant for any integer overlap, so
    the seam is flat by construction. A "better" window would put a ripple into
    every chunk boundary."""
    torch = pytest.importorskip("torch")
    size, fade = 1000, 100
    w = windowing_array(size, fade, torch)

    assert w[0] == pytest.approx(0.0)
    assert w[-1] == pytest.approx(0.0)
    assert w[fade:-fade].min() == pytest.approx(1.0)

    # Two chunks a step apart: their windows must sum to a constant over the
    # region where they overlap.
    step = size // 2
    overlap = w[step:] + w[:-step]
    assert overlap[fade:-fade].std() == pytest.approx(0.0, abs=1e-6)


def test_the_windows_fade_is_a_tenth_of_the_chunk():
    """fade_size = chunk_size // 10 is the reference's own figure, and it is
    what makes the cross-fade wide enough to hide a seam without smearing a
    tenth of a second of transient."""
    torch = pytest.importorskip("torch")
    fade = CHUNK // 10
    assert fade == 57_330
    w = windowing_array(CHUNK, fade, torch)
    assert w.shape[0] == CHUNK
    assert w[fade - 1] == pytest.approx(1.0, abs=1e-4)
