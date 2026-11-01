"""Read-only, bounded projection of workspace skills.

A skill is ``.agent-studio/skills/<id>/SKILL.md``. Roles list the skill ids they use in
``.agent-studio/roles.json``. This module only reads: it never creates or writes a file, never
follows a skill symlink, and reports one bad skill in ``problems`` instead of failing the request.
"""
from __future__ import annotations

import codecs
import hashlib
import json
import os
import stat

from . import rolecatalog, roles
from .protocol import BAD_REQUEST, SKILL_NOT_FOUND, AsError

SKILL_FILE = "SKILL.md"
TITLE_CHARS = 120


def _relative(skill: str) -> str:
    return f"skills/{skill}/{SKILL_FILE}"


def _base(workspace: str) -> str:
    return os.path.join(workspace, roles.CONFIG_DIR)


def _lexical(base: str, *parts: str) -> str:
    return os.path.join(os.path.realpath(base), *parts)


def _problem(path: str, message: str) -> dict:
    return {"path": path, "message": message}


def _skills_dir_is_safe(base: str) -> bool:
    path = _lexical(base, "skills")
    try:
        return not os.path.islink(path) and os.path.isdir(path)
    except OSError:
        return False


def _skill_folders(base: str) -> list[str]:
    """Ids of safe, immediate skill folders; a symlinked skills/ or skill folder is ignored."""
    if not _skills_dir_is_safe(base):
        return []
    directory = _lexical(base, "skills")
    found = []
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if not roles.SKILL_RE.fullmatch(entry.name) or entry.is_symlink():
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                except OSError:
                    continue
                if rolecatalog._inside(base, f"skills/{entry.name}") is None:
                    continue
                found.append(entry.name)
    except OSError:
        return []
    return sorted(set(found))


def _empty_item(skill: str, state: str) -> dict:
    return {"id": skill, "path": _relative(skill), "state": state, "title": None,
            "bytes": None, "sha256": None, "roles": []}


def _title(text: str):
    for line in text.splitlines():
        if line.strip():
            return line.lstrip("# ")[:TITLE_CHARS]
    return None


def _read_skill(base: str, skill: str):
    """(item, text) for one folder's SKILL.md; never follows a link or reads an unbounded file."""
    path = _lexical(base, "skills", skill, SKILL_FILE)
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return _empty_item(skill, "missing"), None
    except OSError:
        return _empty_item(skill, "unreadable"), None
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        return _empty_item(skill, "unreadable"), None
    limit = roles.LIMITS["skill"]
    try:
        with os.fdopen(rolecatalog._open_confined(base, path), "rb") as f:
            opened = os.fstat(f.fileno())
            if not stat.S_ISREG(opened.st_mode):
                return _empty_item(skill, "unreadable"), None
            data = f.read(limit + 1)
    except (OSError, ValueError):
        return _empty_item(skill, "unreadable"), None
    cut = len(data) > limit
    kept = data[:limit]
    if cut:
        try:
            codecs.getincrementaldecoder("utf-8")("strict").decode(kept, final=False)
        except UnicodeDecodeError:
            return _empty_item(skill, "unreadable"), None
        text = kept.decode("utf-8", "ignore")
        size = max(opened.st_size, len(data))
    else:
        try:
            text = kept.decode("utf-8")
        except UnicodeDecodeError:
            return _empty_item(skill, "unreadable"), None
        size = len(kept)
    item = {"id": skill, "path": _relative(skill), "state": "truncated" if cut else "ok",
            "title": _title(text), "bytes": size, "sha256": hashlib.sha256(kept).hexdigest(),
            "roles": []}
    return item, text


def _load_catalog(base: str, problems: list):
    """(catalog bytes sha, roles mapping) or (None, {}) after adding exactly one problem."""
    path = _lexical(base, "roles.json")
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        problems.append(_problem("roles.json", "Role catalog is missing."))
        return None, {}
    except OSError:
        problems.append(_problem("roles.json", "Role catalog could not be read."))
        return None, {}
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        problems.append(_problem("roles.json", "Role catalog could not be read as a regular file."))
        return None, {}
    try:
        with os.fdopen(rolecatalog._open_confined(base, path), "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise OSError("not a regular file")
            data = f.read()
    except (OSError, ValueError):
        problems.append(_problem("roles.json", "Role catalog could not be read."))
        return None, {}
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        problems.append(_problem("roles.json", "Role catalog has invalid content or root shape."))
        return None, {}
    if not isinstance(raw, dict) or raw.get("version") != 1 or not isinstance(raw.get("roles"), dict):
        problems.append(_problem("roles.json", "Role catalog has invalid content or root shape."))
        return None, {}
    return hashlib.sha256(data).hexdigest(), raw["roles"]


def _instruction_bytes(base: str, spec: dict) -> int:
    value = spec.get("instructions")
    if not isinstance(value, str) or not value:
        return 0
    path = rolecatalog._inside(base, value)
    if path is None:
        return 0
    content = rolecatalog._resolver_read(base, path, roles.LIMITS["instructions"])
    return 0 if content is None else content[2]


def _role_entries(base: str, catalog: dict, problems: list) -> list:
    """[(id, name, ordered valid skill ids, instruction bytes)] in roles.json order."""
    entries = []
    for role_id, spec in catalog.items():
        if not isinstance(spec, dict):
            problems.append(_problem(f"roles.{role_id}", "Role must be an object."))
            continue
        name = spec.get("name")
        name = name.strip() if isinstance(name, str) and name.strip() else None
        configured = spec.get("skills", [])
        if not isinstance(configured, list):
            problems.append(_problem(f"roles.{role_id}.skills", "Skills must be a list."))
            configured = []
        skills = []
        for skill in configured:
            if not isinstance(skill, str) or not roles.SKILL_RE.fullmatch(skill):
                problems.append(_problem(f"roles.{role_id}.skills", "Skill id is invalid."))
                continue
            if skill not in skills:
                skills.append(skill)
        entries.append((role_id, name, skills, _instruction_bytes(base, spec)))
    return entries


def _build(workspace: str):
    base = _base(workspace)
    problems = []
    roles_sha256, catalog = _load_catalog(base, problems)
    entries = _role_entries(base, catalog, problems)

    items = {}
    texts = {}
    for skill in _skill_folders(base):
        item, text = _read_skill(base, skill)
        items[skill] = item
        if text is not None:
            texts[skill] = text

    listed = {skill for _, _, skills, _ in entries for skill in skills}
    for skill in sorted(listed - set(items)):
        items[skill] = _empty_item(skill, "missing")

    # A folder without SKILL.md that no role lists is not shown.
    for skill in [s for s, item in items.items() if item["state"] == "missing" and s not in listed]:
        del items[skill]

    for skill, item in items.items():
        if item["state"] == "missing":
            problems.append(_problem(item["path"], f"Skill {skill!r} has no readable {SKILL_FILE}."))
        elif item["state"] == "unreadable":
            problems.append(_problem(item["path"], f"Skill {skill!r} could not be read as regular UTF-8 text."))

    role_skills = {role_id: set(skills) for role_id, _, skills, _ in entries}
    for skill, item in items.items():
        for role_id, name, skills, instruction_bytes in entries:
            if skill not in role_skills[role_id]:
                continue
            context = instruction_bytes + sum(items[s]["bytes"] for s in skills
                                             if s in items and items[s]["state"] == "ok")
            item["roles"].append({"id": role_id, "name": name, "contextBytes": context})

    # Keep one problem per path/message even when several roles repeat the same mistake.
    public, seen = [], set()
    for problem in problems:
        key = (problem["path"], problem["message"])
        if key not in seen:
            seen.add(key)
            public.append({"path": problem["path"], "message": problem["message"]})
    result = {"workspace": workspace, "rolesSha256": roles_sha256,
              "limits": {"skillBytes": roles.LIMITS["skill"], "roleContextBytes": roles.LIMITS["total"]},
              "skills": [items[key] for key in sorted(items)], "problems": public}
    return result, texts


def list_skills(workspace: str) -> dict:
    result, _ = _build(workspace)
    return result


def show_skill(workspace: str, skill: str) -> dict:
    if not isinstance(skill, str) or not roles.SKILL_RE.fullmatch(skill):
        raise AsError(BAD_REQUEST, "skill must be a skill folder name (lowercase letters, digits, '.', '_', '-').")
    result, texts = _build(workspace)
    item = next((entry for entry in result["skills"] if entry["id"] == skill), None)
    if item is None:
        raise AsError(SKILL_NOT_FOUND, f"Skill '{skill}' was not found.")
    text = texts.get(skill) if item["state"] in ("ok", "truncated") else None
    return {"workspace": workspace, "skill": item, "text": text}
