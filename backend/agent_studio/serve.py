"""Persistent line-delimited JSON over stdio: one request per line in, one response per line out."""
from __future__ import annotations

import sys

from . import dispatch
from .protocol import AsError, BAD_REQUEST, MAX_LINE_BYTES, dumps, envelope


def run(inp=None, out=None) -> int:
    inp = inp if inp is not None else sys.stdin.buffer
    out = out if out is not None else sys.stdout.buffer
    try:
        while True:
            line = inp.readline(MAX_LINE_BYTES + 1)
            if not line:
                return 0
            if len(line) > MAX_LINE_BYTES and not line.endswith(b"\n"):
                while True:  # discard the rest of the oversized line, keep the session
                    chunk = inp.readline(65536)
                    if not chunk or chunk.endswith(b"\n"):
                        break
                resp = envelope(None, False, error=AsError(BAD_REQUEST, "Request line is too long.").to_error())
            else:
                line = line.rstrip(b"\r\n")
                if not line.strip():
                    continue
                resp = dispatch.handle_bytes(line, require_id=True)
            out.write(dumps(resp) + b"\n")
            out.flush()
    except BrokenPipeError:
        return 0
    except KeyboardInterrupt:
        return 130
