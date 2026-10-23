"""Coordinator-owned Git worktree and commit operations."""
from __future__ import annotations

import fnmatch
import hashlib
import os
import posixpath
import re
from typing import Iterable, Optional

from . import gitws, paths
from .protocol import (AsError, BAD_REQUEST, MAIN_CHECKOUT_WRONG_BRANCH,
                       STATE_DIR_UNUSABLE, WORKTREE_EXISTS, WORKTREE_NOT_REGISTERED)

_KEY_RE = re.compile(r"^T-\d{3,}$")
_SLUG_RE = re.compile(r"^[a-z0-9-]{1,40}$")
_TRUNCATION = b"\n# ... diff truncated by Agent Studio ...\n"


def _state_dir(state_dir: Optional[str]) -> str:
    state = paths.ensure_state_dir() if state_dir is None else os.path.realpath(state_dir)
    if paths.is_windows_or_network_path(state):
        raise AsError(STATE_DIR_UNUSABLE, f"State directory {state} is on a Windows or network filesystem.")
    return state


def root_for(workspace: str, *, state_dir: Optional[str] = None) -> str:
    """Return the native state root used for this repository's worktrees."""
    state = _state_dir(state_dir)
    workspace = os.path.realpath(workspace)
    digest = hashlib.sha256(workspace.encode("utf-8", "surrogateescape")).hexdigest()[:12]
    return os.path.realpath(os.path.join(state, "worktrees", digest))


def slug(title: str) -> str:
    value = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:40].strip("-")
    return value or "ticket"


def _under(path: str, root: str) -> bool:
    path, root = os.path.realpath(path), os.path.realpath(root)
    return path != root and os.path.commonpath((path, root)) == root


def _git_error(command: str, result) -> None:
    raise AsError(gitws.GIT_FAILED,
                  f"git {command} failed: {result.stderr.decode('utf-8', 'replace').strip()[:500]}")


def create(workspace: str, key: str, slug: str, base_branch: str, *, state_dir: Optional[str] = None) -> dict:
    workspace = os.path.realpath(workspace)
    if not _KEY_RE.fullmatch(key) or not _SLUG_RE.fullmatch(slug):
        raise AsError(BAD_REQUEST, "Worktree key or slug is invalid.")
    root = root_for(workspace, state_dir=state_dir)
    target = os.path.realpath(os.path.join(root, key))
    branch = f"ticket/{key}-{slug}"
    exists = gitws.run(workspace, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}", check=False)
    if exists.returncode == 0 or os.path.lexists(target):
        raise AsError(WORKTREE_EXISTS, "The ticket branch or worktree already exists.")
    if exists.returncode not in (0, 1):
        _git_error("show-ref", exists)
    base = gitws.run(workspace, "rev-parse", "--verify", f"{base_branch}^{{commit}}")
    os.makedirs(root, mode=0o700, exist_ok=True)
    gitws.run(workspace, "worktree", "add", "-b", branch, target, base_branch)
    return {"branch": branch, "path": target, "baseCommit": base.stdout.decode().strip()}


def list_registered(workspace: str, *, state_dir: Optional[str] = None) -> list[dict]:
    workspace = os.path.realpath(workspace)
    root = root_for(workspace, state_dir=state_dir)
    fields = gitws.run(workspace, "worktree", "list", "--porcelain", "-z").stdout.split(b"\0")
    records, record = [], {}
    for raw in fields:
        if not raw:
            continue
        field = raw.decode("utf-8", "surrogateescape")
        if field.startswith("worktree "):
            if record:
                records.append(record)
            record = {"path": os.path.realpath(field[9:])}
        elif field.startswith("HEAD "):
            record["head"] = field[5:]
        elif field.startswith("branch "):
            ref = field[7:]
            record["branch"] = ref[11:] if ref.startswith("refs/heads/") else ref
        elif field == "detached":
            record["branch"] = None
    if record:
        records.append(record)
    return [{"path": record["path"], "branch": record.get("branch"), "head": record.get("head")}
            for record in records if _under(record["path"], root)]


def remove(workspace: str, path: str, *, state_dir: Optional[str] = None) -> None:
    workspace = os.path.realpath(workspace)
    target = os.path.realpath(path)
    if not _under(target, root_for(workspace, state_dir=state_dir)):
        raise AsError(WORKTREE_NOT_REGISTERED, "Worktree path is not under this workspace's worktree root.")
    gitws.run(workspace, "worktree", "remove", "--force", target)
    gitws.run(workspace, "worktree", "prune")


def discard(workspace: str, created: dict, *, state_dir: Optional[str] = None) -> None:
    """Remove only a worktree and branch returned by create()."""
    remove(workspace, created["path"], state_dir=state_dir)
    gitws.run(os.path.realpath(workspace), "branch", "-D", created["branch"])


def commit_round(path: str, message: str) -> dict:
    path = os.path.realpath(path)
    gitws.run(path, "add", "-A")
    changed = gitws.run(path, "diff", "--cached", "--quiet", check=False)
    if changed.returncode == 0:
        return {"commit": None}
    if changed.returncode != 1:
        _git_error("diff", changed)
    gitws.run(path, "commit", "-m", message)
    commit = gitws.run(path, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip()
    return {"commit": commit}


def branch_diff(workspace: str, base_branch: str, branch: str, out_dir: str) -> dict:
    workspace, out_dir = os.path.realpath(workspace), os.path.realpath(out_dir)
    merge_base = gitws.run(workspace, "merge-base", base_branch, branch).stdout.decode().strip()
    blob = gitws.run(workspace, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--binary",
                     merge_base, branch, "--").stdout
    stat = gitws.run(workspace, "diff", "--no-ext-diff", "--no-color", "--numstat", merge_base, branch,
                     "--").stdout.decode("utf-8", "replace")
    truncated = len(blob) > gitws.MAX_DIFF_BYTES
    if truncated:
        blob = blob[:gitws.MAX_DIFF_BYTES] + _TRUNCATION
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    diff_path = os.path.realpath(os.path.join(out_dir, "diff.patch"))
    gitws._write(diff_path, blob)
    changed = [line.split("\t", 2)[-1] for line in stat.splitlines() if line.count("\t") >= 2]
    return {"path": diff_path, "bytes": len(blob), "truncated": truncated,
            "changedFiles": changed[:200], "empty": not blob}


def changed_paths(workspace: str) -> list[str]:
    raw = gitws.run(os.path.realpath(workspace), "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
    fields, result, index = raw.split(b"\0"), set(), 0
    while index < len(fields):
        entry = fields[index]
        index += 1
        if not entry:
            continue
        text = entry.decode("utf-8", "surrogateescape")
        if len(text) < 4:
            continue
        result.add(text[3:])
        if text[:1] in ("R", "C") or text[1:2] in ("R", "C"):
            if index < len(fields) and fields[index]:
                result.add(fields[index].decode("utf-8", "surrogateescape"))
            index += 1
    return sorted(result)


def check_paths(paths: Iterable[str], allowed_globs: Iterable[str], *, max_paths: Optional[int] = None) -> tuple[bool, list[str]]:
    values, globs = list(paths), list(allowed_globs)
    if max_paths is not None and len(values) > max_paths:
        return False, sorted(values)
    offending = []
    for path in values:
        invalid = (not isinstance(path, str) or not path or path.startswith("/") or "\\" in path
                   or ".." in path.split("/") or path != posixpath.normpath(path))
        if invalid or not any(fnmatch.fnmatchcase(path, pattern) for pattern in globs):
            offending.append(path)
    return not offending, sorted(offending)


def commit_paths(workspace: str, base_branch: str, paths_to_commit: list[str], message: str) -> dict:
    if not paths_to_commit:
        return {"commit": None}
    workspace = os.path.realpath(workspace)
    branch = gitws.run(workspace, "symbolic-ref", "--short", "-q", "HEAD", check=False)
    if branch.returncode not in (0, 1):
        _git_error("symbolic-ref", branch)
    if branch.returncode != 0 or branch.stdout.decode().strip() != base_branch:
        raise AsError(MAIN_CHECKOUT_WRONG_BRANCH, "The main checkout is not on its configured base branch.")
    gitws.run(workspace, "add", "-A", "--", *paths_to_commit)
    gitws.run(workspace, "commit", "-m", message, "--", *paths_to_commit)
    commit = gitws.run(workspace, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip()
    return {"commit": commit}


def is_clean(workspace: str) -> bool:
    return not gitws.run(os.path.realpath(workspace), "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
