"""Board workflow created tickets (T-202): held in ``createdTickets`` and released on pass.

A ticket an agent creates through the board MCP is linked to its parent. The workflow that is running the
parent decides where the child waits; a later pass can release children an earlier workflow created.
"""
import json
import os
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from agent_studio import boardmodel
from tests.unit.test_p04_s10_scheduler import SchedCase

BOARD = {"version": 3, "workflowStatuses": [
    {"id": "none", "kind": "initial"}, {"id": "ready"}, {"id": "working"}, {"id": "holding"},
    {"id": "released"}, {"id": "later"}, {"id": "later-working"},
    {"id": "done", "kind": "done"}],
    "ticketFields": [], "todoEntry": [], "todoDefault": None, "rules": []}

STAGES = [{"id": "work", "role": "worker", "permission": "read_only", "prompt": "Do.",
           "next": {"done": "$succeed"}}]


def workflow(starts_at, running, *, created=None, end=None):
    definition = {"version": 2, "startsAt": starts_at, "whileRunning": running, "role": "worker",
                  "end": end or {"pass": "ready", "fail": "ready"}, "stages": STAGES}
    if created is not None:
        definition["createdTickets"] = created
    return definition


class CreatedTicketsCase(SchedCase):
    def setUp(self):
        super().setUp()
        self.write_board(BOARD)
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE agents SET can_add_tickets = 1 WHERE id = ?", (self.worker,))

    def write_workflow(self, name, definition):
        with open(os.path.join(self.ws, ".agent-studio", "workflows", name + ".json"), "w") as f:
            json.dump(definition, f)
        self.commit_board()  # runs need a clean checkout

    def add_parent(self, title="parent"):
        with self.store.transaction() as tx:
            parent = boardmodel.ticket_add(tx, self.ws, {"title": title, "priority": 100})["ticket"]
            config = boardmodel.load_config(self.ws)
            column = boardmodel.column_for(config, "backlog", "ready", False)
            tx.conn.execute("UPDATE tickets SET status = ?, workflow_status = 'ready' WHERE id = ?",
                            (column, parent["id"]))
            return parent

    def claim(self):
        tick = self.tick()
        self.assertEqual(tick["claimed"], 1, tick)
        parent = dict(self.conn.execute(
            "SELECT * FROM tickets WHERE active_run_id IS NOT NULL ORDER BY key").fetchone())
        assignment = self.conn.execute(
            "SELECT assignment_id FROM stage_attempts WHERE workflow_run_id = ?",
            (parent["active_run_id"],)).fetchone()[0]
        return boardmodel.get_ticket(self.conn, self.ws, parent["key"]), assignment

    def child(self, assignment, title):
        with self.store.transaction() as tx:
            return boardmodel.mcp_ticket_add(
                tx, self.ws, {"assignment": assignment, "title": title, "priority": 100})["ticket"]

    def applied_tick(self, run, status="succeeded"):
        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE board_state SET run_status = 'stopped' WHERE workspace = ?", (self.ws,))
        self.finish(run, status)
        tick = self.tick()
        self.assertEqual(tick["applied"], 1, tick)
        return tick

    def row(self, key):
        return boardmodel.get_ticket(self.conn, self.ws, key)

    def workflow_event(self, key):
        row = self.row(key)
        event = self.conn.execute(
            "SELECT * FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.workflow_changed' "
            "ORDER BY id DESC LIMIT 1", (row["id"],)).fetchone()
        return event, json.loads(event["payload_json"])


class CreatedTicketStatus(CreatedTicketsCase):
    def test_created_ticket_lands_in_the_running_workflows_created_tickets_status(self):
        self.write_workflow("create", workflow("ready", "working", created="holding"))
        parent = self.add_parent()
        claimed, assignment = self.claim()
        self.assertEqual((claimed["key"], claimed["workflow_status"]), (parent["key"], "working"))
        child = self.child(assignment, "child")
        row = self.row(child["key"])
        self.assertEqual((row["workflow_status"], row["parent_ticket_id"]), ("holding", parent["id"]))

    def test_without_a_workflow_created_tickets_the_agent_ticket_status_applies(self):
        board = dict(BOARD, agentTicketStatus="released")
        self.write_board(board)
        self.write_workflow("create", workflow("ready", "working"))
        self.add_parent()
        _, assignment = self.claim()
        child = self.child(assignment, "child")
        self.assertEqual(self.row(child["key"])["workflow_status"], "released")

    def test_without_agent_ticket_status_new_ticket_uses_the_initial_status(self):
        self.write_workflow("create", workflow("ready", "working"))
        self.add_parent()
        _, assignment = self.claim()
        child = self.child(assignment, "child")
        self.assertEqual(self.row(child["key"])["workflow_status"], "none")


class ReleaseOnPass(CreatedTicketsCase):
    def setUp(self):
        super().setUp()
        self.write_workflow("create", workflow(
            "ready", "working", created="holding",
            end={"pass": {"status": "done", "releaseCreatedTickets": {"from": "holding", "to": "released"}},
                 "fail": {"status": "ready", "releaseCreatedTickets": {"from": "holding", "to": "released"}}}))

    def test_pass_releases_only_this_parents_tickets_in_the_from_status(self):
        parent = self.add_parent()
        _, assignment = self.claim()
        child = self.child(assignment, "child")
        kept_parent = self.add_parent("other parent")
        with self.store.transaction() as tx:
            other_child = boardmodel.ticket_add(tx, self.ws, {
                "title": "other child", "priority": 100, "_workflow_status": "holding",
                "_parent_ticket_id": kept_parent["id"]})["ticket"]
            wrong_status = boardmodel.ticket_add(tx, self.ws, {
                "title": "already moved", "priority": 100, "_workflow_status": "ready",
                "_parent_ticket_id": parent["id"]})["ticket"]
        run = self.row(parent["key"])["active_run_id"]
        self.applied_tick(run)
        self.assertEqual(self.row(child["key"])["workflow_status"], "released")
        self.assertEqual(self.row(other_child["key"])["workflow_status"], "holding")
        self.assertEqual(self.row(wrong_status["key"])["workflow_status"], "ready")
        event, payload = self.workflow_event(child["key"])
        self.assertEqual((event["from_status"], event["to_status"]), ("holding", "released"))
        self.assertEqual(payload["reason"], f"released by {parent['key']}")
        child_row = self.row(child["key"])
        self.assertEqual(self.conn.execute(
            "SELECT COUNT(*) FROM ticket_events WHERE ticket_id = ? AND name = 'ticket.workflow_changed'",
            (child_row["id"],)).fetchone()[0], 1)

    def test_fail_releases_nothing_even_when_end_fail_configures_a_release(self):
        parent = self.add_parent()
        _, assignment = self.claim()
        child = self.child(assignment, "child")
        run = self.row(parent["key"])["active_run_id"]
        self.applied_tick(run, "failed")
        self.assertEqual(self.row(parent["key"])["workflow_status"], "ready")
        self.assertEqual(self.row(child["key"])["workflow_status"], "holding")

    def test_a_later_workflow_releases_tickets_an_earlier_workflow_created(self):
        self.write_workflow("create", workflow("ready", "working", created="holding",
                                               end={"pass": "later", "fail": "ready"}))
        self.write_workflow("later", workflow(
            "later", "later-working",
            end={"pass": {"status": "done", "releaseCreatedTickets": {"from": "holding", "to": "released"}},
                 "fail": "later"}))
        parent = self.add_parent()
        _, assignment = self.claim()
        child = self.child(assignment, "child")
        first_run = self.row(parent["key"])["active_run_id"]
        self.applied_tick(first_run)
        self.assertEqual(self.row(parent["key"])["workflow_status"], "later")
        self.assertEqual(self.row(child["key"])["workflow_status"], "holding")
        self.free_member()

        with self.store.transaction() as tx:
            tx.conn.execute("UPDATE board_state SET run_status = 'running' WHERE workspace = ?", (self.ws,))
        tick = self.tick()
        self.assertEqual(tick["claimed"], 1, tick)
        later_run = self.row(parent["key"])["active_run_id"]
        self.applied_tick(later_run)
        self.assertEqual(self.row(parent["key"])["workflow_status"], "done")
        self.assertEqual(self.row(child["key"])["workflow_status"], "released")


if __name__ == "__main__":
    unittest.main()
