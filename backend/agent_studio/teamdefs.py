"""Team definitions: <workspace>/.agent-studio/teams/<id>.json (hand-editable; the file is the only source)."""
from __future__ import annotations

import json
import os
import re

from . import providers, roles, teams
from .protocol import (AsError, BAD_REQUEST, MEMBER_EXISTS, MEMBER_NOT_FOUND, TEAM_AMBIGUOUS, TEAM_EXISTS,
                       TEAM_NOT_FOUND)
from .teams import TEAM_CONFIG_INVALID

CONFIG_DIR = ".agent-studio"
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
    seen = set()
    for i, m in enumerate(members):
        p = f"members[{i}]"
        if not isinstance(m, dict):
            add(p, "must be an object")
            continue
        for k in ("id", "name", "role", "provider"):
            if not _text(m.get(k)):
                add(f"{p}.{k}", "must be a non-empty string")
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
        prov = m.get("provider")
        if not _text(prov):
            continue
        if prov not in providers.PEERS and prov not in providers.TEST_ONLY:
            add(f"{p}.provider", f"unknown provider {prov!r} (known: {', '.join(providers.PEERS)})")
            continue
        try:
            adapter = providers.get(prov, allow_test_only=True)
        except AsError as e:
            add(f"{p}.provider", e.message)
            continue
        for k in ("model", "reasoning"):
            if isinstance(m.get(k), str):
                try:
                    adapter.validate_settings(m[k] if k == "model" else None, m[k] if k == "reasoning" else None)
                except AsError as e:
                    add(f"{p}.{k}", e.message)
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
