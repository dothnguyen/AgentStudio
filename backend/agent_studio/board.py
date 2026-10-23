"""Coordinator board column starts; column behaviour comes entirely from schema/config."""
from __future__ import annotations

import json
import os
import re
from datetime import datetime, timedelta, timezone

from . import board_config, bugfile, crashpoints, gitws, schema, tasks, tickets, workflow, workflowdef, worktrees
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


def commit_message(text, ticket):
    """Extract the lead's first exact commit block and add the ticket trailer."""
    lines = (text or "").splitlines()
    message = None
    for index, line in enumerate(lines):
        if line != "```commit":
            continue
        for end in range(index + 1, len(lines)):
            if lines[end] == "```":
                candidate = "\n".join(lines[index + 1:end]).strip()
                if candidate:
                    message = candidate
                break
        break
    defaulted = message is None
    if defaulted:
        message = f"{ticket['key']}: {ticket['title']}"
    trailer = f"Ticket: {ticket['key']}"
    if not message.endswith(trailer):
        message += "\n\n" + trailer
    return message, defaulted


def rewrite_story_status(path):
    """Mark just the first Status line done; return whether the file changed."""
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith("Status:"):
            ending = "\n" if line.endswith("\n") else ""
            lines[index] = "Status: Done (" + datetime.now(timezone.utc).date().isoformat() + ")" + ending
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write("".join(lines))
            return True
    return False


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
        result.append(value.replace("{story}", ticket.get("story_path") or "").replace("{phase}", phase or "").replace("{key}", ticket["key"]))
    return tuple(result)


def commit_planning(tx, ticket, column, globs, config, run_id):
    paths = worktrees.changed_paths(ticket["workspace"])
    allowed, offending = worktrees.check_paths(paths, _globs(ticket, globs))
    if allowed and schema.BOARD_OUTCOMES.get(column, {}).get("single"):
        pattern = re.compile(r"bugs/BUG-" + re.escape(ticket["key"]) + r"-[a-z0-9-]{1,40}\.md\Z")
        if len(paths) > 1 or any(not pattern.fullmatch(path) for path in paths):
            allowed, offending = False, paths
    changed = paths[0] if schema.BOARD_OUTCOMES.get(column, {}).get("single") and len(paths) == 1 else ticket["story_path"]
    message = f"{ticket['key']}: {column} {changed}"
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
    committed_path = None
    if entry.get("commit") == "planning":
        result = commit_planning(tx, ticket, column, entry["globs"], config, run["id"])
        if not result["ok"]:
            outcome = {"to": "blocked", "reason": "PLANNING_DIFF_INVALID", "counter": None,
                       "findingsFrom": None, "offending": result["offending"]}
        elif result["commit"]:
            if entry.get("single") and result["paths"]:
                committed_path = result["paths"][0]
            ticket = _record_commit(tx, ticket, {"baseBranch": config["baseBranch"], "commit": result["commit"],
                                                  "paths": result["paths"], "runId": run["id"]})
    if committed_path:
        tx.update("ticket", ticket["id"], {"story_path": committed_path}, "ticket.bug_file_recorded", {})
        ticket = tx.get("ticket", ticket["id"])
    if entry.get("commit") == "branch" and run["status"] == "succeeded":
        count = tx.conn.execute("SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.committed' "
                                "AND payload_json LIKE '%\"branch\"%' AND payload_json NOT LIKE '%\"baseMerge\":true%'",
                                (ticket["id"],)).fetchone()[0]
        message = f"{ticket['key']}: {column} round {count + 1}"
        conflict_paths = [value[len("MERGE_CONFLICT: "):] for value in json.loads(ticket.get("findings_json") or "[]")
                          if value.startswith("MERGE_CONFLICT: ")]
        left = []
        for rel in conflict_paths:
            try:
                with open(os.path.join(ticket["worktree_path"], rel), "r", encoding="utf-8", errors="replace") as f:
                    if any(line.startswith("<<<<<<< ") for line in f):
                        left.append(rel)
            except OSError:
                continue
        if left:
            outcome = decide(entry, "failed", None,
                             {k: ticket[k] for k in ("dev_rounds", "test_rounds", "review_rounds")}, config["roundLimits"])
            findings = ["MERGE_MARKERS_LEFT: " + path for path in left]
            return _write_outcome(tx, ticket, run, column, outcome, findings)
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
    if entry.get("check") == "bugfile" and outcome["to"] == "ready_dev":
        path = committed_path or ticket.get("story_path")
        if not path:
            checked = {"errors": [{"section": "file", "message": "no bug file written"}]}
        else:
            try:
                with open(os.path.join(ticket["workspace"], path), encoding="utf-8") as f:
                    checked = bugfile.check(f.read(), ticket["key"], [r[0] for r in tx.conn.execute("SELECT key FROM tickets WHERE workspace = ?", (ticket["workspace"],))])
            except OSError:
                checked = {"errors": [{"section": "file", "message": "no bug file written"}]}
        if checked["errors"]:
            outcome = {"to": "blocked", "reason": "BUG_FILE_INVALID", "counter": None, "findingsFrom": "verdict"}
            findings = _bounded([f"{e['section']}: {e['message']}" for e in checked["errors"]])
        elif checked.get("duplicateOf"):
            outcome = {"to": "cancelled", "reason": "duplicate_of:" + checked["duplicateOf"], "counter": None, "findingsFrom": None}
            tx.update("ticket", ticket["id"], {"duplicate_of": checked["duplicateOf"], "severity": checked["severity"]}, "ticket.bug_triaged", {})
            ticket = tx.get("ticket", ticket["id"])
        else:
            tx.update("ticket", ticket["id"], {"severity": checked["severity"], "priority": schema.BUG_SEVERITY_PRIORITY[checked["severity"]]}, "ticket.bug_triaged", {})
            ticket = tx.get("ticket", ticket["id"])
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
    defaulted = False
    if column == "review" and to == "ready_merge":
        payload["commitMessage"], defaulted = commit_message(workflow._last_summary(tx, run["id"]), ticket)
    if applied:
        tx.update("ticket", ticket["id"], {"applied_run_id": run["id"]}, "ticket.outcome_marked", payload)
    ticket = _note(tx, tx.get("ticket", ticket["id"]), "ticket.outcome_applied", payload)
    if defaulted:
        ticket = _note(tx, ticket, "ticket.merge_message_defaulted", {})
    return ticket


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
        values["questions_json" if outcome["reason"] in ("VERDICT_FAIL:" + column, "BUG_FILE_INVALID") else "findings_json"] = findings
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


def _merge_message(tx, ticket):
    row = tx.conn.execute("SELECT payload_json FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.outcome_applied' "
                          "AND to_status = 'ready_merge' ORDER BY id DESC LIMIT 1", (ticket["id"],)).fetchone()
    if row:
        message = json.loads(row[0]).get("commitMessage")
        if message:
            return message
    return commit_message("", ticket)[0]


def _held(tx, ticket, reason):
    row = tx.conn.execute("SELECT name, payload_json FROM ticket_events WHERE ticket_id = ? ORDER BY id DESC LIMIT 1",
                          (ticket["id"],)).fetchone()
    if row and row["name"] == "board.held" and json.loads(row["payload_json"]) == {"column": "merge", "reason": reason}:
        return
    _note(tx, ticket, "board.held", {"column": "merge", "reason": reason})


def _remove_worktree(ticket, ctx):
    if ticket.get("worktree_path"):
        try:
            worktrees.remove(ticket["workspace"], ticket["worktree_path"], state_dir=ctx["stateDir"])
        except Exception:
            pass  # startup reconciliation will remove a registered orphan


def _parent_done(tx, ticket):
    parent_id = ticket.get("parent_ticket_id")
    if not parent_id:
        return
    parent = tx.get("ticket", parent_id)
    rows = tx.conn.execute("SELECT status FROM tickets WHERE parent_ticket_id = ?", (parent_id,)).fetchall()
    statuses = [row[0] for row in rows]
    if parent["status"] == "unpacked" and statuses and any(s == "merged" for s in statuses) and all(
            s in ("merged", "cancelled") for s in statuses):
        tickets.move(tx, parent, "done", "coordinator")


def _complete_merge(tx, ticket, commit):
    head = _head(ticket["worktree_path"]) if ticket.get("worktree_path") else None
    tx.update("ticket", ticket["id"], {"merged_commit": commit, "head_commit": head}, "ticket.merge_recorded", {"commit": commit})
    ticket = tickets.move(tx, tx.get("ticket", ticket["id"]), "merged", "coordinator")
    ticket = _note(tx, ticket, "ticket.merged", {"commit": commit})
    _parent_done(tx, ticket)
    tx.conn.execute("DELETE FROM board_locks WHERE workspace = ? AND name = 'merge'", (ticket["workspace"],))
    return ticket


def _merge_conflict(tx, ticket, files, config):
    findings = ["MERGE_CONFLICT: " + path for path in files]
    rounds = ticket["review_rounds"] + 1
    values = {"review_rounds": rounds, "findings_json": json.dumps(_bounded(findings), ensure_ascii=True),
              "assignee_agent_id": None, "lease_until": None}
    if rounds > int(config["roundLimits"]["review"]):
        ticket = tickets.block(tx, ticket, "coordinator", "ROUND_LIMIT:review", "changes_requested")
    else:
        ticket = tickets.move(tx, ticket, "changes_requested", "coordinator")
    tx.update("ticket", ticket["id"], values, "ticket.outcome_marked", {})
    ticket = tx.get("ticket", ticket["id"])
    _note(tx, ticket, "ticket.findings", {"column": "merge", "count": len(findings)})
    _note(tx, ticket, "ticket.merge_conflict", {"files": files})
    tx.conn.execute("DELETE FROM board_locks WHERE workspace = ? AND name = 'merge'", (ticket["workspace"],))


def merge_ready(store, ctx):
    """Merge at most one oldest ready ticket in each workspace."""
    workspaces = [r[0] for r in store.conn.execute("SELECT DISTINCT workspace FROM tickets WHERE status = 'ready_merge'")]
    total = 0
    for workspace in workspaces:
        with store.transaction() as tx:
            ticket = tx.conn.execute("SELECT * FROM tickets WHERE workspace = ? AND status = 'ready_merge' "
                                     "ORDER BY priority, created_at LIMIT 1", (workspace,)).fetchone()
            if not ticket:
                continue
            ticket = dict(ticket)
            config = board_config.current(tx, workspace, None)
            busy = tasks._mutating_in_workspace(tx, workspace) or tx.conn.execute(
                "SELECT 1 FROM board_locks WHERE workspace = ? AND name = 'merge'", (workspace,)).fetchone()
            branch = gitws.run(workspace, "symbolic-ref", "--short", "HEAD", check=False)
            reason = ("MAIN_CHECKOUT_BUSY" if busy else "MAIN_CHECKOUT_DIRTY" if not worktrees.is_clean(workspace)
                      else "MAIN_CHECKOUT_WRONG_BRANCH" if branch.returncode != 0 or branch.stdout.decode().strip() != config["baseBranch"] else None)
            if reason:
                _held(tx, ticket, reason)
                continue
            tx.conn.execute("INSERT INTO board_locks (workspace, name, ticket_id, created_at) VALUES (?, 'merge', ?, ?)",
                            (workspace, ticket["id"], datetime.now(timezone.utc).isoformat()))
        result = gitws.run(workspace, "merge", "--squash", ticket["branch"], check=False)
        if result.returncode != 0:
            raw = gitws.run(workspace, "diff", "--name-only", "--diff-filter=U", check=False).stdout
            files = [line for line in raw.decode("utf-8", "replace").splitlines() if line]
            gitws.run(workspace, "reset", "--merge")
            with store.transaction() as tx:
                current = tx.get("ticket", ticket["id"])
                _merge_conflict(tx, current, files, board_config.current(tx, workspace, None))
            continue
        crashpoints.hit("after_merge_squash")
        if ticket.get("story_path"):
            story = os.path.join(workspace, ticket["story_path"])
            if os.path.isfile(story) and rewrite_story_status(story):
                gitws.run(workspace, "add", "--", ticket["story_path"])
        message = None
        with store.transaction() as tx:
            message = _merge_message(tx, tx.get("ticket", ticket["id"]))
        message_path = os.path.join(ctx["stateDir"], "board", ticket["id"], "commit-message.txt")
        os.makedirs(os.path.dirname(message_path), mode=0o700, exist_ok=True)
        with open(message_path, "w", encoding="utf-8") as f:
            f.write(message)
        gitws.run(workspace, "commit", "--allow-empty", "-F", message_path)
        crashpoints.hit("after_merge_git_commit")
        commit = _head(workspace)
        with store.transaction() as tx:
            current = tx.get("ticket", ticket["id"])
            _complete_merge(tx, current, commit)
        _remove_worktree(ticket, ctx)
        total += 1
    return total


def recover_merge(store, ctx):
    rows = store.conn.execute("SELECT workspace, ticket_id FROM board_locks WHERE name = 'merge'").fetchall()
    for row in rows:
        with store.transaction() as tx:
            ticket = tx.get("ticket", row["ticket_id"])
            message = gitws.run(row["workspace"], "log", "-1", "--format=%B", check=False).stdout.decode("utf-8", "replace")
            if ticket["status"] == "ready_merge" and message.rstrip("\n").endswith("Ticket: " + ticket["key"]):
                _complete_merge(tx, ticket, _head(row["workspace"]))
                remove = ticket
            else:
                gitws.run(row["workspace"], "reset", "--merge", check=False)
                tx.conn.execute("DELETE FROM board_locks WHERE workspace = ? AND name = 'merge'", (row["workspace"],))
                remove = None
        if remove:
            _remove_worktree(remove, ctx)


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
    if ticket["kind"] == "bug" and ticket.get("attachments_json"):
        attachments = json.loads(ticket["attachments_json"])
        if attachments:
            fields.append("Attachments: " + ", ".join(attachments))
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
            if item["seed"] == "findings" and any(value.startswith("MERGE_CONFLICT: ")
                                           for value in json.loads(ticket.get("findings_json") or "[]")):
                merge_message = f"{ticket['key']}: merge {config['baseBranch']}"
                merged = gitws.run(workspace, "merge", "--no-edit", "-m", merge_message, config["baseBranch"], check=False)
                if merged.returncode != 0:
                    # Keep the conflict worktree available to the developer even if Git cannot
                    # stage or commit its marker snapshot (for example, a transient index
                    # failure).  The base-merge event still records that this develop round
                    # starts from the attempted merge, and the developer receives the markers.
                    gitws.run(workspace, "add", "-A", check=False)
                    gitws.run(workspace, "commit", "-m", merge_message + " (conflicts)", check=False)
                commit = _head(workspace)
                ticket = _record_commit(tx, ticket, {"branch": ticket["branch"], "commit": commit,
                                                      "baseMerge": True, "runId": None}, head=commit)
        definition_name = column.get("bugDefinition") if ticket["kind"] == "bug" and column.get("bugDefinition") else column["definition"]
        definition = workflowdef.load(workspace, definition_name, workflow.BUILTIN_DIR)
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
        started = workflow.start(tx, {"teamId": agent["team_id"], "definition": definition_name, "text": _task(ticket),
                                      "workspace": workspace, "bindings": {next(iter(roles)): agent["id"]}, "seed": seed}, ctx)
        seq = tx.update("ticket", ticket["id"], {"run_id": started["workflowRunId"]}, "ticket.run_started",
                        {"runId": started["workflowRunId"], "definition": definition_name})
        ticket = tx.get("ticket", ticket["id"])
        tickets._ticket_event(tx, ticket, seq, "ticket.run_started", "coordinator", ticket["status"], ticket["status"],
                              {"runId": started["workflowRunId"], "definition": definition_name})
        return {"ticket": ticket, "column": name, "workflowRunId": started["workflowRunId"],
                "definition": definition_name, "workspace": workspace}
    except Exception:
        if created:
            try:
                worktrees.discard(ticket["workspace"], created, state_dir=ctx["stateDir"])
            except Exception:
                pass
        raise
