"""Tuning constants, split by provenance.

Two groups live here and they must not be confused:

ENGINE FACTS are not tunable. They are transcriptions of numbers baked into the
shipping C++ audio path. Changing one here does not change the engine; it only
makes this tool stop emulating it. Each carries the source line it mirrors.

ANALYSIS POLICY values are starting policies, not calibrated ones. They mirror
``engine/src/dsp/LoopOptimizer.h`` so the Python reference and the (partial) C++
implementation agree on what they are looking at. That header documents the
reasoning behind each at length; the short form is repeated here.

Deliberately absent: any weight, threshold or score that would decide whether a
loop is "good". Ranking is a later phase. See ``metrics.py``.
"""

from __future__ import annotations

# ── Engine facts (transcribed, not tunable) ──────────────────────────────────

#: Engine mix rate. ``SampleBank`` resamples every loaded sample to this rate and
#: stores ``bufferSampleRate = engineSampleRate`` (engine/src/SampleBank.cpp:96),
#: so all loop points inside the engine are indices into a 48 kHz buffer.
ENGINE_SAMPLE_RATE = 48000.0

#: Boundary fade applied to every sample at load, in seconds
#: (engine/src/SampleBank.cpp:472). Linear, not Hann — unlike the declick.
SAMPLE_BANK_FADE_SEC = 0.002

#: Size of the shared Hann declick lookup table
#: (engine/src/dsp/DeclickEnvelope.h:12). The table is quantised, and the
#: quantisation is observable, so the emulation reproduces the table rather than
#: evaluating the Hann function directly.
DECLICK_LUT_SIZE = 1024

#: Default region declick width in ms. The Sampler's own default; a region that
#: has never had ``setDeclickMs`` called uses this.
DEFAULT_DECLICK_MS = 0.0

# ── Analysis policy (mirrors engine/src/dsp/LoopOptimizer.h) ─────────────────

#: Lowest pitch treated as loopable (LoopOptimizer.h kMinPitchHz).
MIN_PITCH_HZ = 75.0

#: Highest pitch treated as loopable (LoopOptimizer.h kMaxPitchHz). Raised from
#: 500 Hz — that ceiling was inherited from TDPSOLA's *speech* voicing range and
#: made C5 (525 Hz) resolve an octave low.
MAX_PITCH_HZ = 1800.0

#: Per-hop analysis frame and hop, in samples (LoopOptimizer.h kAnalysisFrame /
#: kAnalysisHop). Mirrors TDPSOLA so the two agree on what period they see.
ANALYSIS_FRAME = 2048
ANALYSIS_HOP = 512

#: Level-envelope frame, in ms (LoopOptimizer.h kEnvelopeFrameMs). Deliberately
#: shorter than, and measured separately from, ANALYSIS_FRAME: a level read over
#: a 46 ms frame looks ~46 ms into the future and fires the attack skip early.
ENVELOPE_FRAME_MS = 20.0

#: Fraction of the tonal run's OWN peak RMS a hop must reach to count as past the
#: attack (kAttackSkipFrac) / must hold to remain sustain (kSustainThresholdFrac).
ATTACK_SKIP_FRAC = 0.70
SUSTAIN_THRESHOLD_FRAC = 0.50

#: Fraction of hops that must be voiced for the material to be treated as
#: pitched-monophonic (kMinVoicedFrac). A strict majority.
MIN_VOICED_FRAC = 0.5

#: Half-width of the "at the fundamental" band, as a fraction of the fundamental
#: period (kFundamentalPeriodTolerance). Wide enough for vibrato, far too narrow
#: to admit an octave (0.5x) or subharmonic (2x) lock.
FUNDAMENTAL_PERIOD_TOLERANCE = 0.20

#: Minimum plateau length for a window to be viable, in periods of the lowest
#: supported pitch (kMinViablePeriods).
MIN_VIABLE_PERIODS = 3

#: Longest loop we will propose, in seconds (kMaxLoopDurationSec). Past this a
#: "loop" has become a phrase repeat, which is a different feature.
MAX_LOOP_DURATION_SEC = 2.0

#: Shortest loop we will propose, in seconds. The symmetric counterpart to
#: MAX_LOOP_DURATION_SEC, and it exists because its absence was exploitable: the
#: perceptual ruler scores a one-period zero-crossfade loop perfectly (no blend,
#: so no blend artefact), and ranking on it promoted 85-sample "loops" — 1.9 ms —
#: to first place on three corpus samples. Below roughly this length the loop
#: repetition rate climbs into the roughness band and stops being heard as a
#: loop at all: the result is a static comb tone that no longer resembles the
#: material it was cut from. A policy bound on what counts as a loop, deliberately
#: NOT a quality threshold - the ruler still decides which of the survivors is best.
MIN_LOOP_DURATION_SEC = 0.05

#: Length of the seam correlation window, in periods (kSeamCorrelationPeriods).
SEAM_CORRELATION_PERIODS = 1

#: Minimum seam NCC for a candidate to be returned (kMinSeamNcc). Permissive on
#: purpose: this only drops candidates whose seam regions are unrelated.
MIN_SEAM_NCC = 0.5

# ── YIN parameters ───────────────────────────────────────────────────────────
# The C++ side uses NSDF/McLeod (LoopAnalysis.h computeNSDF). This tool uses YIN
# instead, per the task brief. They agree on octave for this corpus; where they
# would not, the tonal-band gate above is what actually rejects the octave error,
# and that gate is shared. Documented divergence, not an accident.

#: YIN absolute threshold on the cumulative mean normalised difference
#: (de Cheveigne & Kawahara 2002, step 4). 0.1 is the paper's value.
YIN_THRESHOLD = 0.10

# ── Candidate generation ─────────────────────────────────────────────────────

#: Maximum number of loop lengths (values of k) evaluated per sample. A guard
#: against pathological runtime on very short periods, not a quality policy: the
#: k range is normally bounded first by MAX_LOOP_DURATION_SEC and by the length
#: of the search window.
MAX_PERIOD_MULTIPLES = 512

#: Maximum crossfade width considered, in periods, independent of how long the
#: loop itself is (candidates.py still additionally caps the request at
#: floor(len/2), which is what keeps the engine's clamp from ever binding).
#: Without this, a long loop (large k) would sweep O(k) crossfade widths on
#: top of O(k) lengths, making the joint search O(k^2) for no quality benefit:
#: a multi-second crossfade is not a real option a human would pick, and every
#: gold crossfade observed in this corpus sits under 12 periods. 16 gives the
#: joint search headroom beyond every observed gold crossfade while keeping
#: per-sample candidate counts (and therefore the six-metric measurement pass
#: over all of them) tractable. A guard against pathological runtime, exactly
#: like MAX_PERIOD_MULTIPLES above — not a quality policy.
MAX_XFADE_PERIOD_MULTIPLES = 16

# ── Gold comparison tolerances (definition of "match", from the task brief) ──

#: A candidate matches gold's loop POINTS when its start is within this many
#: periods of gold's start, AND its audible advance (loopEnd - loopStart -
#: effXfade — what the ear actually hears repeat, not the raw span) is within
#: this many periods of gold's own resolved advance. Matching on the span
#: instead of the advance was the wrong quantity: gold's advance survives the
#: engine's clamp the same way a candidate's does, and two loops with
#: identical spans but different crossfades repeat at different rates.
GOLD_TOLERANCE_PERIODS = 0.5

#: ...and its crossfade is within this factor of gold's, in either direction.
GOLD_XFADE_TOLERANCE_FACTOR = 2.0
