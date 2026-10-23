"""Coordinator board column starts; column behaviour comes entirely from schema/config."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone

from . import board_config, crashpoints, gitws, schema, tickets, workflow, workflowdef, worktrees
from .protocol import (AsError, BOARD_CONFIG_INVALID, TICKET_DEPS_NOT_MERGED,
                       TICKET_ROLE_MISMATCH, TICKET_TRANSITION_INVALID, WORKTREE_NOT_REGISTERED)


def decide(entry, run_status, verdict, counters, limits):
    """Return the durable outcome described by one schema entry, without I/O."""
    if run_status == "cancelled":
        return {"to": "release", "reason": None, "counter": None, "findingsFrom": None}
    name = entry.get("name") or next((key for key, value in schema.BOARD_OUTCOMES.items()
                                       if all(entry.get(field) == item for field, item in value.items())), "")
    if entry["kind"] == "work":
        failed = run_status == "failed"
    else:
        if verdict not in ("pass", "fail"):
            return {"to": "blocked", "reason": "RUN_FAILED:" + name, "counter": None, "findingsFrom": None}
        failed = verdict == "fail"
    if not failed:
        return {"to": entry["pass"], "reason": None, "counter": None, "findingsFrom": None}
    counter = entry.get("counter")
    value = None
    if counter:
        value = int(counters.get(counter, 0)) + 1
        if value > int(limits[entry["limit"]]):
            return {"to": "blocked", "reason": "ROUND_LIMIT:" + name,
                    "counter": {counter: value}, "findingsFrom": "validation" if entry["kind"] == "work" else "verdict"}
    if entry["kind"] == "verdict" and entry["fail"] == "blocked":
        return {"to": "blocked", "reason": "VERDICT_FAIL:" + name, "counter": None, "findingsFrom": "verdict"}
    return {"to": entry["fail"], "reason": None, "counter": {counter: value} if counter else None,
            "findingsFrom": "validation" if entry["kind"] == "work" else "verdict"}


def _bounded(items):
    values = [str(x)[:2000] for x in (items or [])][:50]
    while values and len(json.dumps(values, ensure_ascii=True).encode("utf-8")) > 16 * 1024:
        if len(values) > 1:
            values.pop()
        else:
            values[0] = values[0][:-1]
    return values


def _queue(tx, ticket):
    row = tx.conn.execute("SELECT from_status FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.moved' "
                          "AND to_status = ? ORDER BY id DESC LIMIT 1", (ticket["id"], ticket["status"])).fetchone()
    return row[0] if row else schema.TICKET_WORKING[ticket["status"]][0]


def _roles_for(tx, run):
    return {r[0] for r in tx.conn.execute("SELECT DISTINCT role FROM agents WHERE team_id = ?", (run["team_id"],))}


def _verdict(tx, run_id):
    row = tx.conn.execute("SELECT verdict_json FROM stage_attempts WHERE workflow_run_id = ? AND verdict_json IS NOT NULL "
                          "ORDER BY created_at DESC, rowid DESC LIMIT 1", (run_id,)).fetchone()
    return json.loads(row[0]) if row else {}


def _subject(path):
    got = gitws.run(path, "log", "-1", "--format=%s", check=False)
    return got.stdout.decode("utf-8", "replace").rstrip("\n") if got.returncode == 0 else ""


def _head(path):
    got = gitws.run(path, "rev-parse", "--verify", "HEAD^{commit}", check=False)
    return got.stdout.decode().strip() if got.returncode == 0 else None


def _recorded(tx, ticket, commit):
    for row in tx.conn.execute("SELECT payload_json FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.committed'", (ticket["id"],)):
        if json.loads(row[0]).get("commit") == commit:
            return True
    return False


def _globs(ticket, values):
    result = []
    phase = None
    parts = (ticket.get("story_path") or "").split("/")
    if len(parts) >= 2 and parts[0] == "phases" and re.fullmatch(r"phase-\d+", parts[1]):
        phase = "/".join(parts[:2])
    for value in values:
        if value == "{phase}/*" and not phase:
            continue
        result.append(value.replace("{story}", ticket.get("story_path") or "").replace("{phase}", phase or ""))
    return tuple(result)


def commit_planning(tx, ticket, column, globs, config, run_id):
    message = f"{ticket['key']}: {column} {ticket['story_path']}"
    paths = worktrees.changed_paths(ticket["workspace"])
    allowed, offending = worktrees.check_paths(paths, _globs(ticket, globs))
    if not allowed:
        return {"ok": False, "commit": None, "paths": paths, "offending": offending}
    commit = None
    if paths:
        commit = worktrees.commit_paths(ticket["workspace"], config["baseBranch"], paths, message)["commit"]
        crashpoints.hit("after_outcome_git_commit")
    else:
        head = _head(ticket["workspace"])
        if head and _subject(ticket["workspace"]) == message and not _recorded(tx, ticket, head):
            commit = head
    return {"ok": True, "commit": commit, "paths": paths, "offending": []}


def _note(tx, ticket, name, payload):
    seq = tx.note("ticket", ticket["id"], name, payload)
    ticket = tx.get("ticket", ticket["id"])
    tickets._ticket_event(tx, ticket, seq, name, "coordinator", ticket["status"], ticket["status"], payload)
    return ticket


def _paused_code(tx, run):
    row = tx.conn.execute("SELECT payload_json FROM events WHERE entity = 'workflow_run' AND entity_id = ? "
                          "AND name = 'workflow_run.paused' ORDER BY seq DESC LIMIT 1", (run["id"],)).fetchone()
    return (json.loads(row[0]).get("diagnosticCode") if row else None) or "UNKNOWN"


def _apply(tx, ticket, run, ctx):
    column = next((n for n, v in schema.BOARD_COLUMNS.items() if v["working"] == ticket["status"]), None)
    if column is None:
        row = tx.conn.execute("SELECT from_status FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.run_started' "
                              "AND payload_json LIKE ? ORDER BY id DESC LIMIT 1", (ticket["id"], '%"runId":"' + run["id"] + '"%')).fetchone()
        column = next((n for n, v in schema.BOARD_COLUMNS.items() if row and v["working"] == row[0]), None)
    entry = schema.BOARD_OUTCOMES.get(column)
    if entry is None:
        ticket = tickets.block(tx, ticket, "coordinator", "OUTCOME_UNSUPPORTED:" + str(column))
        tx.update("ticket", ticket["id"], {"assignee_agent_id": None, "lease_until": None},
                  "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
        return _finish(tx, ticket, run, column, None, "blocked", ticket["blocked_reason"])
    entry = dict(entry, name=column)
    config = board_config.current(tx, ticket["workspace"], _roles_for(tx, run))
    if run["status"] == "paused" and ticket["status"] == schema.BOARD_COLUMNS[column]["working"]:
        ticket = tickets.block(tx, ticket, "coordinator", "RUN_PAUSED:" + _paused_code(tx, run), _queue(tx, ticket))
        tx.update("ticket", ticket["id"], {"lease_until": None}, "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
        return _finish(tx, ticket, run, column, None, "blocked", ticket["blocked_reason"], applied=False)
    verdict_data = _verdict(tx, run["id"])
    verdict = verdict_data.get("verdict")
    outcome = decide(entry, run["status"], verdict,
                     {k: ticket[k] for k in ("dev_rounds", "test_rounds", "review_rounds")}, config["roundLimits"])
    findings = _bounded(verdict_data.get("findings"))
    if outcome["findingsFrom"] == "validation":
        latest = workflow._latest_result(tx, run["id"])
        findings = _bounded([workflow._validation_text(latest)]) if latest else []
    if entry.get("commit") == "planning":
        result = commit_planning(tx, ticket, column, entry["globs"], config, run["id"])
        if not result["ok"]:
            outcome = {"to": "blocked", "reason": "PLANNING_DIFF_INVALID", "counter": None,
                       "findingsFrom": None, "offending": result["offending"]}
        elif result["commit"]:
            ticket = _record_commit(tx, ticket, {"baseBranch": config["baseBranch"], "commit": result["commit"],
                                                  "paths": result["paths"], "runId": run["id"]})
    if entry.get("commit") == "branch" and run["status"] == "succeeded":
        count = tx.conn.execute("SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.committed' "
                                "AND payload_json LIKE '%\"branch\"%'", (ticket["id"],)).fetchone()[0]
        message = f"{ticket['key']}: {column} round {count + 1}"
        head = _head(ticket["worktree_path"])
        commit = head if head and _subject(ticket["worktree_path"]) == message and not _recorded(tx, ticket, head) else None
        if not commit:
            commit = worktrees.commit_round(ticket["worktree_path"], message)["commit"]
            if commit:
                crashpoints.hit("after_outcome_git_commit")
        if commit:
            ticket = _record_commit(tx, ticket, {"branch": ticket["branch"], "commit": commit, "runId": run["id"]}, head=commit)
        else:
            outcome = decide(entry, "failed", None,
                             {k: ticket[k] for k in ("dev_rounds", "test_rounds", "review_rounds")}, config["roundLimits"])
            findings = ["NO_CHANGES"]
    elif entry.get("commit") == "branch" and run["status"] == "failed" and worktrees.is_clean(ticket["worktree_path"]):
        outcome = decide(entry, "failed", None,
                         {k: ticket[k] for k in ("dev_rounds", "test_rounds", "review_rounds")}, config["roundLimits"])
        findings = ["NO_CHANGES"]
    return _write_outcome(tx, ticket, run, column, outcome, findings)


def _record_commit(tx, ticket, payload, head=None):
    values = {"head_commit": head} if head else { }
    if values:
        tx.update("ticket", ticket["id"], values, "ticket.commit_recorded", payload)
    return _note(tx, tx.get("ticket", ticket["id"]), "ticket.committed", payload)


def _finish(tx, ticket, run, column, verdict, to, reason, applied=True, extra=None):
    payload = {"runId": run["id"], "column": column, "runStatus": run["status"], "verdict": verdict,
               "to": to, "reason": reason}
    if extra:
        payload.update(extra)
    if applied:
        tx.update("ticket", ticket["id"], {"applied_run_id": run["id"]}, "ticket.outcome_marked", payload)
    return _note(tx, tx.get("ticket", ticket["id"]), "ticket.outcome_applied", payload)


def _write_outcome(tx, ticket, run, column, outcome, findings):
    if ticket["status"] in schema.TICKET_TERMINAL:
        # A terminal ticket is never released or otherwise changed by its
        # completed run; recording the application consumes that run.
        return _finish(tx, ticket, run, column, _verdict(tx, run["id"]).get("verdict"),
                       outcome["to"], outcome["reason"],
                       extra={"offending": outcome["offending"]} if outcome.get("offending") else None)
    values = {"assignee_agent_id": None, "lease_until": None, "applied_run_id": run["id"]}
    if outcome["counter"]:
        values.update(outcome["counter"])
    if outcome["findingsFrom"]:
        values["questions_json" if outcome["reason"] == "VERDICT_FAIL:" + column else "findings_json"] = findings
    if outcome["to"] == "release" and ticket["status"] == "blocked":
        ticket = tx.get("ticket", ticket["id"])
        tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
    elif outcome["to"] == "release":
        target = _queue(tx, ticket)
        ticket = tickets.move(tx, ticket, target, "coordinator", "run_cancelled")
        ticket = _note(tx, ticket, "ticket.released", {"reason": "run_cancelled"})
        tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
    elif outcome["to"] == "blocked":
        if ticket["status"] == "blocked":
            values.update({"blocked_reason": outcome["reason"]})
            if outcome["reason"] and outcome["reason"].startswith("ROUND_LIMIT:"):
                values["return_status"] = schema.BOARD_OUTCOMES[column]["fail"]
            tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
            ticket = tx.get("ticket", ticket["id"])
        else:
            restore = (schema.BOARD_OUTCOMES[column]["fail"] if outcome["reason"] and outcome["reason"].startswith("ROUND_LIMIT:")
                       else _queue(tx, ticket))
            ticket = tickets.block(tx, ticket, "coordinator", outcome["reason"], restore)
            tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
            ticket = tx.get("ticket", ticket["id"])
    elif ticket["status"] not in schema.TICKET_TERMINAL:
        ticket = tickets.move(tx, ticket, outcome["to"], "coordinator")
        tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
    else:
        # A late outcome never revives a terminal ticket, but it still consumes
        # the run and releases the stale claim.
        tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
        ticket = tx.get("ticket", ticket["id"])
    if outcome["findingsFrom"]:
        ticket = _note(tx, ticket, "ticket.findings", {"column": column, "count": len(findings)})
    return _finish(tx, ticket, run, column, _verdict(tx, run["id"]).get("verdict"), outcome["to"], outcome["reason"],
                   extra={"offending": outcome["offending"]} if outcome.get("offending") else None)


def _outcome_error(tx, ticket, run, error):
    """Consume a failed application without leaving its claim or event incomplete."""
    column = next((name for name, item in schema.BOARD_COLUMNS.items() if item["working"] == ticket["status"]), None)
    if column is None:
        row = tx.conn.execute("SELECT from_status FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.run_started' "
                              "AND payload_json LIKE ? ORDER BY id DESC LIMIT 1",
                              (ticket["id"], '%"runId":"' + run["id"] + '"%')).fetchone()
        column = next((name for name, item in schema.BOARD_COLUMNS.items() if row and item["working"] == row[0]), None)
    if ticket["status"] in schema.TICKET_TERMINAL:
        # A terminal ticket only consumes the run and records its outcome.  In
        # particular, an application error must not alter its final claim,
        # lease, or blocking details.
        return _finish(tx, ticket, run, column, None, "blocked", error.code)
    if ticket["status"] not in schema.TICKET_TERMINAL and ticket["status"] != "blocked":
        ticket = tickets.block(tx, ticket, "coordinator", error.code, _queue(tx, ticket))
    tx.update("ticket", ticket["id"], {"assignee_agent_id": None, "lease_until": None,
                                         "applied_run_id": ticket["run_id"], "blocked_reason": error.code},
              "ticket.outcome_marked", {})
    ticket = tx.get("ticket", ticket["id"])
    return _finish(tx, ticket, run, column, None, "blocked", error.code)


def apply_outcomes(store, ctx):
    rows = store.conn.execute("SELECT t.id FROM tickets t JOIN workflow_runs w ON w.id = t.run_id "
                              "WHERE t.run_id IS NOT t.applied_run_id AND (w.status IN ('succeeded','failed','cancelled') "
                              "OR (w.status = 'paused' AND t.status IN ('unpacking','refining','triaging','in_dev','in_test','in_review')))" ).fetchall()
    total = 0
    for row in rows:
        try:
            with store.transaction() as tx:
                ticket = tx.get("ticket", row["id"])
                run = tx.get("workflow_run", ticket["run_id"])
                crashpoints.hit("before_outcome_apply")
                _apply(tx, ticket, run, ctx)
            crashpoints.hit("after_outcome_commit")
            total += 1
        except AsError as error:
            with store.transaction() as tx:
                ticket = tx.get("ticket", row["id"])
                if ticket["applied_run_id"] == ticket["run_id"]:
                    continue
                _outcome_error(tx, ticket, tx.get("workflow_run", ticket["run_id"]), error)
    return total


def _column(status):
    for name, item in schema.BOARD_COLUMNS.items():
        if status in item["queues"]:
            return name, item
    raise AsError(TICKET_TRANSITION_INVALID, "Ticket is not waiting in a board column.")


def _roles(definition):
    return {stage.role for stage in definition.stages if stage.type == "agent"}


def _task(ticket):
    fields = [f"Ticket: {ticket['key']} ({ticket['kind']})", f"Title: {ticket['title']}",
              f"Story: {ticket['story_path'] or ''}"]
    if ticket["kind"] == "bug" and ticket.get("raw_text"):
        fields.append(ticket["raw_text"])
    text = "\n".join(fields)
    if len(text.encode("utf-8")) > 32 * 1024:
        raise AsError(BOARD_CONFIG_INVALID, "Board task text exceeds 32 KiB.")
    return text


def _blocked_by(tx, ticket):
    return [r[0] for r in tx.conn.execute("SELECT t.key FROM ticket_deps d JOIN tickets t ON t.id = d.blocked_by_ticket_id "
                                           "WHERE d.ticket_id = ? AND t.status != 'merged' ORDER BY t.key", (ticket["id"],))]


def start_column(tx, ticket, agent, config, ctx):
    name, item = _column(ticket["status"])
    column = config["columns"][name]
    if agent["role"] != column["role"]:
        raise AsError(TICKET_ROLE_MISMATCH, "Agent role does not match board column.",
                      data={"column": name, "role": column["role"], "agentRole": agent["role"]})
    if item["workspace"] == "worktree" and item["seed"] == "findings" and not tickets.deps_merged(tx, ticket):
        raise AsError(TICKET_DEPS_NOT_MERGED, "Ticket dependencies are not merged.", data={"blockedBy": _blocked_by(tx, ticket)})
    lease = (datetime.now(timezone.utc) + timedelta(seconds=config["leaseSeconds"])).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    ticket = tickets.move(tx, ticket, item["working"], "coordinator")
    seq = tx.update("ticket", ticket["id"], {"assignee_agent_id": agent["id"], "lease_until": lease},
                    "ticket.claimed", {"agentId": agent["id"]})
    ticket = tx.get("ticket", ticket["id"])
    tickets._ticket_event(tx, ticket, seq, "ticket.claimed", "coordinator", ticket["status"], ticket["status"], {"agentId": agent["id"]})
    created = None
    try:
        workspace = ticket["workspace"]
        if item["workspace"] == "worktree":
            workspace = ticket["worktree_path"]
            if not workspace:
                if item["seed"] != "findings":
                    raise AsError(WORKTREE_NOT_REGISTERED, "Ticket does not have a registered worktree.")
                created = worktrees.create(ticket["workspace"], ticket["key"], worktrees.slug(ticket["title"]), config["baseBranch"], state_dir=ctx["stateDir"])
                ticket = tickets.record_worktree(tx, ticket, created)
                workspace = created["path"]
        definition = workflowdef.load(workspace, column["definition"], workflow.BUILTIN_DIR)
        roles = _roles(definition)
        if len(roles) != 1:
            raise AsError(BOARD_CONFIG_INVALID, "Board definition must use exactly one agent role.",
                          data={"errors": [{"path": "columns." + name + ".definition", "message": "definition must use exactly one agent role"}]})
        seed = {}
        if item["seed"] == "findings" and ticket["findings_json"] is not None:
            seed["findings"] = json.loads(ticket["findings_json"])
        elif item["seed"] == "diff":
            out = worktrees.branch_diff(ticket["workspace"], config["baseBranch"], ticket["branch"],
                                        os.path.join(ctx["stateDir"], "board", ticket["id"], "seed"))
            with open(out["path"], "rb") as f:
                seed["diff"] = f.read().decode("utf-8", "replace")
        started = workflow.start(tx, {"teamId": agent["team_id"], "definition": column["definition"], "text": _task(ticket),
                                      "workspace": workspace, "bindings": {next(iter(roles)): agent["id"]}, "seed": seed}, ctx)
        seq = tx.update("ticket", ticket["id"], {"run_id": started["workflowRunId"]}, "ticket.run_started",
                        {"runId": started["workflowRunId"], "definition": column["definition"]})
        ticket = tx.get("ticket", ticket["id"])
        tickets._ticket_event(tx, ticket, seq, "ticket.run_started", "coordinator", ticket["status"], ticket["status"],
                              {"runId": started["workflowRunId"], "definition": column["definition"]})
        return {"ticket": ticket, "column": name, "workflowRunId": started["workflowRunId"],
                "definition": column["definition"], "workspace": workspace}
    except Exception:
        if created:
            try:
                worktrees.discard(ticket["workspace"], created, state_dir=ctx["stateDir"])
            except Exception:
                pass
        raise
