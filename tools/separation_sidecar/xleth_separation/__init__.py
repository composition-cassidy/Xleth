"""XLETH separation sidecar — Phase 4 (P4-1).

A local FastAPI service that runs source-separation models out-of-process and
hands finished stems back as WAV files on disk. It exists because the models
live in the PyTorch/ONNX ecosystem and the XLETH engine is C++/JUCE; running
them in-process would mean embedding a second runtime in the audio engine for
an operation that is offline, minutes long, and never real-time.
"""

from .manifest import Manifest, ModelSpec, load_manifest  # noqa: F401

__version__ = "1.0.0"
