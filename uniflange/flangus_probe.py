"""
flangus_probe.py -- measurement harness for reverse-engineering Fruity Flangus.

Every number in FLANGUS_FINDINGS.md came out of this file.  Point it at a
dry.wav + one or more wet-only renders and it will report, per channel:

    * the exact CROSS coefficient (solved, not assumed)
    * the per-voice delay trajectory in ms, absolute (not mod-anything)
    * the interpolator type
    * the LFO rate / depth / phase, if the render is long enough
    * the voice count and per-voice delays for order > 1 (ESPRIT)

Usage:
    python flangus_probe.py dry.wav "wet - order 1, ....wav" [more.wav ...]

Requires numpy + scipy.

IMPORTANT: use a WIDEBAND probe (white noise or a log sweep), not a square
wave.  A square wave only excites odd harmonics of f0, which makes the delay
estimate ambiguous mod 1/f0 and leaves large gaps in the frequency axis.
Set PROBE = 'noise' below once you re-render.
"""

import sys, re, wave
import numpy as np
from scipy.signal import firwin, filtfilt

SR = 44100.0
PROBE = 'square'          # 'square' | 'noise'
F0 = 523.2511             # only used when PROBE == 'square'


# --------------------------------------------------------------------------- io
def read_wav(path):
    w = wave.open(path)
    assert w.getsampwidth() == 2, "expected 16-bit; re-export or widen this"
    d = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')
    d = d.astype(np.float64) / 32768.0
    return d.reshape(-1, w.getnchannels()), w.getframerate()


def demod(x, fc, sr, bw=120.0):
    """Complex envelope of x at frequency fc."""
    t = np.arange(len(x)) / sr
    lp = firwin(513, bw / (sr / 2))
    return filtfilt(lp, [1], x * np.exp(-2j * np.pi * fc * t))


# ------------------------------------------------------------------ cross solve
def solve_cross(dry, wet, sr, f0=F0):
    """Recover c in  outL = A + c*B ,  outR = B + c*A .

    Works because a single un-fed-back delay voice has a CONSTANT |H|; the
    correct c is the one that makes |A(t)| and |B(t)| flat.
    """
    D = demod(dry[:, 0], f0, sr)
    L = demod(wet[:, 0], f0, sr) / D
    R = demod(wet[:, 1], f0, sr) / D
    s = slice(3000, len(D) - 3000)
    grid = np.arange(-0.99, 0.991, 0.0005)
    cost = []
    for c in grid:
        A = (L - c * R) / (1 - c * c)
        B = (R - c * L) / (1 - c * c)
        cost.append(np.std(np.abs(A[s])) + np.std(np.abs(B[s])))
    c = grid[int(np.argmin(cost))]
    return c, min(cost)


def decross(dry, wet, sr, c, k=1, f0=F0):
    D = demod(dry[:, 0], k * f0, sr, bw=400)
    L = demod(wet[:, 0], k * f0, sr, bw=400) / D
    R = demod(wet[:, 1], k * f0, sr, bw=400) / D
    return (L - c * R) / (1 - c * c), (R - c * L) / (1 - c * c)


# ------------------------------------------------------- absolute delay recovery
def absolute_delay(dry, wet, sr, c, ch, f0=F0, harmonics=(21, 25, 29, 31, 35, 37)):
    """Resolve the mod-(1/f0) phase ambiguity using the linear-interpolator
    magnitude ripple, which is periodic in delay mod 1 SAMPLE.  Two
    incommensurate congruences -> a nearly unique absolute delay.
    """
    P = sr / f0
    A1 = decross(dry, wet, sr, c, 1, f0)[ch]
    rel = (-np.unwrap(np.angle(A1)) / (2 * np.pi * f0)) * sr
    mags = {k: np.abs(decross(dry, wet, sr, c, k, f0)[ch]) for k in harmonics}
    s = slice(5000, len(rel) - 5000)
    ds = rel[s]
    out = []
    for m in range(0, int(np.ceil(40e-3 * sr / P))):
        d = ds - ds[0] + ds[0] + m * P
        if d.min() < 0:
            continue
        tot = nrm = 0.0
        for k, mk in mags.items():
            w = 2 * np.pi * k * f0 / sr
            fr = np.mod(d, 1.0)
            p = np.abs((1 - fr) + fr * np.exp(-1j * w))
            mm = mk[s]
            g = (mm * p).sum() / (p * p).sum()
            tot += ((mm - g * p) ** 2).sum(); nrm += (mm ** 2).sum()
        out.append((np.sqrt(tot / nrm) * 100, m, d.min() / sr * 1e3, d.max() / sr * 1e3))
    out.sort()
    return out


# ----------------------------------------------------------------- interpolator
def identify_interpolator(dry, wet, sr, c, ch, f0=F0, k=31):
    """Compare 'flat', 'linear' and 'allpass/thiran' predictions of |H| ripple."""
    A1 = decross(dry, wet, sr, c, 1, f0)[ch]
    rel = (-np.unwrap(np.angle(A1)) / (2 * np.pi * f0)) * sr
    mk = np.abs(decross(dry, wet, sr, c, k, f0)[ch])
    s = slice(5000, len(rel) - 5000)
    ds, mm = rel[s], mk[s]
    w = 2 * np.pi * k * f0 / sr
    res = {}
    for d0 in np.arange(0, 1, 0.01):
        fr = np.mod(ds + d0, 1.0)
        p = np.abs((1 - fr) + fr * np.exp(-1j * w))
        g = (mm * p).sum() / (p * p).sum()
        res[d0] = np.sqrt(((mm - g * p) ** 2).mean()) / mm.mean()
    d0 = min(res, key=res.get)
    return dict(freq=k * f0, linear_resid_pct=res[d0] * 100,
                flat_resid_pct=np.std(mm) / mm.mean() * 100,
                frac_offset=d0)


# --------------------------------------------------------------------- LFO fit
def fit_lfo(dry, wet, sr, c, f0=F0, fmin=0.02, fmax=12.0):
    """Shared-rate sinusoid fit.  Linear in (offset, sin, cos) for fixed F, so
    this is a 1-D grid search -- globally optimal, no local minima.

    If the reported residual keeps falling as F -> fmin, the render is SHORTER
    THAN ONE LFO CYCLE and the answer is meaningless.  Re-render longer.
    """
    A, B = decross(dry, wet, sr, c, 1, f0)
    s = slice(3000, len(A) - 3000, 10)
    t = (np.arange(len(A)) / sr)[s]
    dA = (-np.unwrap(np.angle(A)) / (2 * np.pi * f0) * 1e3)[s]
    dB = (-np.unwrap(np.angle(B)) / (2 * np.pi * f0) * 1e3)[s]

    def cost(F):
        tot, par = 0.0, []
        X = np.vstack([np.ones_like(t), np.sin(2 * np.pi * F * t),
                       np.cos(2 * np.pi * F * t)]).T
        for d in (dA, dB):
            b = np.linalg.lstsq(X, d, rcond=None)[0]
            tot += ((d - X @ b) ** 2).sum(); par.append(b)
        return tot, par

    Fs = np.arange(fmin, fmax, 0.002)
    cs = np.array([cost(F)[0] for F in Fs])
    F = Fs[int(np.argmin(cs))]
    _, par = cost(F)
    res = []
    for b in par:
        o, p, q = b
        res.append(dict(centre_ms=o, amp_ms=float(np.hypot(p, q)),
                        phase_deg=float(np.degrees(np.arctan2(q, p)) % 360)))
    degenerate = F < fmin * 1.5
    return dict(rate_hz=F, degenerate=degenerate, channels=res)


# ------------------------------------------------------------- voice separation
def esprit_voices(dry, wet, sr, c, ch, n, f0=F0, at=0.3, M=768, kmax=15):
    """Recover n simultaneous delays from one time block by treating the
    harmonic index as the 'time' axis of a sum of complex exponentials.
    Delays come out mod 1/(2*f0) with a square-wave probe.
    """
    ks = np.arange(1, kmax + 1, 2)
    s0 = int(at * sr)
    win = np.hanning(M)

    def blk(x):
        seg = x[s0:s0 + M] * win
        idx = np.arange(M) + s0
        return np.array([(seg * np.exp(-2j * np.pi * k * f0 * idx / sr)).sum()
                         for k in ks])

    Dk = blk(dry[:, 0]); Lk = blk(wet[:, 0]) / Dk; Rk = blk(wet[:, 1]) / Dk
    Y = ((Lk - c * Rk) if ch == 0 else (Rk - c * Lk)) / (1 - c * c)
    L = len(Y); Lh = L // 2 + 1
    H = np.array([Y[i:i + L - Lh + 1] for i in range(Lh)])
    U = np.linalg.svd(H)[0][:, :n]
    z = np.linalg.eigvals(np.linalg.pinv(U[:-1]) @ U[1:])
    d = np.mod(-np.angle(z) / (2 * 2 * np.pi * f0) * 1e3, 1e3 / (2 * f0))
    V = np.vstack([zz ** np.arange(L) for zz in z]).T
    g = np.linalg.lstsq(V, Y, rcond=None)[0]
    o = np.argsort(d)
    return dict(delays_ms_mod=d[o], gains=np.abs(g)[o], damping=np.abs(z)[o])


# ------------------------------------------------------- ONSET STAIRCASE (primary)
def onset_taps(dry, wet, sr, max_taps=8, thresh=6e-3, win=700):
    """PRIMARY ESTIMATOR.  Recovers absolute tap delays and the full 2xM gain
    matrix from the render's onset.

    Why this works: the delay buffers start empty, so the wet output is silent
    until the shortest tap delay elapses and then steps up as each further tap
    arrives.  Delays come out ABSOLUTE -- no modulo-probe-period ambiguity, which
    means the probe no longer has to be aperiodic.

    Returns a list of (delay_ms, gain_L_vector, gain_R_vector, residual_pct),
    one entry per tap, cumulative.

    Caveats:
      * taps arriving within ~1 ms of each other cannot be separated (see the
        DELAY=0% case, where all four voices land inside 4 ms).  Use a click /
        impulse probe if you need those resolved.
      * a tap whose delay sweeps far during the render may be reported as two
        adjacent entries with the same pan.  Same voice, two positions -- read
        the pan column, not the tap count.
    """
    x = dry[:, 0]
    N = min(len(x), len(wet))

    def basis(taps, s, e):
        cols = []
        for d in taps:
            i = np.arange(s, e) - d
            i0 = np.floor(i).astype(np.int64)
            fr = i - i0
            cols.append((1 - fr) * x[i0] + fr * x[i0 + 1])
        return np.column_stack(cols)

    def fit(taps, s, e):
        M = basis(taps, s, e)
        gl = np.linalg.lstsq(M, wet[s:e, 0], rcond=None)[0]
        gr = np.linalg.lstsq(M, wet[s:e, 1], rcond=None)[0]
        q = (np.sum((wet[s:e, 0] - M @ gl) ** 2) +
             np.sum((wet[s:e, 1] - M @ gr) ** 2))
        tot = np.sum(wet[s:e, 0] ** 2) + np.sum(wet[s:e, 1] ** 2)
        return gl, gr, np.sqrt(q / max(tot, 1e-18)) * 100

    def refit_delays(taps, s, e, span=1.5):
        """Coordinate descent on existing tap delays.  Essential: the LFO keeps
        moving even at SPEED = 0 (~3.2 samples/s), and an un-refitted stale delay
        leaves residual that the arrival detector misreads as a new tap -- on a
        periodic probe it then locks onto comb aliases spaced at half the probe
        period.  Refit first, THEN test for arrivals."""
        taps = list(taps)
        for _ in range(2):
            for j in range(len(taps)):
                best = (1e18, taps[j])
                for d in np.arange(max(taps[j] - span, 1), taps[j] + span, 0.05):
                    trial = taps[:j] + [float(d)] + taps[j + 1:]
                    r = fit(trial, s, e)[2]
                    if r < best[0]:
                        best = (r, float(d))
                taps[j] = best[1]
        return taps

    taps, out, pos = [], [], 0
    for _ in range(max_taps):
        n, hit, tt, last_refit = pos + 1, None, list(taps), -10 ** 9
        while n < N - win - 10:
            seg = wet[n:n + 120]
            sig = np.sqrt((seg ** 2).mean())
            if taps:
                s0 = max(n - 500, 1)
                if n - last_refit > 400 and n - s0 > 200:
                    tt, last_refit = refit_delays(taps, s0, n), n
                gl, gr, _ = fit(tt, s0, n)
                M = basis(tt, n, n + 120)
                lev = np.sqrt(((seg[:, 0] - M @ gl) ** 2 +
                               (seg[:, 1] - M @ gr) ** 2).mean())
                # a new tap must explain a real share of the local signal, not
                # just leave a bit of drift residue
                new = lev > thresh and lev > 0.30 * sig
            else:
                lev, new = sig, sig > thresh
            if new:
                hit = n
                break
            n += 8
        if hit is None:
            break
        # a genuine arrival at sample n must have delay ~= n (the buffer only
        # just filled), which pins the search window and kills alias solutions
        s, e = hit + 10, hit + win
        base = refit_delays(taps, s, e) if taps else []
        best = (1e18, None)
        for d in np.arange(max(hit - 30, 1), hit + 45, 0.05):
            r = fit(base + [float(d)], s, e)[2]
            if r < best[0]:
                best = (r, d)
        taps = base + [float(best[1])]
        gl, gr, r = fit(taps, s, e)
        out.append((taps[-1] / sr * 1e3, gl.copy(), gr.copy(), r))
        pos = hit + 60
    return out


def cross_from_taps(gl, gr, i):
    """Given the fitted gain vectors and a tap index, report that tap's
    L->R and R->L leak ratios.  For a symmetric cross matrix these agree and
    equal CROSS/100."""
    return gr[i] / gl[i], gl[i] / gr[i]


def unpan(gl_i, gr_i, c):
    """Remove the cross matrix from one tap's observed channel gains, giving the
    voice's true PAN gains (p_left, p_right).  Voices are panned, not assigned to
    a bank -- see FLANGUS_FINDINGS.md section 1.4."""
    d = 1 - c * c
    return (gl_i - c * gr_i) / d, (gr_i - c * gl_i) / d


# ------------------------------------------------------------------------- main
def main(argv):
    dry, sr = read_wav(argv[1])
    for path in argv[2:]:
        wet, _ = read_wav(path)
        n = int(re.search(r'order\s*(\d+)', path).group(1)) if re.search(r'order\s*(\d+)', path) else 1
        print("=" * 72); print(path)

        print("  -- onset staircase (absolute delays) --")
        ot = onset_taps(dry, wet, sr)
        for i, (d, gl, gr, r) in enumerate(ot):
            lr, rl = cross_from_taps(gl, gr, i)
            print(f"    tap{i+1}: {d:9.4f} ms   L {gl[i]:+.5f}  R {gr[i]:+.5f}"
                  f"   leak L->R {lr:+.5f} / R->L {rl:+.5f}   resid {r:.2f}%")

        c, resid = solve_cross(dry, wet, sr)
        print(f"  CROSS coefficient c = {c:+.4f}   (flatness residual {resid:.2e})")
        for i, (d, gl, gr, r) in enumerate(ot):
            p, q = unpan(gl[i], gr[i], c)
            print(f"    tap{i+1} pan gains (cross removed): L {p:+.5f}  R {q:+.5f}")
        for ch, nm in ((0, "L"), (1, "R")):
            it = identify_interpolator(dry, wet, sr, c, ch)
            print(f"  [{nm}] interpolator @ {it['freq']:.0f} Hz: "
                  f"linear {it['linear_resid_pct']:.2f}%  vs  flat {it['flat_resid_pct']:.2f}%"
                  f"   frac offset {it['frac_offset']:.2f}")
            for r, m, lo, hi in absolute_delay(dry, wet, sr, c, ch)[:2]:
                print(f"        abs delay candidate  {lo:7.4f} .. {hi:7.4f} ms "
                      f"(exc {hi-lo:.4f})  resid {r:.2f}%")
        lfo = fit_lfo(dry, wet, sr, c)
        tag = "  <-- DEGENERATE: render is shorter than one LFO cycle" if lfo['degenerate'] else ""
        print(f"  LFO rate {lfo['rate_hz']:.4f} Hz{tag}")
        for nm, r in zip("LR", lfo['channels']):
            print(f"        {nm}: centre {r['centre_ms']:+8.3f} ms  amp {r['amp_ms']:.3f} ms  "
                  f"phase {r['phase_deg']:6.1f} deg")
        if n > 1:
            for ch, nm in ((0, "L"), (1, "R")):
                v = esprit_voices(dry, wet, sr, c, ch, n)
                print(f"  [{nm}] {n} voices  delays(mod {1e3/(2*F0):.3f} ms) "
                      f"{np.round(v['delays_ms_mod'],4)}  gains {np.round(v['gains'],3)}")


if __name__ == "__main__":
    main(sys.argv)
