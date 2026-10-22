"""assignment.resolve (P00-S07): the operator's way out of uncertain or blocked work.

Allowed only for an assignment that is `waiting_input` or `reconciling`, or that is the current stage of a
`paused` workflow - and only once its runner and provider processes are proven gone (cancel first otherwise).

  fail    -> assignment failed; direct task failed; paused workflow failed
  cancel  -> assignment cancelled; direct task cancelled; paused workflow cancelled
  retry   -> the old attempt is closed (SUPERSEDED_BY_RETRY) and a NEW assignment (new ID, attempt + 1) is queued
             for the same agent; a different policy must be asked for explicitly and is recorded; a paused
             workflow resumes from the same stage with the same prompt
"""
from __future__ import annotations

import json
import os

from . import procid, tasks, workflow
from .protocol import AsError, BAD_REQUEST
from .runner import run_dir
from .store import Tx

RESOLVE_NOT_ALLOWED = "RESOLVE_NOT_ALLOWED"
PROCESS_STILL_RUNNING = "PROCESS_STILL_RUNNING"
TERMINAL = ("succeeded", "failed", "cancelled")


def _workflow_for(tx: Tx, task: dict):
    if task["origin"] != "workflow":
        return None
    row = tx.conn.execute("SELECT * FROM workflow_runs WHERE task_id = ?", (task["id"],)).fetchone()
    return dict(row) if row else None


def _processes_alive(sd: str, a: dict) -> list:
    alive = []
    if a["process_pid"] is not None and procid.matches(
            {"pid": a["process_pid"], "startTime": a["process_start_time"], "bootId": a["process_boot_id"]}):
        alive.append({"role": "runner", "pid": a["process_pid"]})
    try:
        with open(os.path.join(run_dir(sd, a["id"]), "meta.json"), encoding="utf-8") as f:
            prov = json.load(f).get("providerProcess")
        if prov and procid.matches(prov):
            alive.append({"role": "provider", "pid": prov["pid"]})
    except (OSError, ValueError):
        pass
    return alive


def _close(tx: Tx, a: dict, status: str, code: str, reason: str) -> None:
    if a["status"] not in TERMINAL:
        tx.transition("assignment", a["id"], status, set_values={"diagnostic_code": code}, payload={"reason": reason})
    g = tx.get("agent", a["agent_id"])
    if g["availability"] in ("busy", "waiting_input") and not tasks._other_active(tx, g["id"], a["id"]):
        tx.transition("agent", g["id"], "idle", payload={"reason": reason})


def resolve(tx: Tx, args: dict, ctx: dict) -> dict:
    a = tx.get("assignment", args["assignmentId"])
    action = args["action"]
    task = tx.get("task", a["task_id"])
    wf = _workflow_for(tx, task)
    if wf and not workflow.is_definition_run(wf):
        raise AsError(RESOLVE_NOT_ALLOWED, "This workflow run was started before the upgrade and cannot continue; "
                      "it can only be cancelled.", remediation=f"agent-studio workflow cancel --workflow {wf['id']}")
    current = workflow._current_attempt(tx, wf["id"]) if wf else None
    if wf and current and current["assignment_id"] != a["id"]:
        raise AsError(RESOLVE_NOT_ALLOWED, "Only the workflow's current stage can be resolved.")
    in_paused_wf = bool(wf and wf["status"] == "paused" and current and current["assignment_id"] == a["id"])
    if not (a["status"] in ("waiting_input", "reconciling") or in_paused_wf):
        raise AsError(RESOLVE_NOT_ALLOWED, f"Assignment {a['id']} is {a['status']}"
                      + (f" in a {wf['status']} workflow" if wf else "") + "; resolve applies only to waiting_input, "
                      "reconciling, or the current stage of a paused workflow.",
                      remediation="Use assignment cancel for queued or running work.")
    if wf and wf["status"] in TERMINAL:
        raise AsError(RESOLVE_NOT_ALLOWED, f"Its workflow is already {wf['status']}.")
    alive = _processes_alive(ctx["stateDir"], a)
    if alive:
        raise AsError(PROCESS_STILL_RUNNING, "The attempt may still be running "
                      f"({', '.join(p['role'] + ' ' + str(p['pid']) for p in alive)}); it is never re-run alongside "
                      "itself.", remediation=f"agent-studio assignment cancel --assignment {a['id']}", data={"alive": alive})
    out = {"assignmentId": a["id"], "action": action, "previousStatus": a["status"]}
    reason = f"resolved by the operator: {action}"

    if action in ("fail", "cancel"):
        status = "failed" if action == "fail" else "cancelled"
        _close(tx, a, status, "RESOLVED_" + action.upper(), reason)
        if wf:
            workflow._end(tx, tx.get("workflow_run", wf["id"]), status, reason)
        elif task["status"] not in TERMINAL:
            tx.transition("task", task["id"], status, payload={"reason": reason})
        return dict(out, status=status)

    # retry
    agent = tx.get("agent", a["agent_id"])
    if agent["pane_state"] != "alive" or agent["availability"] in ("offline", "error", "starting"):
        raise AsError(tasks.AGENT_UNAVAILABLE, f"Agent {agent['display_name']} is {agent['availability']} "
                      f"(pane {agent['pane_state']}); a retry needs a live agent.",
                      remediation=f"Resolve with --action fail or cancel instead.")
    policy = args.get("policy") or a["policy"]
    if wf and policy != a["policy"]:
        raise AsError(BAD_REQUEST, "A workflow stage's policy is fixed by its role; it cannot be changed on retry.")
    adapter, alias = tasks.adapter_for(agent, ctx)
    if adapter.describe(dict(os.environ))["policies"].get(policy) in (None, "unsupported"):
        raise AsError(tasks.POLICY_UNSUPPORTED, f"{agent['provider_id']} has no verified mapping for {policy}.")
    if args.get("debugProviderOptions") is not None and not (ctx["debug"] and getattr(adapter, "test_only", False)):
        raise AsError(BAD_REQUEST, "debugProviderOptions is only accepted by debug coordinators for test-only providers.")
    if not wf and policy == "workspace_write":
        holder = tx.conn.execute(
            f"SELECT a.id FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE t.workspace = ? AND a.task_id != ? "
            f"AND a.policy = 'workspace_write' AND a.status IN ({','.join('?' * len(tasks.ACTIVE))}) LIMIT 1",
            (task["workspace"], task["id"]) + tasks.ACTIVE).fetchone()
        if holder:
            raise AsError(tasks.WORKSPACE_BUSY, f"The workspace has other active mutating work ({holder['id']}).")
    _close(tx, a, "failed", "SUPERSEDED_BY_RETRY", reason)
    policy_change = {"from": a["policy"], "to": policy} if policy != a["policy"] else None

    if wf:
        wf_row = tx.get("workflow_run", wf["id"])
        tx.transition("stage_attempt", current["id"], "abandoned", payload={"reason": reason})
        if wf_row["status"] == "paused":
            tx.transition("workflow_run", wf["id"], "running",
                          set_values={"transition_reason": f"resumed by the operator ({current['stage']} retried)"})
        with open(current["prompt_path"], encoding="utf-8") as f:
            prompt = f.read()
        new = workflow._dispatch(tx, wf_row["id"], current["stage"], prompt, ctx, from_assignment=a["id"],
                                 provider_options=args.get("debugProviderOptions"))
        tx.note("workflow_run", wf["id"], "workflow_run.resumed",
                {"stage": current["stage"], "fromAssignmentId": a["id"], "toAssignmentId": new})
        return dict(out, status="retried", newAssignmentId=new, stage=current["stage"])

    old = json.loads(a["request_json"]) if a["request_json"] else {}
    request = tasks.build_request(agent, task["workspace"],
                                  {k: v for k, v in old.items() if k in ("deadlineMs", "providerOptions", "promptFile")})
    if args.get("debugProviderOptions") is not None:
        request["providerOptions"] = args["debugProviderOptions"]
    if alias:
        request["fixtureAdapter"] = alias
    new = tx.create("assignment", {"team_id": a["team_id"], "task_id": task["id"], "agent_id": agent["id"],
                                   "attempt": a["attempt"] + 1, "policy": policy, "provider_id": agent["provider_id"],
                                   "request_json": request},
                    payload=dict(tasks._request_summary(request), retryOf=a["id"], policyChange=policy_change))
    if task["status"] == "waiting_input":
        tx.transition("task", task["id"], "running", payload={"reason": "retried"})
    tx.note("task", task["id"], "task.retried", {"fromAssignmentId": a["id"], "toAssignmentId": new,
                                                 "policyChange": policy_change})
    return dict(out, status="retried", newAssignmentId=new, attempt=a["attempt"] + 1, policyChange=policy_change)
