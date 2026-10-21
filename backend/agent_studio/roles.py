"""Workspace-configured roles, descriptions and skills (P00-S08).

Layout inside the workspace (all optional, all plain files you commit with the project):

    .agent-studio/roles.json            {"version": 1, "roles": {"developer": {"description": "...",
                                                                       "instructions": "roles/developer.md",
                                                                       "skills": ["python-testing"]}}}
    .agent-studio/roles/<role>.md       instructions for a role (used directly when roles.json does not list it)
    .agent-studio/skills/<name>/SKILL.md  one skill
    .agent-studio/team.json             {"version": 1, "agents": [{"providerId": "<id>", "role": "developer",
                                                                    "model": "...", "reasoning": "high"}, ...]}

At every dispatch the agent's role is resolved, bounded, hashed, and placed in front of the prompt as data
(never executed). Paths must stay inside .agent-studio (no '..', no symlink escape). Each provider still reads
its own native files (AGENTS.md, CLAUDE.md, ...) from the workspace as usual.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Optional

from .protocol import AsError

ROLES_CONFIG_INVALID = "ROLES_CONFIG_INVALID"
CONFIG_DIR = ".agent-studio"
SKILL_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ROLE_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")
LIMITS = {"description": 2000, "instructions": 16 * 1024, "skill": 32 * 1024, "total": 96 * 1024}


def _inside(base: str, rel: str) -> Optional[str]:
    if not isinstance(rel, str) or not rel or os.path.isabs(rel) or ".." in rel.replace("\\", "/").split("/"):
        return None
    path = os.path.realpath(os.path.join(base, rel))
    root = os.path.realpath(base)
    return path if path.startswith(root + os.sep) else None


def _read(path: str, limit: int):
    with open(path, "rb") as f:
        data = f.read(limit + 1)
    truncated = len(data) > limit
    data = data[:limit]
    return data.decode("utf-8", "replace"), hashlib.sha256(data).hexdigest(), len(data), truncated


def load_config(workspace: str) -> Optional[dict]:
    path = os.path.join(workspace, CONFIG_DIR, "roles.json")
    if not os.path.exists(path):
        return None
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise AsError(ROLES_CONFIG_INVALID, f"{CONFIG_DIR}/roles.json is not valid JSON: {e}")
    if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("roles"), dict):
        raise AsError(ROLES_CONFIG_INVALID, f'{CONFIG_DIR}/roles.json must be {{"version": 1, "roles": {{...}}}}.')
    for name, spec in raw["roles"].items():
        if not isinstance(spec, dict):
            raise AsError(ROLES_CONFIG_INVALID, f"roles.{name} must be an object.")
        if "description" in spec and not isinstance(spec["description"], str):
            raise AsError(ROLES_CONFIG_INVALID, f"roles.{name}.description must be text.")
        if "instructions" in spec and not isinstance(spec["instructions"], str):
            raise AsError(ROLES_CONFIG_INVALID, f"roles.{name}.instructions must be a relative file path.")
        skills = spec.get("skills", [])
        if not isinstance(skills, list) or not all(isinstance(x, str) and SKILL_RE.match(x) for x in skills):
            raise AsError(ROLES_CONFIG_INVALID, f"roles.{name}.skills must be a list of skill folder names "
                                                "(lowercase letters, digits, '.', '_', '-').")
    return raw


def context_for(workspace: str, role: str) -> dict:
    """The role context placed in front of an agent's prompt: text, sources (path, sha256, bytes), warnings."""
    base = os.path.join(workspace, CONFIG_DIR)
    cfg = load_config(workspace)
    spec = (cfg or {}).get("roles", {}).get(role)
    sources, warnings, parts = [], [], []
    description = None
    instructions_rel = None
    skills = []
    if spec is not None:
        description = spec.get("description")
        instructions_rel = spec.get("instructions")
        skills = spec.get("skills", [])
    elif ROLE_FILE_RE.match(role or "") and os.path.exists(os.path.join(base, "roles", f"{role}.md")):
        instructions_rel = f"roles/{role}.md"
    head = f"===== AGENT STUDIO ROLE: {role} ====="
    body = []
    if description:
        body.append("Description: " + description[:LIMITS["description"]])
    if instructions_rel:
        path = _inside(base, instructions_rel)
        if path is None:
            warnings.append(f"role instructions path {instructions_rel!r} is outside {CONFIG_DIR}; ignored")
        elif not os.path.isfile(path):
            warnings.append(f"role instructions file {CONFIG_DIR}/{instructions_rel} not found")
        else:
            text, sha, n, cut = _read(path, LIMITS["instructions"])
            body.append(text + ("\n[instructions truncated by Agent Studio]" if cut else ""))
            sources.append({"kind": "role", "path": f"{CONFIG_DIR}/{instructions_rel}", "sha256": sha, "bytes": n})
    if not body:
        body.append("(no role description or instructions are configured in this workspace)")
    parts.append(head + "\n" + "\n\n".join(body) + "\n===== END ROLE =====\n")
    total = len(parts[0].encode())
    for name in skills:
        path = _inside(base, f"skills/{name}/SKILL.md")
        if path is None or not os.path.isfile(path):
            warnings.append(f"skill {name!r} not found at {CONFIG_DIR}/skills/{name}/SKILL.md")
            continue
        text, sha, n, cut = _read(path, LIMITS["skill"])
        block = f"===== SKILL: {name} =====\n{text}" + ("\n[skill truncated by Agent Studio]" if cut else "") + \
                "\n===== END SKILL =====\n"
        if total + len(block.encode()) > LIMITS["total"]:
            warnings.append(f"skill {name!r} skipped: role context would exceed {LIMITS['total']} bytes")
            continue
        parts.append(block)
        total += len(block.encode())
        sources.append({"kind": "skill", "name": name, "path": f"{CONFIG_DIR}/skills/{name}/SKILL.md",
                        "sha256": sha, "bytes": n})
    text = "".join(parts)
    return {"role": role, "text": text, "sha256": hashlib.sha256(text.encode()).hexdigest(), "sources": sources,
            "warnings": warnings, "configured": bool(sources or description)}


def load_team(workspace: str) -> list:
    path = os.path.join(workspace, CONFIG_DIR, "team.json")
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        raise AsError("BAD_REQUEST", f"No roster given and no {CONFIG_DIR}/team.json in the workspace.")
    except (OSError, ValueError) as e:
        raise AsError(ROLES_CONFIG_INVALID, f"{CONFIG_DIR}/team.json is not valid JSON: {e}")
    if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("agents"), list):
        raise AsError(ROLES_CONFIG_INVALID, f'{CONFIG_DIR}/team.json must be {{"version": 1, "agents": [...]}}.')
    return raw["agents"]
