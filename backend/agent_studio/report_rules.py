"""How the coordinator applies worker reports to state.

Rules that already hold:
  * a report must match its assignment's agent and attempt, or it is rejected without any state change;
  * `start` is the only way from claimed to running, and it must carry a full process identity;
  * a final report can only finish a running/waiting assignment; terminal assignments never change;
  * a final report must pass contract.validate_report (protocol, fields, matching assignment/agent/provider/
    attempt/policy); a report that claims success without the evidence is applied as `inconclusive`;
  * an `inconclusive` final goes to `reconciling`, never to `succeeded`.
"""
from __future__ import annotations

import json
import os

from . import boardmodel, contract, gitws, worktrees
from .protocol import AsError
from .state import utcnow
from .store import Tx

REPORT_MISMATCH = "REPORT_MISMATCH"
ACTIVE_ASSIGNMENT = ("claimed", "running", "waiting_input", "reconciling")

FINAL_MAP = {  # report status -> (assignment state, task state or None, agent state)
    "succeeded": ("succeeded", "succeeded", "idle"),
    "failed": ("failed", "failed", "idle"),
    "cancelled": ("cancelled", "cancelled", "idle"),
    "waiting_input": ("waiting_input", "waiting_input", "waiting_input"),
    "inconclusive": ("reconciling", None, "idle"),
}


def _int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _merge_direct_worktree(tx: Tx, asg: dict, task: dict, report_body: dict, ctx: dict | None) -> dict:
    """Commit and squash-merge a successful isolated direct task. Returns an audit-friendly result."""
    try:
        request = json.loads(asg.get("request_json") or "{}")
    except ValueError:
        request = {}
    meta = request.get("directWorktree")
    if not isinstance(meta, dict) or not meta.get("mergeOnSuccess") or report_body.get("status") != "succeeded":
        return {"required": False, "ok": True}
    main, path, branch, base = (meta.get(k) for k in ("mainWorkspace", "path", "branch", "baseBranch"))
    if not all(isinstance(v, str) and v for v in (main, path, branch, base)) or task["workspace"] != path:
        return {"required": True, "ok": False, "code": "DIRECT_WORKTREE_INVALID"}
    try:
        committed = worktrees.commit_round(path, f"Direct task: {task['goal'].splitlines()[0][:72]}")
    except AsError as e:
        return {"required": True, "ok": False, "code": e.code, "message": e.message}
    if not committed.get("commit"):
        # Board-only work (for example, creating tickets through MCP) has no Git delta to merge and must not be
        # blocked by an unrelated dirty main checkout.
        worktrees.remove(main, path, state_dir=(ctx or {}).get("stateDir"))
        merged = {"required": True, "ok": True, "branch": branch, "commit": None, "worktreeCommit": None}
        tx.note("task", task["id"], "task.worktree_merged", merged)
        return merged
    if not worktrees.is_clean(main):
        return {"required": True, "ok": False, "code": "MAIN_CHECKOUT_DIRTY", "branch": branch, "path": path}
    head = gitws.run(main, "symbolic-ref", "--short", "HEAD", check=False)
    if head.returncode != 0 or head.stdout.decode().strip() != base:
        return {"required": True, "ok": False, "code": "MAIN_CHECKOUT_WRONG_BRANCH",
                "branch": branch, "path": path}
    result = gitws.run(main, "merge", "--squash", branch, check=False)
    if result.returncode != 0:
        raw = gitws.run(main, "diff", "--name-only", "--diff-filter=U", check=False).stdout
        files = [line for line in raw.decode("utf-8", "replace").splitlines() if line]
        gitws.run(main, "reset", "--merge", check=False)
        conflict = {"required": True, "ok": False, "code": "MERGE_CONFLICT", "files": files,
                    "branch": branch, "path": path}
        status = meta.get("onMergeConflict")
        if status:
            phase = boardmodel.effective_current_phase(tx.conn, main)
            title = f"Resolve direct-task merge conflict: {task['goal'].splitlines()[0][:120]}"
            body = (f"The coordinator could not merge direct task {task['id']} into `{base}`. "
                    f"Resolve the preserved branch `{branch}` in its registered worktree.\n\n"
                    f"Original task:\n{task['goal']}\n\nConflicting files:\n" +
                    ("\n".join(f"- {name}" for name in files) if files else "- merge failed before Git listed files"))
            added = boardmodel.ticket_add(tx, main, {"title": title, "body": body, "priority": 0,
                                                     "phase": phase["slug"], "status": status})["ticket"]
            tx.conn.execute("UPDATE tickets SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?",
                            (branch, path, utcnow(), added["id"]))
            boardmodel._ticket_event(tx.conn, added["id"], "ticket.direct_merge_conflict", "coordinator",
                                     status, status,
                                     {"ticketId": added["id"], "key": added["key"], "taskId": task["id"],
                                      "branch": branch, "path": path, "files": files})
            conflict["ticket"] = added["key"]
        return conflict
    merge_commit = None
    if gitws.run(main, "diff", "--cached", "--quiet", check=False).returncode == 0:
        gitws.run(main, "reset", "--merge", check=False)
    else:
        gitws.run(main, "commit", "-m", f"Direct task: {task['goal'].splitlines()[0][:72]}")
        merge_commit = gitws.run(main, "rev-parse", "--verify", "HEAD^{commit}").stdout.decode().strip()
    worktrees.remove(main, path, state_dir=(ctx or {}).get("stateDir"))
    merged = {"required": True, "ok": True, "branch": branch, "commit": merge_commit,
              "worktreeCommit": committed.get("commit")}
    tx.note("task", task["id"], "task.worktree_merged", merged)
    return merged


def apply(tx: Tx, report: dict, ctx: dict = None):
    asg = tx.get("assignment", report["assignment_id"])
    payload = report["payload"]
    if payload.get("agentId") != asg["agent_id"] or payload.get("attempt") != asg["attempt"]:
        raise AsError(REPORT_MISMATCH, "Report agent/attempt does not match the assignment.")
    kind = report["kind"]
    data = {"reportSeq": report["report_seq"]}

    if kind == "start":
        if not (_int(payload.get("pid")) and _int(payload.get("startTime")) and isinstance(payload.get("bootId"), str)):
            raise AsError(REPORT_MISMATCH, "A start report needs pid, startTime and bootId.")
        data["provider"] = payload.get("provider")
        seq = tx.transition("assignment", asg["id"], "running", expect=["claimed"], payload=data, set_values={
            "process_pid": payload["pid"], "process_start_time": payload["startTime"],
            "process_boot_id": payload["bootId"]})
        task = tx.get("task", asg["task_id"])
        if task["status"] == "assigned" and task["origin"] == "direct":
            tx.transition("task", task["id"], "running")
        agent = tx.get("agent", asg["agent_id"])
        if agent["availability"] == "idle":
            tx.transition("agent", agent["id"], "busy")
        return "started", seq

    if kind in ("progress", "attention"):
        if asg["status"] not in ACTIVE_ASSIGNMENT:
            raise AsError(REPORT_MISMATCH, f"Assignment is {asg['status']}; late {kind} report ignored.")
        message = str(payload.get("message", ""))[:500]
        extra = {"providerProcess": payload["providerProcess"]} if isinstance(payload.get("providerProcess"), dict) else {}
        return "recorded", tx.note("assignment", asg["id"], f"assignment.{kind}", dict(data, message=message, **extra))

    if kind == "final":
        expect = {"assignmentId": asg["id"], "agentId": asg["agent_id"], "providerId": asg["provider_id"],
                  "attempt": asg["attempt"], "policy": asg["policy"]}
        report_body = {k: v for k, v in payload.items()}
        try:
            contract.validate_report(report_body, expect)
            status = report_body["status"]
            code = report_body.get("diagnosticCode")
        except AsError as e:
            if e.code != contract.CONTRADICTORY:
                raise  # malformed or mismatched: rejected, nothing changes
            status, code = "inconclusive", contract.CONTRADICTORY  # claimed success without the evidence
            data["contradiction"] = e.message
        task = tx.get("task", asg["task_id"])
        merge = _merge_direct_worktree(tx, asg, task, report_body, ctx)
        if status == "succeeded" and not merge["ok"]:
            status, code = "failed", merge["code"]
            report_body = dict(report_body, status="failed", diagnosticCode=code, merge=merge,
                               agentStatus="succeeded")
            data["merge"] = merge
        a_state, t_state, g_state = FINAL_MAP[status]
        if status == "failed" and code == "USAGE_LIMIT":
            g_state = "limit_reached"
        data.update(status=status, diagnosticCode=code)
        seq = tx.transition("assignment", asg["id"], a_state, expect=["running", "waiting_input", "reconciling"],
                            payload=data,
                            set_values={"result_json": report_body, "diagnostic_code": code})
        # A workflow task's status belongs to the workflow engine; one stage finishing never finishes the task.
        if task["origin"] == "direct" and t_state and task["status"] != t_state and \
                t_state in _task_targets(task["status"]):
            tx.transition("task", task["id"], t_state)
        agent = tx.get("agent", asg["agent_id"])
        if agent["availability"] in ("busy", "waiting_input") and agent["availability"] != g_state:
            values = {"limit_reset_at": report_body.get("limitResetAt")} if g_state == "limit_reached" else None
            tx.transition("agent", agent["id"], g_state, set_values=values)
            if g_state == "limit_reached":
                tx.note("agent", agent["id"], "board.limit_reached",
                        {"agentId": agent["id"], "resetAt": report_body.get("limitResetAt")})
        return "finished", seq

    raise AsError(REPORT_MISMATCH, f"Unknown report kind {kind!r}.")


def _task_targets(current: str):
    from .schema import ENTITIES
    return ENTITIES["task"].transitions.get(current, frozenset())
