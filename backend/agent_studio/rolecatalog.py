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

# Reference projections are bounded independently of the complete scan.
MAX_REFERENCE_ITEMS = 500
MAX_REFERENCE_PROBLEMS = 100
MAX_REFERENCE_LABEL = 200


def _label(value):
    from . import textsafe
    return textsafe.one_line(value, MAX_REFERENCE_LABEL)[:MAX_REFERENCE_LABEL] if isinstance(value, str) else None


def _scan_saved_references(workspace: str, role_id: str, keep_members: bool = False) -> dict:
    from . import boardmodel, teamdefs, workflowdef

    result = {key: [] for key in ("members", "boardRules", "workflows", "legacyRoster", "problems")}

    def problem(source, path, error, code=None):
        message = error.message if isinstance(error, AsError) else str(error)
        message = message.replace(workspace, "<workspace>")
        result["problems"].append({"source": source, "path": path,
                                   "code": error.code if isinstance(error, AsError) else (code or "SOURCE_UNREADABLE"),
                                   "message": _label(message)})

    def check_dir(path):
        try:
            with os.scandir(os.path.join(workspace, path)) as entries:
                list(entries)
        except FileNotFoundError:
            pass

    teams_path = ".agent-studio/teams"
    try:
        check_dir(teams_path)
        ids = teamdefs.list_ids(workspace)
    except (AsError, OSError) as e:
        problem("teams", teams_path, e)
        ids = []
    for team_id in ids:
        path = f"{teams_path}/{team_id}.json"
        try:
            team = teamdefs.load(workspace, team_id)
            members = team.get("members")
            if not isinstance(members, list):
                raise AsError("TEAM_CONFIG_INVALID", "members must be a list")
            seen = set()
            for index, member in enumerate(members):
                if not isinstance(member, dict) or ("role" in member and not isinstance(member["role"], str)):
                    problem("teams", path, AsError("TEAM_CONFIG_INVALID", f"members[{index}] is invalid"))
                    continue
                mid = member.get("id")
                if not isinstance(mid, str) or not mid.strip() or mid in seen:
                    problem("teams", path, AsError("TEAM_CONFIG_INVALID", f"members[{index}] has an invalid or duplicate id"))
                    continue
                seen.add(mid)
                if member.get("role") == role_id:
                    result["members"].append({"teamDefId": team_id, "teamName": _label(team.get("name")),
                        "memberId": mid, "memberName": _label(member.get("name")),
                        "saved": {"path": path, "memberIndex": index}, "live": None})
        except (AsError, OSError) as e:
            problem("teams", path, e)

    legacy_path = ".agent-studio/team.json"
    try:
        exists = teamdefs.legacy_exists(workspace)
        if not exists and os.path.lexists(os.path.join(workspace, legacy_path)):
            raise AsError("ROLES_CONFIG_INVALID", f"{legacy_path} is not a readable roster file")
        if exists:
            for index, member in enumerate(roles.load_team(workspace)):
                if not isinstance(member, dict) or ("role" in member and not isinstance(member["role"], str)):
                    problem("legacyRoster", legacy_path, AsError("ROLES_CONFIG_INVALID", f"agents[{index}] is invalid"))
                    continue
                if member.get("role") == role_id:
                    name = member.get("name") or member.get("displayName") or f"{member.get('role')}-{index + 1}"
                    try:
                        mid = teamdefs.slug(str(name))
                    except AsError as e:
                        problem("legacyRoster", legacy_path, e)
                        mid = None
                    result["legacyRoster"].append({"memberIndex": index, "memberId": mid,
                                                   "memberName": _label(name), "path": legacy_path})
    except (AsError, OSError) as e:
        problem("legacyRoster", legacy_path, e)

    board_path = ".agent-studio/board.json"
    try:
        board = boardmodel.load_config(workspace)
        for index, rule in enumerate(board.get("rules", [])):
            if rule.get("role") == role_id:
                result["boardRules"].append({"index": index, "status": _label(rule["when"]["status"]),
                                             "workflow": _label(rule["workflow"]), "path": f"rules[{index}].role"})
    except (AsError, OSError) as e:
        problem("board", board_path, e)

    workflow_path = ".agent-studio/workflows"
    try:
        check_dir(workflow_path)
        definitions = workflowdef.list_definitions(workspace, builtin_dir=None)
    except (AsError, OSError) as e:
        problem("workflows", workflow_path, e)
        definitions = []
    for entry in definitions:
        path = entry["files"][0]
        if entry["errors"]:
            for error in entry["errors"]:
                problem("workflows", path, AsError("WORKFLOW_DEFINITION_INVALID", error["message"]))
            continue
        try:
            definition = workflowdef.load(workspace, entry["name"], builtin_dir=None)
            for stage in definition.stages:
                if stage.type == "agent" and stage.role == role_id:
                    result["workflows"].append({"name": _label(entry["name"]), "path": path, "stageId": stage.id})
        except (AsError, OSError) as e:
            problem("workflows", path, e)
    result["count"] = sum(len(result[k]) for k in ("members", "boardRules", "workflows", "legacyRoster"))
    result["truncated"] = any(len(result[k]) > (MAX_REFERENCE_PROBLEMS if k == "problems" else MAX_REFERENCE_ITEMS)
                              for k in ("members", "boardRules", "workflows", "legacyRoster", "problems"))
    # Members stay complete until runtime rows have been joined.
    for key in ("boardRules", "workflows", "legacyRoster", "problems"):
        result[key] = result[key][:(MAX_REFERENCE_PROBLEMS if key == "problems" else MAX_REFERENCE_ITEMS)]
    if not keep_members:
        result["members"] = result["members"][:MAX_REFERENCE_ITEMS]
    return result


def scan_saved_references(workspace: str, role_id: str) -> dict:
    return _scan_saved_references(workspace, role_id)


def scan_live_references(conn, workspace: str, role_id: str) -> list:
    from .teams import ACTIVE
    rows = conn.execute("SELECT t.id AS team_id, t.def_id, t.name AS team_name, t.status AS team_status, "
                        "a.id AS agent_id, a.member_id, a.display_name, a.availability FROM teams t "
                        "JOIN agents a ON a.team_id = t.id WHERE t.workspace = ? AND a.role = ? "
                        "AND t.status IN ('starting','running') ORDER BY t.created_at, t.rowid, a.ordinal", (workspace, role_id))
    out = []
    marks = ",".join("?" * len(ACTIVE))
    for row in rows:
        assignment = conn.execute(f"SELECT id, status, task_id FROM assignments WHERE agent_id = ? AND status IN ({marks}) "
                                  "ORDER BY created_at DESC, rowid DESC LIMIT 1", (row["agent_id"],) + ACTIVE).fetchone()
        out.append({"teamDefId": row["def_id"], "teamName": _label(row["team_name"]),
                    "memberId": row["member_id"], "memberName": _label(row["display_name"]), "saved": None,
                    "live": {"teamId": row["team_id"], "agentId": row["agent_id"], "teamStatus": row["team_status"],
                             "availability": _label(row["availability"]), "assignment":
                             {"id": assignment["id"], "status": assignment["status"], "taskId": assignment["task_id"]} if assignment else None}})
    return out


def attach_usage(catalog: dict, workspace: str, conn, coordinator_running: bool, runtime_error: dict | None) -> dict:
    result = dict(catalog)
    result["items"] = []
    for item in catalog["items"]:
        usage = _scan_saved_references(workspace, item["id"], keep_members=True)
        members = usage["members"]
        if conn is not None:
            for live in scan_live_references(conn, workspace, item["id"]):
                match = next ( (m for m in members if live["teamDefId"] is not None and live["memberId"] is not None
                                 and m["teamDefId"] == live["teamDefId"] and m["memberId"] == live["memberId"]
                                 and m["saved"] is not None and m["live"] is None), None)
                if match is None:
                    members.append(live)
                    usage["count"] += 1
                else:
                    match["live"] = live["live"]
        else:
            error = runtime_error or {"code": "BACKEND_UNAVAILABLE", "message": "State database unavailable"}
            error = {"code": error["code"], "message": _label(error["message"].replace(workspace, "<workspace>"))}
            usage["problems"].append({"source": "runtime", "path": "", **error})
        usage["liveRuntime"] = {"state": ("unavailable" if conn is None else "connected" if coordinator_running else "disconnected"),
                                "error": error if conn is None else None}
        usage["partial"] = bool(usage["problems"]) or conn is None
        usage["blocking"] = usage["count"] > 0 or usage["partial"]
        usage["truncated"] |= len(members) > MAX_REFERENCE_ITEMS or len(usage["problems"]) > MAX_REFERENCE_PROBLEMS
        usage["members"] = members[:MAX_REFERENCE_ITEMS]
        usage["problems"] = usage["problems"][:MAX_REFERENCE_PROBLEMS]
        result["items"].append(dict(item, usage=usage))
    return result
