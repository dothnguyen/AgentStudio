"""Read-only, bounded projection of workspace skills.

A skill is ``.agent-studio/skills/<id>/SKILL.md``. Roles list the skill ids they use in
``.agent-studio/roles.json``. This module only reads: it never creates or writes a file, never
follows a skill symlink, and reports one bad skill in ``problems`` instead of failing the request.
"""
from __future__ import annotations

import codecs
import copy
import hashlib
import json
import os
import re
import stat

from . import rolecatalog, roles
from .protocol import (BAD_REQUEST, CONFIG_CHANGED, ROLE_NOT_FOUND, SKILL_EXISTS, SKILL_IN_USE,
                       SKILL_NOT_FOUND, AsError)

SKILL_FILE = "SKILL.md"
TITLE_CHARS = 120
_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


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


# ---- skill file writes (P07-S02) ------------------------------------------------------------
#
# These commands touch only .agent-studio/skills/<id>/SKILL.md. They deliberately never read or
# write roles.json, so a write keeps working while the role catalog is missing or invalid.

def _valid_skill_id(skill) -> str:
    if not isinstance(skill, str) or not roles.SKILL_RE.fullmatch(skill):
        raise AsError(BAD_REQUEST, "Argument 'skill' must be a skill folder name "
                                   "(lowercase letters, digits, '.', '_', '-'; at most 64 characters).")
    return skill


def _text_bytes(value, name: str) -> bytes:
    if not isinstance(value, str):
        raise AsError(BAD_REQUEST, f"Argument '{name}' must be a string.")
    try:
        data = value.encode("utf-8")
    except UnicodeEncodeError:
        raise AsError(BAD_REQUEST, f"Argument '{name}' contains an unpaired surrogate and is not valid Unicode text.")
    limit = roles.LIMITS["skill"]
    if len(data) > limit:
        raise AsError(BAD_REQUEST, f"Argument '{name}' is {len(data)} bytes; the limit is {limit}.")
    return data


def _real_base(base: str) -> str:
    real = os.path.realpath(base)
    if not os.path.isdir(real):
        raise AsError(BAD_REQUEST, f"{roles.CONFIG_DIR} must be a directory.")
    return real


def _resolves_inside(real_base: str, path: str) -> bool:
    try:
        return os.path.realpath(path).startswith(real_base + os.sep)
    except OSError:
        return False


def _skill_paths(base: str, skill: str):
    """(real base, skills dir, skill folder, SKILL.md) without ever traversing a symlink."""
    real_base = _real_base(base)
    skills_dir = os.path.join(real_base, "skills")
    folder = os.path.join(skills_dir, skill)
    for path in (skills_dir, folder):
        if os.path.islink(path):
            raise AsError(BAD_REQUEST, f"Skill '{skill}' must not be stored through a symbolic link.")
        if os.path.lexists(path):
            if not os.path.isdir(path):
                raise AsError(BAD_REQUEST, f"Skill '{skill}' path must be a folder.")
            if not _resolves_inside(real_base, path):
                raise AsError(BAD_REQUEST, f"Skill '{skill}' path must be inside {roles.CONFIG_DIR}.")
    return real_base, skills_dir, folder, os.path.join(folder, SKILL_FILE)


def _make_folders(real_base: str, skills_dir: str, folder: str) -> list[str]:
    made = []
    try:
        for path in (skills_dir, folder):
            if os.path.lexists(path):
                continue
            if not path.startswith(real_base + os.sep):
                raise AsError(BAD_REQUEST, f"Skill folder must be inside {roles.CONFIG_DIR}.")
            os.mkdir(path)
            made.append(path)
            if not _resolves_inside(real_base, path):
                raise AsError(BAD_REQUEST, f"Skill folder must resolve inside {roles.CONFIG_DIR}.")
    except BaseException:
        _remove_folders(made)
        raise
    return made


def _remove_folders(folders: list[str]):
    for path in reversed(folders):
        try:
            os.rmdir(path)
        except OSError:
            pass


def _create_input(values) -> tuple[str, bytes]:
    if not isinstance(values, dict):
        raise AsError(BAD_REQUEST, "Argument 'skill' must be an object with id and text.")
    unknown = sorted(set(values) - {"id", "text"})
    if unknown:
        raise AsError(BAD_REQUEST, f"Argument 'skill' has unknown field(s): {', '.join(unknown)}.")
    if "id" not in values:
        raise AsError(BAD_REQUEST, "Missing required argument 'skill.id'.")
    skill = values["id"]
    if not isinstance(skill, str) or not roles.SKILL_RE.fullmatch(skill):
        raise AsError(BAD_REQUEST, "Argument 'skill.id' must be a skill folder name "
                                   "(lowercase letters, digits, '.', '_', '-'; at most 64 characters).")
    if "text" not in values:
        raise AsError(BAD_REQUEST, "Missing required argument 'skill.text'.")
    return skill, _text_bytes(values["text"], "skill.text")


def _write_result(workspace: str, base: str, skill: str, text: str) -> dict:
    item, _ = _read_skill(base, skill)
    # `roles` is derived from roles.json; these commands intentionally do not read it.
    return {"workspace": workspace, "skill": item, "text": text}


def create_skill(workspace: str, values) -> dict:
    skill, data = _create_input(values)
    base = _base(workspace)
    real_base, skills_dir, folder, target = _skill_paths(base, skill)
    if os.path.lexists(target):
        raise AsError(SKILL_EXISTS, f"Skill '{skill}' already exists.")
    made = _make_folders(real_base, skills_dir, folder)
    tmp = None
    try:
        tmp = roles._stage(folder, data, None)
        # A concurrent writer may have created the file after our first check.
        if os.path.lexists(target):
            raise AsError(SKILL_EXISTS, f"Skill '{skill}' already exists.")
        roles._replace(tmp, target)
        tmp = None
    except BaseException:
        roles._discard(tmp)
        _remove_folders(made)
        raise
    return _write_result(workspace, base, skill, values["text"])


def update_skill(workspace: str, skill: str, text, expected_sha256) -> dict:
    _valid_skill_id(skill)
    data = _text_bytes(text, "text")
    if not isinstance(expected_sha256, str) or not _SHA_RE.fullmatch(expected_sha256):
        raise AsError(BAD_REQUEST, "Argument 'expectedSha256' must be a lowercase hex sha256.")
    base = _base(workspace)
    _, _, _, target = _skill_paths(base, skill)
    try:
        info = os.lstat(target)
    except FileNotFoundError:
        raise AsError(SKILL_NOT_FOUND, f"Skill '{skill}' was not found.")
    except OSError:
        raise AsError(BAD_REQUEST, f"Skill '{skill}' must be a regular file.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise AsError(BAD_REQUEST, f"Skill '{skill}' must be a regular file.")
    old = roles._read_raw(target)
    if old is None:
        raise AsError(SKILL_NOT_FOUND, f"Skill '{skill}' was not found.")
    limit = roles.LIMITS["skill"]
    if len(old) > limit:
        raise AsError(BAD_REQUEST, f"Skill '{skill}' is larger than {limit} bytes; "
                                   "shorten it outside the app first.")
    current = roles._sha(old)
    if current != expected_sha256:
        raise AsError(CONFIG_CHANGED, f"Skill '{skill}' changed since it was read; reload and retry.",
                      data={"skillSha256": current})
    if old == data:
        return _write_result(workspace, base, skill, text)
    tmp = None
    try:
        tmp = roles._stage(os.path.dirname(target), data, roles._mode_of(target))
        now = roles._read_raw(target)
        if now != old:
            raise AsError(CONFIG_CHANGED, f"Skill '{skill}' changed since it was read; reload and retry.",
                          data={"skillSha256": roles._sha(now)})
        roles._replace(tmp, target)
        tmp = None
    except BaseException:
        roles._discard(tmp)
        raise
    return _write_result(workspace, base, skill, text)


# ---- skill deletion (P07-S03) ---------------------------------------------------------------
#
# A delete removes only skills/<id>/SKILL.md and then that folder when it is empty. It never edits
# roles.json and never follows a symbolic link in the skill path.

def _delete_conflict(message: str, roles_data, skill_data) -> AsError:
    return AsError(CONFIG_CHANGED, message,
                   data={"rolesSha256": roles._sha(roles_data), "skillSha256": roles._sha(skill_data)})


def _read_skill_bytes(real_base: str, skill: str, target: str):
    """The bytes of one regular SKILL.md, or None when it is missing; a link is a bad request."""
    try:
        info = os.lstat(target)
    except FileNotFoundError:
        return None
    except OSError:
        raise AsError(BAD_REQUEST, f"Skill '{skill}' file could not be inspected.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
        raise AsError(BAD_REQUEST, f"Skill '{skill}' must be a regular file, not a symbolic link or folder.")
    try:
        with os.fdopen(rolecatalog._open_confined(real_base, target), "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise AsError(BAD_REQUEST, f"Skill '{skill}' must be a regular file, not a symbolic link or folder.")
            return f.read()
    except FileNotFoundError:
        return None
    except AsError:
        raise
    except (OSError, ValueError):
        raise AsError(BAD_REQUEST, f"Skill '{skill}' file could not be read.")


def _roles_listing(workspace: str, roles_data: bytes, skill: str) -> list[str]:
    raw = roles._validated_catalog(workspace, roles_data)
    return [role_id for role_id, spec in raw["roles"].items()
            if skill in spec.get("skills", [])]


def delete_skill(workspace: str, skill, expected_roles_sha256, expected_sha256) -> dict:
    _valid_skill_id(skill)
    base = _base(workspace)
    real_base, _, folder, target = _skill_paths(base, skill)
    skill_data = _read_skill_bytes(real_base, skill, target)
    if skill_data is None:
        raise AsError(SKILL_NOT_FOUND, f"Skill '{skill}' has no {_relative(skill)} to delete; "
                                       "a missing skill has nothing to delete.")
    roles_path = os.path.join(real_base, "roles.json")
    roles_data = roles._read_raw(roles_path)
    roles_sha, skill_sha = roles._sha(roles_data), roles._sha(skill_data)
    if roles_sha != expected_roles_sha256:
        raise _delete_conflict(f"{roles.CONFIG_DIR}/roles.json changed since it was read; reload and retry.",
                               roles_data, skill_data)
    if skill_sha != expected_sha256:
        raise _delete_conflict(f"Skill '{skill}' changed since it was read; reload and retry.",
                               roles_data, skill_data)
    if roles_data is not None:
        listed = _roles_listing(workspace, roles_data, skill)
        if listed:
            raise AsError(SKILL_IN_USE,
                          f"Skill '{skill}' is still used by role(s) {', '.join(listed)}; "
                          "remove it from those roles before deleting it.",
                          data={"roles": listed})

    # Recheck immediately before removing anything: a change after the first check must not delete.
    now_roles, now_skill = roles._read_raw(roles_path), _read_skill_bytes(real_base, skill, target)
    if now_roles != roles_data:
        raise _delete_conflict(f"{roles.CONFIG_DIR}/roles.json changed since it was read; reload and retry.",
                               now_roles, now_skill)
    if now_skill != skill_data:
        raise _delete_conflict(f"Skill '{skill}' changed since it was read; reload and retry.",
                               now_roles, now_skill)
    try:
        os.unlink(target)
    except FileNotFoundError:
        raise _delete_conflict(f"Skill '{skill}' changed since it was read; reload and retry.", now_roles, None)

    folder_state = "kept"
    if not os.path.islink(folder):
        try:
            os.rmdir(folder)
            folder_state = "removed"
        except OSError:
            folder_state = "kept"
    return {"workspace": workspace, "deleted": {"id": skill, "folder": folder_state},
            "rolesSha256": roles_sha}


# ---- the roles that use a skill (P07-S04) -----------------------------------------------------
#
# One atomic write of roles.json for every role that should (or should no longer) list a skill.
# The complete wanted set is applied or nothing is written; SKILL.md files and role instructions
# are never touched.

def _roles_conflict(roles_data) -> AsError:
    return AsError(CONFIG_CHANGED, f"{roles.CONFIG_DIR}/roles.json changed since it was read; reload and retry.",
                   data={"rolesSha256": roles._sha(roles_data)})


def _role_id_list(value) -> list[str]:
    if not isinstance(value, list):
        raise AsError(BAD_REQUEST, "Argument 'roles' must be an array of role ids.")
    seen = set()
    for index, role_id in enumerate(value):
        if not isinstance(role_id, str):
            raise AsError(BAD_REQUEST, f"Argument 'roles[{index}]' must be a role id.")
        if role_id in seen:
            raise AsError(BAD_REQUEST, f"Argument 'roles' contains role '{role_id}' more than once.")
        seen.add(role_id)
    return list(value)


def update_skill_roles(workspace: str, skill: str, role_ids, expected_roles_sha256) -> dict:
    """Set exactly which roles list ``skill`` in roles.json with one write.

    ``role_ids`` is the complete wanted set (unique, may be empty). Adding a skill whose SKILL.md is
    missing is refused; removing one is allowed so a dangling reference can be cleaned up.
    """
    _valid_skill_id(skill)
    wanted = _role_id_list(role_ids)
    base = _base(workspace)
    roles_path = os.path.join(base, "roles.json")
    roles_data = roles._read_raw(roles_path)
    if roles._sha(roles_data) != expected_roles_sha256:
        raise _roles_conflict(roles_data)
    if roles_data is None:
        raw = {"version": 1, "roles": {}}
    else:
        raw = roles._validated_catalog(workspace, roles_data)
        roles._catalog_problems(workspace, raw, False)
    for role_id in wanted:
        if role_id not in raw["roles"]:
            raise AsError(ROLE_NOT_FOUND, f"Role '{role_id}' is not defined in .agent-studio/roles.json.")
    wanted_set = set(wanted)
    current = [role_id for role_id, spec in raw["roles"].items() if skill in spec.get("skills", [])]
    current_set = set(current)
    added = [role_id for role_id in raw["roles"] if role_id in wanted_set and role_id not in current_set]
    removed = [role_id for role_id in raw["roles"] if role_id in current_set and role_id not in wanted_set]
    # A semantic no-op must retain the original bytes and inode.
    if not added and not removed:
        return {"workspace": workspace, "skill": skill, "roles": current,
                "added": [], "removed": [], "rolesSha256": roles._sha(roles_data)}
    # Only a new reference needs a readable SKILL.md; removing a dangling one stays possible.
    if added and not rolecatalog._skill_exists(base, skill):
        raise AsError(SKILL_NOT_FOUND,
                      f"Skill '{skill}' has no {roles.CONFIG_DIR}/skills/{skill}/{SKILL_FILE}; "
                      "create it before adding it to a role.")
    candidate = copy.deepcopy(raw)
    for role_id in added:
        spec = candidate["roles"][role_id]
        spec["skills"] = list(spec.get("skills", [])) + [skill]
    for role_id in removed:
        spec = candidate["roles"][role_id]
        # Keep the key (possibly empty) rather than deleting it.
        spec["skills"] = [entry for entry in spec.get("skills", []) if entry != skill]
    roles._catalog_problems(workspace, candidate, False)
    data = (json.dumps(candidate, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    tmp = None
    try:
        tmp = roles._stage(os.path.dirname(roles_path), data, roles._mode_of(roles_path))
        # Recheck immediately before the replace so a concurrent edit is never overwritten.
        now = roles._read_raw(roles_path)
        if now != roles_data:
            raise _roles_conflict(now)
        roles._replace(tmp, roles_path)
        tmp = None
    except BaseException:
        roles._discard(tmp)
        raise
    return {"workspace": workspace, "skill": skill,
            "roles": [role_id for role_id, spec in candidate["roles"].items()
                      if skill in spec.get("skills", [])],
            "added": added, "removed": removed,
            "rolesSha256": hashlib.sha256(data).hexdigest()}
