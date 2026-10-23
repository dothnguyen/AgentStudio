import os
import tempfile
import unittest

from tests.unit.test_p03_s01_tickets import fresh
from agent_studio import PROTOCOL, coordinator, dispatch, queries, tickets
from agent_studio.protocol import AsError, BAD_REQUEST, TICKET_NOT_FOUND, WORKSPACE_NOT_FOUND


class TicketCommands(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.conn, self.store = fresh()
        os.makedirs(os.path.join(self.root, "phases", "phase-03", "stories"))
        self._story("P03-S01-a.md", "# First story\n")
        self._story("P03-S02-b.md", "# Second story\nDepends on: P03-S01, P03-S99\n")

    def _story(self, name, text):
        with open(os.path.join(self.root, "phases", "phase-03", "stories", name), "w", encoding="utf-8") as f:
            f.write(text)

    def _create(self, path, **more):
        args = {"workspace": self.root, "storyPath": "phases/phase-03/stories/" + path,
                "priority": 100, "noDeps": False, **more}
        with self.store.transaction(actor="operator") as tx:
            return coordinator.HANDLERS["ticket.create"](args, tx, {})

    def test_create_resolves_or_overrides_story_dependencies(self):
        first = self._create("P03-S01-a.md")
        self.assertEqual((first["ticket"]["key"], first["ticket"]["status"], first["ticket"]["title"]),
                         ("T-001", "refine", "First story"))
        second = self._create("P03-S02-b.md")
        self.assertEqual(second["dependsOn"], ["T-001"])
        self.assertEqual(second["warnings"], [{"code": "DEPENDS_UNRESOLVED", "id": "P03-S99"}])
        overridden = self._create("P03-S02-b.md", dependsOn=["T-002"])
        self.assertEqual(overridden["dependsOn"], ["T-002"])
        explicit_empty = self._create("P03-S02-b.md", dependsOn=[])
        self.assertEqual(explicit_empty["dependsOn"], [])
        none = self._create("P03-S02-b.md", noDeps=True)
        self.assertEqual(none["dependsOn"], [])
        self.assertEqual(none["warnings"][0]["id"], "P03-S99")
        with self.assertRaises(AsError) as cm:
            self._create("P03-S02-b.md", dependsOn=["T-999"])
        self.assertEqual(cm.exception.code, "TICKET_NOT_FOUND")
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM tickets").fetchone()[0], 5)

    def test_commands_errors_and_read_models(self):
        first = self._create("P03-S01-a.md")["ticket"]
        with self.store.transaction(actor="operator") as tx:
            with self.assertRaises(AsError) as cm:
                coordinator.HANDLERS["ticket.move"]({"workspace": self.root, "key": first["key"], "to": "merged"}, tx, {})
            self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")
        with self.store.transaction(actor="operator") as tx:
            with self.assertRaises(AsError) as cm:
                coordinator.HANDLERS["ticket.unblock"]({"workspace": self.root, "key": first["key"]}, tx, {})
            self.assertEqual(cm.exception.code, "TICKET_TRANSITION_INVALID")
        with self.store.transaction(actor="operator") as tx:
            with self.assertRaises(AsError) as cm:
                coordinator.HANDLERS["ticket.depend"]({"workspace": self.root, "key": first["key"], "on": [first["key"]], "remove": []}, tx, {})
            self.assertEqual(cm.exception.code, "TICKET_DEPENDENCY_CYCLE")
        detail = queries.ticket_detail(self.conn, self.root, first["key"])
        self.assertEqual(detail["ticket"]["key"], first["key"])
        self.assertEqual(queries.ticket_list(self.conn, self.root, status="refine")["tickets"][0]["key"], first["key"])

    def test_create_validation_rejects_conflicting_empty_override_and_kind(self):
        args = {"workspace": self.root, "storyPath": "phases/phase-03/stories/P03-S01-a.md",
                "dependsOn": [], "noDeps": True}
        with self.assertRaises(AsError) as cm:
            dispatch._validate_ticket_create(args)
        self.assertEqual(cm.exception.code, BAD_REQUEST)
        with self.assertRaises(AsError) as cm:
            dispatch._validate_ticket_create(dict(args, dependsOn=[], noDeps=False, kind="bug"))
        self.assertEqual(cm.exception.code, BAD_REQUEST)

    def test_every_ticket_command_rejects_relative_or_missing_workspace_at_dispatch(self):
        commands = (
            ("ticket.create", {"storyPath": "story.md", "noDeps": False, "priority": 100}),
            ("ticket.move", {"key": "T-001", "to": "refine"}),
            ("ticket.block", {"key": "T-001", "reason": "wait"}),
            ("ticket.unblock", {"key": "T-001"}),
            ("ticket.cancel", {"key": "T-001"}),
            ("ticket.depend", {"key": "T-001", "on": ["T-002"]}),
            ("ticket.show", {"key": "T-001"}),
            ("ticket.list", {}),
        )
        for workspace in ("relative-workspace", os.path.join(self.root, "missing-workspace")):
            for command, args in commands:
                with self.subTest(command=command, workspace=workspace):
                    request = {"id": "workspace-test", "protocol": PROTOCOL, "command": command,
                               "args": {"workspace": workspace, **args}}
                    if command not in ("ticket.show", "ticket.list"):
                        request["idempotencyKey"] = "workspace-test-key"
                    response = dispatch.handle_request(request, require_id=True)
                    self.assertFalse(response["ok"])
                    self.assertEqual(response["error"]["code"], WORKSPACE_NOT_FOUND)

    def test_cancel_cancels_queued_workflow_run(self):
        ticket = self._create("P03-S01-a.md")["ticket"]
        with self.store.transaction(actor="operator") as tx:
            team = tx.create("team", {"name": "t", "workspace": self.root})
            task = tx.create("task", {"team_id": team, "origin": "direct", "workspace": self.root, "goal": "g"})
            run = tx.create("workflow_run", {"team_id": team, "task_id": task, "workflow": "w"})
            tx.update("ticket", ticket["id"], {"run_id": run}, "ticket.attached")
            result = coordinator.HANDLERS["ticket.cancel"](
                {"workspace": self.root, "key": ticket["key"]}, tx, {})
        self.assertEqual(result["ticket"]["status"], "cancelled")
        self.assertEqual(result["run"]["status"], "cancelled")
        self.assertEqual(self.conn.execute("SELECT status FROM workflow_runs WHERE id = ?", (run,)).fetchone()[0], "cancelled")

    def test_show_limits_events_and_list_filters_status_and_kind(self):
        ticket = self._create("P03-S01-a.md")["ticket"]
        with self.store.transaction(actor="operator") as tx:
            current = tickets.get(tx, self.root, ticket["key"])
            for _ in range(27):
                current = tickets.block(tx, current, "operator", "wait")
                current = tickets.unblock(tx, current, "operator")
            feature = tickets.create(tx, self.root, "feature", {"title": "feature", "priority": 10})
            tickets.add_deps(tx, current, [feature["key"]])
        detail = queries.ticket_detail(self.conn, self.root, ticket["key"])
        self.assertEqual(len(detail["events"]), 50)
        sequences = [event["eventSeq"] for event in detail["events"]]
        self.assertEqual(sequences, sorted(sequences))
        self.assertEqual(detail["dependsOn"], [feature["key"]])
        self.assertEqual(queries.ticket_detail(self.conn, self.root, feature["key"])["dependents"], [ticket["key"]])
        self.assertEqual(queries.ticket_list(self.conn, self.root, status="refine")["tickets"], [detail["ticket"]])
        self.assertEqual([row["kind"] for row in queries.ticket_list(self.conn, self.root, kind="feature")["tickets"]],
                         ["feature"])

    def test_ticket_commands_report_not_found(self):
        for command, args in (
                ("ticket.show", {"workspace": self.root, "key": "T-999"}),
                ("ticket.move", {"workspace": self.root, "key": "T-999", "to": "refine"}),
                ("ticket.block", {"workspace": self.root, "key": "T-999", "reason": "wait"}),
                ("ticket.unblock", {"workspace": self.root, "key": "T-999"}),
                ("ticket.cancel", {"workspace": self.root, "key": "T-999"}),
                ("ticket.depend", {"workspace": self.root, "key": "T-999", "on": ["T-001"], "remove": []})):
            with self.subTest(command=command), self.assertRaises(AsError) as cm:
                if command == "ticket.show":
                    queries.ticket_detail(self.conn, args["workspace"], args["key"])
                else:
                    with self.store.transaction(actor="operator") as tx:
                        coordinator.HANDLERS[command](args, tx, {})
            self.assertEqual(cm.exception.code, TICKET_NOT_FOUND)
