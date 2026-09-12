"""DE-BLEED — an optional post-pass that reduces cross-talk between a
separation's two stems.

Not a model, and not a second inference pass. A separated "Vocals" stem still
carries some instrumental energy wherever the model's own mask was uncertain,
and vice versa — that is the model's quality ceiling, and de-bleed cannot see
past it. What it CAN do is attenuate, in each stem, whatever time-frequency
energy is dominated by the OTHER stem's evidence, using only the two stems
already on hand.

The technique is the textbook ideal ratio mask: for every STFT bin, split the
combined energy between the two stems in proportion to how much each of them
already has there. A bin where Vocals is loud and Instrumental is near-silent
stays almost entirely Vocals; a bin where both are comparable — the exact
signature of bleed — gets pulled toward whichever stem the model already
favoured, softly rather than as a hard cut. No download, no new weight, no
per-tier special case: this runs identically after any tier's separate(),
because it only ever looks at the two stems' spectra.

Deliberately opt-in. A ratio mask computed from two real, correlated stereo
sources can also suppress genuine shared content (room bleed, print-through,
the kind of thing a mix engineer might have left in on purpose) — that is a
trade the user should choose per run, not one made for them silently. It also
only makes sense for exactly two stems: with three or more, "the other
stem's evidence" is not a single well-defined thing, so it is a no-op there.
"""

from __future__ import annotations

from typing import Dict

import numpy as np

# Framing for the mask's own STFT. Independent of any tier's chunking or
# transform settings — this pass runs on the WHOLE finished stem, once, after
# separate() has already reassembled it — so it does not need to agree with
# any model's n_fft/hop, only to resolve bleed at a reasonable time-frequency
# resolution. 2048/512 (75% overlap) is a common general-purpose choice, fine
# enough in frequency and time for a cleanup pass rather than a transform the
# model was trained around.
N_FFT = 2048
HOP = 512
_EPS = 1e-8


def can_de_bleed(stems: Dict[str, np.ndarray]) -> bool:
    """Whether `stems` is the shape this pass knows how to clean.

    Exactly two stems: with more, "the other stem" is not a single thing, and
    forcing a two-way ratio mask onto three inputs would just redistribute
    energy arbitrarily between the first two and quietly drop the rest.
    """
    return len(stems) == 2


def de_bleed(stems: Dict[str, np.ndarray], sample_rate: int) -> Dict[str, np.ndarray]:
    """Apply the ratio-mask cleanup to a two-stem separation.

    `stems` maps stem name -> [channels, samples] float32, all the same
    length and sample rate (true of every separator's output). Returns a new
    dict with the same keys and shapes; a stem's channel count and length are
    preserved exactly, only its content is masked.
    """
    if not can_de_bleed(stems):
        return stems

    import torch

    names = list(stems.keys())
    a_name, b_name = names[0], names[1]
    a = np.asarray(stems[a_name], dtype=np.float32)
    b = np.asarray(stems[b_name], dtype=np.float32)

    n = min(a.shape[-1], b.shape[-1])
    a, b = a[..., :n], b[..., :n]

    window = torch.hann_window(N_FFT)

    def stft(x: np.ndarray) -> "torch.Tensor":
        t = torch.from_numpy(np.ascontiguousarray(x, dtype=np.float32))
        return torch.stft(t, n_fft=N_FFT, hop_length=HOP, window=window,
                          center=True, return_complex=True)

    Sa = stft(a)
    Sb = stft(b)

    mag_a = Sa.abs()
    mag_b = Sb.abs()
    total = mag_a + mag_b + _EPS

    # Ideal ratio mask: each stem keeps the share of the combined energy it
    # already accounts for. Applied to BOTH stems' own complex spectra (not
    # swapped) — this attenuates a bin, it does not move energy from one
    # stem's phase into the other's.
    mask_a = mag_a / total
    mask_b = mag_b / total

    cleaned_a = torch.istft(Sa * mask_a, n_fft=N_FFT, hop_length=HOP,
                            window=window, center=True, length=n)
    cleaned_b = torch.istft(Sb * mask_b, n_fft=N_FFT, hop_length=HOP,
                            window=window, center=True, length=n)

    result = dict(stems)
    result[a_name] = np.ascontiguousarray(cleaned_a.numpy(), dtype=np.float32)
    result[b_name] = np.ascontiguousarray(cleaned_b.numpy(), dtype=np.float32)
    return result
