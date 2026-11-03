"""The board scheduler (P04-S10): binds a running team to a workspace board and works it.

One coordinator tick, per workspace with a running board binding: apply finished runs through the S09
applier (also while the board is stopped — running work finishes), and (only while running) claim tickets
by rule: rules in `priority` order, tickets of the effective current phase whose dependencies are
finished, under the rule's `cap`, worked by a free member of the rule's role. A claim takes a lease, sets
the rule's `during` status, creates the ticket's worktree when the rule's workspace mode says so, and
starts the rule's workflow. Workflows with no role (only `action`/`check` steps) are run by the
coordinator itself, after claims: it claims one ticket, sets `whileRunning`, executes the steps in order
and applies the result. Roles, workflows and statuses come from the board's configuration; nothing here
names one. This module is coordinator glue (like the P03 scheduler it replaces): it may drive the engine
and the retained worktree helpers.
"""
from __future__ import annotations

import json
import os
import time

from . import boardmodel, boardworkflows, delegation, gitws, tasks, workflowdef, worktrees
from .protocol import AsError, BOARD_ALREADY_RUNNING, TEAM_NOT_RUNNING
from .state import utcnow

ACTIVE_ASSIGNMENT = ("queued", "claimed", "running", "waiting_input", "reconciling")
# The tick applies every finished or paused run except one waiting for input.


def _board_row(conn, workspace):
    return conn.execute("SELECT * FROM board_state WHERE workspace = ?", (workspace,)).fetchone()


def _team(conn, team_id):
    return conn.execute("SELECT * FROM teams WHERE id = ?", (team_id,)).fetchone()


# ---- binding (board.run / board.stop, called from the coordinator handlers) --------------------------------

def bind_team(tx, workspace: str, team_id: str) -> dict:
    config = boardmodel.load_config(workspace)
    problems = boardmodel.check_rules(workspace, config)
    if problems:
        raise AsError("BOARD_CONFIG_INVALID", f"board rules: {len(problems)} problem(s); the board cannot run",
                      data={"problems": problems})
    team = _team(tx.conn, team_id)
    if team is None or team["workspace"] != workspace:
        raise AsError(TEAM_NOT_RUNNING, f"Team {team_id} is not running on this workspace.")
    if team["status"] != "running":
        raise AsError(TEAM_NOT_RUNNING, f"Team {team['id']} is {team['status']}.")
    boardmodel.ensure_board(tx, workspace)
    row = _board_row(tx.conn, workspace)
    if row["team_id"] is not None and row["team_id"] != team_id and row["run_status"] == "running":
        bound = _team(tx.conn, row["team_id"])
        if bound is not None and bound["status"] == "running":  # a stopped team's binding is stale: take it over
            raise AsError(BOARD_ALREADY_RUNNING, f"Team {row['team_id']} already runs this board.",
                          data={"teamId": row["team_id"]})
    tx.conn.execute("UPDATE board_state SET team_id = ?, run_status = 'running', updated_at = ? "
                    "WHERE workspace = ?", (team_id, utcnow(), workspace))
    return {"board": {"workspace": workspace, "status": "running", "teamId": team_id},
            "rules": len(config["rules"])}


def stop_board(tx, workspace: str) -> dict:
    row = _board_row(tx.conn, workspace)
    if row is None:
        raise AsError(TEAM_NOT_RUNNING, "No board is running on this workspace.")
    tx.conn.execute("UPDATE board_state SET run_status = 'stopped', updated_at = ? WHERE workspace = ?",
                    (utcnow(), workspace))
    return {"board": {"workspace": workspace, "status": "stopped", "teamId": row["team_id"]}}


# ---- the tick ---------------------------------------------------------------------------------------------

def tick(store, ctx: dict) -> dict:
    """One scheduler pass over every workspace with a board binding. Never raises: a broken board is
    skipped (its commands already report the problem) and recorded in the return value."""
    out = {"boards": 0, "applied": 0, "merged": 0, "claimed": 0, "errors": []}
    rows = store.conn.execute("SELECT * FROM board_state WHERE team_id IS NOT NULL").fetchall()
    for row in rows:
        workspace = row["workspace"]
        try:
            with store.transaction(actor="coordinator") as tx:  # running work always finishes
                boardmodel.backfill_workflow(tx, workspace)
                _recover(tx, workspace, ctx)
                out["applied"] += _apply_finished(tx, workspace, ctx)
                if row["run_status"] != "running":  # a stopped board still finishes action workflows
                    config = boardmodel.load_config(workspace)
                    merged, errors = _run_action_workflows(tx, workspace, row["team_id"], config, ctx)
                    out["merged"] += merged
                    out["errors"].extend(errors)
            if row["run_status"] == "running":
                with store.transaction(actor="coordinator") as tx:
                    team = _team(tx.conn, row["team_id"])
                    config = boardmodel.load_config(workspace)
                    if team is not None and team["status"] == "running":
                        claimed, errors = _claim(tx, workspace, team, config, ctx)
                        out["claimed"] += claimed
                        out["errors"].extend(errors)
                    merged, errors = _run_action_workflows(tx, workspace, row["team_id"], config, ctx)
                    out["merged"] += merged
                    out["errors"].extend(errors)
            out["boards"] += 1
        except AsError as e:
            out["errors"].append({"workspace": workspace, "code": e.code, "message": e.message})
        except Exception as e:  # a broken workspace must not stop the others
            out["errors"].append({"workspace": workspace, "code": "INTERNAL", "message": str(e)})
    return out


def _apply_finished(tx, workspace: str, ctx: dict) -> int:
    rows = tx.conn.execute(
        "SELECT t.key AS key, t.active_run_id AS run FROM tickets t WHERE t.workspace = ? "
        "AND t.active_run_id IS NOT NULL", (workspace,)).fetchall()
    applied = 0
    for row in rows:
        run = tx.conn.execute("SELECT id, status, transition_reason FROM workflow_runs WHERE id = ?",
                              (row["run"],)).fetchone()
        if run is None:
            continue
        if tx.conn.execute("SELECT 1 FROM agents a JOIN stage_attempts s ON s.assignment_id = a.pending_assignment "
                           "WHERE a.pending_agent IS NOT NULL AND s.workflow_run_id = ?", (row["run"],)).fetchone():
            continue
        if _waiting_input(tx, row["run"]):
            continue
        if run["status"] not in boardmodel.FINISHED_RUN_STATES:
            continue
        ticket = boardmodel.get_ticket(tx.conn, workspace, row["key"])
        result = boardmodel.run_result(tx.conn, dict(run))
        workflow = _claiming_workflow(tx, workspace, ticket)
        rule = _legacy_rule(workflow)
        if result in ("pass", "fail", "blocked"):
            _commit_worktree(tx, ticket, rule)
        # a non-succeeded run's files are stashed, so even a paused or cancelled run on `workspace: main`
        # leaves that checkout clean
        _settle_main(tx, workspace, ticket, rule, run["status"])
        # apply before ending a paused run: ending it cancels the assignment that carries the pause code
        applied_result = boardmodel.apply_run_outcome(tx, workspace, {"key": row["key"], "run": row["run"]},
                                                      workflow=workflow, result=result)
        if run["status"] == "paused":
            _end_paused_run(tx, row["run"], result, ctx)
        if applied_result['applied'] and applied_result['outcome'] == 'pass':
            parent = boardmodel.get_ticket(tx.conn, workspace, row['key'])
            _release_created_tickets(tx, workspace, parent, workflow)
        applied += 1
    return applied


def _waiting_input(tx, run_id: str) -> bool:
    """The run's current stage waits for an answer: the claim, status and rounds stay as they are."""
    return tx.conn.execute(
        "SELECT 1 FROM stage_attempts s JOIN assignments a ON a.id = s.assignment_id "
        "WHERE s.workflow_run_id = ? AND s.status = 'active' AND a.status = 'waiting_input' LIMIT 1",
        (run_id,)).fetchone() is not None


def _end_paused_run(tx, run_id: str, result: str, ctx: dict) -> None:
    """End a paused run that the board can apply: cancel any live assignment, then fail the run so the ticket
    can be claimed again."""
    from . import workflow
    reason = f"ended by the board: {result}"
    sa = workflow._current_attempt(tx, run_id)
    if sa is not None and sa.get("assignment_id"):
        assignment = tx.get("assignment", sa["assignment_id"])
        if assignment["status"] in tasks.ACTIVE:
            tasks.assignment_cancel(tx, {"assignmentId": sa["assignment_id"]}, ctx)
    wf = tx.get("workflow_run", run_id)
    task = tx.get("task", wf["task_id"])
    if task["status"] in ("succeeded", "failed", "cancelled"):
        # A team stop can already have cancelled the task without settling its paused workflow.
        for stage in tx.conn.execute("SELECT id FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active'",
                                     (wf["id"],)).fetchall():
            tx.transition("stage_attempt", stage["id"], "abandoned", payload={"reason": reason})
        tx.transition("workflow_run", wf["id"], "failed",
                      set_values={"transition_reason": reason, "current_agent_id": None},
                      payload={"reason": reason})
    else:
        workflow._end(tx, wf, "failed", reason)


def _commit_worktree(tx, ticket: dict, rule) -> None:
    """Whatever an agent changed in the ticket worktree is committed on the ticket branch before the outcome
    is applied: the next stage needs a clean worktree to start a run, and the merge takes the branch's
    commits (an uncommitted change would be lost when the worktree is removed)."""
    path = ticket.get("worktree_path")
    if not path or not rule or rule.get("workspace") != "worktree" or not os.path.isdir(path):
        return
    try:
        result = worktrees.commit_round(path, f"{ticket['key']}: {rule['when']['status']}")
    except AsError as e:
        _ticket_event_note(tx, ticket, "ticket.commit_failed", {"code": e.code, "message": e.message})
        return
    if result.get("commit"):
        _ticket_event_note(tx, ticket, "ticket.committed", {"commit": result["commit"],
                                                            "rule": rule["when"]["status"]})


def _commit_leftovers(tx, ticket: dict, rule: dict) -> None:
    """A run that ended without its outcome being applied (paused, cancelled, a usage limit, a manual retry)
    leaves its files uncommitted in the ticket worktree, and every start needs a clean tree. The leftovers
    are committed on the ticket branch before the next run, so the work is kept and nothing blocks."""
    path = ticket.get("worktree_path")
    if not path or not os.path.isdir(path) or worktrees.is_clean(path):
        return
    try:
        result = worktrees.commit_round(path, f"{ticket['key']}: uncommitted work from an earlier run")
    except AsError as e:
        _ticket_event_note(tx, ticket, "ticket.commit_failed", {"code": e.code, "message": e.message})
        return
    if result.get("commit"):
        _ticket_event_note(tx, ticket, "ticket.committed", {"commit": result["commit"], "rule": rule["when"]["status"],
                                                            "reason": "leftovers"})


def _settle_main(tx, workspace: str, ticket: dict, rule, run_status: str) -> None:
    """A rule that works in the main checkout (`workspace: main`) must leave it clean, because every run starts
    only on a clean tree. The checkout was clean when the run started (the claim required it), so what is
    dirty now is the agent's output: a passing run's files are committed on the current branch (planning
    documents, for example); any other outcome's files are stashed (recoverable with `git stash list`), so one
    failed run cannot block the whole board."""
    if not rule or rule.get("workspace") != "main" or worktrees.is_clean(workspace):
        return
    try:
        if run_status == "succeeded":
            result = worktrees.commit_round(workspace, f"{ticket['key']}: {rule['when']['status']}")
            _ticket_event_note(tx, ticket, "ticket.committed", {"commit": result.get("commit"),
                                                                "rule": rule["when"]["status"], "branch": "main"})
        else:
            gitws.run(workspace, "stash", "push", "--include-untracked", "-m",
                      f"agent-studio {ticket['key']} {rule['when']['status']} ({run_status})")
            _ticket_event_note(tx, ticket, "ticket.stashed", {"rule": rule["when"]["status"],
                                                              "run": run_status})
    except AsError as e:
        _ticket_event_note(tx, ticket, "ticket.commit_failed", {"code": e.code, "message": e.message})


def _release_with_run(tx, workspace: str, ticket: dict, reason: str, to_status=None):
    """Release a claim and record the run it was for, so a late report of that run is never re-applied."""
    rule_to = to_status if to_status is not None else _return_status(tx, workspace, ticket)
    tx.conn.execute("UPDATE tickets SET run_id = ? WHERE id = ?", (ticket["active_run_id"], ticket["id"]))
    boardmodel.release_claim(tx, ticket, reason, to_status=rule_to)


# ---- crash recovery ---------------------------------------------------------------------------------------

def _recover(tx, workspace: str, ctx: dict) -> dict:
    """Lease expiry and orphan worktrees.

    A lease protects only the gap between claiming a ticket and successfully starting its workflow. Once
    ``active_run_id`` is recorded, assignment/process reconciliation owns crash detection and the workflow
    may legitimately run longer than ``leaseSeconds``. An expired pending claim is released exactly once
    and returned to its rule's status. A run waiting for input keeps its claim; it is never expired.
    Worktrees the board created that no ticket references are removed.
    """
    out = {"released": 0, "worktrees": 0}
    now = utcnow()
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE workspace = ? AND assignee IS NOT NULL AND lease_until IS NOT NULL "
        "AND active_run_id IS NULL AND lease_until < ?", (workspace, now)).fetchall()
    for row in rows:
        ticket = dict(row)
        boardmodel.release_claim(tx, ticket, "lease_expired", to_status=_return_status(tx, workspace, ticket))
        _ticket_event_note(tx, ticket, "ticket.lease_expired", {"run": None})
        out["released"] += 1
    referenced = {r[0] for r in tx.conn.execute(
        "SELECT worktree_path FROM tickets WHERE workspace = ? AND worktree_path IS NOT NULL", (workspace,))}
    for entry in worktrees.list_registered(workspace, state_dir=ctx["stateDir"]):
        if entry["path"] not in referenced:
            worktrees.remove(workspace, entry["path"], state_dir=ctx["stateDir"])
            out["worktrees"] += 1
    return out


def _return_status(tx, workspace: str, ticket: dict) -> str:
    rule = _claiming_workflow(tx, workspace, ticket)
    return rule["startsAt"] if rule else ticket["workflow_status"]


def _ticket_event_note(tx, ticket: dict, name: str, payload: dict) -> None:
    boardmodel._ticket_event(tx.conn, ticket["id"], name, "coordinator", ticket["status"], ticket["status"],
                             dict({"ticketId": ticket["id"], "key": ticket["key"]}, **payload))


def _cancel_run(tx, run_id, ctx) -> None:
    from . import workflow
    workflow.cancel(tx, {"workflowRunId": run_id}, ctx)


def ticket_retry(tx, workspace: str, args: dict, ctx: dict) -> dict:
    """`ticket retry`: clear a stuck claim — release it back to its rule's status and cancel its run."""
    ticket = boardmodel.get_ticket(tx.conn, workspace, args["key"])
    if ticket["assignee"] is None:
        raise AsError("TICKET_TRANSITION_INVALID", f"Ticket {ticket['key']} is not claimed.",
                      data={"key": ticket["key"], "status": ticket["status"]})
    if ticket["active_run_id"]:
        try:
            _cancel_run(tx, ticket["active_run_id"], ctx)
        except AsError:
            pass
    _release_with_run(tx, workspace, ticket, "operator_retry")
    _ticket_event_note(tx, ticket, "ticket.released", {"reason": "operator_retry"})
    return {"ticket": boardmodel._ticket_json(tx.conn, tx.conn.execute(
        "SELECT * FROM tickets WHERE id = ?", (ticket["id"],)).fetchone())}


def _claiming_workflow(tx, workspace: str, ticket: dict) -> dict:
    index = boardworkflows.load(workspace, boardmodel.load_config(workspace))
    status = ticket["workflow_status"]
    found = index["byRunning"].get(status) or index["byStart"].get(status)
    if found is None:
        config = boardmodel.load_config(workspace)
        legacy = config["duringToRule"].get(status) or config["rulesByStatus"].get(status)
        if legacy:
            # Keep the rule's routing and limits: the applier works from a workflow, so a fallback that
            # dropped maxRounds/onFailPriority would silently stop enforcing them on a legacy board.
            workflow = boardmodel._workflow_from_rule(legacy)
            workflow["workspace"] = legacy.get("workspace")
            return workflow
    return found


def _legacy_rule(workflow):
    """Adapt a workflow for the existing outcome applier and commit helpers."""
    if not workflow:
        return None
    end = workflow['end']
    def target(value):
        return value['status'] if isinstance(value, dict) else value
    rule = {'when': {'status': workflow['startsAt']}, 'workspace': workflow.get('workspace'),
            'onPass': target(end['pass']), 'onFail': target(end['fail'])}
    if 'blocked' in end:
        rule['onBlocked'] = target(end['blocked'])
        if isinstance(end['blocked'], dict) and 'returnTo' in end['blocked']:
            rule['blockedReturnTo'] = end['blocked']['returnTo']
    for source, dest in [('maxRuns', 'maxRounds'), ('failuresInARow', 'onFailureLimit'),
                         ('onFailPriority', 'onFailPriority')]:
        if source in workflow.get('limits', {}):
            rule[dest] = workflow['limits'][source]
    return rule


def _deps_open(tx, ticket_id: str, config) -> int:
    """Dependencies whose board column is not finished."""
    return tx.conn.execute(
        "SELECT COUNT(*) FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
        "WHERE d.ticket_id = ? AND t.status NOT IN ('done', 'closed')", (ticket_id,)).fetchone()[0]


def _free_members(tx, team_id: str, role: str) -> list:
    rows = tx.conn.execute(
        f"SELECT * FROM agents WHERE team_id = ? AND role = ? AND availability = 'idle' "
        f"AND pane_state = 'alive' AND pending_agent IS NULL AND id NOT IN (SELECT agent_id FROM assignments WHERE status IN "
        f"({','.join('?' * len(ACTIVE_ASSIGNMENT))})) "
        f"AND id NOT IN (SELECT assignee FROM tickets WHERE assignee IS NOT NULL)",
        (team_id, role) + ACTIVE_ASSIGNMENT).fetchall()
    return [dict(r) for r in rows]


def _claim(tx, workspace: str, team: dict, config: dict, ctx: dict):
    claimed, errors = 0, []
    current = boardmodel.effective_current_phase(tx.conn, workspace)
    index = boardworkflows.load(workspace, config)
    problems = index['problems']
    for problem in problems:
        errors.append({'workspace': workspace, 'code': 'BOARD_WORKFLOW_INVALID',
                       'message': problem['message'], 'workflow': problem['workflow'], 'path': problem['path']})
    invalid = {p['workflow'] for p in problems}
    for wf in sorted(index['workflows'], key=lambda w: (w.get('priority', 100), w['name'])):
        if not wf.get('role') or wf['name'] in invalid or '' in invalid:
            continue
        try:
            while True:
                if wf.get('workspace') == 'main' and (tasks._mutating_in_workspace(tx, workspace)
                                                       or not worktrees.is_clean(workspace)):
                    break
                members = _free_members(tx, team['id'], wf['role'])
                ticket = _pick_ticket(tx, workspace, wf, config, current) if members else None
                if ticket is None:
                    break
                if _start_ticket(tx, workspace, team, members[0], wf, ticket, config, ctx) is None:
                    break
                claimed += 1
        except AsError as e:
            errors.append({'workspace': workspace, 'code': e.code, 'message': e.message})
    return claimed, errors


def _pick_ticket(tx, workspace: str, workflow: dict, config: dict, current: dict):
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE workspace = ? AND workflow_status = ? "
        "AND status IN ('todo', 'in-progress') AND assignee IS NULL "
        "ORDER BY priority, created_at, key", (workspace, workflow['startsAt'])).fetchall()
    for row in rows:
        ticket = dict(row)
        if not boardmodel.ticket_in_scope(ticket, current):
            continue
        if workflow.get('waitForDependencies') and _deps_open(tx, ticket['id'], config):
            continue
        return ticket
    return None


def _start_ticket(tx, workspace: str, team: dict, member: dict, rule: dict, ticket: dict, config: dict,
                  ctx: dict):
    lease = lease_time(config)
    status = rule["whileRunning"] or rule["startsAt"]
    # claim first: the engine's run-workspace check accepts a ticket worktree only while it is claimed
    tx.conn.execute("UPDATE tickets SET assignee = ?, lease_until = ?, updated_at = ? WHERE id = ?",
                    (member["id"], lease, utcnow(), ticket["id"]))
    boardmodel.set_workflow(tx, ticket, status, "coordinator", "claim", config, claimed=True,
                            column_override="in-progress")
    ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
    try:
        run_workspace = workspace
        if rule.get("workspace") == "worktree":
            if not ticket.get("worktree_path"):
                created = worktrees.create(workspace, ticket["key"], worktrees.slug(ticket["title"]),
                                           config["baseBranch"], state_dir=ctx["stateDir"])
                tx.conn.execute("UPDATE tickets SET branch = ?, worktree_path = ?, updated_at = ? WHERE id = ?",
                                (created["branch"], created["path"], utcnow(), ticket["id"]))
                ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
            run_workspace = ticket["worktree_path"]
            _commit_leftovers(tx, ticket, _legacy_rule(rule))
            if rule.get("syncBase"):
                _sync_base(tx, ticket, config)
        start_args = {"teamId": team["id"], "definition": rule.get("workflow", rule["name"]),
                      "text": _task_text(ticket), "bindings": {rule["role"]: member["id"]}}
        if run_workspace != workspace:
            start_args["workspace"] = run_workspace
        started = _start(tx, start_args, ctx)
        # The lease covers claim -> start only. Clearing it here prevents a legitimate long-running agent or
        # validation stage from being mistaken for an abandoned pre-start claim.
        tx.conn.execute("UPDATE tickets SET active_run_id = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
                        (started["workflowRunId"], utcnow(), ticket["id"]))
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.claimed", "coordinator", rule["startsAt"],
                                 status, {"ticketId": ticket["id"], "key": ticket["key"],
                                          "agentId": member["id"], "run": started["workflowRunId"],
                                          "rule": rule["startsAt"], "workspace": rule.get("workspace")})
        return started["workflowRunId"]
    except AsError as e:
        boardmodel.release_claim(tx, boardmodel.get_ticket(tx.conn, workspace, ticket["key"]),
                                 f"start_failed:{e.code}", to_status=rule["startsAt"],
                                 detail={"workspace": run_workspace, **_start_detail(e)})
        return None


def _sync_base(tx, ticket: dict, config: dict) -> None:
    """Bring the base branch into the ticket worktree before the next round; conflicts are committed with
    their markers, listed in the ticket body and left for that round."""
    base = config["baseBranch"]
    try:
        synced = worktrees.sync_base(ticket["worktree_path"], base)
    except AsError as e:
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.sync_failed", "coordinator", ticket["status"],
                                 ticket["status"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                    "reason": e.code})
        return
    if synced["conflicts"]:
        boardmodel.append_body(tx, ticket["id"], f"## Merge conflicts with {base}\n"
                               f"The branch was merged with {base} and these files still contain conflict markers "
                               f"(<<<<<<<, =======, >>>>>>>). Resolve them, keeping both sides' intent, before "
                               f"anything else:\n" + "\n".join(f"- {f}" for f in synced["conflicts"]))
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.sync_conflicts", "coordinator", ticket["status"],
                                 ticket["status"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                    "files": synced["conflicts"]})


def _start_detail(e) -> dict:
    """Where a failed start looked and what it found (the dirty paths), so the ticket events say what to fix."""
    data = getattr(e, "data", None) or {}
    return {"entries": data["entries"][:10]} if data.get("entries") else {}


def _task_text(ticket: dict) -> str:
    text = f"Ticket {ticket['key']}: {ticket['title']}"
    if ticket.get("body"):
        text += f"\n\n{ticket['body']}"
    return text[:32 * 1024]


def _start(tx, args: dict, ctx: dict) -> dict:
    from . import workflow
    return workflow.start(tx, args, ctx)


# ---- coordinator-only actions ------------------------------------------------------------------------------

def _run_action_workflows(tx, workspace: str, team_id: str, config: dict, ctx: dict):
    """Run at most one action-only workflow ticket in this workspace, so merges never overlap.

    Workflows with no role run in the coordinator itself: the same pick rules as a member workflow, then
    their steps in order (merge through ``merge_ticket``, checks through the command runner). The result is
    applied by the normal run-outcome applier, which releases the claim and moves the ticket to the
    workflow's end status."""
    index = boardworkflows.load(workspace, config)
    current = boardmodel.effective_current_phase(tx.conn, workspace)
    invalid = {p["workflow"] for p in index["problems"]}
    errors = []
    for wf in sorted(index["workflows"], key=lambda w: (w.get("priority", 100), w["name"])):
        if wf.get("role") or wf["name"] in invalid or "" in invalid:
            continue
        try:
            steps = _workflow_steps(workspace, wf)
        except AsError as e:
            errors.append({"workspace": workspace, "code": e.code, "message": e.message})
            continue
        if not _action_only(steps):
            continue
        ticket = _pick_ticket(tx, workspace, wf, config, current)
        if ticket is None:
            continue
        try:
            processed = _run_action_workflow(tx, workspace, team_id, wf, steps, ticket, config, ctx)
        except AsError as e:
            errors.append({"workspace": workspace, "code": e.code, "message": e.message})
            continue
        return (1 if processed else 0), errors
    return 0, errors


def _workflow_steps(workspace: str, wf: dict) -> list:
    """The executable stages of one board workflow. Converted rules already carry frozen stages; a
    workflow file is read again because its summary keeps only ids and kinds."""
    steps = wf.get("steps") or []
    if wf.get("workflow") or any("action" in s or "checks" in s for s in steps):
        return steps
    definition = workflowdef.load(workspace, wf["name"])
    out = []
    for stage in definition.stages:
        step = {"id": stage.id, "kind": stage.kind}
        if stage.kind == "action":
            step["action"] = stage.step_value
        if stage.checks is not None:
            step["checks"] = stage.checks
        out.append(step)
    return out


def _action_only(steps: list) -> bool:
    """True when every step is one the coordinator can run without a member: merge or a check set."""
    return bool(steps) and all(s.get("action") == "merge" or s.get("checks") for s in steps)


def _run_action_workflow(tx, workspace: str, team_id: str, wf: dict, steps: list, ticket: dict,
                         config: dict, ctx: dict) -> bool:
    has_merge = any(s.get("action") == "merge" for s in steps)
    if has_merge:
        reason = _merge_hold(tx, workspace, config, ctx)
        if reason:  # the main checkout holds the ticket until it is free, like any merge action
            _note_merge_held(tx, ticket, reason)
            return False
    task_id, run_id = _start_action_run(tx, team_id, workspace, wf, ticket, steps)
    _claim_action(tx, workspace, wf, ticket, config, run_id)
    ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
    outcome, reason, failed_step, merged = "pass", None, None, False
    for index, step in enumerate(steps, 1):
        if step.get("action") == "merge":
            passed, reason = merge_ticket(tx, workspace, ticket, config, dict(ctx, mergeRunId=run_id))
            if not passed:
                outcome, failed_step = "fail", "merge"
                break
            merged = True
            ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
            continue
        passed, reason = _run_check_step(tx, workspace, team_id, run_id, step, index, ctx)
        if not passed:
            outcome, failed_step = "fail", "check"
            break
    _finish_action_run(tx, task_id, run_id, outcome, reason)
    rule = _legacy_rule(wf)
    if outcome == "pass" and merged:
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merged", "coordinator", ticket["status"],
                                 rule["onPass"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                  "branch": ticket["branch"], "to": rule["onPass"]})
    applied = boardmodel.apply_run_outcome(tx, workspace, {"key": ticket["key"], "run": run_id}, workflow=wf)
    if failed_step == "merge":
        _record_merge_failure(tx, workspace, ticket, rule, reason)
    if applied.get("applied") and applied.get("outcome") == "pass":
        parent = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
        _release_created_tickets(tx, workspace, parent, wf)
    return True


def _start_action_run(tx, team_id: str, workspace: str, wf: dict, ticket: dict, steps: list):
    """A durable run row for the coordinator's steps, so the normal outcome applier and audit trail apply."""
    task = tx.create("task", {"team_id": team_id, "origin": "workflow", "workspace": workspace,
                              "goal": _task_text(ticket)})
    tx.transition("task", task, "assigned")
    tx.transition("task", task, "running")
    run = tx.create("workflow_run", {"team_id": team_id, "task_id": task, "workflow": "definition",
                                     "transition_reason": "coordinator action",
                                     "definition_name": wf["name"], "step_count": len(steps),
                                     "config_json": {"workflow": wf["name"]}})
    tx.transition("workflow_run", run, "running")
    return task, run


def _claim_action(tx, workspace: str, wf: dict, ticket: dict, config: dict, run_id: str) -> None:
    lease = lease_time(config)
    tx.conn.execute("UPDATE tickets SET assignee = 'coordinator', lease_until = ?, active_run_id = ?, "
                    "updated_at = ? WHERE id = ?", (lease, run_id, utcnow(), ticket["id"]))
    ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
    running = wf.get("whileRunning")
    if running and running != ticket["workflow_status"]:
        boardmodel.set_workflow(tx, ticket, running, "coordinator", "claim", config, claimed=True,
                                column_override="in-progress")


def _finish_action_run(tx, task_id: str, run_id: str, outcome: str, reason) -> None:
    status = "succeeded" if outcome == "pass" else "failed"
    tx.transition("workflow_run", run_id, status, set_values={"transition_reason": reason})
    tx.transition("task", task_id, status)


def _run_check_step(tx, workspace: str, team_id: str, run_id: str, step: dict, index: int, ctx: dict):
    """Run one check set through the same vetted command runner the engine uses, in order, to completion."""
    catalog = delegation.load_config(workspace)
    check_set = (catalog or {}).get("checkSets", {}).get(step.get("checks"))
    if check_set is None:
        return False, f"CHECK_SET_MISSING: {step.get('checks')}"
    selected = delegation.select_checks(check_set, delegation.changed_paths(workspace))
    first = len(delegation.requests_for(tx, workflow_run_id=run_id))
    for position, cid in enumerate(selected, 1):
        ordinal = first + position
        command = catalog["commands"][cid]
        rid = tx.create("command_request", {
            "team_id": team_id, "workflow_run_id": run_id, "stage_attempt_id": None, "assignment_id": None,
            "stage": step["id"], "visit": 1, "ordinal": ordinal, "command_id": cid, "params_json": {},
            "argv_json": delegation.render_argv(command, {}), "reason": "workflow check", "source": "marker"},
            state="approved")
        run_dir = os.path.join(ctx["stateDir"], "workflows", run_id, f"{index:02d}-{step['id']}",
                               f"check-{ordinal:02d}")
        proc = delegation.spawn(run_dir, workspace, tx.get("command_request", rid), command)
        tx.transition("command_request", rid, "running", set_values={"process_json": proc})
        result = _wait_check(run_dir, proc, command)
        tx.transition("command_request", rid, "succeeded" if result.get("passed") else "failed",
                      set_values={"result_json": result})
        if not result.get("passed"):
            return False, f"CHECK_FAILED: {cid}"
    return True, None


def _wait_check(run_dir: str, proc: dict, command: dict) -> dict:
    deadline = time.monotonic() + command.get("timeoutMs", 600000) / 1000.0 + 60
    while time.monotonic() < deadline:
        result = delegation.result(run_dir)
        if result is not None:
            return result
        if not delegation.alive(proc):
            break
        time.sleep(0.05)
    delegation.stop(proc)
    return delegation.result(run_dir) or {"passed": False, "error": "command process lost"}


def _note_merge_held(tx, ticket: dict, reason: str) -> None:
    last = tx.conn.execute("SELECT name, payload_json FROM ticket_events WHERE ticket_id = ? "
                           "ORDER BY id DESC LIMIT 1", (ticket["id"],)).fetchone()
    if last is None or last["name"] != "ticket.merge_held" or \
            json.loads(last["payload_json"]).get("reason") != reason:  # one event per hold, not one per tick
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merge_held", "coordinator", ticket["status"],
                                 ticket["status"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                    "reason": reason})


def _record_merge_failure(tx, workspace: str, ticket: dict, rule: dict, reason: str) -> None:
    boardmodel.append_body(tx, ticket["id"], f"## {reason}")
    ticket = boardmodel.get_ticket(tx.conn, workspace, ticket["key"])
    boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merge_conflict", "coordinator", ticket["status"],
                             rule["onFail"], {"ticketId": ticket["id"], "key": ticket["key"],
                                              "reason": reason, "to": rule["onFail"]})


def _merge_hold(tx, workspace, config, ctx):
    hold = tasks._mutating_in_workspace(tx, workspace, exclude_workflow=ctx.get("mergeRunId"))
    if not hold:
        if not worktrees.is_clean(workspace):
            hold = "MAIN_CHECKOUT_DIRTY"
        else:
            head = gitws.run(workspace, "symbolic-ref", "--short", "HEAD", check=False)
            if head.returncode != 0 or head.stdout.decode().strip() != config["baseBranch"]:
                hold = "MAIN_CHECKOUT_WRONG_BRANCH"
    return hold if isinstance(hold, str) else ("MAIN_CHECKOUT_BUSY" if hold else None)


def merge_ticket(tx, workspace, ticket, config, ctx):
    """Merge a ticket branch into the base checkout, retaining its worktree on failure."""
    reason = _merge_hold(tx, workspace, config, ctx)
    if reason:
        return False, reason
    if not ticket.get("branch"):
        return False, "MERGE_NO_BRANCH"
    result = gitws.run(workspace, "merge", "--squash", ticket["branch"], check=False)
    if result.returncode != 0:
        raw = gitws.run(workspace, "diff", "--name-only", "--diff-filter=U", check=False).stdout
        files = [line for line in raw.decode("utf-8", "replace").splitlines() if line]
        gitws.run(workspace, "reset", "--merge", check=False)
        return False, f"MERGE_CONFLICT: {', '.join(files) if files else 'merge failed'}"
    if gitws.run(workspace, "diff", "--cached", "--quiet", check=False).returncode == 0:
        gitws.run(workspace, "reset", "--merge", check=False)
    else:
        gitws.run(workspace, "commit", "-F", "-", input_bytes=f"{ticket['key']}: {ticket['title']}\n".encode())
    commit = gitws.run(workspace, "rev-parse", "HEAD").stdout.decode().strip()
    tx.conn.execute("UPDATE tickets SET merged_commit = ?, updated_at = ? WHERE id = ?", (commit, utcnow(), ticket["id"]))
    if ticket.get("worktree_path"):
        worktrees.remove(workspace, ticket["worktree_path"], state_dir=ctx["stateDir"])
        tx.conn.execute("UPDATE tickets SET worktree_path = NULL, updated_at = ? WHERE id = ?", (utcnow(), ticket["id"]))
    return True, None


def _release_created_tickets(tx, workspace: str, parent: dict, workflow) -> list:
    """Release the children this ticket created when its workflow passes.

    The parent link is stored on the child (``parent_ticket_id``), so a later workflow can release children an
    earlier one created (for example an unpack workflow creates, the plan-merge workflow releases). Only
    children currently held in the pass release's ``from`` status move; each move is one
    ``ticket.workflow_changed`` event with the parent in its reason.
    """
    end = (workflow or {}).get('end') or {}
    pass_end = end.get('pass')
    policy = pass_end.get('releaseCreatedTickets') if isinstance(pass_end, dict) else None
    if not isinstance(policy, dict) or not policy.get('from') or not policy.get('to'):
        return []
    config = boardmodel.load_config(workspace)
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE parent_ticket_id = ? AND workflow_status = ? ORDER BY created_at, key",
        (parent['id'], policy['from'])).fetchall()
    keys = []
    for row in rows:
        child = dict(row)
        boardmodel.set_workflow(tx, child, policy['to'], 'coordinator', f"released by {parent['key']}", config)
        keys.append(child['key'])
    return keys


# ---- lease helper ------------------------------------------------------------------------------------------

def lease_time(config: dict) -> str:
    """The claim lease deadline (ISO, UTC) from the board's leaseSeconds."""
    from datetime import datetime, timedelta, timezone
    seconds = config.get("leaseSeconds", boardmodel.DEFAULT_LEASE_SECONDS)
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds") \
        .replace("+00:00", "Z")
