"""Vendored third-party model architectures.

Everything in this package is a VERBATIM copy of upstream source, pinned to a
named commit, carrying its own licence. It is vendored rather than pip-installed
for one measured reason:

    lucidrains' `bs-roformer` on PyPI has moved on from the architecture these
    community checkpoints were trained against. Version 1.2.4 wraps every
    attention and feed-forward block in a hyper-connections residual, so a
    strict load of `becruily_deux.ckpt` reports 1002 missing and 240 unexpected
    parameters. Older releases back to 0.9.2 fail the same way. There is no
    published version of that package which loads this weight.

    ZFTurbo's Music-Source-Separation-Training vendors its own copy, and that is
    the implementation these checkpoints are trained and evaluated with. It
    loads becruily_deux.ckpt strictly: 1188 parameters, 1188 matched, no shape
    mismatches.

This is the same reasoning that puts URLs and checksums in models.json instead
of fetching an upstream manifest at runtime: an upstream edit must not be able
to silently change what we run. See VENDOR-NOTICE.md for provenance and the
exact edits made.
"""
