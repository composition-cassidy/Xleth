"""Generate the click probe: one full-scale sample at t=0, then silence.

44.1kHz, 32-bit float, mono (Sampler channel sums to mono anyway per the
handoff's assumption, but we keep the source file itself simple/mono).
"""
import sys
import numpy as np
import soundfile as sf

SR = 44100


def make_click(seconds_silence=2.5):
    n = int(round(seconds_silence * SR)) + 1
    x = np.zeros(n, dtype=np.float32)
    x[0] = 1.0
    return x


def make_noise(seconds=12.0, seed=0):
    rng = np.random.default_rng(seed)
    n = int(round(seconds * SR))
    x = rng.standard_normal(n).astype(np.float32)
    x /= np.max(np.abs(x)) * 1.2  # headroom, avoid clipping through Flangus's +6dB cross gain
    return x


def make_stereo_noise(seconds=12.0, seed_l=1, seed_r=2):
    l = make_noise(seconds, seed_l)
    r = make_noise(seconds, seed_r)
    return np.stack([l, r], axis=1)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "click.wav"
    sf.write(out, make_click(), SR, subtype="FLOAT")
    print("wrote", out)
