"""State-directory resolution and filesystem checks."""
from __future__ import annotations

import os
import re
from typing import Optional

from .protocol import AsError, STATE_DIR_UNUSABLE

# Filesystems that are Windows drives or network mounts from WSL's point of view.
NON_NATIVE_FS = {"9p", "drvfs", "fuse.drvfs", "v9fs", "cifs", "smb3", "smbfs", "nfs", "nfs4", "fuse.sshfs"}


def raw_state_dir() -> str:
    base = os.environ.get("XDG_STATE_HOME") or ""
    if not os.path.isabs(base):
        base = os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "agent-studio")


def _unescape_mount(s: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), s)


def nearest_existing(path: str) -> str:
    path = os.path.realpath(path)
    while not os.path.exists(path) and path != "/":
        path = os.path.dirname(path)
    return path


def mount_fstype(path: str) -> Optional[str]:
    target = nearest_existing(path)
    best_mp, best_fs = "", None
    try:
        with open("/proc/self/mountinfo", encoding="utf-8", errors="replace") as f:
            for line in f:
                left, _, right = line.partition(" - ")
                fields = left.split()
                if len(fields) < 5 or not right:
                    continue
                mp = _unescape_mount(fields[4])
                fstype = right.split()[0]
                prefix = mp.rstrip("/") + "/"
                if (target == mp or target.startswith(prefix)) and len(mp) >= len(best_mp):
                    best_mp, best_fs = mp, fstype
    except OSError:
        return None
    return best_fs


def is_windows_or_network_path(path: str) -> bool:
    rp = os.path.realpath(path)
    if rp == "/mnt" or rp.startswith("/mnt/"):
        return True
    return mount_fstype(rp) in NON_NATIVE_FS


def ensure_state_dir() -> str:
    sd = os.path.realpath(raw_state_dir())
    remediation = "Unset XDG_STATE_HOME or point it at a writable WSL-native directory such as ~/.local/state."
    if is_windows_or_network_path(sd):
        raise AsError(STATE_DIR_UNUSABLE, f"State directory {sd} is on a Windows or network filesystem.",
                      remediation=remediation)
    try:
        os.makedirs(sd, mode=0o700, exist_ok=True)
        os.chmod(sd, 0o700)
    except OSError as e:
        raise AsError(STATE_DIR_UNUSABLE, f"Cannot create state directory {sd}: {e.strerror}.", remediation=remediation)
    if not os.access(sd, os.W_OK | os.X_OK):
        raise AsError(STATE_DIR_UNUSABLE, f"State directory {sd} is not writable.", remediation=remediation)
    return sd
