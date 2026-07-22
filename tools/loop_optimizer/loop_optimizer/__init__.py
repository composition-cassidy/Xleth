"""Loop-optimizer lab — XLETH auto-loop-optimizer reference implementation.

Phase 1 of the auto loop optimizer: generate candidate loops for monophonic
tonal samples, score them with a six-metric suite computed on an emulation of
XLETH's real sampler render path, and evaluate the result against a gold-labelled
corpus.

This package is measurement infrastructure and nothing else. It deliberately
contains no weight tuning, no accept/reject thresholds and no auto-apply. The
one place an ordering is imposed — picking a "top" candidate so the corpus
report has something to compare against gold — is an explicitly untuned single
metric, selectable on the command line. See ``ranking.py``.

Entry point: ``python -m loop_optimizer report --corpus <dir>``.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
