"""
UniFlange -- reference model of Fruity Flangus (Didier Dambrin), for XLETH.
Round 2.  See FLANGUS_FINDINGS.md.

  [CONFIRMED]  measured two independent ways
  [INFERRED]   structurally forced, not numerically pinned
  [UNKNOWN]    placeholder -- blocked on the round-3 render matrix

A runnable specification, not a shipping DSP core.  Port the CONFIRMED parts
verbatim; refit the UNKNOWN maps before you ship.
"""

import numpy as np

MAX_DELAY_MS = 40.0
WET_GAIN_ORDER1 = 0.9373      # [CONFIRMED] flat vs frequency, 523 Hz .. 19.4 kHz


# ---------------------------------------------------------------------------
# TOPOLOGY  [CONFIRMED]
#
#   A "voice" is ONE delay line read, with a PAN position.  It is not a left
#   voice or a right voice.  Evidence: the same physical tap appears in both
#   outputs with gains 0.5531 / 0.1053 (cross removed), and those two numbers are
#   identical to 5 dp across renders with different DEPTH and different SPEED.
#   Pan depends on voice index and SPREAD only.
#
#   Do NOT build this as two independent per-channel banks.  It will not null.
#
#   signal flow:
#       mono/stereo in
#         -> N modulated delay taps, linear interpolation, NO feedback
#         -> each tap panned (p_L, p_R)
#         -> summed into wet_L, wet_R
#         -> cross matrix [[1, c], [c, 1]],  c = CROSS/100, unnormalised
#         -> dry/wet blend
# ---------------------------------------------------------------------------


def map_depth(depth_pct):
    """DEPTH% -> peak LFO excursion, ms.  [UNKNOWN]

    Anchors: at DEPTH 50 / SPREAD 100 / order 1 the two voices swung 1.749 ms and
    2.332 ms peak-to-peak -- i.e. depth is per-voice and scaled by the spread
    ladder, so this returns the *base* the ladder multiplies.
    """
    return 0.035 * depth_pct                      # GUESS, linear


def map_speed(speed_pct):
    """SPD% -> LFO rate, Hz.  [UNKNOWN]

    Hard constraints from the data, both awkward:
      * SPEED = 75 %  -> period > 1.7 s (trajectory monotonic across a 0.857 s file)
      * SPEED = 0 %   -> NOT zero.  Taps still drift ~3.2 samples/s (0.073 ms/s).
                         There is no freeze.  Whatever curve you fit must have a
                         non-zero floor.
    """
    return 0.03 + 0.05 * (200.0 ** (speed_pct / 100.0))       # GUESS


def map_delay_spacing(delay_pct):
    """DEL% -> inter-voice delay SPACING, ms.  [INFERRED, constants UNKNOWN]

    NOT a common base offset.  Measured: voice 1 sits at 0.596 ms (DEL 0) vs
    0.672 ms (DEL 100) -- essentially unmoved -- while voice 2 moves from ~1.3 ms
    to 26.77 ms.  DELAY fans the later voices outward from an almost fixed first
    voice.
    """
    return 0.7 + 0.26 * delay_pct                  # ~0.7 ms at 0%, ~26.8 at 100%


def voice_layout(n_voices, spread_pct, delay_pct, depth_pct):
    """Per-voice (delay_centre_ms, depth_ms, lfo_phase_turns, pan).  [UNKNOWN]

    Known anchors:
      * order 1 -> TWO taps, at 12.1100 ms and 0.1855 ms (DEL 0, SPREAD 100).
        `order` is not a raw voice count; order 1 already gives a stereo pair.
      * order 4, DEL 100, SPREAD 100: voice 1 pan gains (0.5531, 0.1053);
        voice 2 is the mirror (0.1053, 0.5531).  The ladder is symmetric about
        centre.
      * pan is independent of DEPTH and SPEED.

    `pan` here is in [-1, +1]; see pan_gains().
    """
    n = max(int(n_voices), 1)
    idx = np.arange(n)
    frac = idx / max(n - 1, 1) if n > 1 else np.array([0.5])

    spacing = map_delay_spacing(delay_pct)
    centres = 0.65 + spacing * frac                              # GUESS
    depths = map_depth(depth_pct) * (1.0 + 0.33 * (frac - 0.5))  # GUESS (4/3 ratio)
    phases = frac * (spread_pct / 100.0) * 0.5                   # GUESS
    pans = (2 * frac - 1) * (spread_pct / 100.0)                 # GUESS
    return centres, depths, phases, pans


def pan_gains(pan):
    """pan in [-1,+1] -> (gL, gR).  [UNKNOWN law, one data point]

    The single measured voice gave (0.5531, 0.1053).  Their sum is 0.6584 and
    their quadratic norm 0.5630 -- neither matches a textbook constant-power or
    constant-gain law against the order-1 figure of 0.9373, so the per-voice
    normalisation and the pan law are entangled.  The impulse render in
    FLANGUS_FINDINGS.md section 3.1 separates them in one bounce.
    """
    a = (1.0 - pan) * 0.5
    return a, 1.0 - a


def voice_gain(n_voices):
    """Overall per-voice gain before panning.  [UNKNOWN]

    order 1 -> 0.9373 (confirmed).  order 4 voice 1 -> pan gains summing to
    0.6584.  Output RMS grows by only 1.126x (order 2) and 1.192x (order 4)
    against the sqrt(N) an unnormalised sum would give, so a normalisation
    between N^-1/4 and N^-1/2 is in there somewhere.
    """
    return WET_GAIN_ORDER1 / (max(int(n_voices), 1) ** 0.33)     # GUESS


# ---------------------------------------------------------------------------
class UniFlange:
    def __init__(self, sr=44100.0, order=4, depth=50.0, speed=75.0,
                 delay=0.0, spread=100.0, cross=-25.0, dry=0.0, wet=100.0):
        self.sr = float(sr)
        self.order = int(order)
        self.p = dict(depth=depth, speed=speed, delay=delay, spread=spread,
                      cross=cross, dry=dry, wet=wet)

    def process(self, x):
        x = np.asarray(x, dtype=np.float64)
        if x.ndim == 1:
            x = np.stack([x, x], axis=1)
        n, sr = len(x), self.sr
        t = np.arange(n) / sr

        n_voices = 2 * self.order              # [INFERRED] order 1 gave 2 taps
        centres, depths, phases, pans = voice_layout(
            n_voices, self.p['spread'], self.p['delay'], self.p['depth'])
        rate = map_speed(self.p['speed'])
        g = voice_gain(n_voices)

        mono = x.mean(axis=1)
        wet = np.zeros((n, 2))
        for i in range(n_voices):
            d_ms = centres[i] + depths[i] * np.sin(2 * np.pi * (rate * t + phases[i]))
            v = g * _read_linear(mono, np.maximum(d_ms, 0.0) * sr / 1000.0)
            pl, pr = pan_gains(pans[i])
            wet[:, 0] += pl * v
            wet[:, 1] += pr * v

        c = self.p['cross'] / 100.0            # [CONFIRMED] exact, unnormalised
        out = np.empty_like(wet)
        out[:, 0] = wet[:, 0] + c * wet[:, 1]
        out[:, 1] = wet[:, 1] + c * wet[:, 0]

        return (self.p['dry'] / 100.0) * x + (self.p['wet'] / 100.0) * out


def _read_linear(buf, delay_samples):
    """2-point linear interpolated tap.  [CONFIRMED interpolator]

    Costs ~5.5 dB at 16 kHz at the worst fractional phase, and the loss MOVES
    with the LFO.  Much of Flangus's soft character is this artefact.  Swap for
    a higher-order tap only behind a LEGACY/HQ switch.
    """
    n = len(buf)
    idx = np.arange(n) - delay_samples
    i0 = np.floor(idx).astype(np.int64)
    fr = idx - i0
    i1 = i0 + 1
    s0 = np.where((i0 >= 0) & (i0 < n), buf[np.clip(i0, 0, n - 1)], 0.0)
    s1 = np.where((i1 >= 0) & (i1 < n), buf[np.clip(i1, 0, n - 1)], 0.0)
    return (1.0 - fr) * s0 + fr * s1


if __name__ == "__main__":
    sr = 44100
    t = np.arange(int(sr * 0.857)) / sr
    x = 0.3 * (2 * (t * 523.2511 % 1.0) - 1)
    for o in (1, 2, 4):
        y = UniFlange(sr=sr, order=o, dry=0, wet=100).process(x)
        print(f"order {o}: rms L {np.sqrt((y[:,0]**2).mean()):.4f} "
              f"R {np.sqrt((y[:,1]**2).mean()):.4f}  peak {np.abs(y).max():.4f}")
