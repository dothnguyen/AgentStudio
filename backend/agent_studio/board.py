"""Coordinator board column starts; column behaviour comes entirely from schema/config."""
from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from . import schema, tickets, workflow, workflowdef, worktrees
from .protocol import (AsError, BOARD_CONFIG_INVALID, TICKET_DEPS_NOT_MERGED,
                       TICKET_ROLE_MISMATCH, TICKET_TRANSITION_INVALID, WORKTREE_NOT_REGISTERED)


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
