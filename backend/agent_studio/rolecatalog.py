"""Read-only, bounded projection of workspace roles."""
import codecs
import hashlib
import json
import os
import stat

from . import roles
from .protocol import AsError

ROLE_NAME_LIMIT = 80
CATALOG_FILE = "roles.json"


def _problem(path, role_id, code, message):
    return {"path": path, "roleId": role_id, "code": code, "message": message}


def _inside(base, value):
    try:
        return roles._inside(base, value)
    except (OSError, ValueError):
        return None


def _open_confined(base, path):
    """Open a resolved path without following links introduced after resolution."""
    root = os.path.realpath(base)
    parts = os.path.relpath(path, root).split(os.sep)
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | os.O_NOFOLLOW
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_dir = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_dir
        return os.open(parts[-1], flags, dir_fd=directory)
    finally:
        os.close(directory)


def _skill_exists(base, skill):
    path = _inside(base, f"skills/{skill}/SKILL.md")
    return path is not None and os.path.isfile(path)


def _resolver_read(base, path, limit):
    """Read resolver content through a confined, nonblocking file descriptor."""
    try:
        with os.fdopen(_open_confined(base, path), "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                return None
            data = f.read(limit + 1)
        cut = len(data) > limit
        data = data[:limit]
        return data.decode("utf-8", "replace"), hashlib.sha256(data).hexdigest(), len(data), cut
    except (OSError, ValueError):
        return None


def _available(base):
    directory = os.path.join(base, "skills")
    try:
        with os.scandir(directory) as entries:
            return sorted(entry.name for entry in entries
                          if roles.SKILL_RE.fullmatch(entry.name) and not entry.is_symlink()
                          and entry.is_dir(follow_symlinks=False) and _skill_exists(base, entry.name))
    except OSError:
        return []


def _instructions(base, value, present, problems, role_id, warnings):
    result = {"path": None, "state": "none", "text": None, "sha256": None, "bytes": None}
    if not present or value == "":
        return result
    path = _inside(base, value)
    if path is None:
        result["state"] = "invalid"
    else:
        result["path"] = value
        try:
            with os.fdopen(_open_confined(base, path), "rb") as f:
                if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                    raise OSError("not a regular file")
                digest = hashlib.sha256()
                decoder = codecs.getincrementaldecoder("utf-8")("strict")
                prefix = bytearray()
                size = 0
                valid = True
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    digest.update(chunk)
                    size += len(chunk)
                    prefix.extend(chunk[:max(0, roles.LIMITS["instructions"] - len(prefix))])
                    if valid:
                        try:
                            decoder.decode(chunk, final=False)
                        except UnicodeDecodeError:
                            valid = False
                if valid:
                    try:
                        decoder.decode(b"", final=True)
                    except UnicodeDecodeError:
                        valid = False
                result.update(sha256=digest.hexdigest(), bytes=size)
                if valid:
                    # The full stream is valid; only the final prefix character may be incomplete.
                    result["text"] = bytes(prefix).decode("utf-8", "ignore")
                    result["state"] = "truncated" if size > roles.LIMITS["instructions"] else "ok"
                else:
                    result["state"] = "invalid"
        except FileNotFoundError:
            result["state"] = "missing"
        except (OSError, ValueError):
            result["state"] = "invalid"
    if result["state"] == "missing":
        warning = f"role instructions file {roles.CONFIG_DIR}/{value} not found"
        if warning not in warnings:
            warnings.append(warning)
    if result["state"] in ("invalid", "truncated"):
        state = result["state"]
        message = f"Role instructions are {state}."
        problems.append(_problem(f"roles.{role_id}.instructions", role_id, f"instructions_{state}", message))
        warnings.append(message)
    return result


def list_roles(workspace: str) -> dict:
    base = os.path.join(workspace, roles.CONFIG_DIR)
    result = {"state": "missing", "sha256": None, "bytes": None, "items": [],
              "problems": [], "availableSkills": _available(base)}
    catalog_path = _inside(base, CATALOG_FILE)
    if catalog_path is None:
        result["state"] = "invalid"
        result["problems"].append(_problem(CATALOG_FILE, None, "catalog_unreadable", "Role catalog could not be read."))
        return result
    try:
        # Non-blocking open so a FIFO without a writer cannot hang the read.
        with os.fdopen(_open_confined(base, catalog_path), "rb") as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
                raise OSError("not a regular file")
            data = f.read()
    except FileNotFoundError:
        return result
    except OSError:
        result["state"] = "invalid"
        result["problems"].append(_problem(CATALOG_FILE, None, "catalog_unreadable", "Role catalog could not be read."))
        return result
    result.update(sha256=hashlib.sha256(data).hexdigest(), bytes=len(data))
    try:
        catalog = json.loads(data.decode("utf-8"))
        if (not isinstance(catalog, dict) or catalog.get("version") != 1
                or not isinstance(catalog.get("roles"), dict)):
            raise ValueError("invalid root")
    except (UnicodeDecodeError, ValueError, RecursionError):
        result["state"] = "invalid"
        result["problems"].append(_problem(CATALOG_FILE, None, "invalid_catalog", "Role catalog has invalid content or root shape."))
        return result
    token = roles._catalog_snapshot.set((workspace, catalog))
    reader_token = roles._catalog_reader.set(lambda path, limit: _resolver_read(base, path, limit))
    try:
        return _project(workspace, base, catalog, result)
    finally:
        roles._catalog_reader.reset(reader_token)
        roles._catalog_snapshot.reset(token)


def _project(workspace, base, catalog, result):
    try:
        roles.load_config(workspace)
        resolvable = True
    except (AsError, OSError, UnicodeError):
        resolvable = False
    for role_id, spec in catalog["roles"].items():
        item = {"id": role_id, "name": role_id, "description": None, "instructions": None,
                "skills": [], "warnings": [], "problems": []}
        result["items"].append(item)
        problems, warnings = item["problems"], item["warnings"]
        def problem(field, code, message):
            problems.append(_problem(f"roles.{role_id}" + (f".{field}" if field else ""), role_id, code, message))
        if not isinstance(spec, dict):
            problem("", "invalid_role", "Role must be an object.")
            spec = {}
        name = spec.get("name", role_id)
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= ROLE_NAME_LIMIT:
            if "name" in spec:
                problem("name", "invalid_name", "Display name must contain 1–80 characters.")
        else:
            item["name"] = name.strip() if "name" in spec else role_id
        if "description" in spec:
            desc = spec["description"]
            if not isinstance(desc, str):
                problem("description", "invalid_description", "Description must be text.")
            else:
                item["description"] = desc[:roles.LIMITS["description"]]
                if len(desc) > roles.LIMITS["description"]:
                    problem("description", "description_too_long", "Description exceeds the limit.")
        if resolvable:
            try:
                for warning in roles.context_for(workspace, role_id)["warnings"]:
                    # Existing resolver can include an unsafe configured path verbatim.
                    value = spec.get("instructions")
                    if isinstance(value, str) and _inside(base, value) is None and warning.startswith("role instructions path"):
                        continue
                    warnings.append(warning)
            except (AsError, OSError, UnicodeError, ValueError):
                pass
        item["instructions"] = _instructions(base, spec.get("instructions"), "instructions" in spec,
                                               problems, role_id, warnings)
        skills = spec.get("skills", [])
        if not isinstance(skills, list):
            problem("skills", "invalid_skills", "Skills must be a list.")
            warnings.append("Configured skills are invalid.")
            skills = []
        seen = set()
        for skill in skills:
            if not isinstance(skill, str) or not roles.SKILL_RE.fullmatch(skill):
                problem("skills", "invalid_skill", "Skill id is invalid.")
                if "A configured skill id is invalid." not in warnings:
                    warnings.append("A configured skill id is invalid.")
                continue
            if skill in seen:
                problem("skills", "duplicate_skill", "A skill id is duplicated.")
            seen.add(skill)
            exists = _skill_exists(base, skill)
            item["skills"].append({"id": skill, "state": "ok" if exists else "missing"})
            warning = f"skill {skill!r} not found at {roles.CONFIG_DIR}/skills/{skill}/SKILL.md"
            if not exists and warning not in warnings:
                warnings.append(warning)
    for item in result["items"]:
        for other in result["items"]:
            if other is not item and other["name"].strip().casefold() == item["name"].strip().casefold():
                result["problems"].append(_problem(f"roles.{item['id']}.name", item["id"], "duplicate_name",
                    f"Display name '{item['name']}' is also used by role '{other['id']}' (case-insensitive)."))
                break
    result["state"] = "problems" if result["problems"] or any(i["problems"] for i in result["items"]) else "ok"
    return result
