"""Coordinator-side team lifecycle, assignment delivery, and pane liveness (P00-S03)."""
from __future__ import annotations

import json
import os
import shlex
import uuid
from typing import List, Optional

from . import ops, procid, tmuxctl
from .protocol import AsError, BAD_REQUEST
from .runner import request_path
from .store import Store, Tx, new_id
from .textsafe import one_line

CLEANUP_INCOMPLETE = "CLEANUP_INCOMPLETE"
TEAM_START_FAILED = "TEAM_START_FAILED"
MAX_ROSTER = 8
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


# ---- team.start ---------------------------------------------------------------------------------

def validate_roster(args: dict, allow_fake: bool) -> List[dict]:
    roster = args.get("roster")
    if not isinstance(roster, list) or not roster:
        raise AsError(BAD_REQUEST, "roster must be a non-empty list of agents.")
    if len(roster) > MAX_ROSTER:
        raise AsError(BAD_REQUEST, f"A P00 team has at most {MAX_ROSTER} agents (got {len(roster)}).")
    providers = {"codex", "claude", "agy", "opencode"} | ({"fake"} if allow_fake else set())
    seen, clean = set(), []
    for i, m in enumerate(roster):
        if not isinstance(m, dict):
            raise AsError(BAD_REQUEST, f"roster[{i}] must be an object.")
        pid = m.get("providerId")
        if pid not in providers:
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
        name = m.get("displayName") or f"{role.strip()}-{i + 1}"
        if not isinstance(name, str) or len(name) > 64:
            raise AsError(BAD_REQUEST, f"roster[{i}].displayName must be at most 64 characters.")
        clean.append({"agentId": aid, "providerId": pid, "role": one_line(role.strip(), 64),
                      "displayName": one_line(name.strip(), 64)})
    return clean


def team_start(tx: Tx, args: dict, ctx: dict) -> dict:
    roster = validate_roster(args, allow_fake=ctx["debug"])
    workspace = ops.canonical_workspace(args["workspace"])
    for m in roster:
        if tx.conn.execute("SELECT 1 FROM agents WHERE id = ?", (m["agentId"],)).fetchone():
            raise AsError(BAD_REQUEST, f"Agent {m['agentId']} already exists in another team.")
    team_id = new_id()
    marker = uuid.uuid4().hex
    name = one_line(args.get("name") or f"team {team_id[:8]}", 80)
    tx.create("team", {"name": name, "workspace": workspace, "ownership_marker": marker}, entity_id=team_id)
    for i, m in enumerate(roster):
        tx.create("agent", {"team_id": team_id, "ordinal": i, "provider_id": m["providerId"], "role": m["role"],
                            "display_name": m["displayName"]}, entity_id=m["agentId"])
        d = agent_dir(ctx["stateDir"], m["agentId"])
        for box in ("inbox", "active", "done"):
            os.makedirs(os.path.join(d, box), mode=0o700, exist_ok=True)
        with open(os.path.join(d, "banner"), "w", encoding="utf-8") as f:
            f.write(f"Agent Studio - {m['displayName']}  [{m['providerId']} / {m['role']}]\n"
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
            agents_out.append(dict(m, paneId=pane["pane_id"]))
        tx.transition("team", team_id, "running")
    except BaseException:
        tmux.run("kill-session", "-t", session["session_id"], check=False)
        raise
    team = tx.get("team", team_id)
    return {"teamId": team_id, "name": name, "workspace": workspace, "agents": agents_out,
            "attach": attach_info(team, tmux)}


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
    team = tx.get("team", args["teamId"])
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
    if check["state"] == "ok":
        tmux.kill_session(team["tmux_session_id"])
        if tmux.session_exists(team["tmux_session_id"]):
            tx.transition("team", team["id"], "error", payload={"reason": "session still present after kill"})
            return Failure(AsError(CLEANUP_INCOMPLETE, "The tmux session is still present after kill-session.",
                                   data={"teamId": team["id"]}))
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


# ---- delivery -------------------------------------------------------------------------------------

def write_request(state_dir: str, conn, assignment_id: str) -> None:
    a = conn.execute("SELECT a.*, t.goal, t.workspace FROM assignments a JOIN tasks t ON t.id = a.task_id "
                     "WHERE a.id = ?", (assignment_id,)).fetchone()
    body = {"protocol": "agent-studio/request/v1", "teamId": a["team_id"], "agentId": a["agent_id"],
            "assignmentId": a["id"], "attempt": a["attempt"], "providerId": a["provider_id"], "policy": a["policy"],
            "workspace": a["workspace"], "goal": a["goal"],
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
    asg = tx.create("assignment", {"team_id": team["id"], "task_id": task, "agent_id": agent["id"], "attempt": 1,
                                   "policy": "read_only", "provider_id": agent["provider_id"],
                                   "request_json": {"stub": args["stub"]}})
    tx.transition("task", task, "assigned")
    return {"taskId": task, "assignmentId": asg, "agentId": agent["id"], "receipt": "accepted"}
