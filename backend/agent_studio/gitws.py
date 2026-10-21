"""Git inspection of a workspace for the workflow (P00-S06).

Every call is an argv (no shell) with options that stop repository configuration from running programs:
an agent can edit .git/config, so fsmonitor, hooks, external diff drivers, and textconv filters are disabled.
"""
from __future__ import annotations

import os
import shutil
import subprocess
from typing import List, Optional, Tuple

from .protocol import AsError

WORKSPACE_NOT_GIT = "WORKSPACE_NOT_GIT"
WORKSPACE_DIRTY = "WORKSPACE_DIRTY"
GIT_FAILED = "GIT_FAILED"
SAFE = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "diff.external=",
        "-c", "core.pager=cat", "-c", "color.ui=false"]
MAX_DIFF_BYTES = 512 * 1024
MAX_UNTRACKED_FILE = 256 * 1024


def _git() -> str:
    return shutil.which("git") or "/usr/bin/git"


def run(workspace: str, *args: str, check: bool = True, timeout: float = 60) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    try:
        p = subprocess.run([_git(), "-C", workspace] + SAFE + list(args), stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        raise AsError(GIT_FAILED, f"git could not be run: {e}")
    if check and p.returncode != 0:
        raise AsError(GIT_FAILED, f"git {args[0]} failed: {p.stderr.decode('utf-8', 'replace').strip()[:500]}")
    return p


def require_repo(workspace: str) -> str:
    p = run(workspace, "rev-parse", "--show-toplevel", check=False)
    if p.returncode != 0:
        raise AsError(WORKSPACE_NOT_GIT, f"{workspace} is not a git repository; the workflow needs one to record "
                                         "a base commit and diffs.", remediation="git init && git add -A && git commit")
    top = os.path.realpath(p.stdout.decode().strip())
    if top != os.path.realpath(workspace):
        raise AsError(WORKSPACE_NOT_GIT, f"The workspace must be the repository root ({top}).")
    head = run(workspace, "rev-parse", "--verify", "HEAD^{commit}", check=False)
    if head.returncode != 0:
        raise AsError(WORKSPACE_NOT_GIT, "The repository has no commits yet.", remediation="Make an initial commit.")
    return head.stdout.decode().strip()


def dirty_entries(workspace: str) -> List[str]:
    out = run(workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
    return [e.decode("utf-8", "replace") for e in out.split(b"\0") if e]


def untracked(workspace: str) -> List[str]:
    out = run(workspace, "ls-files", "--others", "--exclude-standard", "-z").stdout
    return [e.decode("utf-8", "surrogateescape") for e in out.split(b"\0") if e]


def capture_diff(workspace: str, base: str, out_dir: str) -> dict:
    """Write diff.patch (tracked changes vs base, plus new untracked files) and untracked.txt into out_dir."""
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    tracked = run(workspace, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", base, "--").stdout
    stat = run(workspace, "diff", "--no-ext-diff", "--no-color", "--numstat", base, "--").stdout.decode("utf-8", "replace")
    parts, truncated = [tracked], False
    files = untracked(workspace)
    for rel in files:
        path = os.path.join(workspace, rel)
        try:
            if os.path.islink(path) or not os.path.isfile(path) or os.path.getsize(path) > MAX_UNTRACKED_FILE:
                parts.append(f"# untracked (not inlined): {rel}\n".encode("utf-8", "surrogateescape"))
                continue
        except OSError:
            continue
        p = run(workspace, "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--binary", "--",
                "/dev/null", rel, check=False)
        parts.append(p.stdout)
    blob = b"".join(parts)
    if len(blob) > MAX_DIFF_BYTES:
        blob, truncated = blob[:MAX_DIFF_BYTES] + b"\n# ... diff truncated by Agent Studio ...\n", True
    diff_path = os.path.join(out_dir, "diff.patch")
    _write(diff_path, blob)
    _write(os.path.join(out_dir, "untracked.txt"), "\n".join(files).encode("utf-8", "surrogateescape"))
    changed = [l.split("\t", 2)[-1] for l in stat.splitlines() if l.count("\t") >= 2]
    return {"path": diff_path, "bytes": len(blob), "truncated": truncated, "changedFiles": changed[:200],
            "untrackedFiles": files[:200], "empty": not tracked and not files}


def _write(path: str, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
