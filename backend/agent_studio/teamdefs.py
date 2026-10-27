"""Team definitions: <workspace>/.agent-studio/teams/<id>.json (hand-editable; the file is the only source)."""
from __future__ import annotations

import copy
import json
import os
import re

from . import providers, roles, teams
from .protocol import (AsError, BAD_REQUEST, MEMBER_EXISTS, MEMBER_NOT_FOUND, TEAM_ALREADY_RUNNING, TEAM_AMBIGUOUS,
                       TEAM_EXISTS, TEAM_NOT_FOUND)
from .teams import TEAM_CONFIG_INVALID

CONFIG_DIR = ".agent-studio"
CATALOG_FILE = "agents.json"
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
LEGACY_ID = "default"
_ADD_HINT = "run agent-studio team add --name NAME"
_LEGACY_HINT = "run agent-studio team import-legacy"


def slug(name: str) -> str:
    out = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:64].strip("-")
    if not out:
        raise AsError(BAD_REQUEST, f"{name!r} gives an empty id; use letters or digits.")
    return out


def _dir(workspace: str) -> str:
    return os.path.join(workspace, CONFIG_DIR, "teams")


def _path(workspace: str, team_id: str) -> str:
    return os.path.join(_dir(workspace), f"{team_id}.json")


def load(workspace: str, team_id: str) -> dict:
    path = _path(workspace, team_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise AsError(TEAM_NOT_FOUND, f"No team {team_id!r} ({path}).", remediation=_ADD_HINT)
    except (OSError, ValueError) as e:
        raise AsError(TEAM_CONFIG_INVALID, f"{path} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise AsError(TEAM_CONFIG_INVALID, f"{path} must be a JSON object.")
    return data


def save(workspace: str, team: dict) -> None:
    os.makedirs(_dir(workspace), exist_ok=True)
    target = _path(workspace, team["id"])
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(team, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, target)


def list_ids(workspace: str) -> list:
    try:
        names = os.listdir(_dir(workspace))
    except OSError:
        return []
    return sorted(n[:-5] for n in names if n.endswith(".json") and SLUG_RE.match(n[:-5]))


def find_member(team: dict, ref: str) -> dict:
    members = [m for m in team.get("members", []) if isinstance(m, dict)]
    for m in members:
        if m.get("id") == ref:
            return m
    for m in members:
        if isinstance(m.get("name"), str) and m["name"].casefold() == str(ref).casefold():
            return m
    raise AsError(MEMBER_NOT_FOUND, f"No member {ref!r} in team {team.get('id')!r}.")


# ---- legacy team.json ---------------------------------------------------------------------------

def _legacy_path(workspace: str) -> str:
    return os.path.join(workspace, CONFIG_DIR, "team.json")


def legacy_exists(workspace: str) -> bool:
    return os.path.isfile(_legacy_path(workspace))


def legacy_team(workspace: str, team_id: str = LEGACY_ID, name: str = LEGACY_ID) -> dict:
    agents = roles.load_team(workspace)
    members = []
    for i, a in enumerate(agents):
        if not isinstance(a, dict):
            raise AsError(TEAM_CONFIG_INVALID, f"{CONFIG_DIR}/team.json agents[{i}] must be an object.")
        role = a.get("role")
        mname = a.get("name") or a.get("displayName") or f"{role}-{i + 1}"
        m = {"id": slug(str(mname)), "name": mname}
        if "role" in a:
            m["role"] = role
        if "providerId" in a:
            m["provider"] = a["providerId"]
        for k in ("model", "reasoning"):
            if k in a:
                m[k] = a[k]
        members.append(m)
    return {"id": team_id, "name": name, "members": members}


# ---- validation ---------------------------------------------------------------------------------

def _text(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def _catalog(workspace: str) -> dict:
    """{agent_id: entry} from the reusable agent catalog (agents.json). AsError propagates."""
    from . import agentcatalog  # lazy: agentcatalog imports teamdefs
    agents = agentcatalog.load(workspace).get("agents")
    if isinstance(agents, list):
        return {a["id"]: a for a in agents if isinstance(a, dict) and isinstance(a.get("id"), str)}
    if isinstance(agents, dict):
        return {k: v for k, v in agents.items() if isinstance(v, dict)}
    return {}


def _check_provider(emit, prov, model, reasoning) -> None:
    if prov not in providers.PEERS and prov not in providers.TEST_ONLY:
        emit("provider", f"unknown provider {prov!r} (known: {', '.join(providers.PEERS)})")
        return
    try:
        adapter = providers.get(prov, allow_test_only=True)
    except AsError as e:
        emit("provider", e.message)
        return
    for k, v in (("model", model), ("reasoning", reasoning)):
        if isinstance(v, str):
            try:
                adapter.validate_settings(v if k == "model" else None, v if k == "reasoning" else None)
            except AsError as e:
                emit(k, e.message)


def validate(workspace: str, team: dict, file_id: str) -> list:
    problems = []

    def add(path, message):
        problems.append({"path": path, "message": message})

    if not _text(team.get("id")):
        add("id", "must be a non-empty string")
    elif not SLUG_RE.match(team["id"]):
        add("id", "must be a slug (lowercase letters, digits, '-'; at most 64 characters)")
    elif team["id"] != file_id:
        add("id", f"must equal the file name ({file_id!r})")
    if not _text(team.get("name")):
        add("name", "must be a non-empty string")
    members = team.get("members")
    if not isinstance(members, list):
        add("members", "must be a list")
        return problems
    if len(members) > teams.MAX_ROSTER:
        add("members", f"at most {teams.MAX_ROSTER} members (got {len(members)})")
    try:
        cfg = roles.load_config(workspace)
    except AsError as e:
        cfg = None
        add("roles.json", e.message)
    known_roles = (cfg or {}).get("roles", {})
    catalog = None
    if any(isinstance(m, dict) and ("agent" in m or "agents" in m) for m in members):
        try:
            catalog = _catalog(workspace)
        except AsError as e:
            add(CATALOG_FILE, e.message)
    seen = set()
    for i, m in enumerate(members):
        p = f"members[{i}]"
        if not isinstance(m, dict):
            add(p, "must be an object")
            continue
        if "agents" in m:
            options = m["agents"]
            if not isinstance(options, list) or not options:
                add(f"{p}.agents", "must be a non-empty list of catalog agent ids")
                continue
            if any(not _text(a) or not SLUG_RE.match(a) for a in options):
                add(f"{p}.agents", "must contain only valid catalog agent ids")
                continue
            if len(set(options)) != len(options):
                add(f"{p}.agents", "must not contain duplicates")
            if any(k in m for k in ("agent", "provider", "model", "reasoning")):
                add(f"{p}.agents", "cannot be combined with agent or inline provider settings")
            for aid in options:
                if catalog is not None and aid not in catalog:
                    add(f"{p}.agents", f"agent {aid!r} is not defined in {CONFIG_DIR}/{CATALOG_FILE}")
                elif catalog is not None:
                    entry = catalog[aid]
                    _check_provider(lambda f, msg, aid=aid: add(f"{p}.agents", f"agent {aid!r} {f}: {msg}"),
                                    entry.get("provider"), entry.get("model"), entry.get("reasoning"))
            # Reuse existing member and role validation for the first option.
            m = dict(m, agent=options[0])
            m.pop("agents")
        is_catalog = "agent" in m
        for k in (("id", "name", "role", "agent") if is_catalog else ("id", "name", "role", "provider")):
            if not _text(m.get(k)):
                add(f"{p}.{k}", "must be a non-empty string")
        if is_catalog:
            for k in ("provider", "model", "reasoning"):
                if k in m:
                    add(f"{p}.{k}", f"must not be set on a member that uses agent {m.get('agent')!r}; "
                                    f"edit the agent in {CONFIG_DIR}/{CATALOG_FILE}")
        else:
            for k in ("model", "reasoning"):
                if k in m and not isinstance(m[k], str):
                    add(f"{p}.{k}", "must be a string")
        if "canAddTickets" in m and not isinstance(m["canAddTickets"], bool):
            add(f"{p}.canAddTickets", "must be true or false")
        mid = m.get("id")
        if _text(mid):
            if not SLUG_RE.match(mid):
                add(f"{p}.id", "must be a slug (lowercase letters, digits, '-'; at most 64 characters)")
            if mid in seen:
                add(f"{p}.id", f"duplicate member id {mid!r}")
            seen.add(mid)
        role = m.get("role")
        if _text(role) and role not in known_roles:
            add(f"{p}.role", f"role {role!r} is not defined in {CONFIG_DIR}/roles.json")
        if is_catalog:
            aid = m.get("agent")
            if not _text(aid):
                continue
            if not SLUG_RE.match(aid):
                add(f"{p}.agent", "must be a slug (lowercase letters, digits, '-'; at most 64 characters)")
            elif catalog is not None:
                if aid not in catalog:
                    add(f"{p}.agent", f"agent {aid!r} is not defined in {CONFIG_DIR}/{CATALOG_FILE}")
                else:
                    entry = catalog[aid]

                    def emit(field, msg, aid=aid, p=p):
                        add(f"{p}.agent", f"agent {aid!r} {field}: {msg}")

                    if not _text(entry.get("provider")):
                        emit("provider", "must be a non-empty string")
                    else:
                        _check_provider(emit, entry["provider"], entry.get("model"), entry.get("reasoning"))
            continue
        prov = m.get("provider")
        if _text(prov):
            _check_provider(lambda f, msg, p=p: add(f"{p}.{f}", msg), prov, m.get("model"), m.get("reasoning"))
    return problems


def _invalid(team_id: str, problems: list) -> AsError:
    lines = "; ".join(f"{p['path']}: {p['message']}" for p in problems)
    return AsError(TEAM_CONFIG_INVALID, f"team {team_id}: {lines}", data={"problems": problems})


# ---- commands -----------------------------------------------------------------------------------

def _select(workspace: str, team_id):
    """-> (team dict, file id, legacy flag). The legacy flag is always False since P04-S06 removed the
    team.json fallback from the CLI (the coordinator's roster-less team.start still reads team.json)."""
    ids = list_ids(workspace)
    if team_id:
        if team_id in ids:
            return load(workspace, team_id), team_id, False
        raise AsError(TEAM_NOT_FOUND, f"No team {team_id!r}.", remediation=_ADD_HINT)
    if not ids:
        raise AsError(TEAM_NOT_FOUND, "No team is defined in this workspace.", remediation=_ADD_HINT)
    if len(ids) > 1:
        raise AsError(TEAM_AMBIGUOUS, f"Several teams exist ({', '.join(ids)}); pass --team ID.")
    return load(workspace, ids[0]), ids[0], False


def _select_writable(workspace: str, team_id):
    team, fid, legacy = _select(workspace, team_id)
    if legacy:
        raise AsError(BAD_REQUEST, "The team is the legacy team.json; it cannot be edited here.",
                      remediation=_LEGACY_HINT)
    return team, fid


def add_team(workspace: str, name, team_id=None) -> dict:
    if not _text(name):
        raise AsError(BAD_REQUEST, "team add needs --name NAME")
    if team_id is None:
        team_id = slug(name)
    elif not SLUG_RE.match(team_id):
        raise AsError(BAD_REQUEST, f"--id {team_id!r} is not a slug (lowercase letters, digits, '-').")
    if os.path.exists(_path(workspace, team_id)):
        raise AsError(TEAM_EXISTS, f"Team {team_id!r} already exists.")
    team = {"id": team_id, "name": name, "members": []}
    save(workspace, team)
    return {"team": team}


def add_member(workspace: str, team_id, name, role, provider, model=None, reasoning=None,
               can_add_tickets=None) -> dict:
    if not (_text(name) and _text(role) and _text(provider)):
        raise AsError(BAD_REQUEST, "team add-member needs --name, --role and --provider")
    team, fid = _select_writable(workspace, team_id)
    if not isinstance(team.get("members"), list):
        raise AsError(TEAM_CONFIG_INVALID, f"team {fid}: members must be a list")
    mid = slug(name)
    if any(isinstance(m, dict) and m.get("id") == mid for m in team["members"]):
        raise AsError(MEMBER_EXISTS, f"Team {fid!r} already has a member {mid!r}.")
    member = {"id": mid, "name": name, "role": role, "provider": provider}
    if model is not None:
        member["model"] = model
    if reasoning is not None:
        member["reasoning"] = reasoning
    if can_add_tickets is not None:
        member["canAddTickets"] = can_add_tickets
    team["members"].append(member)
    save(workspace, team)
    return {"team": team, "member": member, "warnings": validate(workspace, team, fid)}


def remove_member(workspace: str, team_id, ref) -> dict:
    if not _text(ref):
        raise AsError(BAD_REQUEST, "team remove-member needs --member M")
    team, fid = _select_writable(workspace, team_id)
    if not isinstance(team.get("members"), list):
        raise AsError(TEAM_CONFIG_INVALID, f"team {fid}: members must be a list")
    member = find_member(team, ref)
    team["members"] = [m for m in team["members"] if m is not member]
    save(workspace, team)
    return {"team": team, "removed": member, "warnings": validate(workspace, team, fid)}


def list_teams(workspace: str) -> dict:
    ids = list_ids(workspace)
    out = []
    for tid in ids:
        t = load(workspace, tid)
        members = t.get("members")
        out.append({"id": tid, "name": t.get("name"), "members": len(members) if isinstance(members, list) else 0,
                    "legacy": False})
    return {"teams": out}


def show(workspace: str, team_id) -> dict:
    team, _, legacy = _select(workspace, team_id)
    return {"team": team, "legacy": legacy}


def validate_team(workspace: str, team_id) -> dict:
    team, fid, _ = _select(workspace, team_id)
    problems = validate(workspace, team, fid)
    if problems:
        raise _invalid(fid, problems)
    return {"team": fid, "problems": []}


def import_legacy(workspace: str, team_id=LEGACY_ID, name=LEGACY_ID) -> dict:
    if not SLUG_RE.match(team_id or ""):
        raise AsError(BAD_REQUEST, f"--id {team_id!r} is not a slug (lowercase letters, digits, '-').")
    if not legacy_exists(workspace):
        raise AsError(TEAM_NOT_FOUND, f"No {CONFIG_DIR}/team.json to import.")
    if list_ids(workspace):
        raise AsError(TEAM_EXISTS, "A team definition already exists; import-legacy only runs on an empty workspace.")
    team = legacy_team(workspace, team_id, name)
    save(workspace, team)
    return {"team": team, "warnings": validate(workspace, team, team_id)}


# ---- strict edits (teamdef.* serve commands) ----------------------------------------------------

def resolve_member(member: dict, catalog: dict) -> dict:
    out = {"id": member.get("id"), "name": member.get("name"), "role": member.get("role")}
    if member.get("agents"):
        selected = dict(member, agent=member["agents"][0])
        selected.pop("agents")
        out = resolve_member(selected, catalog)
        out["agents"] = list(member["agents"])
        return out
    if "agent" in member:
        entry = catalog.get(member["agent"]) or {}
        out.update(source="catalog", agent=member["agent"], provider=entry.get("provider"),
                   model=entry.get("model"), reasoning=entry.get("reasoning"))
    else:
        out.update(source="inline", agent=None, provider=member.get("provider"), model=member.get("model"),
                   reasoning=member.get("reasoning"))
    out["canAddTickets"] = member.get("canAddTickets")
    return out


def _members_catalog(workspace: str, team: dict) -> dict:
    if not any(isinstance(m, dict) and ("agent" in m or "agents" in m) for m in team.get("members", [])):
        return {}
    try:
        return _catalog(workspace)
    except AsError:
        return {}


def active_runtime(conn, workspace: str, team_id: str):
    row = conn.execute("SELECT id, status FROM teams WHERE workspace = ? AND def_id = ? "
                       "AND status IN ('starting','running','stopping') ORDER BY created_at DESC, rowid DESC",
                       (workspace, team_id)).fetchone()
    return {"teamId": row["id"], "status": row["status"]} if row else None


_MEMBER_PATH = re.compile(r"^members\[(\d+)\](.*)$")


def _keyed(team: dict, problems: list) -> set:
    members = team.get("members") if isinstance(team, dict) else None
    out = set()
    for pr in problems:
        path = pr["path"]
        mt = _MEMBER_PATH.match(path)
        if mt and isinstance(members, list) and int(mt.group(1)) < len(members):
            m = members[int(mt.group(1))]
            if isinstance(m, dict) and _text(m.get("id")):
                path = f"members[{m['id']}]{mt.group(2)}"
        out.add((path, pr["message"]))
    return out


def _check_edit(workspace: str, fid: str, before, candidate: dict) -> list:
    old = _keyed(before, validate(workspace, before, fid)) if before is not None else set()
    after = validate(workspace, candidate, fid)
    new = [p for p in after if next(iter(_keyed(candidate, [p]))) not in old]
    if new:
        raise _invalid(fid, new)
    return after


def _strict_team(workspace: str, team_id):
    team, fid, _ = _select(workspace, team_id)
    if not isinstance(team.get("members"), list):
        raise AsError(TEAM_CONFIG_INVALID, f"team {fid}: members must be a list")
    return team, fid


def _running(fid: str, active: dict, verb_phrase: str):
    raise AsError(TEAM_ALREADY_RUNNING, f"Team {fid!r} is running in this workspace; stop it before {verb_phrase}.",
                  remediation=f"run agent-studio team stop --team {fid}",
                  data={"teamId": active["teamId"], "teamDefId": fid})


def _roster(workspace: str, team: dict) -> list:
    catalog = _members_catalog(workspace, team)
    return [resolve_member(m, catalog) for m in team["members"] if isinstance(m, dict)]


def describe(workspace: str, team_id, active) -> dict:
    team, fid = _strict_team(workspace, team_id)
    return {"team": team, "members": _roster(workspace, team), "problems": validate(workspace, team, fid),
            "active": active}


def check_team(workspace: str, team_id) -> dict:
    team, fid = _strict_team(workspace, team_id)
    problems = validate(workspace, team, fid)
    if not problems and not team["members"]:
        problems = [{"path": "members", "message": "the team has no members"}]
    ready = not problems
    return {"teamDefId": fid, "ready": ready, "problems": problems,
            "roster": _roster(workspace, team) if ready else []}


def create_team(workspace: str, name, team_id=None) -> dict:
    return {"team": add_team(workspace, name, team_id)["team"], "problems": []}


def rename_team(workspace: str, team_id, name, active) -> dict:
    if not _text(name):
        raise AsError(BAD_REQUEST, "teamdef.rename needs name")
    team, fid = _strict_team(workspace, team_id)
    candidate = copy.deepcopy(team)
    candidate["name"] = name
    after = _check_edit(workspace, fid, team, candidate)
    save(workspace, candidate)
    return {"team": candidate, "problems": after, "appliesOnNextStart": active is not None}


def delete_team(workspace: str, team_id, active) -> dict:
    team, fid = _strict_team(workspace, team_id)
    if active:
        _running(fid, active, "deleting it")
    os.remove(_path(workspace, fid))
    return {"deleted": fid}


def _agent_model_error(agent) -> AsError:
    return AsError(BAD_REQUEST, f"model and reasoning come from agent {agent!r} in {CONFIG_DIR}/{CATALOG_FILE}; "
                                f"edit the agent instead.")


def member_add(workspace: str, team_id, fields: dict, active) -> dict:
    team, fid = _strict_team(workspace, team_id)
    agent, provider = fields.get("agent"), fields.get("provider")
    options = fields.get("agents")
    if options is not None and (agent is not None or provider is not None):
        raise AsError(BAD_REQUEST, "Give agents, agent or provider, not more than one.")
    if agent is not None and provider is not None:
        raise AsError(BAD_REQUEST, "Give agent or provider, not both.")
    if agent is None and provider is None and options is None:
        raise AsError(BAD_REQUEST, "teamdef.member.add needs agent (a catalog agent id) or provider.")
    if (agent is not None or options is not None) and (fields.get("model") is not None or fields.get("reasoning") is not None):
        raise _agent_model_error(agent or options)
    if fields.get("role") is None:
        raise AsError(BAD_REQUEST, "teamdef.member.add needs role")
    name = fields.get("name")
    if name is None and agent is not None:
        try:
            name = _catalog(workspace).get(agent, {}).get("name")
        except AsError:
            name = None
    if not _text(name):
        raise AsError(BAD_REQUEST, "teamdef.member.add needs name")
    mid = fields.get("id") or slug(name)
    if any(isinstance(m, dict) and m.get("id") == mid for m in team["members"]):
        raise AsError(MEMBER_EXISTS, f"Team {fid!r} already has a member {mid!r}.")
    member = {"id": mid, "name": name, "role": fields["role"]}
    if options is not None:
        member["agents"] = options
    elif agent is not None:
        member["agent"] = agent
    else:
        member["provider"] = provider
        for k in ("model", "reasoning"):
            if fields.get(k) is not None:
                member[k] = fields[k]
    if fields.get("canAddTickets") is not None:
        member["canAddTickets"] = fields["canAddTickets"]
    candidate = copy.deepcopy(team)
    candidate["members"].append(member)
    after = _check_edit(workspace, fid, team, candidate)
    save(workspace, candidate)
    return {"team": candidate, "member": member, "problems": after, "appliesOnNextStart": active is not None}


def _exact_member(candidate: dict, fid: str, member_id: str) -> dict:
    for m in candidate["members"]:
        if isinstance(m, dict) and m.get("id") == member_id:
            return m
    raise AsError(MEMBER_NOT_FOUND, f"No member {member_id!r} in team {fid!r}.")


def member_update(workspace: str, team_id, member_id: str, changes: dict, active) -> dict:
    if not changes:
        raise AsError(BAD_REQUEST, "teamdef.member.update needs at least one change.")
    if any(k in changes and changes[k] is None for k in ("name", "role", "agent", "provider")):
        raise AsError(BAD_REQUEST, "name, role, agent and provider cannot be cleared.")
    if "agent" in changes and "provider" in changes:
        raise AsError(BAD_REQUEST, "Give agent or provider, not both.")
    if "agents" in changes and any(k in changes for k in ("agent", "provider", "model", "reasoning")):
        raise AsError(BAD_REQUEST, "Give agents or a single agent/provider, not both.")
    team, fid = _strict_team(workspace, team_id)
    candidate = copy.deepcopy(team)
    m = _exact_member(candidate, fid, member_id)
    if "agents" in changes:
        m["agents"] = changes["agents"]
        for k in ("agent", "provider", "model", "reasoning"):
            m.pop(k, None)
    if "agent" in changes:
        m["agent"] = changes["agent"]
        m.pop("agents", None)
        for k in ("provider", "model", "reasoning"):
            m.pop(k, None)
    if "provider" in changes:
        m["provider"] = changes["provider"]
        m.pop("agent", None)
        m.pop("agents", None)
    if "agent" in m and (changes.get("model") is not None or changes.get("reasoning") is not None):
        raise _agent_model_error(m["agent"])
    for k in ("name", "role"):
        if k in changes:
            m[k] = changes[k]
    for k in ("model", "reasoning", "canAddTickets"):
        if k in changes:
            if changes[k] is None:
                m.pop(k, None)
            else:
                m[k] = changes[k]
    after = _check_edit(workspace, fid, team, candidate)
    save(workspace, candidate)
    return {"team": candidate, "member": m, "problems": after, "appliesOnNextStart": active is not None}


def member_remove(workspace: str, team_id, member_id: str, active) -> dict:
    team, fid = _strict_team(workspace, team_id)
    candidate = copy.deepcopy(team)
    member = _exact_member(candidate, fid, member_id)
    if active:
        _running(fid, active, f"removing member {member_id!r}")
    candidate["members"] = [x for x in candidate["members"] if x is not member]
    after = _check_edit(workspace, fid, team, candidate)
    save(workspace, candidate)
    return {"team": candidate, "removed": member, "problems": after}
