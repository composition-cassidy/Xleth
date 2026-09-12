"""Entry point: `python -m xleth_separation --port 0 --models-dir ... --work-dir ...`

Port 0 means "let the OS pick", and the chosen port is printed to stdout as a
single machine-readable line:

    XLETH_SIDECAR_READY {"port": 51234, "pid": 9876, "device": "cpu"}

The Electron launcher reads that line rather than probing a guessed port —
guessing races another instance of the app, and probing a fixed port fails on
a machine where something else already holds it.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

import uvicorn

from .app import SidecarConfig, create_app

DEFAULT_MODELS_DIR = Path.home() / ".xleth" / "separation-models"
DEFAULT_WORK_DIR = Path.home() / ".xleth" / "separation-work"

READY_PREFIX = "XLETH_SIDECAR_READY "


def _bind_socket(host: str, port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(64)
    return sock


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="xleth_separation")
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address (loopback only by default, and that is the point)")
    parser.add_argument("--port", type=int, default=0, help="0 = let the OS choose")
    parser.add_argument("--models-dir", default=str(DEFAULT_MODELS_DIR))
    parser.add_argument("--work-dir", default=str(DEFAULT_WORK_DIR))
    parser.add_argument("--token", default=os.environ.get("XLETH_SIDECAR_TOKEN"),
                        help="shared secret required in X-Xleth-Token")
    parser.add_argument("--manifest", default=None, help="override models.json path")
    parser.add_argument("--batch-size", type=int, default=1)
    parser.add_argument("--device", default=None, choices=[None, "cuda", "directml", "cpu"],
                        help="force a device instead of taking the best available")
    parser.add_argument("--log-level", default="warning")
    args = parser.parse_args(argv)

    config = SidecarConfig(
        models_dir=args.models_dir,
        work_dir=args.work_dir,
        token=args.token,
        manifest_path=args.manifest,
        batch_size=args.batch_size,
        prefer_device=args.device,
    )
    app = create_app(config)

    sock = _bind_socket(args.host, args.port)
    port = sock.getsockname()[1]

    def announce() -> None:
        from .mdx import available_device
        payload = {"port": port, "pid": os.getpid(), "device": available_device(),
                   "host": args.host}
        sys.stdout.write(READY_PREFIX + json.dumps(payload) + "\n")
        sys.stdout.flush()

    config = uvicorn.Config(app, log_level=args.log_level, access_log=False)
    server = uvicorn.Server(config)

    # Announce only once uvicorn is ACTUALLY accepting. The port is known the
    # moment the socket is bound, but a client that connects before the server
    # loop is up gets an accepted connection that nobody ever answers — which
    # reads as a hang, not as a refusal, and is far harder to diagnose.
    def announce_when_serving() -> None:
        deadline = time.time() + 120
        while not getattr(server, "started", False) and time.time() < deadline:
            time.sleep(0.02)
        announce()

    threading.Thread(target=announce_when_serving, daemon=True).start()

    # `sockets=[...]` hands uvicorn the already-bound socket object. The
    # `fd=` form of this does NOT work on Windows (there is no usable
    # socket.fromfd there), and its failure mode is the silent one above:
    # connections are accepted by the listen backlog and never served.
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
