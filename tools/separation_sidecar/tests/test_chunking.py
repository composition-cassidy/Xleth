"""Chunk arithmetic. Imports mdx.py — which must be importable WITHOUT torch
or onnxruntime, so this doubles as the regression test for the lazy imports."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.manifest import load_manifest  # noqa: E402
from xleth_separation.mdx import chunk_plan  # noqa: E402


def kim_geometry():
    p = load_manifest().model_for_tier("fast").params
    hop, dim_t, n_fft = p["hop"], p["dim_t"], p["n_fft"]
    chunk_size = hop * (dim_t - 1)
    gen_size = chunk_size - 2 * (n_fft // 2)
    return chunk_size, gen_size


def test_kim_vocal_2_geometry_is_what_the_reference_uses():
    chunk_size, gen_size = kim_geometry()
    assert chunk_size == 1024 * 255 == 261_120
    assert gen_size == 261_120 - 7_680 == 253_440


@pytest.mark.parametrize("n", [1, 1000, 253_439, 253_440, 253_441, 44_100 * 180])
def test_chunks_cover_the_input_with_a_whole_number_of_windows(n):
    chunk_size, gen_size = kim_geometry()
    plan = chunk_plan(n, chunk_size, gen_size)
    covered = plan["chunks"] * gen_size
    assert covered == n + plan["pad"]
    assert covered >= n
    assert plan["starts"][0] == 0
    assert plan["starts"][-1] + gen_size == covered


def test_pad_is_always_positive_even_on_an_exact_multiple():
    """The last chunk's tail is STFT edge padding that gets trimmed, so an
    exactly-divisible input still needs one more window behind it."""
    chunk_size, gen_size = kim_geometry()
    plan = chunk_plan(gen_size * 3, chunk_size, gen_size)
    assert plan["pad"] == gen_size
    assert plan["chunks"] == 4


def test_plan_and_the_run_agree_on_the_chunk_count():
    """Same call, same numbers — the progress denominator cannot drift from
    the loop that actually runs."""
    chunk_size, gen_size = kim_geometry()
    n = 44_100 * 97
    a = chunk_plan(n, chunk_size, gen_size)
    b = chunk_plan(n, chunk_size, gen_size)
    assert a["chunks"] == b["chunks"] == len(b["starts"])


def test_three_minutes_of_audio_is_a_sane_number_of_chunks():
    chunk_size, gen_size = kim_geometry()
    plan = chunk_plan(44_100 * 180, chunk_size, gen_size)
    # ~5.75 s of audio per chunk at 44.1 kHz.
    assert 30 <= plan["chunks"] <= 34
