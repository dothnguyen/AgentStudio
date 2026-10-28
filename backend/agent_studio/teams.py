"""Coordinator-side team lifecycle, assignment delivery, and pane liveness (P00-S03)."""
from __future__ import annotations

import json
import os
import shlex
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from . import ops, procid, providers, tmuxctl
import re

from .protocol import AsError, BAD_REQUEST, MEMBER_NOT_FOUND, TEAM_ALREADY_RUNNING, TEAM_NOT_RUNNING
from .runner import request_path
from .store import Store, Tx, new_id
from .textsafe import one_line

CLEANUP_INCOMPLETE = "CLEANUP_INCOMPLETE"
TEAM_START_FAILED = "TEAM_START_FAILED"
TEAM_CONFIG_INVALID = "TEAM_CONFIG_INVALID"
MAX_ROSTER = 8
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
ACTIVE = ("queued", "claimed", "running", "waiting_input", "reconciling")


class Failure:
    """Returned by a handler to COMMIT its transaction yet answer the command with an error
    (e.g. record team.error while reporting CLEANUP_INCOMPLETE)."""

    def __init__(self, error: AsError):
        self.error = error


def worker_path() -> str:
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "agent-studio-worker")


def agent_dir(state_dir: str, agent_id: str) -> str:
    return os.path.join(state_dir, "agents", agent_id)


def pane_command(team_id: str, agent_id: str) -> str:
    """Only validated UUIDs and our own paths go into the pane command; each piece is shell-quoted anyway."""
    parts = ["exec", "env"]
    xdg = os.environ.get("XDG_STATE_HOME")
    parts += [f"XDG_STATE_HOME={xdg}"] if xdg else ["-u", "XDG_STATE_HOME"]
    parts += [worker_path(), team_id, agent_id]
    return " ".join(shlex.quote(p) for p in parts)


def attach_info(team: dict, tmux: tmuxctl.Tmux) -> dict:
    name = tmuxctl.session_name_for(team["id"])
    argv = tmux.attach_argv(name)
    distro = os.environ.get("WSL_DISTRO_NAME") or "<distro>"
    wsl_cmd = " ".join(shlex.quote(a) for a in argv)
    windows = ["wsl.exe", "-d", distro, "--exec"] + argv
    return {"sessionName": name, "sessionId": team.get("tmux_session_id"), "socket": tmux.socket, "argv": argv,
            "wsl": wsl_cmd, "windowsTerminal": "wt.exe -w new " + " ".join(windows),
            "powershell": " ".join(windows), "keys": {"detach": "Ctrl-b d", "zoomPane": "Ctrl-b z",
                                                       "nextPane": "Ctrl-b o", "selectPane": "Ctrl-b <arrow>"}}


def quota_holds(agent):
    try:
        holds = json.loads(agent.get("quota_holds_json") or "{}")
    except (ValueError, TypeError):
        holds = {}
    if not isinstance(holds, dict):
        return {}
    now = datetime.now(timezone.utc)
    for key, reset in list(holds.items()):
        if isinstance(reset, str):
            try:
                parsed = datetime.fromisoformat(reset.replace("Z", "+00:00"))
                if parsed.tzinfo and parsed <= now:
                    del holds[key]
            except ValueError:
                pass
    return holds


def _configured_agent_options(agent: dict, fallback_member: dict | None = None) -> list[str]:
    if agent.get("configured_agents_json") is not None:
        return json.loads(agent["configured_agents_json"])
    return list((fallback_member or {}).get("agents") or [])


def _runtime_options(agent, workspace, fid, mid):
    from . import teamdefs
    member = None if agent.get("configured_agents_json") is not None else teamdefs.find_member(
        teamdefs.load(workspace, fid), mid)
    return _configured_agent_options(agent, member)


def resume_member_agent(tx: Tx, args: dict) -> dict:
    """Clear one configured option's hold, without switching or interrupting the member."""
    from . import teamdefs
    workspace, fid, mid, choice = (args[k] for k in ("workspace", "teamDefId", "memberId", "agent"))
    team = tx.conn.execute("SELECT * FROM teams WHERE workspace = ? AND def_id = ? AND status = 'running' "
                           "ORDER BY created_at DESC, rowid DESC LIMIT 1", (workspace, fid)).fetchone()
    if team is None:
        raise AsError(TEAM_NOT_RUNNING, f"Team {fid!r} is not running.")
    row = tx.conn.execute("SELECT * FROM agents WHERE team_id = ? AND member_id = ?", (team["id"], mid)).fetchone()
    if row is None:
        raise AsError(MEMBER_NOT_FOUND, f"No running member {mid!r} in team {fid!r}.")
    agent = dict(row)
    if choice not in _runtime_options(agent, workspace, fid, mid):
        raise AsError(BAD_REQUEST, f"Agent {choice!r} is not configured for member {mid!r}.")
    try:
        holds = json.loads(agent.get("quota_holds_json") or "{}")
    except (TypeError, ValueError):
        raise AsError("INTERNAL", "The member's quota holds are invalid; no hold was cleared.")
    if not isinstance(holds, dict):
        raise AsError("INTERNAL", "The member's quota holds are invalid; no hold was cleared.")
    cleared = choice in holds
    if cleared:
        del holds[choice]
        payload = {"option": choice, "active": agent["active_catalog_agent"] == choice}
        if agent["availability"] == "limit_reached" and agent["active_catalog_agent"] == choice:
            tx.transition("agent", agent["id"], "idle", event="agent.quota_resumed", payload=payload,
                          set_values={"quota_holds_json": holds, "limit_reset_at": None})
        else:
            tx.update("agent", agent["id"], {"quota_holds_json": holds}, "agent.quota_resumed", payload)
    return {"teamId": team["id"], "memberId": mid, "agentId": agent["id"], "option": choice,
            "cleared": cleared, "activeAgent": agent["active_catalog_agent"]}


def reset_provider_usage(tx: Tx, args: dict, ctx: dict) -> dict:
    """Clear one provider's configured holds and recover members waiting on quota."""
    from . import teamdefs
    workspace, fid, provider = (args[k] for k in ("workspace", "teamDefId", "provider"))
    row = tx.conn.execute("SELECT * FROM teams WHERE workspace = ? AND def_id = ? AND status = 'running' "
                          "ORDER BY created_at DESC, rowid DESC LIMIT 1", (workspace, fid)).fetchone()
    if row is None:
        raise AsError(TEAM_NOT_RUNNING, f"Team {fid!r} is not running.")
    definition = teamdefs.load(workspace, fid)
    catalog = teamdefs._catalog(workspace)
    results = []
    members = list(definition.get("members", []))
    member_ids = {member.get("id") for member in members}
    for runtime in tx.conn.execute("SELECT member_id FROM agents WHERE team_id = ? AND configured_agents_json IS NOT NULL ORDER BY ordinal", (row["id"],)):
        if runtime["member_id"] and runtime["member_id"] not in member_ids:
            members.append({"id": runtime["member_id"]})
    for member in members:
        mid = member.get("id")
        current = tx.conn.execute("SELECT * FROM agents WHERE team_id = ? AND member_id = ?", (row["id"], mid)).fetchone()
        options = _configured_agent_options(dict(current), member) if current else list(member.get("agents") or [])
        choices = [option for option in options if catalog.get(option, {}).get("provider") == provider]
        if not choices:
            continue
        if current is None:
            results.append({"memberId": mid, "cleared": [], "error": "Member is not running."})
            continue
        agent = dict(current)
        was_held = agent["availability"] == "limit_reached"
        cleared = []
        for option in choices:
            result = resume_member_agent(tx, {"workspace": workspace, "teamDefId": fid, "memberId": mid, "agent": option})
            if result["cleared"]:
                cleared.append(option)
        agent = tx.get("agent", agent["id"])
        entry = {"memberId": mid, "cleared": cleared, "activeAgent": agent["active_catalog_agent"], "switched": False}
        # An already-running assignment or usable member is never interrupted or switched.
        if was_held and agent["availability"] == "limit_reached" and not agent.get("pending_agent"):
            for option in choices:
                if option in quota_holds(agent) or option == agent["active_catalog_agent"]:
                    continue
                try:
                    result = switch_member_agent(tx, {"workspace": workspace, "teamDefId": fid,
                                                       "memberId": mid, "agent": option}, ctx)
                    entry.update(activeAgent=result["activeAgent"], switched=True)
                    break
                except AsError as e:
                    entry["error"] = e.message
            if entry["switched"]:
                entry.pop("error", None)
        results.append(entry)
    return {"teamId": row["id"], "provider": provider, "members": results}

def switch_member_agent(tx: Tx, args: dict, ctx: dict) -> dict:
    from . import teamdefs
    workspace, fid, mid, choice = (args[k] for k in ("workspace", "teamDefId", "memberId", "agent"))
    row = tx.conn.execute("SELECT * FROM teams WHERE workspace = ? AND def_id = ? AND status = 'running' "
                          "ORDER BY created_at DESC, rowid DESC LIMIT 1", (workspace, fid)).fetchone()
    if row is None:
        raise AsError(TEAM_NOT_RUNNING, f"Team {fid!r} is not running.")
    agent = tx.conn.execute("SELECT * FROM agents WHERE team_id = ? AND member_id = ?", (row["id"], mid)).fetchone()
    if agent is None:
        raise AsError(MEMBER_NOT_FOUND, f"No running member {mid!r} in team {fid!r}.")
    agent = dict(agent)
    if choice not in _runtime_options(agent, workspace, fid, mid):
        raise AsError(BAD_REQUEST, f"Agent {choice!r} is not configured for member {mid!r}.")
    if choice in quota_holds(agent):
        raise AsError(BAD_REQUEST, f"Agent {choice!r} is on quota hold.")
    marks = ",".join("?" * len(ACTIVE))
    active_assignment = tx.conn.execute(f"SELECT id FROM assignments WHERE agent_id = ? AND status IN ({marks}) LIMIT 1",
                                        (agent["id"], *ACTIVE)).fetchone()
    if agent["pane_state"] != "alive":
        raise AsError(BAD_REQUEST, "The member's pane is not alive.")
    if agent.get("pending_agent") and not args.get("_pending"):
        raise AsError(BAD_REQUEST, "A switch is already pending for this member.")
    if active_assignment and (not args.get("cancelActive") or args.get("assignmentId") != active_assignment["id"]):
        raise AsError(BAD_REQUEST, "Member has an active assignment; confirm cancellation of this assignment to switch.",
                      data={"assignmentId": active_assignment["id"]})
    if not active_assignment and agent["availability"] not in ("idle", "limit_reached"):
        raise AsError(BAD_REQUEST, "Member must be idle or quota-limited before switching.")
    if agent["active_catalog_agent"] == choice:
        raise AsError(BAD_REQUEST, "That agent is already active; use board resume when its quota resets.")
    entry = teamdefs._catalog(workspace).get(choice)
    if not entry:
        raise AsError(TEAM_CONFIG_INVALID, f"Agent {choice!r} is missing from the catalog.")
    pid = entry.get("provider")
    aliases = providers.fixture_aliases(os.environ, ctx["debug"])
    adapter = providers.resolve(pid, allow_test_only=ctx["debug"], fixture=aliases.get(pid))
    adapter.validate_settings(entry.get("model"), entry.get("reasoning"))
    probes = providers.probe_many([pid], dict(os.environ), allow_test_only=ctx["debug"], aliases=aliases)
    if not probes[pid].get("available"):
        raise AsError(providers.PROVIDER_UNAVAILABLE, f"Provider {pid!r} is not ready: {probes[pid].get('reason')}")
    if active_assignment:
        from . import workflow, tasks
        assignment_id = active_assignment["id"]
        wf = tx.conn.execute("SELECT w.id FROM workflow_runs w JOIN stage_attempts s ON s.workflow_run_id = w.id "
                             "WHERE s.assignment_id = ? AND w.status IN ('running','paused') LIMIT 1",
                             (assignment_id,)).fetchone()
        tx.update("agent", agent["id"], {"pending_agent": choice, "pending_assignment": assignment_id},
                  "agent.switch_requested", {"toAgent": choice, "assignmentId": assignment_id})
        outcome = (workflow.cancel(tx, {"workflowRunId": wf["id"]}, ctx) if wf else
                   tasks.assignment_cancel(tx, {"assignmentId": assignment_id}, ctx))
        return {"teamId": row["id"], "memberId": mid, "agentId": agent["id"], "pendingAgent": choice,
                "assignmentId": assignment_id, "cancellation": outcome}
    values = {"provider_id": pid, "model": entry.get("model"), "reasoning": entry.get("reasoning"),
              "capabilities_json": probes[pid], "active_catalog_agent": choice, "limit_reset_at": None,
              "quota_holds_json": quota_holds(agent), "pending_agent": None, "pending_assignment": None}
    payload = {"fromAgent": agent["active_catalog_agent"], "toAgent": choice, "providerId": pid}
    if args.get("_pending"):
        payload["assignmentId"] = agent["pending_assignment"]
    tx.update("agent", agent["id"], values, "agent.option_switched", payload)
    if agent["availability"] == "limit_reached":
        tx.transition("agent", agent["id"], "idle")
    return {"teamId": row["id"], "memberId": mid, "agentId": agent["id"], "activeAgent": choice, "provider": pid}


def handle_quota_limit(tx: Tx, agent_id: str, reset, ctx: dict) -> None:
    from . import teamdefs
    agent = tx.get("agent", agent_id)
    team = tx.get("team", agent["team_id"])
    active = agent.get("active_catalog_agent")
    if not active or not team.get("def_id") or not agent.get("member_id"):
        return
    holds = quota_holds(agent)
    holds[active] = reset
    tx.update("agent", agent_id, {"quota_holds_json": holds}, "agent.quota_held",
              {"option": active, "resetAt": reset})
    if agent.get("pending_agent"):
        return
    try:
        options = _runtime_options(agent, team["workspace"], team["def_id"], agent["member_id"])
        start = options.index(active) + 1 if active in options else 0
        ordered = options[start:] + options[:start]
        for option in ordered:
            if option == active or option in holds:
                continue
            try:
                switch_member_agent(tx, {"workspace": team["workspace"], "teamDefId": team["def_id"],
                                         "memberId": agent["member_id"], "agent": option}, ctx)
                return
            except AsError as e:
                tx.note("agent", agent_id, "agent.option_unavailable", {"option": option, "code": e.code})
    except AsError as e:
        tx.note("agent", agent_id, "agent.failover_failed", {"code": e.code})


def recover_expired_quotas(store: Store, ctx: dict) -> None:
    from . import teamdefs
    rows = store.conn.execute("SELECT a.id FROM agents a JOIN teams t ON t.id = a.team_id "
                              "WHERE a.availability = 'limit_reached' AND a.pending_agent IS NULL "
                              "AND t.status = 'running' AND a.active_catalog_agent IS NOT NULL").fetchall()
    for row in rows:
        with store.transaction() as tx:
            agent = tx.get("agent", row["id"])
            try:
                recorded = json.loads(agent.get("quota_holds_json") or "{}")
                holds = quota_holds(agent)
                if recorded == holds:
                    continue
                team = tx.get("team", agent["team_id"])
                if agent["active_catalog_agent"] not in holds:
                    tx.transition("agent", agent["id"], "idle", event="agent.quota_reset",
                                  set_values={"quota_holds_json": holds, "limit_reset_at": None})
                    continue
                for option in _runtime_options(agent, team["workspace"], team["def_id"], agent["member_id"]):
                    if option not in holds:
                        try:
                            switch_member_agent(tx, {"workspace": team["workspace"], "teamDefId": team["def_id"],
                                                     "memberId": agent["member_id"], "agent": option}, ctx)
                            break
                        except AsError:
                            continue
            except (AsError, ValueError, TypeError):
                continue


def complete_pending_switches(store: Store, ctx: dict) -> None:
    from . import boardsched
    rows = store.conn.execute("SELECT id FROM agents WHERE pending_agent IS NOT NULL").fetchall()
    for row in rows:
        with store.transaction() as tx:
            agent = tx.get("agent", row["id"])
            assignment = tx.get("assignment", agent["pending_assignment"])
            if assignment["status"] in ACTIVE:
                continue
            wf = tx.conn.execute("SELECT w.* FROM workflow_runs w JOIN stage_attempts s ON s.workflow_run_id = w.id "
                                 "WHERE s.assignment_id = ? ORDER BY s.created_at DESC LIMIT 1",
                                 (assignment["id"],)).fetchone()
            if wf and wf["status"] not in ("succeeded", "failed", "cancelled"):
                continue
            team = tx.get("team", agent["team_id"])
            ticket = (tx.conn.execute("SELECT * FROM tickets WHERE active_run_id = ?", (wf["id"],)).fetchone()
                      if wf and wf["status"] == "cancelled" else None)
            try:
                switch_member_agent(tx, {"workspace": team["workspace"], "teamDefId": team["def_id"],
                                         "memberId": agent["member_id"], "agent": agent["pending_agent"],
                                         "_pending": True}, ctx)
                if ticket:
                    boardsched._release_with_run(tx, team["workspace"], dict(ticket), "agent_switch_cancelled")
                    tx.conn.execute("UPDATE tickets SET preferred_agent_id = ? WHERE id = ?", (agent["id"], ticket["id"]))
            except AsError as e:
                tx.update("agent", agent["id"], {"pending_agent": None, "pending_assignment": None},
                          "agent.switch_failed", {"toAgent": agent["pending_agent"], "assignmentId": agent["pending_assignment"],
                                                  "code": e.code, "message": e.message})
                if ticket:
                    boardsched._release_with_run(tx, team["workspace"], dict(ticket), "agent_switch_failed")


# ---- team.start ---------------------------------------------------------------------------------

def validate_roster(args: dict, allow_fake: bool) -> List[dict]:
    roster = args.get("roster")
    if not isinstance(roster, list) or not roster:
        raise AsError(BAD_REQUEST, "roster must be a non-empty list of agents.")
    if len(roster) > MAX_ROSTER:
        raise AsError(BAD_REQUEST, f"A P00 team has at most {MAX_ROSTER} agents (got {len(roster)}).")
    allowed = set(providers.PEERS) | (set(providers.TEST_ONLY) if allow_fake else set())
    seen, clean, names = set(), [], {}
    for i, m in enumerate(roster):
        if not isinstance(m, dict):
            raise AsError(BAD_REQUEST, f"roster[{i}] must be an object.")
        pid = m.get("providerId")
        if pid not in allowed:
            hint = " (fake is test-only)" if pid == "fake" else ""
            raise AsError(BAD_REQUEST, f"roster[{i}].providerId {pid!r} is not supported{hint}.")
        aid = m.get("agentId") or new_id()
        from .store import validate_uuid
        validate_uuid(aid, f"roster[{i}].agentId")
        if aid in seen:
            raise AsError(BAD_REQUEST, f"roster[{i}].agentId is duplicated.")
        seen.add(aid)
        role = m.get("role")
        if not isinstance(role, str) or not role.strip() or len(role) > 64:
            raise AsError(BAD_REQUEST, f"roster[{i}].role must be a non-empty string of at most 64 characters.")
        name = m.get("displayName") or m.get("name") or f"{role.strip()}-{i + 1}"
        if not isinstance(name, str) or len(name) > 64:
            raise AsError(BAD_REQUEST, f"roster[{i}].displayName must be at most 64 characters.")
        key = one_line(name.strip(), 64).casefold()
        if key in names:
            raise AsError(TEAM_CONFIG_INVALID, f"roster[{names[key]}] and roster[{i}] have the same agent name "
                          f"{name.strip()!r}; names must be unique in a team.",
                          data={"name": name.strip(), "indexes": [names[key], i]})
        names[key] = i
        member = {"agentId": aid, "providerId": pid, "role": one_line(role.strip(), 64),
                  "displayName": one_line(name.strip(), 64)}
        mid = m.get("memberId")
        if mid is not None:
            if not isinstance(mid, str) or not SLUG_RE.match(mid):
                raise AsError(BAD_REQUEST, f"roster[{i}].memberId must be a slug (lowercase letters, digits, '-').")
            member["memberId"] = mid
        for key in ("model", "reasoning"):
            value = m.get(key)
            if value is not None and (not isinstance(value, str) or not value or len(value) > 128):
                raise AsError(BAD_REQUEST, f"roster[{i}].{key} must be a non-empty string of at most 128 characters.")
            member[key] = value
        if m.get("canAddTickets") is not None:
            if not isinstance(m.get("canAddTickets"), bool):
                raise AsError(TEAM_CONFIG_INVALID, f"roster[{i}].canAddTickets must be true or false.")
            member["canAddTickets"] = m["canAddTickets"]
        if m.get("activeCatalogAgent") is not None:
            member["activeCatalogAgent"] = m["activeCatalogAgent"]
        if m.get("quotaHolds") is not None:
            member["quotaHolds"] = m["quotaHolds"]
        clean.append(member)
    return clean


def team_start(tx: Tx, args: dict, ctx: dict) -> dict:
    if not os.access(worker_path(), os.X_OK):  # otherwise every pane exits at once and tmux reports a vanished session
        raise AsError("BACKEND_UNAVAILABLE", f"The worker shim {worker_path()} is not executable.",
                      remediation=f"Run: bash {os.path.join(os.path.dirname(os.path.dirname(worker_path())), 'install.sh')}")
    workspace = ops.canonical_workspace(args["workspace"])
    if not args.get("roster"):
        from . import roles
        args = dict(args, roster=roles.load_team(workspace))  # .agent-studio/team.json
    frozen_options = {}
    if args.get("teamDefId"):
        from . import teamdefs
        definition = teamdefs.load(workspace, args["teamDefId"])
        catalog = teamdefs._members_catalog(workspace, definition)
        args = dict(args, roster=[dict(m) for m in args["roster"]])
        for member in args["roster"]:
            if not member.get("memberId"):
                continue
            definition_member = teamdefs.find_member(definition, member["memberId"])
            choices = definition_member.get("agents")
            if not choices:
                continue
            frozen_options[member["memberId"]] = list(choices)
            previous = tx.conn.execute(
                "SELECT a.active_catalog_agent, a.quota_holds_json FROM agents a JOIN teams t ON t.id = a.team_id "
                "WHERE t.workspace = ? AND t.def_id = ? AND a.member_id = ? "
                "ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1",
                (workspace, args["teamDefId"], member["memberId"])).fetchone()
            holds = quota_holds(dict(previous)) if previous else {}
            prior = previous["active_catalog_agent"] if previous else None
            selected = prior if prior in choices and prior not in holds else next((c for c in choices if c not in holds), choices[0])
            entry = catalog.get(selected)
            if not entry:
                raise AsError(TEAM_CONFIG_INVALID, f"Agent {selected!r} is missing from the catalog.")
            member.update(providerId=entry.get("provider"), model=entry.get("model"), reasoning=entry.get("reasoning"),
                          activeCatalogAgent=selected, quotaHolds=holds)
    roster = validate_roster(args, allow_fake=ctx["debug"])
    for m in roster:
        if m.get("memberId") in frozen_options:
            m["_configuredAgents"] = frozen_options[m["memberId"]]
    probes = providers.probe_many([m["providerId"] for m in roster], dict(os.environ), allow_test_only=ctx["debug"],
                                  aliases=providers.fixture_aliases(os.environ, ctx["debug"]))
    missing = {pid: p.get("reason") for pid, p in probes.items() if not p.get("available")}
    if missing:  # never substitute another provider or start a partial team
        raise AsError(providers.PROVIDER_UNAVAILABLE, "Provider(s) not ready: " +
                      "; ".join(f"{k}: {v}" for k, v in missing.items()), data={"probes": probes})
    aliases = providers.fixture_aliases(os.environ, ctx["debug"])
    for i, m in enumerate(roster):  # each agent's own model / reasoning, checked by its adapter
        adapter = providers.resolve(m["providerId"], allow_test_only=ctx["debug"], fixture=aliases.get(m["providerId"]))
        try:
            adapter.validate_settings(m.get("model"), m.get("reasoning"))
        except AsError as e:
            raise AsError(e.code, f"roster[{i}] ({m['displayName']}): {e.message}")
    for m in roster:
        if tx.conn.execute("SELECT 1 FROM agents WHERE id = ?", (m["agentId"],)).fetchone():
            raise AsError(BAD_REQUEST, f"Agent {m['agentId']} already exists in another team.")
    def_id = args.get("teamDefId")
    if def_id is not None:
        running = tx.conn.execute("SELECT id FROM teams WHERE workspace = ? AND def_id = ? AND status IN "
                                  "('starting', 'running', 'stopping') ORDER BY created_at DESC, rowid DESC",
                                  (workspace, def_id)).fetchone()
        if running:
            raise AsError(TEAM_ALREADY_RUNNING, f"Team {def_id!r} is already running in this workspace.",
                          remediation=f"run agent-studio team stop --team {def_id}",
                          data={"teamId": running["id"], "teamDefId": def_id})
    team_id = new_id()
    marker = uuid.uuid4().hex
    name = one_line(args.get("name") or f"team {team_id[:8]}", 80)
    tx.create("team", {"name": name, "workspace": workspace, "ownership_marker": marker, "def_id": def_id},
              entity_id=team_id)
    for i, m in enumerate(roster):
        tx.create("agent", {"team_id": team_id, "ordinal": i, "provider_id": m["providerId"], "role": m["role"],
                            "display_name": m["displayName"], "capabilities_json": probes[m["providerId"]],
                            "model": m.get("model"), "reasoning": m.get("reasoning"),
                            "member_id": m.get("memberId"),
                            "active_catalog_agent": m.get("activeCatalogAgent"),
                            "quota_holds_json": m.get("quotaHolds"),
                            "configured_agents_json": m.get("_configuredAgents"),
                            "can_add_tickets": 1 if m.get("canAddTickets") else 0},
                  entity_id=m["agentId"])
        d = agent_dir(ctx["stateDir"], m["agentId"])
        for box in ("inbox", "active", "done"):
            os.makedirs(os.path.join(d, box), mode=0o700, exist_ok=True)
        with open(os.path.join(d, "banner"), "w", encoding="utf-8") as f:
            settings = " ".join(x for x in (m.get("model") or "", f"reasoning {m['reasoning']}" if m.get("reasoning") else "") if x)
            f.write(f"Agent Studio - {m['displayName']}  [{m['providerId']} / {m['role']}]"
                    + (f"  ({one_line(settings, 120)})" if settings else "") + "\n"
                    f"team {team_id[:8]}  agent {m['agentId'][:8]}  workspace {one_line(workspace, 200)}\n")
    tmux: tmuxctl.Tmux = ctx["tmux"]
    session = tmux.create_team_session(
        tmuxctl.session_name_for(team_id), workspace,
        [pane_command(team_id, m["agentId"]) for m in roster],
        [f"{m['displayName']} [{m['providerId']}/{m['role']}]" for m in roster], team_id, marker)
    try:
        tx.update("team", team_id, {"tmux_session_id": session["session_id"], "tmux_window_id": session["window_id"]},
                  "team.session_created", {"sessionName": session["session_name"], "socket": tmux.socket,
                                           "panes": len(session["panes"])})
        agents_out = []
        for m, pane in zip(roster, session["panes"]):
            ident = procid.identity(pane["pane_pid"])
            if ident["startTime"] is None:
                raise AsError(TEAM_START_FAILED, f"Pane {pane['pane_id']} exited immediately.")
            tx.update("agent", m["agentId"], {"pane_id": pane["pane_id"], "pane_pid": ident["pid"],
                                              "pane_start_time": ident["startTime"], "pane_boot_id": ident["bootId"],
                                              "pane_state": "alive"}, "agent.pane_assigned",
                      {"paneId": pane["pane_id"]})
            tx.transition("agent", m["agentId"], "idle")
            if m.get("activeCatalogAgent") in (m.get("quotaHolds") or {}):
                tx.transition("agent", m["agentId"], "limit_reached",
                              set_values={"limit_reset_at": m["quotaHolds"][m["activeCatalogAgent"]]})
            from . import roles
            rc = roles.context_for(workspace, m["role"])
            agents_out.append(dict({k: v for k, v in m.items() if k != "_configuredAgents"}, paneId=pane["pane_id"], roleConfigured=rc["configured"],
                                   roleSources=rc["sources"], roleWarnings=rc["warnings"]))
        tx.transition("team", team_id, "running")
    except BaseException:
        tmux.run("kill-session", "-t", session["session_id"], check=False)
        raise
    team = tx.get("team", team_id)
    return {"teamId": team_id, "name": name, "workspace": workspace, "agents": agents_out,
            "attach": attach_info(team, tmux)}


def match_member(rows, ref, keys=("id", "member_id"), name_key="display_name"):
    """The row whose agent id equals ref, else whose member id equals ref, else whose name equals ref
    (case-insensitive); None if none does. Pure: shared by find_agent and the team CLI."""
    for key in keys:
        for r in rows:
            if r[key] is not None and r[key] == ref:
                return r
    for r in rows:
        if isinstance(ref, str) and r[name_key].casefold() == ref.casefold():
            return r
    return None


def find_agent(conn, team_id: str, ref: str) -> dict:
    """The agent of a runtime team by agent UUID, else member id, else display name (case-insensitive)."""
    rows = [dict(r) for r in conn.execute("SELECT * FROM agents WHERE team_id = ? ORDER BY ordinal", (team_id,))]
    found = match_member(rows, ref)
    if found is None:
        raise AsError(MEMBER_NOT_FOUND, f"No member {ref!r} in team {team_id}.")
    return found


# ---- verification ---------------------------------------------------------------------------------

def verify_team(tx_or_conn, team: dict, tmux: tmuxctl.Tmux) -> dict:
    """ok | missing | mismatch, plus details. Never trusts names or indices alone."""
    conn = getattr(tx_or_conn, "conn", tx_or_conn)
    sid = team.get("tmux_session_id")
    if not sid:
        return {"state": "missing", "reason": "no session recorded"}
    panes = tmux.list_panes()
    if panes is None or not any(p["session_id"] == sid for p in panes):
        return {"state": "missing", "reason": "session not found on the Agent Studio tmux server"}
    owner = tmux.session_option(sid, tmuxctl.OPT_OWNER)
    team_opt = tmux.session_option(sid, tmuxctl.OPT_TEAM)
    if owner != team.get("ownership_marker") or team_opt != team["id"]:
        return {"state": "mismatch", "reason": "ownership marker does not match"}
    session_panes = {p["pane_id"]: p for p in panes if p["session_id"] == sid}
    agents = conn.execute("SELECT id, pane_id FROM agents WHERE team_id = ?", (team["id"],)).fetchall()
    unknown = set(session_panes) - {a["pane_id"] for a in agents}
    if unknown:
        return {"state": "mismatch", "reason": f"session contains panes Agent Studio did not create: {sorted(unknown)}"}
    return {"state": "ok", "panes": session_panes}


# ---- team.stop ------------------------------------------------------------------------------------

def team_stop(tx: Tx, args: dict, ctx: dict):
    if args.get("teamId"):
        team = tx.get("team", args["teamId"])
    else:
        row = tx.conn.execute("SELECT id FROM teams WHERE workspace = ? AND def_id = ? AND status != 'stopped' "
                              "ORDER BY created_at DESC, rowid DESC", (ops.canonical_workspace(args["workspace"]),
                                                                    args["teamDefId"])).fetchone()
        if row is None:
            raise AsError(TEAM_NOT_RUNNING, f"Team {args['teamDefId']!r} is not running in this workspace.")
        team = tx.get("team", row["id"])
    if team["status"] == "stopped":
        return {"teamId": team["id"], "stopped": True, "alreadyStopped": True}
    tmux: tmuxctl.Tmux = ctx["tmux"]
    before = tmux.list_sessions() or []
    check = verify_team(tx, team, tmux)
    if check["state"] == "mismatch":
        if team["status"] != "error":
            tx.transition("team", team["id"], "error", payload={"reason": check["reason"]})
        return Failure(AsError(CLEANUP_INCOMPLETE, f"Not stopping: {check['reason']}. The session was preserved.",
                               remediation="Inspect it with: " + " ".join(tmux.base() + ["ls"]),
                               data={"teamId": team["id"]}))
    if team["status"] != "stopping":
        tx.transition("team", team["id"], "stopping")
    processes = _owned_processes(tx, team["id"], ctx["stateDir"])
    if check["state"] == "ok":
        tmux.kill_session(team["tmux_session_id"])
        if tmux.session_exists(team["tmux_session_id"]):
            tx.transition("team", team["id"], "error", payload={"reason": "session still present after kill"})
            return Failure(AsError(CLEANUP_INCOMPLETE, "The tmux session is still present after kill-session.",
                                   data={"teamId": team["id"]}))
    survivors = _reap(processes)
    if survivors:
        tx.transition("team", team["id"], "error", payload={"reason": "processes survived the stop",
                                                            "processes": survivors})
        return Failure(AsError(CLEANUP_INCOMPLETE, f"{len(survivors)} recorded process(es) are still running after "
                               "the bounded stop.", data={"teamId": team["id"], "processes": survivors}))
    for a in tx.conn.execute(f"SELECT id, status FROM assignments WHERE team_id = ? AND status IN "
                             f"({','.join('?' * len(ACTIVE))})", (team["id"],) + ACTIVE).fetchall():
        tx.transition("assignment", a["id"], "cancelled", set_values={"diagnostic_code": "TEAM_STOPPED"},
                      payload={"reason": "team stopped"})
    for t in tx.conn.execute("SELECT id, status FROM tasks WHERE team_id = ? AND status NOT IN "
                             "('succeeded', 'failed', 'cancelled')", (team["id"],)).fetchall():
        tx.transition("task", t["id"], "cancelled", payload={"reason": "team stopped"})
    for g in tx.conn.execute("SELECT id, availability, pane_state FROM agents WHERE team_id = ?",
                             (team["id"],)).fetchall():
        if g["availability"] != "offline":
            tx.transition("agent", g["id"], "offline", set_values={"pane_state": "dead"},
                          payload={"reason": "team stopped"})
    tx.transition("team", team["id"], "stopped")
    after = tmux.list_sessions() or []
    return {"teamId": team["id"], "stopped": True, "sessionWasPresent": check["state"] == "ok",
            "tmuxInventory": {"before": before, "after": after}}


def _owned_processes(tx: Tx, team_id: str, state_dir: str) -> list:
    """Recorded runner and provider identities of the team's active assignments - the only processes stop touches."""
    from .runner import run_dir
    out = []
    for a in tx.conn.execute("SELECT id, process_pid, process_start_time, process_boot_id FROM assignments "
                             "WHERE team_id = ? AND status IN ('claimed', 'running', 'waiting_input', 'reconciling')",
                             (team_id,)).fetchall():
        if a["process_pid"] is not None:
            out.append({"role": "runner", "assignmentId": a["id"], "pid": a["process_pid"],
                        "startTime": a["process_start_time"], "bootId": a["process_boot_id"]})
        meta = procid.read_json(os.path.join(run_dir(state_dir, a["id"]), "meta.json"))
        if isinstance(meta, dict) and isinstance(meta.get("providerProcess"), dict):
            out.append(dict(meta["providerProcess"], role="provider", assignmentId=a["id"]))
    return out


def _reap(processes: list, grace_s: float = 2.0) -> list:
    """Wait briefly for verified processes to exit, then SIGTERM, then SIGKILL - each step re-verifies identity."""
    import signal
    import time

    def alive():
        return [p for p in processes if procid.matches(p)]

    for sig in (None, signal.SIGTERM, signal.SIGKILL):
        if sig is not None:
            for p in alive():
                try:
                    os.kill(p["pid"], sig)
                except ProcessLookupError:
                    pass
        deadline = time.monotonic() + grace_s
        while alive() and time.monotonic() < deadline:
            time.sleep(0.05)
        if not alive():
            return []
    return [{k: p[k] for k in ("role", "assignmentId", "pid")} for p in alive()]


# ---- delivery -------------------------------------------------------------------------------------

def write_request(state_dir: str, conn, assignment_id: str) -> None:
    a = conn.execute("SELECT a.*, t.goal, t.workspace, g.role FROM assignments a JOIN tasks t ON t.id = a.task_id "
                     "JOIN agents g ON g.id = a.agent_id WHERE a.id = ?", (assignment_id,)).fetchone()
    body = {"protocol": "agent-studio/request/v1", "teamId": a["team_id"], "agentId": a["agent_id"],
            "assignmentId": a["id"], "attempt": a["attempt"], "providerId": a["provider_id"], "policy": a["policy"],
            "workspace": a["workspace"], "goal": a["goal"], "role": a["role"],
            "request": json.loads(a["request_json"]) if a["request_json"] else {}}
    target = request_path(state_dir, a["agent_id"], a["id"], box="inbox")
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    tmp = target + f".tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, target)


def delivered_anywhere(state_dir: str, agent_id: str, assignment_id: str) -> bool:
    return any(os.path.exists(request_path(state_dir, agent_id, assignment_id, box)) for box in ("inbox", "active", "done"))


def dispatch_claims(store: Store, state_dir: str) -> int:
    """Claim queued assignments for idle, live agents (one per agent), commit, THEN write the request file."""
    rows = store.conn.execute(
        "SELECT a.id, a.agent_id FROM assignments a JOIN agents g ON g.id = a.agent_id JOIN teams t ON t.id = a.team_id "
        "WHERE a.status = 'queued' AND g.availability = 'idle' AND g.pane_state = 'alive' AND t.status = 'running' "
        "AND NOT EXISTS (SELECT 1 FROM assignments b WHERE b.agent_id = a.agent_id "
        "                AND b.status IN ('claimed', 'running', 'waiting_input', 'reconciling')) "
        "ORDER BY a.created_at, a.id").fetchall()
    done_agents, n = set(), 0
    for r in rows:
        if r["agent_id"] in done_agents:
            continue
        done_agents.add(r["agent_id"])
        with store.transaction() as tx:
            tx.transition("assignment", r["id"], "claimed", expect=["queued"])
        from . import crashpoints
        crashpoints.hit("after_claim_commit")  # test-only: redelivery must cover this window
        write_request(state_dir, store.conn, r["id"])
        n += 1
    return n


def redeliver(store: Store, state_dir: str) -> int:
    """A claim committed before a crash may never have had its file written; such a request was never seen by
    any worker, so writing it now cannot cause a second execution."""
    n = 0
    for r in store.conn.execute("SELECT id, agent_id FROM assignments WHERE status = 'claimed'").fetchall():
        if not delivered_anywhere(state_dir, r["agent_id"], r["id"]):
            write_request(state_dir, store.conn, r["id"])
            n += 1
    return n


# ---- liveness -------------------------------------------------------------------------------------

def monitor(store: Store, tmux: tmuxctl.Tmux) -> int:
    """Mark verified-dead panes and lost sessions. Changes availability only; never task success."""
    teams = store.conn.execute("SELECT * FROM teams WHERE status = 'running'").fetchall()
    if not teams:
        return 0
    panes = tmux.list_panes() or []
    by_id = {p["pane_id"]: p for p in panes}
    changes = 0
    for team in map(dict, teams):
        agents = store.conn.execute("SELECT * FROM agents WHERE team_id = ? AND pane_state = 'alive'",
                                    (team["id"],)).fetchall()
        session_present = any(p["session_id"] == team["tmux_session_id"] for p in panes)
        dead = []
        for g in agents:
            p = by_id.get(g["pane_id"])
            reason = None
            if p is None or p["session_id"] != team["tmux_session_id"]:
                reason = "pane no longer exists"
            elif p["dead"]:
                reason = "pane process exited"
            elif p["pane_pid"] != g["pane_pid"] or not procid.matches(
                    {"pid": g["pane_pid"], "startTime": g["pane_start_time"], "bootId": g["pane_boot_id"]}):
                reason = "pane process identity changed"
            if reason:
                dead.append((g, reason))
        if not dead and session_present:
            continue
        with store.transaction() as tx:
            for g, reason in dead:
                tx.update("agent", g["id"], {"pane_state": "dead"}, "agent.pane_dead",
                          {"paneId": g["pane_id"], "reason": reason})
                if g["availability"] != "offline":
                    tx.transition("agent", g["id"], "offline", payload={"reason": reason})
                for a in tx.conn.execute("SELECT id FROM assignments WHERE agent_id = ? AND status IN "
                                         "('claimed', 'running', 'waiting_input')", (g["id"],)).fetchall():
                    tx.transition("assignment", a["id"], "reconciling",
                                  payload={"reason": f"worker pane lost: {reason}"})
                changes += 1
            if not session_present:
                tx.transition("team", team["id"], "error", payload={"reason": "tmux session lost"})
                changes += 1
    return changes


# ---- debug ----------------------------------------------------------------------------------------

def debug_assign(tx: Tx, args: dict, ctx: dict) -> dict:
    agent = tx.get("agent", args["agentId"])
    team = tx.get("team", agent["team_id"])
    if team["status"] != "running":
        raise AsError(BAD_REQUEST, f"Team is {team['status']}, not running.")
    task = tx.create("task", {"team_id": team["id"], "origin": "direct", "workspace": team["workspace"],
                              "goal": args["goal"]})
    from .tasks import build_request
    request = build_request(agent, team["workspace"], {"providerOptions": args.get("providerOptions") or {}})
    alias = providers.fixture_aliases(os.environ, ctx["debug"]).get(agent["provider_id"])
    if alias:
        request["fixtureAdapter"] = alias
    for k in ("deadlineMs", "outputBudgetBytes"):
        if args.get(k) is not None:
            request[k] = args[k]
    asg = tx.create("assignment", {"team_id": team["id"], "task_id": task, "agent_id": agent["id"], "attempt": 1,
                                   "policy": args.get("policy", "read_only"), "provider_id": agent["provider_id"],
                                   "request_json": request})
    tx.transition("task", task, "assigned")
    return {"taskId": task, "assignmentId": asg, "agentId": agent["id"], "receipt": "accepted"}
