"""Process identity = PID + kernel start time + boot ID. A bare PID is never identity."""
from __future__ import annotations

import fcntl
import json
import os
from typing import Optional


def boot_id() -> str:
    try:
        with open("/proc/sys/kernel/random/boot_id", encoding="ascii") as f:
            return f.read().strip()
    except OSError:
        return ""


def start_time(pid: int) -> Optional[int]:
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            data = f.read()
    except OSError:
        return None
    rest = data[data.rindex(b")") + 2:].split()
    return int(rest[19])  # field 22 (starttime); rest[0] is field 3


def identity(pid: int) -> dict:
    return {"pid": pid, "startTime": start_time(pid), "bootId": boot_id()}


def matches(ident: dict) -> bool:
    pid = ident.get("pid")
    if not isinstance(pid, int) or pid <= 0:
        return False
    return ident.get("bootId") == boot_id() and ident.get("startTime") is not None \
        and start_time(pid) == ident.get("startTime")


def lock_is_held(path: str) -> bool:
    """True if another process holds an exclusive flock on path."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        fcntl.flock(fd, fcntl.LOCK_UN)
        return False
    finally:
        os.close(fd)


def read_json(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def write_json_atomic(path: str, obj) -> None:
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=True)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)
