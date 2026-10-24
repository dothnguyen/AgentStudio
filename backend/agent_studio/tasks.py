"""Direct tasks and assignment cancellation (P00-S05). Coordinator-side; every function runs inside the
command's transaction, so the receipt, rows, and events commit together."""
from __future__ import annotations

import os
from typing import Optional

from . import providers
from .protocol import AsError, BAD_REQUEST
from .runner import CANCEL_MARKER, request_path, run_dir
from .store import NOT_FOUND, Tx

AGENT_BUSY = "AGENT_BUSY"
AGENT_UNAVAILABLE = "AGENT_UNAVAILABLE"
AGENT_NOT_IN_TEAM = "AGENT_NOT_IN_TEAM"
TEAM_NOT_RUNNING = "TEAM_NOT_RUNNING"
WORKSPACE_BUSY = "WORKSPACE_BUSY"
POLICY_UNSUPPORTED = "POLICY_UNSUPPORTED"

ACTIVE = ("queued", "claimed", "running", "waiting_input", "reconciling")


def _active_for_agent(tx: Tx, agent_id: str) -> Optional[dict]:
    row = tx.conn.execute(f"SELECT id, status FROM assignments WHERE agent_id = ? AND status IN "
                          f"({','.join('?' * len(ACTIVE))}) LIMIT 1", (agent_id,) + ACTIVE).fetchone()
    return dict(row) if row else None


def _mutating_in_workspace(tx: Tx, workspace: str) -> Optional[str]:
    row = tx.conn.execute(
        f"SELECT a.id FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.workspace = ? "
        f"AND a.policy = 'workspace_write' AND a.status IN ({','.join('?' * len(ACTIVE))}) LIMIT 1",
        (workspace,) + ACTIVE).fetchone()
    if row:
        return f"assignment {row['id']}"
    row = tx.conn.execute("SELECT w.id FROM workflow_runs w JOIN tasks t ON t.id = w.task_id WHERE t.workspace = ? "
                          "AND w.status IN ('queued', 'running', 'paused') LIMIT 1", (workspace,)).fetchone()
    return f"workflow {row['id']}" if row else None


def run_workspace(tx, team: dict, requested) -> str:
    """The workspace a run may use: the team's own, or a worktree registered to a live ticket of the
    board (P04-S10 restored the check S06 removed; §F)."""
    if requested is None or os.path.realpath(requested) == team["workspace"]:
        return team["workspace"]
    from . import boardmodel
    return boardmodel.registered_worktree(tx, team["workspace"], requested)


def build_request(agent: dict, workspace: str, extra: dict = None) -> dict:
    """Freeze, at assignment creation, what the runner will use: model, reasoning, the workspace role context
    (text + source hashes), and whether the runner starts the board MCP server for this assignment, so the
    journal shows exactly what each attempt was given."""
    from . import roles
    request = dict(extra or {})
    request["model"] = agent.get("model")
    request["reasoning"] = agent.get("reasoning")
    request["mcpTickets"] = bool(agent.get("can_add_tickets"))
    ctx = roles.context_for(workspace, agent["role"])
    request["roleContext"] = ctx
    return request


def adapter_for(agent: dict, ctx: dict):
    alias = providers.fixture_aliases(os.environ, ctx["debug"]).get(agent["provider_id"])
    return providers.resolve(agent["provider_id"], allow_test_only=ctx["debug"], fixture=alias), alias


def task_direct(tx: Tx, args: dict, ctx: dict) -> dict:
    team = tx.get("team", args["teamId"])
    try:
        agent = tx.get("agent", args["agentId"])
    except AsError:
        raise AsError(NOT_FOUND, f"Agent {args['agentId']} does not exist.")
    if agent["team_id"] != team["id"]:
        raise AsError(AGENT_NOT_IN_TEAM, f"Agent {agent['id']} is not a member of team {team['id']}.")
    if team["status"] != "running":
        raise AsError(TEAM_NOT_RUNNING, f"Team {team['id']} is {team['status']}.")
    ws = run_workspace(tx, team, args.get("workspace"))
    if agent["availability"] != "idle" or agent["pane_state"] != "alive":
        code = AGENT_BUSY if agent["availability"] in ("busy", "waiting_input") else AGENT_UNAVAILABLE
        raise AsError(code, f"Agent {agent['display_name']} is {agent['availability']} (pane {agent['pane_state']}).",
                      data={"agentId": agent["id"], "availability": agent["availability"]})
    active = _active_for_agent(tx, agent["id"])
    if active:
        raise AsError(AGENT_BUSY, f"Agent {agent['display_name']} already has assignment {active['id']} "
                                  f"({active['status']}). Busy agents are not silently queued.",
                      data={"agentId": agent["id"], "assignmentId": active["id"]})
    adapter, alias = adapter_for(agent, ctx)
    policy = args["policy"]
    if adapter.describe(dict(os.environ))["policies"].get(policy) in (None, "unsupported"):
        raise AsError(POLICY_UNSUPPORTED, f"{agent['provider_id']} has no verified mapping for {policy}.")
    if policy == "workspace_write":
        holder = _mutating_in_workspace(tx, ws)
        if holder:
            raise AsError(WORKSPACE_BUSY, f"The workspace already has active mutating work ({holder}).",
                          data={"workspace": ws})
    request = build_request(agent, ws)
    if args.get("deadlineMs"):
        request["deadlineMs"] = args["deadlineMs"]
    if args.get("debugProviderOptions") is not None:
        if not ctx["debug"] or not getattr(adapter, "test_only", False):
            raise AsError(BAD_REQUEST, "debugProviderOptions is only accepted by debug coordinators for test-only "
                                       "providers.")
        request["providerOptions"] = args["debugProviderOptions"]
    if alias:
        request["fixtureAdapter"] = alias
    task = tx.create("task", {"team_id": team["id"], "origin": "direct", "workspace": ws,
                              "goal": args["text"]})
    asg = tx.create("assignment", {"team_id": team["id"], "task_id": task, "agent_id": agent["id"], "attempt": 1,
                                   "policy": policy, "provider_id": agent["provider_id"], "request_json": request},
                    payload=_request_summary(request))
    tx.transition("task", task, "assigned")
    return {"receipt": "accepted", "model": agent.get("model"), "reasoning": agent.get("reasoning"),
            "roleSources": request["roleContext"]["sources"], "roleWarnings": request["roleContext"]["warnings"], "teamId": team["id"], "agentId": agent["id"], "taskId": task,
            "assignmentId": asg, "policy": policy, "providerId": agent["provider_id"]}


def _finish_cancel(tx: Tx, asg: dict, reason: str) -> None:
    tx.transition("assignment", asg["id"], "cancelled", set_values={"diagnostic_code": "CANCELLED"},
                  payload={"reason": reason})
    task = tx.get("task", asg["task_id"])
    if task["origin"] == "direct" and task["status"] not in ("succeeded", "failed", "cancelled"):
        tx.transition("task", task["id"], "cancelled", payload={"reason": reason})  # workflows own their task
    agent = tx.get("agent", asg["agent_id"])
    if agent["availability"] in ("busy", "waiting_input") and not _other_active(tx, agent["id"], asg["id"]):
        tx.transition("agent", agent["id"], "idle", payload={"reason": "assignment cancelled"})


def _other_active(tx: Tx, agent_id: str, except_id: str) -> bool:
    return tx.conn.execute(f"SELECT 1 FROM assignments WHERE agent_id = ? AND id != ? AND status IN "
                           f"({','.join('?' * len(ACTIVE))}) LIMIT 1", (agent_id, except_id) + ACTIVE).fetchone() \
        is not None


def _unapplied_final(tx: Tx, assignment_id: str) -> bool:
    return tx.conn.execute("SELECT 1 FROM worker_reports r LEFT JOIN report_applications a ON a.report_id = r.id "
                           "WHERE r.assignment_id = ? AND r.kind = 'final' AND a.report_id IS NULL",
                           (assignment_id,)).fetchone() is not None


def _runner_alive(asg: dict) -> bool:
    from . import procid
    return asg.get("process_pid") is not None and procid.matches(
        {"pid": asg["process_pid"], "startTime": asg["process_start_time"], "bootId": asg["process_boot_id"]})


def _write_marker(state_dir: str, assignment_id: str) -> None:
    d = run_dir(state_dir, assignment_id)
    os.makedirs(d, mode=0o700, exist_ok=True)
    fd = os.open(os.path.join(d, CANCEL_MARKER), os.O_WRONLY | os.O_CREAT, 0o600)
    os.close(fd)


def assignment_cancel(tx: Tx, args: dict, ctx: dict) -> dict:
    """Request cancellation. Exactly one terminal state ever wins: either this cancel or the runner's own final
    report, never both (terminal states are final; a late report is rejected)."""
    asg = tx.get("assignment", args["assignmentId"])
    status, sd = asg["status"], ctx["stateDir"]
    out = {"assignmentId": asg["id"], "previousStatus": status}
    if status in ("succeeded", "failed", "cancelled"):
        return dict(out, outcome="already_finished", status=status)
    if _unapplied_final(tx, asg["id"]):
        return dict(out, outcome="finishing", status=status)  # its final report is being applied right now
    if status == "queued":
        _finish_cancel(tx, asg, "cancelled before it was claimed")
        return dict(out, outcome="cancelled", status="cancelled")
    if status == "claimed":
        inbox = request_path(sd, asg["agent_id"], asg["id"], "inbox")
        pulled = os.path.join(os.path.dirname(request_path(sd, asg["agent_id"], asg["id"], "done")),
                              f"{asg['id']}.request.cancelled")
        os.makedirs(os.path.dirname(pulled), mode=0o700, exist_ok=True)
        try:
            os.rename(inbox, pulled)  # atomic: the worker either already moved it, or never will see it
            _finish_cancel(tx, asg, "cancelled before any worker picked it up")
            return dict(out, outcome="cancelled", status="cancelled")
        except FileNotFoundError:
            if not any(os.path.exists(request_path(sd, asg["agent_id"], asg["id"], b)) for b in ("active", "done")):
                _finish_cancel(tx, asg, "cancelled before the request was written")
                return dict(out, outcome="cancelled", status="cancelled")
    if status in ("claimed", "running", "reconciling") and (status == "claimed" or _runner_alive(asg)):
        _write_marker(sd, asg["id"])  # the runner checks this before starting and while running
        signalled = False
        if _runner_alive(asg):
            try:
                os.kill(asg["process_pid"], 15)  # SIGTERM to the recorded runner only
                signalled = True
            except ProcessLookupError:
                pass
        tx.note("assignment", asg["id"], "assignment.cancel_requested", {"signalled": signalled})
        return dict(out, outcome="cancel_requested", status=status)
    # waiting_input, or running/reconciling with the runner gone: nothing can still act, so cancel now.
    _finish_cancel(tx, asg, f"cancelled while {status}")
    return dict(out, outcome="cancelled", status="cancelled")


def _request_summary(request: dict) -> dict:
    rc = request.get("roleContext") or {}
    return {"model": request.get("model"), "reasoning": request.get("reasoning"),
            "roleContextSha256": rc.get("sha256"), "roleSources": rc.get("sources", []),
            "roleWarnings": rc.get("warnings", [])}
