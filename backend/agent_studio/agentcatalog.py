"""Reusable agent definitions: <workspace>/.agent-studio/agents.json (hand-editable; the file is the only source)."""
from __future__ import annotations

import json
import os

from . import providers, teamdefs
from .protocol import AsError, BAD_REQUEST, AGENT_CATALOG_INVALID, AGENT_EXISTS, AGENT_NOT_FOUND, AGENT_IN_USE

CATALOG_FILE = "agents.json"
VERSION = 1
MAX_AGENTS = 200
MAX_NAME_CHARS = 80
MAX_DESCRIPTION_CHARS = 4000
FIELDS = ("id", "name", "description", "provider", "model", "reasoning")
EDITABLE = ("name", "description", "provider", "model", "reasoning")
_OPTIONAL = ("description", "model", "reasoning")


def path(workspace: str) -> str:
    return os.path.join(workspace, teamdefs.CONFIG_DIR, CATALOG_FILE)


def load(workspace: str) -> dict:
    p = path(workspace)
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return {"version": VERSION, "agents": []}
    except (OSError, ValueError) as e:
        raise AsError(AGENT_CATALOG_INVALID, f"{p} is not valid JSON: {e}")
    if not isinstance(data, dict):
        raise AsError(AGENT_CATALOG_INVALID, f"{p} must be a JSON object.")
    return data


def save(workspace: str, catalog: dict) -> None:
    target = path(workspace)
    tmp = f"{target}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(catalog, indent=2, ensure_ascii=False) + "\n")
    os.replace(tmp, target)


def _text(v) -> bool:
    return isinstance(v, str) and bool(v.strip())


def validate_agent(agent, prefix: str) -> list:
    problems = []

    def add(field, msg):
        problems.append({"path": f"{prefix}.{field}" if field else prefix, "message": msg})

    if not isinstance(agent, dict):
        add(None, "must be an object")
        return problems
    if not _text(agent.get("id")):
        add("id", "must be a non-empty string")
    elif not teamdefs.SLUG_RE.match(agent["id"]):
        add("id", "must be a slug (lowercase letters, digits, '-'; at most 64 characters)")
    name = agent.get("name")
    if not _text(name):
        add("name", "must be a non-empty string")
    elif len(name) > MAX_NAME_CHARS:
        add("name", f"at most {MAX_NAME_CHARS} characters")
    if "description" in agent:
        d = agent["description"]
        if not isinstance(d, str):
            add("description", "must be a string")
        elif len(d) > MAX_DESCRIPTION_CHARS:
            add("description", f"at most {MAX_DESCRIPTION_CHARS} characters")
    prov = agent.get("provider")
    prov_ok = False
    if not _text(prov):
        add("provider", "must be a non-empty string")
    elif prov not in providers.PEERS and prov not in providers.TEST_ONLY:
        add("provider", f"unknown provider {prov!r} (known: {', '.join(providers.PEERS)})")
    else:
        prov_ok = True
    for k in ("model", "reasoning"):
        if k in agent and not isinstance(agent[k], str):
            add(k, "must be a string")
    if prov_ok:
        try:
            adapter = providers.get(prov, allow_test_only=True)
        except AsError as e:
            add("provider", e.message)
            return problems
        for k in ("model", "reasoning"):
            if isinstance(agent.get(k), str):
                try:
                    adapter.validate_settings(agent[k] if k == "model" else None,
                                              agent[k] if k == "reasoning" else None)
                except AsError as e:
                    add(k, e.message)
    return problems


def validate(catalog: dict) -> list:
    problems = []
    if catalog.get("version") != VERSION:
        problems.append({"path": "version", "message": "must be 1"})
    agents = catalog.get("agents")
    if not isinstance(agents, list):
        problems.append({"path": "agents", "message": "must be a list"})
        return problems
    if len(agents) > MAX_AGENTS:
        problems.append({"path": "agents", "message": f"at most {MAX_AGENTS} agents (got {len(agents)})"})
    seen = set()
    for i, a in enumerate(agents):
        problems += validate_agent(a, f"agents[{i}]")
        aid = a.get("id") if isinstance(a, dict) else None
        if isinstance(aid, str):
            if aid in seen:
                problems.append({"path": f"agents[{i}].id", "message": f"duplicate agent id {aid!r}"})
            seen.add(aid)
    return problems


def _invalid(problems: list) -> AsError:
    lines = "; ".join(f"{p['path']}: {p['message']}" for p in problems)
    return AsError(AGENT_CATALOG_INVALID, f"agents.json: {lines}", data={"problems": problems})


def _load_valid(workspace: str) -> dict:
    catalog = load(workspace)
    problems = validate(catalog)
    if problems:
        raise _invalid(problems)
    return catalog


def _find(catalog: dict, agent_id: str) -> int:
    for i, a in enumerate(catalog["agents"]):
        if a.get("id") == agent_id:
            return i
    raise AsError(AGENT_NOT_FOUND, f"No agent {agent_id!r} in agents.json.")


def get(workspace: str, agent_id: str) -> dict:
    catalog = _load_valid(workspace)
    return catalog["agents"][_find(catalog, agent_id)]


def references(workspace: str, agent_id: str) -> list:
    out = []
    for tid in teamdefs.list_ids(workspace):
        members = teamdefs.load(workspace, tid).get("members")
        if isinstance(members, list) and any(isinstance(m, dict) and m.get("agent") == agent_id for m in members):
            out.append(tid)
    return sorted(out)


def list_agents(workspace: str) -> dict:
    catalog = load(workspace)
    agents = catalog.get("agents")
    return {"version": catalog.get("version"),
            "agents": [a for a in agents if isinstance(a, dict)] if isinstance(agents, list) else [],
            "problems": validate(catalog)}


def _check_fields(fields, allowed, what: str) -> None:
    if not isinstance(fields, dict):
        raise AsError(BAD_REQUEST, f"{what} must be an object.")
    unknown = set(fields) - set(allowed)
    if unknown:
        raise AsError(BAD_REQUEST, f"{what} has unknown field(s): {', '.join(sorted(unknown))}.")


def create_agent(workspace: str, fields: dict) -> dict:
    _check_fields(fields, FIELDS, "agent")
    catalog = _load_valid(workspace)
    agent = {k: fields[k] for k in FIELDS if fields.get(k) is not None}
    if "id" not in agent and isinstance(fields.get("name"), str) and fields["name"]:
        agent["id"] = teamdefs.slug(fields["name"])
    problems = validate_agent(agent, "agent")
    if problems:
        raise _invalid(problems)
    if any(a["id"] == agent["id"] for a in catalog["agents"]):
        raise AsError(AGENT_EXISTS, f"Agent {agent['id']!r} already exists.")
    if len(catalog["agents"]) >= MAX_AGENTS:
        raise _invalid([{"path": "agents", "message": f"at most {MAX_AGENTS} agents"}])
    catalog["agents"].append(agent)
    save(workspace, catalog)
    return {"agent": agent}


def update_agent(workspace: str, agent_id: str, changes: dict) -> dict:
    if isinstance(changes, dict) and "id" in changes:
        raise AsError(BAD_REQUEST, "An agent id cannot be changed.")
    _check_fields(changes, EDITABLE, "changes")
    if not changes:
        raise AsError(BAD_REQUEST, "changes needs at least one field.")
    catalog = _load_valid(workspace)
    i = _find(catalog, agent_id)
    merged = dict(catalog["agents"][i])
    for k, v in changes.items():
        if v is None and k in _OPTIONAL:
            merged.pop(k, None)
        else:
            merged[k] = v
    problems = validate_agent(merged, f"agents[{i}]")
    if problems:
        raise _invalid(problems)
    catalog["agents"][i] = merged
    save(workspace, catalog)
    return {"agent": merged}


def delete_agent(workspace: str, agent_id: str) -> dict:
    catalog = _load_valid(workspace)
    i = _find(catalog, agent_id)
    teams = references(workspace, agent_id)
    if teams:
        raise AsError(AGENT_IN_USE, f"Agent {agent_id!r} is used by team(s): {', '.join(teams)}.",
                      remediation="remove it from those teams first", data={"teams": teams})
    removed = catalog["agents"].pop(i)
    save(workspace, catalog)
    return {"deleted": removed}
