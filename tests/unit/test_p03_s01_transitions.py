import unittest

from tests.unit.test_p03_s01_tickets import fresh, make
from agent_studio import tickets
from agent_studio.protocol import AsError


class TicketTransitions(unittest.TestCase):
    def setUp(self):
        self.conn, self.store = fresh()

    def test_block_unblock_and_terminal_rules(self):
        with self.store.transaction() as tx:
            ticket = make(tx)
            ticket = tickets.block(tx, ticket, "operator", "wait")
            self.assertEqual(ticket["return_status"], "refine")
            ticket = tickets.unblock(tx, ticket, "operator")
            self.assertEqual((ticket["status"], ticket["return_status"], ticket["blocked_reason"]),
                             ("refine", None, None))
            with self.assertRaises(AsError) as cm:
                tickets.unblock(tx, ticket, "operator")
            self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")

    def test_block_unblock_restores_ready_test_and_clears_block_fields(self):
        with self.store.transaction() as tx:
            ticket = make(tx)
            for status in ("refining", "ready_dev", "in_dev", "ready_test"):
                ticket = tickets.move(tx, ticket, status, "coordinator")
            ticket = tickets.block(tx, ticket, "operator", "wait")
            self.assertEqual(ticket["return_status"], "ready_test")
            ticket = tickets.unblock(tx, ticket, "operator")
            self.assertEqual((ticket["status"], ticket["return_status"], ticket["blocked_reason"]),
                             ("ready_test", None, None))

    def test_working_block_restores_first_queue_and_late_outcome_clears(self):
        with self.store.transaction() as tx:
            ticket = make(tx)
            ticket = tickets.move(tx, ticket, "refining", "coordinator")
            ticket = tickets.move(tx, ticket, "ready_dev", "coordinator")
            ticket = tickets.move(tx, ticket, "in_dev", "coordinator")
            ticket = tickets.block(tx, ticket, "coordinator", "wait")
            self.assertEqual(ticket["return_status"], "ready_dev")
            ticket = tickets.move(tx, ticket, "ready_test", "coordinator")
            self.assertEqual((ticket["status"], ticket["return_status"], ticket["blocked_reason"]),
                             ("ready_test", None, None))

    def test_operator_cannot_enter_coordinator_columns_or_wrong_kind_path(self):
        with self.store.transaction() as tx:
            story = make(tx)
            for target in ("refining", "ready_merge", "merged", "ready_unpack"):
                with self.assertRaises(AsError) as cm:
                    tickets.move(tx, story, target, "operator")
                self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")

    def test_cancel_from_blocked_clears_and_terminal_refuses(self):
        with self.store.transaction() as tx:
            ticket = tickets.block(tx, make(tx), "coordinator", "wait")
            ticket = tickets.cancel(tx, ticket, "operator")
            self.assertEqual((ticket["status"], ticket["return_status"], ticket["blocked_reason"]),
                             ("cancelled", None, None))
            for call in (lambda: tickets.cancel(tx, ticket, "operator"),
                         lambda: tickets.block(tx, ticket, "operator", "x")):
                with self.assertRaises(AsError) as cm:
                    call()
                self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")

    def test_transition_table_accepts_allowed_and_refuses_every_other_triple(self):
        """The store, rather than Entity's actor-free graph, owns ticket policy."""
        for frm, to, actor in tickets.TRANSITIONS:
            kinds = [kind for kind, statuses in tickets.KIND_STATUSES.items() if frm in statuses and to in statuses]
            if not kinds:
                continue
            with self.store.transaction() as tx:
                ticket = make(tx, kind=kinds[0], hold=(frm == "backlog" and kinds[0] != "bug"))
                # Set only valid per-kind source states; the call under test still validates the full triple.
                values = (frm, "refine" if frm == "blocked" else None)
                tx.conn.execute("UPDATE tickets SET status = ?, return_status = ?, blocked_reason = ? WHERE id = ?",
                                (values[0], values[1], "wait" if frm == "blocked" else None, ticket["id"]))
                ticket = tickets.get(tx, ticket["workspace"], ticket["key"])
                moved = tickets.move(tx, ticket, to, actor, "test")
                self.assertEqual(moved["status"], to, (frm, to, actor))
        for frm in tickets.TICKET_STATES:
            for to in tickets.TICKET_STATES:
                for actor in ("coordinator", "operator"):
                    kinds = [kind for kind, statuses in tickets.KIND_STATUSES.items() if frm in statuses and to in statuses]
                    if (frm, to, actor) in tickets.TRANSITIONS and kinds:
                        continue
                    with self.store.transaction() as tx:
                        ticket = make(tx)
                        tx.conn.execute("UPDATE tickets SET status = ?, return_status = ?, blocked_reason = ? WHERE id = ?",
                                        (frm, "refine" if frm == "blocked" else None,
                                         "wait" if frm == "blocked" else None, ticket["id"]))
                        ticket = tickets.get(tx, ticket["workspace"], ticket["key"])
                        before = dict(ticket)
                        with self.assertRaises(AsError) as cm:
                            tickets.move(tx, ticket, to, actor)
                        self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID", (frm, to, actor))
                        self.assertEqual(tickets.get(tx, ticket["workspace"], ticket["key"]), before)

    def test_operator_is_busy_only_while_run_is_active(self):
        with self.store.transaction() as tx:
            team = tx.create("team", {"name": "t", "workspace": "/one"})
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": "/one", "goal": "g"})
            run = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "w"})
            tx.transition("workflow_run", run, "running")
            ticket = make(tx)
            tx.update("ticket", ticket["id"], {"run_id": run}, "ticket.attached")
            ticket = tickets.get(tx, "/one", ticket["key"])
            for call in (lambda: tickets.move(tx, ticket, "ready_dev", "operator"),
                         lambda: tickets.block(tx, ticket, "operator", "wait")):
                with self.assertRaises(AsError) as cm:
                    call()
                self.assertEqual(cm.exception.code, "TICKET_BUSY")
            ticket = tickets.move(tx, ticket, "refining", "coordinator")
            ticket = tickets.block(tx, ticket, "coordinator", "wait")
            with self.assertRaises(AsError) as cm:
                tickets.unblock(tx, ticket, "operator")
            self.assertEqual(cm.exception.code, "TICKET_BUSY")
            ticket = tickets.cancel(tx, ticket, "operator")
            self.assertEqual(ticket["status"], "cancelled")
            tx.transition("workflow_run", run, "cancelled")
            other = make(tx)
            tx.update("ticket", other["id"], {"run_id": run}, "ticket.attached")
            other = tickets.move(tx, tickets.get(tx, "/one", other["key"]), "ready_dev", "operator")
            self.assertEqual(other["status"], "ready_dev")
