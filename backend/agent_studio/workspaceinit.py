"""Canonical scaffolding for a workspace's ``.agent-studio`` directory.

Creating a workspace is more than registering its identity: the app opens Boards, Roles, Agents and
Workflows against the same directory immediately. This module writes the files those readers require,
using the defaults owned by each feature (and therefore the same schema versions their loaders accept).

Every operation only creates what is missing. Existing user files are never overwritten, so a repeated
``workspace.init`` (or a retry after a partial failure) finishes the missing scaffolding and leaves the
rest byte-for-byte unchanged.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time

from . import agentcatalog, boardmodel, delegation, paths, providers, roles, state, validation
from .protocol import AsError, BAD_REQUEST
from .store import Store

CONFIG_DIR = boardmodel.CONFIG_DIR
DIRECTORIES = (
    CONFIG_DIR,
    os.path.join(CONFIG_DIR, "roles"),
    os.path.join(CONFIG_DIR, "skills"),
    os.path.join(CONFIG_DIR, "teams"),
    os.path.join(CONFIG_DIR, "workflows"),
    os.path.join(CONFIG_DIR, "workflows", "prompts"),
)
_REMEDIATION = ("Fix the path named above and run agent-studio init again; existing files are kept and "
                "missing ones are completed.")


def documents() -> dict:
    """Relative file name -> canonical document, built by each feature's own default."""
    return {
        "board.json": boardmodel.default_config(),
        "roles.json": roles.default_config(),
        "agents.json": agentcatalog.default_catalog(),
        "workflow.json": validation.default_config(),
        "commands.json": delegation.default_config(),
        "permissions.json": providers.default_permissions(),
    }


def _ensure_dir(path: str) -> None:
    if os.path.isdir(path):
        return
    try:
        os.makedirs(path, exist_ok=True)
    except FileExistsError:
        pass
    if not os.path.isdir(path):
        raise AsError(BAD_REQUEST, f"Workspace initialization cannot create {path}: it exists and is not a directory.",
                      remediation=_REMEDIATION)


def _create_file(path: str, data: bytes) -> bool:
    """Create ``path`` without replacing anything; True when this call created it."""
    if os.path.lexists(path):
        if not os.path.isfile(path):
            raise AsError(BAD_REQUEST, f"Workspace initialization cannot create {path}: it exists and is not a file.",
                          remediation=_REMEDIATION)
        return False
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:  # another initializer won the race; its file is the user's file
        return False
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return True


def ensure(workspace: str) -> list:
    """Create every missing directory and file; return the relative paths created."""
    created = []
    try:
        for rel in DIRECTORIES:
            _ensure_dir(os.path.join(workspace, rel))
        for name, doc in documents().items():
            rel = os.path.join(CONFIG_DIR, name)
            data = (json.dumps(doc, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
            if _create_file(os.path.join(workspace, rel), data):
                created.append(rel)
    except AsError:
        raise
    except OSError as e:
        raise AsError(BAD_REQUEST, f"Workspace initialization failed: {e}", remediation=_REMEDIATION)
    ensure_runtime(workspace)
    return created


def ensure_runtime(workspace: str) -> None:
    """Ensure the persistent board/default phase exists, repairing old partial workspaces."""
    for tries in range(6):
        conn = None
        try:
            sd = paths.ensure_state_dir()
            conn = state.connect(state.db_path(sd), role="coordinator", create=True)
            state.migrate(conn, state.db_path(sd))
            with Store(conn).transaction() as tx:
                boardmodel.ensure_board(tx, workspace)
            return
        except AsError:
            raise
        except sqlite3.OperationalError as e:
            if "locked" not in str(e) and "busy" not in str(e):
                raise AsError(BAD_REQUEST, f"Workspace runtime initialization failed: {e}", remediation=_REMEDIATION)
            if tries == 5:
                raise AsError(BAD_REQUEST, f"Workspace runtime initialization failed: {e}", remediation=_REMEDIATION)
            time.sleep(0.1 * (2 ** tries))
        except Exception as e:
            raise AsError(BAD_REQUEST, f"Workspace runtime initialization failed: {e}", remediation=_REMEDIATION)
        finally:
            if conn is not None:
                conn.close()
