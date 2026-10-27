"""The board scheduler (P04-S10): binds a running team to a workspace board and works it.

One coordinator tick, per workspace with a running board binding: apply finished runs through the S09
applier (also while the board is stopped — running work finishes), perform coordinator-only `merge`
actions, and (only while running) claim tickets by rule: rules in `priority` order, tickets of the
effective current phase whose dependencies are finished, under the rule's `cap`, worked by a free member
of the rule's role. A claim takes a lease, sets the rule's `during` status, creates the ticket's worktree
when the rule's workspace mode says so, and starts the rule's workflow. Roles, workflows and statuses
come from the board's configuration; nothing here names one. This module is coordinator glue (like the
P03 scheduler it replaces): it may drive the engine and the retained worktree helpers.
"""
from __future__ import annotations

import json
import os

from . import boardmodel, gitws, tasks, worktrees
from .protocol import AsError, BOARD_ALREADY_RUNNING, TEAM_NOT_RUNNING
from .state import utcnow

ACTIVE_ASSIGNMENT = ("queued", "claimed", "running", "waiting_input", "reconciling")
# Runs the tick applies by itself. A paused run waits for the operator; assignment/process reconciliation
# handles a runner that disappears after a workflow has started.
APPLY_RUN_STATES = ("succeeded", "failed", "cancelled")


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
                _recover(tx, workspace, ctx)
                out["applied"] += _apply_finished(tx, workspace)
                out["merged"] += _run_merge_actions(tx, workspace, ctx)
            if row["run_status"] == "running":
                with store.transaction(actor="coordinator") as tx:
                    team = _team(tx.conn, row["team_id"])
                    if team is not None and team["status"] == "running":
                        config = boardmodel.load_config(workspace)
                        claimed, errors = _claim(tx, workspace, team, config, ctx)
                        out["claimed"] += claimed
                        out["errors"].extend(errors)
            out["boards"] += 1
        except AsError as e:
            out["errors"].append({"workspace": workspace, "code": e.code, "message": e.message})
        except Exception as e:  # a broken workspace must not stop the others
            out["errors"].append({"workspace": workspace, "code": "INTERNAL", "message": str(e)})
    return out


def _apply_finished(tx, workspace: str) -> int:
    rows = tx.conn.execute(
        "SELECT t.key AS key, t.active_run_id AS run FROM tickets t WHERE t.workspace = ? "
        "AND t.active_run_id IS NOT NULL", (workspace,)).fetchall()
    applied = 0
    for row in rows:
        run = tx.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (row["run"],)).fetchone()
        if run is None:
            continue
        if tx.conn.execute("SELECT 1 FROM agents a JOIN stage_attempts s ON s.assignment_id = a.pending_assignment "
                           "WHERE a.pending_agent IS NOT NULL AND s.workflow_run_id = ?", (row["run"],)).fetchone():
            continue
        ticket = boardmodel.get_ticket(tx.conn, workspace, row["key"])
        if run["status"] == "paused" and _paused_on_usage_limit(tx, row["run"]):
            # Failed provider assignments pause definition workflows. Quota failures are recoverable:
            # end this attempt and release its ticket so a switched or resumed member can claim it.
            from . import workflow
            wf = tx.get("workflow_run", row["run"])
            task = tx.get("task", wf["task_id"])
            if task["status"] in ("succeeded", "failed", "cancelled"):
                # A team stop can already have cancelled the task without settling its paused workflow.
                for stage in tx.conn.execute("SELECT id FROM stage_attempts WHERE workflow_run_id = ? AND status = 'active'",
                                             (wf["id"],)).fetchall():
                    tx.transition("stage_attempt", stage["id"], "abandoned", payload={"reason": "provider usage limit"})
                tx.transition("workflow_run", wf["id"], "failed",
                              set_values={"transition_reason": "provider usage limit", "current_agent_id": None},
                              payload={"reason": "provider usage limit"})
            else:
                workflow._end(tx, wf, "failed", "provider usage limit")
            _release_with_run(tx, workspace, ticket, "usage_limit")
            applied += 1
            continue
        if run["status"] not in APPLY_RUN_STATES:
            continue
        if run["status"] == "failed" and _usage_limited(tx, row["run"]):
            # a USAGE_LIMIT result releases the ticket without counting a round; report_rules has already
            # marked the member limit_reached, and `board resume` makes them eligible again
            _release_with_run(tx, workspace, ticket, "usage_limit")
            applied += 1
            continue
        rule = _claiming_rule(tx, workspace, ticket)
        _commit_worktree(tx, ticket, rule)
        _settle_main(tx, workspace, ticket, rule, run["status"])
        boardmodel.apply_run_outcome(tx, workspace, {"key": row["key"], "run": row["run"]}, rule=rule)
        applied += 1
    return applied


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


def _usage_limited(tx, run_id: str) -> bool:
    row = tx.conn.execute(
        "SELECT 1 FROM assignments a JOIN workflow_runs w ON w.task_id = a.task_id "
        "WHERE w.id = ? AND a.diagnostic_code = 'USAGE_LIMIT' LIMIT 1", (run_id,)).fetchone()
    return row is not None


def _paused_on_usage_limit(tx, run_id: str) -> bool:
    return tx.conn.execute(
        "SELECT 1 FROM stage_attempts s JOIN assignments a ON a.id = s.assignment_id "
        "WHERE s.workflow_run_id = ? AND s.status = 'active' AND a.status = 'failed' "
        "AND a.diagnostic_code = 'USAGE_LIMIT' LIMIT 1", (run_id,)).fetchone() is not None


def _release_with_run(tx, workspace: str, ticket: dict, reason: str, to_status=None):
    """Release a claim and record the run it was for, so a late report of that run is never re-applied."""
    rule_to = to_status
    if rule_to is None:
        rule = _claiming_rule(tx, workspace, ticket)
        rule_to = rule["when"]["status"] if rule else ticket["status"]
    tx.conn.execute("UPDATE tickets SET run_id = ? WHERE id = ?", (ticket["active_run_id"], ticket["id"]))
    boardmodel.release_claim(tx, ticket, reason, to_status=rule_to)


# ---- crash recovery ---------------------------------------------------------------------------------------

def _recover(tx, workspace: str, ctx: dict) -> dict:
    """Lease expiry and orphan worktrees.

    A lease protects only the gap between claiming a ticket and successfully starting its workflow. Once
    ``active_run_id`` is recorded, assignment/process reconciliation owns crash detection and the workflow
    may legitimately run longer than ``leaseSeconds``. An expired pending claim is released exactly once
    and returned to its rule's status. Worktrees the board created that no ticket references are removed.
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
    rule = _claiming_rule(tx, workspace, ticket)
    return rule["when"]["status"] if rule else ticket["status"]


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


def _claiming_rule(tx, workspace: str, ticket: dict) -> dict:
    """The rule that claimed the ticket: the one whose `during` status it sits in, else the one for its
    status (a ticket worked without a `during` status stays in the rule's `when` status)."""
    config = boardmodel.load_config(workspace)
    for rule in config["rules"]:
        if rule.get("during") == ticket["status"]:
            return rule
    return config["rulesByStatus"].get(ticket["status"])


def _rule_order(config):
    return sorted(config["rules"], key=lambda r: (r.get("priority", 0), config["rules"].index(r)))


def _deps_open(tx, ticket_id: str, config) -> int:
    """Dependencies not in a finished status (kind done or closed)."""
    finished = {s["id"] for s in config["statuses"] if s["kind"] in boardmodel.TERMINAL_KINDS}
    marks = ",".join("?" * len(finished)) or "NULL"
    return tx.conn.execute(
        f"SELECT COUNT(*) FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
        f"WHERE d.ticket_id = ? AND t.status NOT IN ({marks})",
        (ticket_id,) + tuple(finished)).fetchone()[0]


def _free_members(tx, team_id: str, role: str) -> list:
    rows = tx.conn.execute(
        f"SELECT * FROM agents WHERE team_id = ? AND role = ? AND availability = 'idle' "
        f"AND pane_state = 'alive' AND pending_agent IS NULL AND id NOT IN (SELECT agent_id FROM assignments WHERE status IN "
        f"({','.join('?' * len(ACTIVE_ASSIGNMENT))})) "
        f"AND id NOT IN (SELECT assignee FROM tickets WHERE assignee IS NOT NULL)",
        (team_id, role) + ACTIVE_ASSIGNMENT).fetchall()
    return [dict(r) for r in rows]


def _active_under_rule(tx, workspace: str, rule: dict) -> int:
    statuses = [rule["during"]] if rule.get("during") else [rule["when"]["status"]]
    marks = ",".join("?" * len(statuses))
    return tx.conn.execute(
        f"SELECT COUNT(*) FROM tickets WHERE workspace = ? AND status IN ({marks}) AND assignee IS NOT NULL",
        (workspace,) + tuple(statuses)).fetchone()[0]


def _claim(tx, workspace: str, team: dict, config: dict, ctx: dict):
    claimed, errors = 0, []
    current = boardmodel.effective_current_phase(tx.conn, workspace)
    for rule in _rule_order(config):
        if "action" in rule:  # coordinator-only actions run in their own pass
            continue
        try:
            cap = rule.get("cap")
            if cap is not None and _active_under_rule(tx, workspace, rule) >= cap:
                continue
            if rule.get("workspace") == "main" and (tasks._mutating_in_workspace(tx, workspace)
                                                    or not worktrees.is_clean(workspace)):
                continue  # the main checkout is held; this rule waits
            members = _free_members(tx, team["id"], rule["role"])
            if not members:
                continue
            ticket = _pick_ticket(tx, workspace, rule, config, current, members)
            if ticket is None:
                continue
            member = next((m for m in members if m["id"] == ticket.get("preferred_agent_id")), members[0])
            if _start_ticket(tx, workspace, team, member, rule, ticket, config, ctx) is not None:
                claimed += 1
        except AsError as e:  # one rule's problem never blocks the others
            errors.append({"workspace": workspace, "code": e.code, "message": e.message})
    return claimed, errors


def _pick_ticket(tx, workspace: str, rule: dict, config: dict, current: dict, members=None):
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE workspace = ? AND status = ? AND assignee IS NULL "
        "ORDER BY priority, created_at, key", (workspace, rule["when"]["status"])).fetchall()
    for row in rows:
        ticket = dict(row)
        preferred = ticket.get("preferred_agent_id")
        if preferred and members is not None and not any(m["id"] == preferred for m in members):
            # A stopped/replaced runtime cannot satisfy an old reservation.
            prior = tx.conn.execute("SELECT t.status FROM agents a JOIN teams t ON t.id = a.team_id WHERE a.id = ?",
                                    (preferred,)).fetchone()
            if prior and prior["status"] == "running":
                continue
            tx.conn.execute("UPDATE tickets SET preferred_agent_id = NULL WHERE id = ?", (ticket["id"],))
            ticket["preferred_agent_id"] = None
        if not boardmodel.ticket_in_scope(ticket, current):
            continue
        if rule.get("requiresDeps") and _deps_open(tx, ticket["id"], config):
            continue
        return ticket
    return None


def _start_ticket(tx, workspace: str, team: dict, member: dict, rule: dict, ticket: dict, config: dict,
                  ctx: dict):
    lease = lease_time(config)
    status = rule.get("during") or rule["when"]["status"]
    # claim first: the engine's run-workspace check accepts a ticket worktree only while it is claimed
    tx.conn.execute("UPDATE tickets SET assignee = ?, lease_until = ?, status = ?, updated_at = ? "
                    "WHERE id = ?", (member["id"], lease, status, utcnow(), ticket["id"]))
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
            _commit_leftovers(tx, ticket, rule)
            if rule.get("syncBase"):
                _sync_base(tx, ticket, config)
        start_args = {"teamId": team["id"], "definition": rule["workflow"],
                      "text": _task_text(ticket), "bindings": {rule["role"]: member["id"]}}
        if run_workspace != workspace:
            start_args["workspace"] = run_workspace
        started = _start(tx, start_args, ctx)
        # The lease covers claim -> start only. Clearing it here prevents a legitimate long-running agent or
        # validation stage from being mistaken for an abandoned pre-start claim.
        tx.conn.execute("UPDATE tickets SET active_run_id = ?, lease_until = NULL, updated_at = ? WHERE id = ?",
                        (started["workflowRunId"], utcnow(), ticket["id"]))
        tx.conn.execute("UPDATE tickets SET preferred_agent_id = NULL WHERE id = ?", (ticket["id"],))
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.claimed", "coordinator", rule["when"]["status"],
                                 status, {"ticketId": ticket["id"], "key": ticket["key"],
                                          "agentId": member["id"], "run": started["workflowRunId"],
                                          "rule": rule["when"]["status"], "workspace": rule.get("workspace")})
        return started["workflowRunId"]
    except AsError as e:
        boardmodel.release_claim(tx, boardmodel.get_ticket(tx.conn, workspace, ticket["key"]),
                                 f"start_failed:{e.code}", to_status=rule["when"]["status"],
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

def _run_merge_actions(tx, workspace: str, ctx: dict) -> int:
    config = boardmodel.load_config(workspace)
    merged = 0
    for rule in _rule_order(config):
        if rule.get("action") != "merge":
            continue
        rows = tx.conn.execute(
            "SELECT * FROM tickets WHERE workspace = ? AND status = ? AND branch IS NOT NULL "
            "AND assignee IS NULL ORDER BY priority, created_at, key",
            (workspace, rule["when"]["status"])).fetchall()
        for row in rows:
            if _merge_one(tx, workspace, dict(row), rule, config, ctx):
                merged += 1
    return merged


def _merge_one(tx, workspace: str, ticket: dict, rule: dict, config: dict, ctx) -> bool:
    """Squash-merge the ticket branch into the base branch. The tick is single-threaded and synchronous,
    so one merge at a time holds the main checkout; a dirty, busy or wrong-headed checkout holds the
    ticket instead of failing the tick."""
    base = config["baseBranch"]
    hold = tasks._mutating_in_workspace(tx, workspace)
    if not hold:
        if not worktrees.is_clean(workspace):
            hold = "MAIN_CHECKOUT_DIRTY"
        else:
            head = gitws.run(workspace, "symbolic-ref", "--short", "HEAD", check=False)
            if head.returncode != 0 or head.stdout.decode().strip() != base:
                hold = "MAIN_CHECKOUT_WRONG_BRANCH"
    if hold:
        reason = hold if isinstance(hold, str) else "MAIN_CHECKOUT_BUSY"
        last = tx.conn.execute("SELECT name, payload_json FROM ticket_events WHERE ticket_id = ? "
                               "ORDER BY id DESC LIMIT 1", (ticket["id"],)).fetchone()
        if last is None or last["name"] != "ticket.merge_held" or \
                json.loads(last["payload_json"]).get("reason") != reason:  # one event per hold, not one per tick
            boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merge_held", "coordinator", ticket["status"],
                                     ticket["status"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                        "reason": reason})
        return False
    result = gitws.run(workspace, "merge", "--squash", ticket["branch"], check=False)
    if result.returncode != 0:
        raw = gitws.run(workspace, "diff", "--name-only", "--diff-filter=U", check=False).stdout
        files = [line for line in raw.decode("utf-8", "replace").splitlines() if line]
        gitws.run(workspace, "reset", "--merge", check=False)
        _move_by_rule(tx, workspace, ticket, rule, "onFail",
                      f"MERGE_CONFLICT: {', '.join(files) if files else 'merge failed'}")
        return True
    if gitws.run(workspace, "diff", "--cached", "--quiet", check=False).returncode == 0:
        gitws.run(workspace, "reset", "--merge", check=False)  # nothing to merge: the branch is already in base
    else:
        gitws.run(workspace, "commit", "-m", f"{ticket['key']}: {ticket['title']}")
    boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merged", "coordinator", ticket["status"],
                             rule["onPass"], {"ticketId": ticket["id"], "key": ticket["key"],
                                              "branch": ticket["branch"], "to": rule["onPass"]})
    _set_status(tx, ticket, rule["onPass"])
    _promote_created_tickets(tx, ticket, rule)
    if ticket.get("worktree_path"):
        worktrees.remove(workspace, ticket["worktree_path"], state_dir=ctx["stateDir"])
        tx.conn.execute("UPDATE tickets SET worktree_path = NULL, updated_at = ? WHERE id = ?",
                        (utcnow(), ticket["id"]))
    return True


def _promote_created_tickets(tx, parent: dict, rule: dict) -> None:
    """Apply an action rule's configured transition to tickets created by the parent's workflow.

    The relationship already exists through ``created_by_assignment`` and stage attempts, so this remains
    generic: no role, workflow, or status name is embedded in the scheduler. The transition happens only after
    the action succeeds (for today's ``merge`` action, after the branch has landed on the base checkout).
    """
    policy = rule.get("onPassCreatedTickets")
    run_id = parent.get("run_id")
    if not policy or not run_id:
        return
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE created_by_assignment IN "
        "(SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ? AND assignment_id IS NOT NULL) "
        "AND status = ? ORDER BY created_at, key", (run_id, policy["from"])).fetchall()
    keys = []
    for row in rows:
        child = dict(row)
        _set_status(tx, child, policy["to"])
        boardmodel._ticket_event(
            tx.conn, child["id"], "ticket.created_status_promoted", "coordinator", policy["from"], policy["to"],
            {"ticketId": child["id"], "key": child["key"], "parentKey": parent["key"],
             "parentTicketId": parent["id"], "run": run_id, "from": policy["from"], "to": policy["to"]})
        keys.append(child["key"])
    if keys:
        boardmodel._ticket_event(
            tx.conn, parent["id"], "ticket.created_tickets_promoted", "coordinator",
            rule["onPass"], rule["onPass"],
            {"ticketId": parent["id"], "key": parent["key"], "run": run_id, "tickets": keys,
             "from": policy["from"], "to": policy["to"]})


def _move_by_rule(tx, workspace: str, ticket: dict, rule: dict, target_key: str, reason: str) -> None:
    _set_status(tx, ticket, rule[target_key])
    boardmodel.append_body(tx, ticket["id"], f"## {reason}")
    if "onFailPriority" in rule:
        boardmodel.bump_priority(tx, ticket["id"], rule["onFailPriority"])
    boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merge_conflict", "coordinator", ticket["status"],
                             rule[target_key], {"ticketId": ticket["id"], "key": ticket["key"],
                                                "reason": reason, "to": rule[target_key]})


def _set_status(tx, ticket: dict, status: str) -> None:
    tx.conn.execute("UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?",
                    (status, utcnow(), ticket["id"]))


# ---- lease helper ------------------------------------------------------------------------------------------

def lease_time(config: dict) -> str:
    """The claim lease deadline (ISO, UTC) from the board's leaseSeconds."""
    from datetime import datetime, timedelta, timezone
    seconds = config.get("leaseSeconds", boardmodel.DEFAULT_LEASE_SECONDS)
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(timespec="milliseconds") \
        .replace("+00:00", "Z")
