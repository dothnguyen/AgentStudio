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

from . import boardmodel, gitws, tasks, worktrees
from .protocol import AsError, BOARD_ALREADY_RUNNING, TEAM_NOT_RUNNING
from .state import utcnow

ACTIVE_ASSIGNMENT = ("queued", "claimed", "running", "waiting_input", "reconciling")


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
        if run is None or run["status"] not in boardmodel.FINISHED_RUN_STATES:
            continue
        ticket = boardmodel.get_ticket(tx.conn, workspace, row["key"])
        rule = _claiming_rule(tx, workspace, ticket)
        boardmodel.apply_run_outcome(tx, workspace, {"key": row["key"], "run": row["run"]}, rule=rule)
        applied += 1
    return applied


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
        f"AND pane_state = 'alive' AND id NOT IN (SELECT agent_id FROM assignments WHERE status IN "
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
            member = next(iter(_free_members(tx, team["id"], rule["role"])), None)
            if member is None:
                continue
            ticket = _pick_ticket(tx, workspace, rule, config, current)
            if ticket is None:
                continue
            if _start_ticket(tx, workspace, team, member, rule, ticket, config, ctx) is not None:
                claimed += 1
        except AsError as e:  # one rule's problem never blocks the others
            errors.append({"workspace": workspace, "code": e.code, "message": e.message})
    return claimed, errors


def _pick_ticket(tx, workspace: str, rule: dict, config: dict, current: dict):
    rows = tx.conn.execute(
        "SELECT * FROM tickets WHERE workspace = ? AND status = ? AND assignee IS NULL "
        "ORDER BY priority, created_at, key", (workspace, rule["when"]["status"])).fetchall()
    for row in rows:
        ticket = dict(row)
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
        start_args = {"teamId": team["id"], "definition": rule["workflow"],
                      "text": _task_text(ticket), "bindings": {rule["role"]: member["id"]}}
        if run_workspace != workspace:
            start_args["workspace"] = run_workspace
        started = _start(tx, start_args, ctx)
        tx.conn.execute("UPDATE tickets SET active_run_id = ?, updated_at = ? WHERE id = ?",
                        (started["workflowRunId"], utcnow(), ticket["id"]))
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.claimed", "coordinator", rule["when"]["status"],
                                 status, {"ticketId": ticket["id"], "key": ticket["key"],
                                          "agentId": member["id"], "run": started["workflowRunId"],
                                          "rule": rule["when"]["status"], "workspace": rule.get("workspace")})
        return started["workflowRunId"]
    except AsError as e:
        boardmodel.release_claim(tx, boardmodel.get_ticket(tx.conn, workspace, ticket["key"]),
                                 f"start_failed:{e.code}", to_status=rule["when"]["status"])
        return None


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
        boardmodel._ticket_event(tx.conn, ticket["id"], "ticket.merge_held", "coordinator", ticket["status"],
                                 ticket["status"], {"ticketId": ticket["id"], "key": ticket["key"],
                                                    "reason": hold if isinstance(hold, str) else "MAIN_CHECKOUT_BUSY"})
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
    if ticket.get("worktree_path"):
        worktrees.remove(workspace, ticket["worktree_path"], state_dir=ctx["stateDir"])
        tx.conn.execute("UPDATE tickets SET worktree_path = NULL, updated_at = ? WHERE id = ?",
                        (utcnow(), ticket["id"]))
    return True


def _move_by_rule(tx, workspace: str, ticket: dict, rule: dict, target_key: str, reason: str) -> None:
    _set_status(tx, ticket, rule[target_key])
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
