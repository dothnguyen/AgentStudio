"""Optional keep-alive holder. Started hidden from Windows (scripts/windows/start-keepalive.ps1) so a wsl.exe
client stays attached and the distro is not idle-terminated. health reports whether it is active."""
from __future__ import annotations

import fcntl
import os
import signal
import sys

from . import paths
from .protocol import dumps, envelope


def run() -> int:
    sd = paths.ensure_state_dir()
    fd = os.open(os.path.join(sd, "keepalive.lock"), os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.stdout.buffer.write(dumps(envelope(None, True, data={"keepAlive": "already-active"})) + b"\n")
        return 0
    sys.stdout.buffer.write(dumps(envelope(None, True, data={"keepAlive": "active", "pid": os.getpid()})) + b"\n")
    sys.stdout.flush()
    signal.signal(signal.SIGTERM, lambda s, f: sys.exit(0))
    signal.signal(signal.SIGHUP, lambda s, f: sys.exit(0))
    while True:
        signal.pause()
