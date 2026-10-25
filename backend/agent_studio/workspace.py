"""Workspace identity (.agent-studio/workspace.json), resolution and the registry (workspaces.json)."""
from __future__ import annotations

import json
import os
import uuid

from . import paths
from .protocol import AsError, BAD_REQUEST, WORKSPACE_NOT_FOUND

MARKER_DIR = ".agent-studio"
MARKER_FILE = "workspace.json"
REGISTRY_FILE = "workspaces.json"
_REMEDIATION = "run agent-studio init"


def _marker(path: str) -> str:
    return os.path.join(path, MARKER_DIR, MARKER_FILE)


def _read(path: str) -> dict:
    marker = _marker(path)
    try:
        with open(marker, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise AsError(BAD_REQUEST, f"{marker} is not valid JSON: {e}")
    if (not isinstance(data, dict) or not isinstance(data.get("id"), str) or not data["id"]
            or not isinstance(data.get("name"), str) or not data["name"]):
        raise AsError(BAD_REQUEST, f"{marker} must be a JSON object with string id and name")
    return {"id": data["id"], "name": data["name"], "path": os.path.realpath(path)}


def resolve(cwd: str, override: str | None = None) -> dict:
    if override is not None:
        if not os.path.isfile(_marker(override)):
            raise AsError(WORKSPACE_NOT_FOUND, f"No {MARKER_DIR}/{MARKER_FILE} in {override}.",
                          remediation=_REMEDIATION)
        return _read(override)
    cur = os.path.realpath(cwd)
    while True:
        if os.path.isfile(_marker(cur)):
            return _read(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            raise AsError(WORKSPACE_NOT_FOUND, f"No workspace found at or above {cwd}.", remediation=_REMEDIATION)
        cur = parent


def _registry_path() -> str:
    return os.path.join(paths.ensure_state_dir(), REGISTRY_FILE)


def _load_registry() -> list:
    try:
        with open(_registry_path(), "r", encoding="utf-8") as f:
            items = json.load(f).get("workspaces", [])
    except FileNotFoundError:
        return []
    except (OSError, ValueError, AttributeError) as e:
        raise AsError(BAD_REQUEST, f"{REGISTRY_FILE} is unreadable: {e}")
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _register(ws: dict) -> None:
    items = _load_registry()
    if any(i.get("path") == ws["path"] for i in items):
        return
    items.append({"id": ws["id"], "name": ws["name"], "path": ws["path"]})
    target = _registry_path()
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"workspaces": items}, f, indent=2)
        f.write("\n")
    os.replace(tmp, target)


def init(path: str, name: str | None = None) -> dict:
    if not os.path.isdir(path):
        raise AsError(BAD_REQUEST, f"--path {path} is not an existing directory")
    real = os.path.realpath(path)
    existed = os.path.isfile(_marker(real))
    if not existed:
        os.makedirs(os.path.join(real, MARKER_DIR), exist_ok=True)
        body = {"id": str(uuid.uuid4()), "name": name or os.path.basename(real) or real}
        tmp = _marker(real) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
            f.write("\n")
        os.replace(tmp, _marker(real))
    ws = _read(real)
    _register(ws)
    return dict(ws, existed=existed)


def list_workspaces() -> dict:
    out = []
    for i in _load_registry():
        p = i.get("path")
        entry = {"id": i.get("id"), "name": i.get("name"), "path": p}
        entry["missing"] = not (isinstance(p, str) and os.path.isfile(_marker(p)))
        entry["exists"] = not entry["missing"]
        out.append(entry)
    return {"workspaces": out}
