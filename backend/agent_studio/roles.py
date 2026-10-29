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

import copy
import tempfile
import hashlib
import contextvars
import json
import os
import re
from typing import Optional

from .protocol import AsError, CONFIG_CHANGED, ROLE_EXISTS, ROLE_NOT_FOUND

MAX_NAME_CHARS = 80
ROLES_CONFIG_INVALID = "ROLES_CONFIG_INVALID"
CONFIG_DIR = ".agent-studio"
SKILL_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ROLE_FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
DIRECT_TASK_KEYS = {"workspace", "mergeOnSuccess", "baseBranch", "onMergeConflict"}
LIMITS = {"description": 2000, "instructions": 16 * 1024, "skill": 32 * 1024, "total": 96 * 1024}
_catalog_snapshot = contextvars.ContextVar("role_catalog_snapshot", default=None)
_catalog_reader = contextvars.ContextVar("role_catalog_reader", default=None)


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


def _context_read(path, limit):
    reader = _catalog_reader.get()
    if reader is None:
        return _read(path, limit)
    return reader(path, limit)


def load_config(workspace: str) -> Optional[dict]:
    path = os.path.join(workspace, CONFIG_DIR, "roles.json")
    snapshot = _catalog_snapshot.get()
    if snapshot is not None and snapshot[0] == workspace:
        raw = snapshot[1]
    else:
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
        direct = spec.get("directTask")
        if direct is not None:
            if not isinstance(direct, dict) or set(direct) - DIRECT_TASK_KEYS:
                raise AsError(ROLES_CONFIG_INVALID, f"roles.{name}.directTask must contain only workspace, "
                                                    "mergeOnSuccess, baseBranch and onMergeConflict.")
            if direct.get("workspace") not in ("main", "worktree"):
                raise AsError(ROLES_CONFIG_INVALID, f"roles.{name}.directTask.workspace must be main or worktree.")
            if "mergeOnSuccess" in direct and not isinstance(direct["mergeOnSuccess"], bool):
                raise AsError(ROLES_CONFIG_INVALID,
                              f"roles.{name}.directTask.mergeOnSuccess must be true or false.")
            if direct.get("mergeOnSuccess") and direct.get("workspace") != "worktree":
                raise AsError(ROLES_CONFIG_INVALID,
                              f"roles.{name}.directTask.mergeOnSuccess requires workspace worktree.")
            base_branch = direct.get("baseBranch", "main")
            if not isinstance(base_branch, str) or not BRANCH_RE.match(base_branch) or ".." in base_branch:
                raise AsError(ROLES_CONFIG_INVALID,
                              f"roles.{name}.directTask.baseBranch must be a safe Git branch name.")
            conflict_status = direct.get("onMergeConflict")
            if conflict_status is not None and (not isinstance(conflict_status, str)
                                                or not SKILL_RE.match(conflict_status)):
                raise AsError(ROLES_CONFIG_INVALID,
                              f"roles.{name}.directTask.onMergeConflict must be a status slug.")
    return raw


def direct_task_config(workspace: str, role: str) -> dict:
    """Return the role's one-off task isolation policy, with backwards-compatible main-checkout defaults."""
    spec = ((load_config(workspace) or {}).get("roles") or {}).get(role) or {}
    configured = spec.get("directTask") or {}
    return {"workspace": configured.get("workspace", "main"),
            "mergeOnSuccess": bool(configured.get("mergeOnSuccess", False)),
            "baseBranch": configured.get("baseBranch", "main"),
            "onMergeConflict": configured.get("onMergeConflict")}


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
            content = _context_read(path, LIMITS["instructions"])
            if content is None:
                warnings.append(f"role instructions file {CONFIG_DIR}/{instructions_rel} not found")
            else:
                text, sha, n, cut = content
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
        content = _context_read(path, LIMITS["skill"])
        if content is None:
            warnings.append(f"skill {name!r} not found at {CONFIG_DIR}/skills/{name}/SKILL.md")
            continue
        text, sha, n, cut = content
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


def _invalid_mutation(problems):
    raise AsError(ROLES_CONFIG_INVALID, "Invalid role configuration.", data={"problems": problems})


def _mutation_input(values, prefix, create=False):
    problems = []
    if not isinstance(values, dict):
        _invalid_mutation([{"path": prefix, "message": "must be an object"}])
    allowed = {"name", "description", "skills"} | ({"id"} if create else set())
    for key in values.keys() - allowed:
        problems.append({"path": f"{prefix}.{key}", "message": "unknown field"})
    if not create and not values:
        problems.append({"path": prefix, "message": "must not be empty"})
    if create and "name" not in values:
        problems.append({"path": f"{prefix}.name", "message": "is required"})
    cleaned = dict(values)
    for key, limit in (("name", MAX_NAME_CHARS), ("description", LIMITS["description"])):
        if key not in values:
            continue
        value = values[key]
        if value is None and (key == "description" or not create):
            continue
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
            problems.append({"path": f"{prefix}.{key}", "message": f"must be text containing 1..{limit} characters after trimming"})
        else:
            cleaned[key] = value.strip()
    if "skills" in values:
        skills = values["skills"]
        if not isinstance(skills, list):
            problems.append({"path": f"{prefix}.skills", "message": "must be an array"})
        else:
            seen = set()
            for i, skill in enumerate(skills):
                if not isinstance(skill, str) or not SKILL_RE.fullmatch(skill):
                    problems.append({"path": f"{prefix}.skills[{i}]", "message": "invalid skill id"})
                elif skill in seen:
                    problems.append({"path": f"{prefix}.skills[{i}]", "message": "duplicate skill id"})
                else:
                    seen.add(skill)
    if problems:
        _invalid_mutation(problems)
    return cleaned


def _mutation_load(workspace, expected):
    path = os.path.join(workspace, CONFIG_DIR, "roles.json")
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        data = None
    sha = hashlib.sha256(data).hexdigest() if data is not None else None
    if expected is not None and expected != sha:
        raise AsError(CONFIG_CHANGED, ".agent-studio/roles.json changed since it was read; reload and retry.", data={"sha256": sha})
    if data is None:
        return path, data, {"version": 1, "roles": {}}
    try:
        raw = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise AsError(ROLES_CONFIG_INVALID, f".agent-studio/roles.json is not valid JSON: {exc}")
    token = _catalog_snapshot.set((workspace, raw))
    try:
        load_config(workspace)
    finally:
        _catalog_snapshot.reset(token)
    return path, data, raw


def _catalog_problems(workspace, raw, creating):
    problems = []
    names = {}
    for role_id, spec in raw["roles"].items():
        name = spec.get("name", role_id)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= MAX_NAME_CHARS:
            problems.append({"path": f"roles.{role_id}.name", "message": "Display name must contain 1–80 characters."})
        else:
            normalized = name.strip().casefold()
            if creating and normalized in names:
                problems.append({"path": f"roles.{role_id}.name", "message": "Display name is duplicated."})
            names[normalized] = role_id
        if len(spec.get("description", "")) > LIMITS["description"]:
            problems.append({"path": f"roles.{role_id}.description", "message": "Description exceeds the limit."})
        skills = spec.get("skills", [])
        if len(skills) != len(set(skills)):
            problems.append({"path": f"roles.{role_id}.skills", "message": "A skill id is duplicated."})
        instruction = spec.get("instructions")
        if instruction and _inside(os.path.join(workspace, CONFIG_DIR), instruction) is None:
            problems.append({"path": f"roles.{role_id}.instructions", "message": "Role instructions are invalid."})
    if problems:
        _invalid_mutation(problems)


def _save_role(workspace, path, old, raw, role_id):
    data = (json.dumps(raw, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    changed = data != old
    if changed:
        fd, tmp = tempfile.mkstemp(prefix=".roles.json.", suffix=".tmp", dir=os.path.dirname(path))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise
    spec = raw["roles"][role_id]
    skills = spec.get("skills", [])
    base = os.path.join(workspace, CONFIG_DIR)
    warnings = [f"skill '{skill}' not found at .agent-studio/skills/{skill}/SKILL.md" for skill in skills
                if not (lambda p: p is not None and os.path.isfile(p))(_inside(base, f"skills/{skill}/SKILL.md"))]
    return {"workspace": workspace, "file": "roles.json", "sha256": hashlib.sha256(data).hexdigest(),
            "role": {"id": role_id, "name": spec.get("name", role_id).strip(),
                     "description": spec.get("description"), "skills": skills},
            "changed": changed, "warnings": warnings}


def _check_name(raw, role_id, name, prefix):
    for other, spec in raw["roles"].items():
        if other != role_id and spec.get("name", other).strip().casefold() == name.strip().casefold():
            _invalid_mutation([{"path": f"{prefix}.name", "message": f"display name conflicts with role '{other}' (case-insensitive after trimming)"}])


def create_role(workspace: str, role_input: dict, expected_sha256: Optional[str] = None) -> dict:
    from . import teamdefs
    path, old, raw = _mutation_load(workspace, expected_sha256)
    values = _mutation_input(role_input, "role", True)
    role_id = values.get("id", teamdefs.slug(values["name"]))
    if not isinstance(role_id, str) or not teamdefs.SLUG_RE.fullmatch(role_id):
        _invalid_mutation([{"path": "role.id", "message": "must be a lowercase role slug"}])
    if role_id in raw["roles"]:
        raise AsError(ROLE_EXISTS, f"Role '{role_id}' already exists.")
    _catalog_problems(workspace, raw, True)
    _check_name(raw, role_id, values["name"], "role")
    candidate = copy.deepcopy(raw)
    spec = {"name": values["name"], "skills": values.get("skills", [])}
    if values.get("description") is not None:
        spec["description"] = values["description"]
    candidate["roles"][role_id] = spec
    return _save_role(workspace, path, old, candidate, role_id)


def update_role(workspace: str, role_id: str, changes: dict, expected_sha256: Optional[str] = None) -> dict:
    path, old, raw = _mutation_load(workspace, expected_sha256)
    values = _mutation_input(changes, "changes")
    if role_id not in raw["roles"]:
        raise AsError(ROLE_NOT_FOUND, f"Role '{role_id}' is not defined in .agent-studio/roles.json.")
    _catalog_problems(workspace, raw, False)
    candidate = copy.deepcopy(raw)
    spec = candidate["roles"][role_id]
    for key, value in values.items():
        if value is None:
            spec.pop(key, None)
        else:
            spec[key] = value
    _check_name(candidate, role_id, spec.get("name", role_id), "changes")
    # A semantic no-op must retain the original bytes and inode.
    if candidate == raw:
        result = _save_role_result_noop(workspace, old, candidate, role_id)
        return result
    return _save_role(workspace, path, old, candidate, role_id)


def _save_role_result_noop(workspace, old, raw, role_id):
    spec = raw["roles"][role_id]
    skills = spec.get("skills", [])
    base = os.path.join(workspace, CONFIG_DIR)
    warnings = [f"skill '{skill}' not found at .agent-studio/skills/{skill}/SKILL.md" for skill in skills
                if not (lambda p: p is not None and os.path.isfile(p))(_inside(base, f"skills/{skill}/SKILL.md"))]
    return {"workspace": workspace, "file": "roles.json", "sha256": hashlib.sha256(old).hexdigest(),
            "role": {"id": role_id, "name": spec.get("name", role_id).strip(), "description": spec.get("description"), "skills": skills},
            "changed": False, "warnings": warnings}
