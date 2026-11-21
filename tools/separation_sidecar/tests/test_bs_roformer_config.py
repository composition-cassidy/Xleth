"""BS-Roformer (BEST tier) chunk arithmetic — the same regression shape as
test_roformer_config.py, for the same reason: this checkpoint's geometry
differs sharply from BALANCED's (4x overlap instead of 2x, a 16.3 s border
instead of 6.5 s) and a config substitution would run without error and
separate worse, silently.

Imports bs_roformer.py, which must be importable WITHOUT torch, einops or
beartype — it borrows chunk_plan/windowing_array from roformer.py, which
carries that same guarantee. Nothing here loads the 204 MB checkpoint.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from xleth_separation.bs_roformer import chunk_plan  # noqa: E402
from xleth_separation.manifest import load_manifest  # noqa: E402

SR = 44100
HOP = 512                # model.stft_hop_length — NOT audio.hop_length (441, a decoy)
CHUNK = 960_000           # 21.77 s
NUM_OVERLAP = 4           # 4x overlap, not BALANCED's 2x
STEP = CHUNK // NUM_OVERLAP
BORDER = CHUNK - STEP


def test_the_expects_block_matches_the_real_checkpoints_config():
    expects = load_manifest().model_for_tier("best").params["expects"]
    assert expects["chunk_size"] == CHUNK
    assert expects["stft_hop_length"] == HOP
    assert expects["num_overlap"] == NUM_OVERLAP


def test_chunk_size_is_a_whole_number_of_stft_hops():
    assert CHUNK % HOP == 0
    assert CHUNK // HOP == 1875


def test_the_decoy_hop_length_would_fail_the_same_check():
    """audio.hop_length (441) is the same MDX-style leftover BALANCED's
    audio.dim_f/dim_t/n_fft are. If bs_roformer.py ever read it by mistake
    instead of model.stft_hop_length, this is what would break."""
    decoy_hop = 441
    assert CHUNK % decoy_hop != 0


def test_four_times_overlap_means_a_much_wider_border_than_balanced():
    """BALANCED's num_overlap is 2, so border == step (50% new audio per
    chunk). This checkpoint's num_overlap is 4, so border is 3x step — three
    quarters of every chunk is overlap, which is why it costs roughly 4
    chunks of compute per unit of genuinely new audio instead of 2."""
    assert STEP == 240_000
    assert BORDER == 720_000
    assert BORDER == 3 * STEP


@pytest.mark.parametrize("n", [1, 1000, CHUNK - 1, CHUNK, CHUNK + 1, SR * 180])
def test_the_plan_covers_the_whole_input(n):
    plan = chunk_plan(n, CHUNK, STEP, BORDER)
    assert plan["chunks"] == len(plan["starts"])
    assert plan["starts"][0] == 0
    assert plan["starts"][-1] + CHUNK >= plan["padded"]
    assert plan["chunks"] * STEP >= plan["padded"]


def test_padding_does_not_trigger_below_twice_the_border():
    """The border here (16.3 s each side) is wide enough that a typical
    Sample Sandbox clip pays none of it — reflect-padding only kicks in past
    2*border = 32.65 s of input, unlike BALANCED where a 5 s sample already
    exceeds it."""
    short = chunk_plan(SR * 30, CHUNK, STEP, BORDER)
    assert short["padded"] == SR * 30
    long = chunk_plan(SR * 40, CHUNK, STEP, BORDER)
    assert long["padded"] == SR * 40 + 2 * BORDER
