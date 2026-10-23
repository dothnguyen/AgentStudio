"""Read-only board selection and one scheduler pass."""
from __future__ import annotations

import json
import sys
import traceback

from . import board, board_config, gitws, schema, tasks, tickets, worktrees
from .protocol import AsError


def _hold(tx, workspace, config):
    main_working = tuple(item["working"] for item in schema.BOARD_COLUMNS.values()
                         if item["workspace"] == "main")
    busy_ticket = tx.conn.execute(
        "SELECT 1 FROM tickets WHERE workspace = ? AND status IN ({}) LIMIT 1".format(
            ",".join("?" * len(main_working))),
        (workspace,) + main_working).fetchone()
    busy = busy_ticket or tasks._mutating_in_workspace(tx, workspace) or tx.conn.execute(
        "SELECT 1 FROM board_locks WHERE workspace = ? AND name = 'merge'", (workspace,)).fetchone()
    if busy:
        return "MAIN_CHECKOUT_BUSY"
    if not worktrees.is_clean(workspace):
        return "MAIN_CHECKOUT_DIRTY"
    branch = gitws.run(workspace, "symbolic-ref", "--short", "HEAD", check=False)
    if branch.returncode != 0 or branch.stdout.decode().strip() != config["baseBranch"]:
        return "MAIN_CHECKOUT_WRONG_BRANCH"
    return None


def holds(tx, workspace, config):
    waiting = []
    for name, item in schema.BOARD_COLUMNS.items():
        if item["workspace"] != "main":
            continue
        marks = ",".join("?" * len(item["queues"]))
        if tx.conn.execute("SELECT 1 FROM tickets WHERE workspace = ? AND status IN (" + marks + ") LIMIT 1",
                           (workspace,) + item["queues"]).fetchone():
            waiting.append(name)
    if not waiting:
        return []
    reason = _hold(tx, workspace, config)
    return [{"column": name, "reason": reason} for name in waiting] if reason else []


def _candidates(tx, workspace, name, item, rule):
    marks = ",".join("?" * len(item["queues"]))
    rows = [dict(row) for row in tx.conn.execute(
        "SELECT * FROM tickets WHERE workspace = ? AND status IN (" + marks + ")",
        (workspace,) + item["queues"])]
    rework = set(rule.get("rework", ()))
    def rank(row):
        if not rework:
            return 0
        if row["kind"] == "bug" and row["severity"] == "blocker":
            return 0
        if row["status"] in rework:
            return 1
        if row["kind"] == "bug":
            return 2
        return 3
    return sorted(rows, key=lambda row: (rank(row), row["priority"], row["created_at"], row["key"]))


def _eligible(tx, workspace, name, item, rule, candidate, config):
    if rule.get("depsMerged") and not tickets.deps_merged(tx, candidate):
        return False
    cap_name = rule.get("cap")
    if cap_name:
        count = tx.conn.execute("SELECT COUNT(*) FROM tickets WHERE workspace = ? AND status = ?",
                                (workspace, item["working"])).fetchone()[0]
        cap = config[cap_name]
        extra = candidate["kind"] == "bug" and candidate["severity"] == "blocker"
        if count >= cap + (1 if extra else 0):
            return False
    return True


def _streak(tx, agent, item, rule):
    amount = rule.get("streak")
    if not amount:
        return False
    rows = []
    for row in tx.conn.execute("SELECT to_status, payload_json FROM ticket_events WHERE name = 'ticket.claimed' "
                               "ORDER BY id DESC"):
        if json.loads(row["payload_json"]).get("agentId") == agent["id"]:
            rows.append(row)
            if len(rows) == amount:
                break
    if len(rows) != amount:
        return False
    return all(row["to_status"] == item["working"] and json.loads(row["payload_json"]).get("agentId") == agent["id"]
               for row in rows)


def pick(tx, workspace, agent, config):
    selected = []
    for name in schema.BOARD_PICK_ORDER:
        item = schema.BOARD_COLUMNS[name]
        if config["columns"][name]["role"] == agent["role"]:
            selected.append((name, item, schema.BOARD_PICK_RULES.get(name, {})))
    held = holds(tx, workspace, config)
    held_names = {entry["column"] for entry in held}
    available = []
    for name, item, rule in selected:
        if name in held_names:
            continue
        for candidate in _candidates(tx, workspace, name, item, rule):
            if _eligible(tx, workspace, name, item, rule, candidate, config):
                available.append((name, item, rule, candidate))
                break
    for name, item, rule in selected:
        if _streak(tx, agent, item, rule):
            alternate = next((entry for entry in available if entry[0] != name and
                              schema.BOARD_COLUMNS[entry[0]]["workspace"] == "main"), None)
            if alternate:
                return alternate[3], held
    return (available[0][3] if available else None), held


def _free(tx, workspace, agent):
    if agent["availability"] != "idle" or tasks._active_for_agent(tx, agent["id"]):
        return False
    return tx.conn.execute("SELECT 1 FROM tickets WHERE workspace = ? AND assignee_agent_id = ? "
                           "AND status IN ({}) LIMIT 1".format(",".join("?" * len(schema.TICKET_WORKING))),
                           (workspace, agent["id"]) + tuple(schema.TICKET_WORKING)).fetchone() is None


def _note_holds(tx, team_id, entries):
    for entry in entries:
        row = next((row for row in tx.conn.execute("SELECT payload_json FROM events WHERE team_id = ? AND name = 'board.held' "
                                                   "ORDER BY seq DESC", (team_id,))
                    if json.loads(row["payload_json"]).get("column") == entry["column"]), None)
        same = row and json.loads(row["payload_json"]).get("reason") == entry["reason"]
        if not same:
            tx.note("team", team_id, "board.held", entry)


def tick(store, ctx):
    rows = store.conn.execute("SELECT * FROM board_state WHERE status = 'running'").fetchall()
    for state in rows:
        try:
            _serve(store, ctx, state)
        except Exception:
            sys.stderr.write("board scheduler: serving {} failed:\n{}\n".format(state["workspace"], traceback.format_exc()))
            sys.stderr.flush()


def _serve(store, ctx, state):
    workspace = state["workspace"]
    team = store.conn.execute("SELECT * FROM teams WHERE workspace = ? AND status = 'running' ORDER BY created_at LIMIT 1",
                              (workspace,)).fetchone()
    if not team:
        return
    agents = store.conn.execute("SELECT * FROM agents WHERE team_id = ? ORDER BY ordinal", (team["id"],)).fetchall()
    for raw in agents:
        agent = dict(raw)
        with store.transaction() as tx:
            current = tx.get("agent", agent["id"])
            if not _free(tx, workspace, current):
                continue
            config = json.loads(state["config_json"]) if state["config_json"] else \
                board_config.current(tx, workspace, {current["role"]})
            candidate, held = pick(tx, workspace, current, config)
            _note_holds(tx, team["id"], held)
        if not candidate:
            continue
        try:
            board.claim_and_start(store, workspace, candidate["key"], agent["id"], ctx, config=config)
        except AsError as error:
            with store.transaction() as tx:
                current = tickets.get(tx, workspace, candidate["key"])
                if current["status"] not in schema.TICKET_TERMINAL and current["status"] != "blocked":
                    tickets.block(tx, current, "coordinator", "START_FAILED:" + error.code)
