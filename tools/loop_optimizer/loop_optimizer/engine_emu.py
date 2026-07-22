"""Emulation of XLETH's Sampler voice render path.

Every metric in this tool is computed on the output of this module, never on
idealised math. A loop that is perfect on paper and audibly wrong through the
engine must score as audibly wrong, so the thing being measured has to be the
thing the engine actually plays.

Mirrors ``engine/src/audio/Sampler.cpp`` ``Sampler::processVoice``, specifically:

  * effective crossfade clamp          :898-910
  * FL-style loop wrap past the fade-in :1020-1030
  * bounds check / silence              :1045-1053
  * Hann declick at trim edges          :1055-1063  (dsp/DeclickEnvelope.h)
  * user linear fade in/out             :1065-1088
  * equal-power cos/sin crossfade blend :1090-1104, :1119-1130
  * 4-point cubic Hermite read          :912-937

Held fixed, and why:

  ``envGain``, ``velocity``   1.0 — the ADSR is not part of loop quality, and a
                              decaying envelope would smear every seam metric
                              with an amplitude trend that has nothing to do
                              with the seam.
  vol/pan/pitch LFOs          off — all three are per-region modulation; a
                              pitch LFO in particular would make ``stride``
                              time-varying and the closed-form position solve
                              below invalid.
  ``stride``                  1.0 by default. Playing at the root note, on a
                              buffer already at the engine rate, gives
                              ``modulatedRatio * srRatio == 1.0`` (:1011-1013).

Two renderers are provided and they must agree:

  :func:`render_reference`  a literal, slow, sample-at-a-time transcription of
                            the C++ loop, in C++ statement order. This is the
                            readable spec.
  :func:`render_window`     a vectorised solve used for the actual measurements,
                            able to render an arbitrary output range without
                            walking the samples before it.

``tests/test_engine_emu.py`` asserts they are bit-identical over randomised
configurations. Trust the reference; use the fast one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .constants import DECLICK_LUT_SIZE, ENGINE_SAMPLE_RATE

_PI = 3.14159265358979323846


def _build_declick_lut() -> np.ndarray:
    """Mirror ``DeclickEnvelope::initialize`` (engine/src/dsp/DeclickEnvelope.cpp).

    ``sLut[i] = 0.5 * (1 - cos(pi * i / (kLutSize-1)))`` — a raised cosine rising
    0 -> 1 across the table. Reproduced as a table, not as a function, because
    the engine's integer index arithmetic quantises the gain and that
    quantisation is visible in a seam measurement.
    """
    i = np.arange(DECLICK_LUT_SIZE, dtype=np.float32)
    t = i / np.float32(DECLICK_LUT_SIZE - 1)
    return (np.float32(0.5) * (np.float32(1.0) - np.cos(np.float32(_PI) * t))).astype(np.float32)


_DECLICK_LUT = _build_declick_lut()


def declick_ms_to_samples(ms: float, sample_rate: float) -> int:
    """``DeclickEnvelope::msToSamples`` — note the +0.5 round, then clamp >= 0."""
    n = int(ms * sample_rate * 0.001 + 0.5)
    return 0 if n < 0 else n


@dataclass(frozen=True)
class LoopConfig:
    """The subset of Sampler region state that shapes a loop seam.

    All sample counts are ENGINE-domain (48 kHz), matching the engine's own
    fields. ``dataset.json`` stores gold in the file domain — convert with
    :meth:`loop_optimizer.ingest.IngestedSample.file_to_engine` first.
    """

    loop_start: int
    loop_end: int
    crossfade_samples: int = 0
    smp_start: int = 0
    #: 0 means "to the end of the buffer" (Sampler.cpp:882-883).
    smp_length: int = 0
    declick_ms: float = 0.0
    fade_in_ms: float = 0.0
    fade_out_ms: float = 0.0
    loop_enabled: bool = True
    #: Gates looping ENTIRELY, not just the fade — ``useLoop`` requires it
    #: (Sampler.cpp:895-896). Named for the mode it came from, but a region with
    #: crossfade mode off does not loop at all.
    crossfade_enabled: bool = True


@dataclass(frozen=True)
class EffectiveLoop:
    """``LoopConfig`` after the engine's clamps. What actually plays."""

    clamped_end: int
    eff_declick: int
    eff_loop_start: int
    eff_loop_end: int
    eff_xfade: int
    xfade_start: float
    use_loop: bool

    @property
    def wrap_advance(self) -> int:
        """Samples of new material per loop pass: ``loopEnd - (loopStart + xfade)``.

        The first ``eff_xfade`` samples of the loop region are skipped on wrap
        (Sampler.cpp:1024-1028), so a loop's audible period is this, NOT
        ``loopEnd - loopStart``. Getting this wrong is the single easiest way to
        mis-measure a crossfaded loop.
        """
        return self.eff_loop_end - (self.eff_loop_start + self.eff_xfade)


def resolve(cfg: LoopConfig, num_frames: int, sample_rate: float = ENGINE_SAMPLE_RATE) -> EffectiveLoop:
    """Apply the engine's clamps. Mirrors Sampler.cpp:881-910 exactly."""
    # Trim end (:881-884).
    eff_end = cfg.smp_start + (cfg.smp_length if cfg.smp_length > 0 else num_frames - cfg.smp_start)
    clamped_end = min(eff_end, num_frames)

    # Declick width, clamped so the two fades cannot overlap (:885-888).
    declick_n = declick_ms_to_samples(cfg.declick_ms, sample_rate)
    eff_declick = min(declick_n, int((clamped_end - cfg.smp_start) / 2))

    # Effective loop bounds; loopEnd == 0 means end of sample (:890-894).
    eff_loop_end = min(cfg.loop_end, num_frames) if cfg.loop_end > 0 else num_frames
    eff_loop_start = min(cfg.loop_start, eff_loop_end)
    use_loop = cfg.crossfade_enabled and cfg.loop_enabled and eff_loop_end > eff_loop_start

    # Crossfade clamp (:898-909). Four bounds, in the engine's order:
    #   1. the requested width
    #   2. half the loop, so the two ends cannot overlap inside it
    #   3. the fade-out read [loopEnd-N, loopEnd] stays inside the trim region
    #   4. the fade-in source [loopStart, loopStart+N] stays inside the trim region
    # Note (2) is integer division, truncating.
    eff_xfade = 0
    if use_loop and cfg.crossfade_samples > 0:
        eff_xfade = cfg.crossfade_samples
        eff_xfade = min(eff_xfade, (eff_loop_end - eff_loop_start) // 2)
        eff_xfade = min(eff_xfade, eff_loop_end - cfg.smp_start)
        eff_xfade = min(eff_xfade, clamped_end - eff_loop_start)
        if eff_xfade < 0:
            eff_xfade = 0

    return EffectiveLoop(
        clamped_end=clamped_end,
        eff_declick=eff_declick,
        eff_loop_start=eff_loop_start,
        eff_loop_end=eff_loop_end,
        eff_xfade=eff_xfade,
        xfade_start=float(eff_loop_end - eff_xfade),  # :910
        use_loop=use_loop,
    )


def seam_output_index(eff: EffectiveLoop, cfg: LoopConfig, stride: float = 1.0) -> int:
    """Output index of the first post-wrap sample.

    ``out[n-1]`` is the last sample read before the wrap (position just under
    ``effLoopEnd``); ``out[n]`` is the first read after it (position
    ``effLoopStart + effXfade``). The audible seam is between those two.
    """
    if not eff.use_loop:
        return -1
    return int(math.ceil((eff.eff_loop_end - cfg.smp_start) / stride))


# ─── Reference renderer ──────────────────────────────────────────────────────


def _read_interp_scalar(x: np.ndarray, pos: float) -> np.float32:
    """``readInterp`` — 4-point cubic Hermite (Sampler.cpp:912-937)."""
    n = x.shape[0]
    i0 = int(pos)  # static_cast<int>: truncates toward zero
    if i0 < 0 or i0 >= n:
        return np.float32(0.0)
    f = np.float32(pos - i0)

    def clamp_get(idx: int) -> np.float32:
        if idx < 0:
            idx = 0
        elif idx >= n:
            idx = n - 1
        return np.float32(x[idx])

    ym1, y0, y1, y2 = clamp_get(i0 - 1), clamp_get(i0), clamp_get(i0 + 1), clamp_get(i0 + 2)
    c0 = y0
    c1 = np.float32(0.5) * (y1 - ym1)
    c2 = ym1 - np.float32(2.5) * y0 + np.float32(2.0) * y1 - np.float32(0.5) * y2
    c3 = np.float32(0.5) * (y2 - ym1) + np.float32(1.5) * (y0 - y1)
    return ((c3 * f + c2) * f + c1) * f + c0


def _declick_fade_in(pos_in_ramp: int, ramp_len: int) -> np.float32:
    """``DeclickEnvelope::fadeIn`` (DeclickEnvelope.h:19-25)."""
    if ramp_len <= 0 or pos_in_ramp >= ramp_len:
        return np.float32(1.0)
    if pos_in_ramp <= 0:
        return np.float32(0.0)
    return _DECLICK_LUT[pos_in_ramp * (DECLICK_LUT_SIZE - 1) // ramp_len]


def _declick_fade_out(pos_from_end: int, ramp_len: int) -> np.float32:
    """``DeclickEnvelope::fadeOut`` (DeclickEnvelope.h:29-35)."""
    if ramp_len <= 0 or pos_from_end >= ramp_len:
        return np.float32(1.0)
    if pos_from_end <= 0:
        return np.float32(0.0)
    return _DECLICK_LUT[pos_from_end * (DECLICK_LUT_SIZE - 1) // ramp_len]


def render_reference(
    x: np.ndarray,
    cfg: LoopConfig,
    num_samples: int,
    stride: float = 1.0,
    sample_rate: float = ENGINE_SAMPLE_RATE,
) -> np.ndarray:
    """Literal transcription of ``Sampler::processVoice``'s per-sample loop.

    Slow and deliberately unoptimised — statement order follows the C++ so the
    two can be diffed by eye. :func:`render_window` is what measurements use.
    """
    xf = np.asarray(x, dtype=np.float32)
    n_frames = xf.shape[0]
    eff = resolve(cfg, n_frames, sample_rate)
    out = np.zeros(num_samples, dtype=np.float32)

    pos = float(cfg.smp_start)
    for s in range(num_samples):
        # :1019-1030 — end-of-sample / loop handling, BEFORE the read.
        if eff.use_loop:
            if pos >= float(eff.eff_loop_end):
                over = pos - float(eff.eff_loop_end)
                pos = float(eff.eff_loop_start + eff.eff_xfade) + over
        # (the non-looping branch only triggers the release envelope, which we
        #  hold at unity gain — nothing to emulate)

        # :1045-1053 — bounds check; out of range writes nothing.
        # NOTE the `continue`: it skips `playPosition += stride` at :1132, so a
        # voice that walks off the buffer FREEZES at that position rather than
        # advancing past it. With the envelope held at unity it then emits
        # silence forever. Preserved deliberately — it is the engine's behaviour,
        # not a plausible-looking approximation of it.
        idx0 = int(pos)
        if idx0 < 0 or idx0 >= n_frames:
            continue

        # :1055-1063 — Hann declick at trim start and end.
        declick_gain = np.float32(1.0)
        if eff.eff_declick > 0:
            pos_from_start = int(pos - float(cfg.smp_start))
            pos_from_end = int(float(eff.clamped_end) - pos)
            declick_gain = _declick_fade_in(pos_from_start, eff.eff_declick) * _declick_fade_out(
                pos_from_end, eff.eff_declick
            )

        # :1065-1088 — user linear fades.
        fade_gain = np.float32(1.0)
        if cfg.fade_in_ms > 0.0:
            fade_in_samples = int(cfg.fade_in_ms * 0.001 * sample_rate)
            if fade_in_samples > 0:
                rel_pos = int(pos) - cfg.smp_start
                if rel_pos < fade_in_samples:
                    fade_gain *= max(np.float32(0.0), np.float32(rel_pos) / np.float32(fade_in_samples))
        if cfg.fade_out_ms > 0.0:
            fade_out_samples = int(cfg.fade_out_ms * 0.001 * sample_rate)
            if fade_out_samples > 0:
                dist_from_end = eff.clamped_end - int(pos)
                if dist_from_end < fade_out_samples:
                    fade_gain *= max(np.float32(0.0), np.float32(dist_from_end) / np.float32(fade_out_samples))

        # :1090-1104 — equal-power crossfade weights and the fade-in read position.
        in_xfade = eff.eff_xfade > 0 and pos >= eff.xfade_start
        fade_out_x, fade_in_x = np.float32(1.0), np.float32(0.0)
        loop_src_pos = 0.0
        if in_xfade:
            progress = np.float32((pos - eff.xfade_start) / float(eff.eff_xfade))
            if progress > np.float32(1.0):
                progress = np.float32(1.0)
            # cosf/sinf of a float argument: kPi is `static constexpr float`
            # (Sampler.cpp:879), so the whole expression is single precision.
            arg = progress * np.float32(_PI) * np.float32(0.5)
            fade_out_x = np.cos(arg, dtype=np.float32)
            fade_in_x = np.sin(arg, dtype=np.float32)
            loop_src_pos = float(eff.eff_loop_start) + (pos - eff.xfade_start)

        # :1119-1130 — read, blend, write.
        sample = _read_interp_scalar(xf, pos)
        if in_xfade:
            sample = sample * fade_out_x + _read_interp_scalar(xf, loop_src_pos) * fade_in_x
        out[s] = sample * declick_gain * fade_gain

        pos += stride  # :1132

    return out


# ─── Vectorised renderer ─────────────────────────────────────────────────────


def _read_interp_vec(x: np.ndarray, pos: np.ndarray) -> np.ndarray:
    """Vectorised ``readInterp``. Same coefficients, same out-of-range zero."""
    n = x.shape[0]
    i0 = pos.astype(np.int64)  # pos >= 0 here, so truncation == floor
    valid = (i0 >= 0) & (i0 < n)
    f = (pos - i0).astype(np.float32)

    def clamp_get(off: int) -> np.ndarray:
        return x[np.clip(i0 + off, 0, n - 1)]

    ym1, y0, y1, y2 = clamp_get(-1), clamp_get(0), clamp_get(1), clamp_get(2)
    c0 = y0
    c1 = np.float32(0.5) * (y1 - ym1)
    c2 = ym1 - np.float32(2.5) * y0 + np.float32(2.0) * y1 - np.float32(0.5) * y2
    c3 = np.float32(0.5) * (y2 - ym1) + np.float32(1.5) * (y0 - y1)
    out = ((c3 * f + c2) * f + c1) * f + c0
    return np.where(valid, out, np.float32(0.0)).astype(np.float32)


def _declick_gain_vec(pos: np.ndarray, cfg: LoopConfig, eff: EffectiveLoop) -> np.ndarray:
    """Vectorised declick, reproducing the integer LUT indexing exactly."""
    ramp = eff.eff_declick
    if ramp <= 0:
        return np.ones_like(pos, dtype=np.float32)

    def lut_gain(p: np.ndarray) -> np.ndarray:
        # p is the C++ `int` distance; static_cast<int> truncates toward zero.
        idx = (p * (DECLICK_LUT_SIZE - 1)) // ramp
        g = _DECLICK_LUT[np.clip(idx, 0, DECLICK_LUT_SIZE - 1)]
        g = np.where(p <= 0, np.float32(0.0), g)
        return np.where(p >= ramp, np.float32(1.0), g).astype(np.float32)

    pos_from_start = np.trunc(pos - float(cfg.smp_start)).astype(np.int64)
    pos_from_end = np.trunc(float(eff.clamped_end) - pos).astype(np.int64)
    return (lut_gain(pos_from_start) * lut_gain(pos_from_end)).astype(np.float32)


def _fade_gain_vec(pos: np.ndarray, cfg: LoopConfig, eff: EffectiveLoop, sample_rate: float) -> np.ndarray:
    gain = np.ones_like(pos, dtype=np.float32)
    if cfg.fade_in_ms > 0.0:
        n = int(cfg.fade_in_ms * 0.001 * sample_rate)
        if n > 0:
            rel = pos.astype(np.int64) - cfg.smp_start
            ramp = np.maximum(np.float32(0.0), rel.astype(np.float32) / np.float32(n))
            gain *= np.where(rel < n, ramp, np.float32(1.0)).astype(np.float32)
    if cfg.fade_out_ms > 0.0:
        n = int(cfg.fade_out_ms * 0.001 * sample_rate)
        if n > 0:
            dist = eff.clamped_end - pos.astype(np.int64)
            ramp = np.maximum(np.float32(0.0), dist.astype(np.float32) / np.float32(n))
            gain *= np.where(dist < n, ramp, np.float32(1.0)).astype(np.float32)
    return gain


def positions_for_range(
    cfg: LoopConfig,
    eff: EffectiveLoop,
    out_start: int,
    out_count: int,
    stride: float = 1.0,
) -> np.ndarray:
    """Closed-form solve for the play position at each output index.

    The engine advances ``playPosition`` by ``stride`` per output sample and, on
    each sample, applies AT MOST ONE wrap (an ``if``, not a ``while`` —
    Sampler.cpp:1020-1030). Each wrap subtracts exactly
    ``wrap_advance = loopEnd - (loopStart + xfade)``, so the position is

        pos(n) = smpStart + n*stride - wraps(n) * wrap_advance

    with ``wraps(n)`` the number of subtractions needed to bring the unwrapped
    position back below ``loopEnd``. That closed form corresponds to a ``while``,
    so it is only equal to the engine when one wrap per sample is always enough —
    which holds exactly when ``stride <= wrap_advance``. Asserted, not assumed.
    """
    n = np.arange(out_start, out_start + out_count, dtype=np.float64)
    unwrapped = float(cfg.smp_start) + n * stride
    if not eff.use_loop:
        return unwrapped

    advance = eff.wrap_advance
    if advance <= 0:
        # A loop whose whole body is crossfade cannot advance; the engine would
        # spin on the same position forever. Refuse rather than emulate nonsense.
        raise ValueError(
            f"degenerate loop: wrap_advance={advance} "
            f"(loop_end={eff.eff_loop_end}, loop_start={eff.eff_loop_start}, xfade={eff.eff_xfade})"
        )
    if stride > advance:
        raise ValueError(
            f"stride {stride} exceeds wrap_advance {advance}; the engine's single-wrap-per-sample "
            "rule and this closed form diverge here"
        )

    over = unwrapped - float(eff.eff_loop_end)
    wraps = np.where(over >= 0.0, np.floor(over / advance) + 1.0, 0.0)
    return unwrapped - wraps * float(advance)


def render_window(
    x: np.ndarray,
    cfg: LoopConfig,
    out_start: int,
    out_count: int,
    stride: float = 1.0,
    sample_rate: float = ENGINE_SAMPLE_RATE,
) -> np.ndarray:
    """Render output samples ``[out_start, out_start + out_count)``.

    Equivalent to ``render_reference(...)[out_start:out_start+out_count]`` but
    without rendering the samples before ``out_start`` — which is what makes it
    affordable to measure a seam in a long sample across many candidates.
    """
    xf = np.asarray(x, dtype=np.float32)
    n_frames = xf.shape[0]
    eff = resolve(cfg, n_frames, sample_rate)
    if out_count <= 0:
        return np.zeros(0, dtype=np.float32)

    pos = positions_for_range(cfg, eff, out_start, out_count, stride)

    declick = _declick_gain_vec(pos, cfg, eff)
    fade = _fade_gain_vec(pos, cfg, eff, sample_rate)

    sample = _read_interp_vec(xf, pos)

    if eff.eff_xfade > 0:
        in_xfade = pos >= eff.xfade_start
        # Statement order matters: the C++ computes in double, casts to float,
        # THEN clamps (:1097-1099). Do the same so the two renderers agree bit
        # for bit at progress values sitting right on 1.0.
        progress = ((pos - eff.xfade_start) / float(eff.eff_xfade)).astype(np.float32)
        progress = np.minimum(progress, np.float32(1.0))
        arg = progress * np.float32(_PI) * np.float32(0.5)
        fade_out_x = np.cos(arg, dtype=np.float32)
        fade_in_x = np.sin(arg, dtype=np.float32)
        loop_src_pos = float(eff.eff_loop_start) + (pos - eff.xfade_start)
        blended = sample * fade_out_x + _read_interp_vec(xf, loop_src_pos) * fade_in_x
        sample = np.where(in_xfade, blended, sample).astype(np.float32)

    out = (sample * declick * fade).astype(np.float32)

    # :1045-1053 — a position outside the buffer writes nothing AND freezes the
    # voice (the `continue` skips the stride advance at :1132). So the first
    # out-of-bounds sample silences everything after it too, not just itself.
    idx0 = pos.astype(np.int64)
    oob = (idx0 < 0) | (idx0 >= n_frames)
    if oob.any():
        out[int(np.argmax(oob)) :] = np.float32(0.0)
    return out
