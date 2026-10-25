"""Linux-side chores for the Windows app live check (app/src/live/liveCheck.ts).

Runs inside WSL, stdlib only. Each subcommand prints exactly one JSON line.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import shutil
import signal
import sys

PREFIX = "agent-studio-live-"


def setup(tmp_dir: str = "/tmp") -> dict:
    base = os.path.realpath(tmp_dir)
    root = None
    for _ in range(100):
        candidate = os.path.join(base, PREFIX + secrets.token_hex(6))
        try:
            os.mkdir(candidate, 0o700)
        except FileExistsError:
            continue
        root = candidate
        break
    if root is None:
        raise OSError("could not create a unique temp dir")
    os.mkdir(root + "/state", 0o700)
    os.mkdir(root + "/ws")
    return {"root": root, "state": root + "/state", "workspace": root + "/ws"}


def _read_args(path: str) -> list[str]:
    with open(path, "rb") as f:
        parts = f.read().split(b"\0")
    return [p.decode("utf-8", errors="replace") for p in parts if p]


def find_serve_pids(state: str, proc_root: str = "/proc", uid: int | None = None) -> list[int]:
    if uid is None:
        uid = os.getuid()
    found = []
    for name in os.listdir(proc_root):
        if not name.isdigit():
            continue
        entry = os.path.join(proc_root, name)
        try:
            if os.stat(entry).st_uid != uid:
                continue
            cmdline = _read_args(os.path.join(entry, "cmdline"))
            environ = _read_args(os.path.join(entry, "environ"))
        except OSError:
            continue
        if (
            cmdline
            and cmdline[-1] == "serve"
            and any(a.endswith("/launch.py") for a in cmdline)
            and ("XDG_STATE_HOME=" + state) in environ
        ):
            found.append(int(name))
    return sorted(found)


def kill_serve(state: str, proc_root: str = "/proc") -> dict:
    pids = find_serve_pids(state, proc_root)
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    return {"killed": pids}


def cleanup(root: str, tmp_dir: str = "/tmp", proc_root: str = "/proc") -> dict:
    real = os.path.realpath(root)
    if os.path.dirname(real) != os.path.realpath(tmp_dir) or not os.path.basename(real).startswith(PREFIX):
        raise ValueError(f"refusing to remove {real}: not a {PREFIX}* directory in {tmp_dir}")
    kill_serve(real + "/state", proc_root)
    shutil.rmtree(real)
    return {"removed": real}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="app-live-helper.py")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup")
    sub.add_parser("kill-serve").add_argument("--state", required=True)
    sub.add_parser("cleanup").add_argument("--root", required=True)
    args = parser.parse_args(argv)
    try:
        if args.cmd == "setup":
            result = setup()
        elif args.cmd == "kill-serve":
            result = kill_serve(args.state)
        else:
            result = cleanup(args.root)
    except (ValueError, OSError) as e:
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
