"""P04-S07: the generic board — config-driven statuses, the protected default phase, tickets and dependencies."""
import ast
import json
import os
import re
import shutil
import tempfile
import unittest

from tests import helpers  # noqa: F401  (puts backend on sys.path)
from tests.helpers import fresh
from agent_studio import boardcli, boardmodel, cli, dispatch
from agent_studio.protocol import AsError

CONFIG_A = {"version": 2, "statuses": [{"id": "open", "kind": "initial"}, {"id": "wip"},
                                       {"id": "finished", "kind": "done"}],
            "ticketFields": [], "rules": []}
CONFIG_B = {"version": 2, "statuses": [{"id": "todo", "kind": "initial"}, {"id": "doing"}, {"id": "review"},
                                       {"id": "done", "kind": "done"}, {"id": "dropped", "kind": "closed"}],
            "ticketFields": [{"id": "severity", "type": "text"}], "rules": []}
P03_SHAPE = {"version": 1, "baseBranch": "main", "columns": {"unpack": {"role": "ProductOwner"}}}


class BoardCase(unittest.TestCase):
    def setUp(self):
        self.ws = os.path.realpath(tempfile.mkdtemp(prefix="as-board-"))
        self.addCleanup(shutil.rmtree, self.ws, True)
        os.makedirs(os.path.join(self.ws, ".agent-studio"))
        self.write_config(CONFIG_A)
        self.conn, self.store = fresh()

    def write_config(self, config):
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w", encoding="utf-8") as f:
            json.dump(config, f)

    def add(self, title="a", workspace=None, **extra):
        with self.store.transaction() as tx:
            return boardmodel.ticket_add(tx, workspace or self.ws, dict({"title": title, "priority": 100},
                                                                        **extra))["ticket"]

    def move(self, key, to, workspace=None, **extra):
        with self.store.transaction() as tx:
            return boardmodel.ticket_move(tx, workspace or self.ws, dict({"key": key, "to": to}, **extra))

    def depend(self, key, on=(), remove=(), workspace=None):
        with self.store.transaction() as tx:
            return boardmodel.ticket_depend(tx, workspace or self.ws,
                                            {"key": key, "on": list(on), "remove": list(remove)})

    def count(self, table, where="1=1", params=()):
        return self.conn.execute(f"SELECT COUNT(*) FROM {table} WHERE {where}", params).fetchone()[0]

    def events(self, key):
        row = self.conn.execute("SELECT id FROM tickets WHERE workspace = ? AND key = ?", (self.ws, key)).fetchone()
        return self.conn.execute("SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id",
                                 (row["id"],)).fetchall()


class ConfigTests(BoardCase):
    def check_problems(self, config, *fragments):
        self.write_config(config)
        with self.assertRaises(AsError) as caught:
            boardmodel.load_config(self.ws)
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")
        paths = " ".join(p["path"] for p in caught.exception.data["problems"])
        for fragment in fragments:
            self.assertIn(fragment, paths)

    def test_both_status_sets_load_with_kinds_resolved(self):
        for config, initial, terminal in ((CONFIG_A, "open", {"finished"}), (CONFIG_B, "todo", {"done", "dropped"})):
            self.write_config(config)
            model = boardmodel.load_config(self.ws)
            self.assertEqual(model["initial"], initial)
            self.assertEqual(model["terminal"], frozenset(terminal))
            self.assertEqual([s["id"] for s in model["statuses"]], [s["id"] for s in config["statuses"]])

    def test_p03_shape_is_rejected(self):
        self.check_problems(P03_SHAPE, "version", "root")

    def test_status_rules(self):
        dup = json.loads(json.dumps(CONFIG_A))
        dup["statuses"][1]["id"] = "open"
        self.check_problems(dup, "statuses[1].id")
        two_initial = json.loads(json.dumps(CONFIG_A))
        two_initial["statuses"][1] = {"id": "wip", "kind": "initial"}
        self.check_problems(two_initial, "statuses")
        no_done = {"version": 2, "statuses": [{"id": "open", "kind": "initial"}, {"id": "wip"}]}
        self.check_problems(no_done, "statuses")
        bad_kind = json.loads(json.dumps(CONFIG_A))
        bad_kind["statuses"][1]["kind"] = "parked"
        self.check_problems(bad_kind, "statuses[1].kind")
        bad_id = json.loads(json.dumps(CONFIG_A))
        bad_id["statuses"][1]["id"] = "Not A Slug"
        self.check_problems(bad_id, "statuses[1].id")

    def test_ticket_field_rules_and_unknown_keys(self):
        dup = json.loads(json.dumps(CONFIG_B))
        dup["ticketFields"].append({"id": "severity"})
        self.check_problems(dup, "ticketFields[1].id")
        bad_type = json.loads(json.dumps(CONFIG_B))
        bad_type["ticketFields"][0]["type"] = "colour"
        self.check_problems(bad_type, "ticketFields[0].type")
        unknown = json.loads(json.dumps(CONFIG_A))
        unknown["roundLimits"] = {}
        self.check_problems(unknown, "root")

    def test_missing_or_broken_file(self):
        os.remove(os.path.join(self.ws, ".agent-studio", "board.json"))
        with self.assertRaises(AsError) as caught:
            boardmodel.load_config(self.ws)
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")
        with open(os.path.join(self.ws, ".agent-studio", "board.json"), "w") as f:
            f.write("{nope")
        with self.assertRaises(AsError) as caught:
            boardmodel.load_config(self.ws)
        self.assertEqual(caught.exception.code, "BOARD_CONFIG_INVALID")


class TicketTests(BoardCase):
    def test_first_add_creates_default_phase_and_state_once(self):
        self.assertEqual((self.count("board_state"), self.count("phases")), (0, 0))
        first = self.add("one")
        self.assertEqual((self.count("board_state"), self.count("phases")), (1, 1))
        phase = self.conn.execute("SELECT * FROM phases").fetchone()
        self.assertEqual((phase["slug"], phase["name"], phase["position"], phase["status"]),
                         ("default", "Default", 0, "open"))
        self.assertEqual((first["key"], first["status"], first["phase"]), ("T-001", "open", "default"))
        self.assertIsNone(first["assignee"])
        second = self.add("two")
        self.assertEqual((self.count("board_state"), self.count("phases")), (1, 1))
        self.assertEqual(second["key"], "T-002")
        other_ws = self.ws + "-b"
        os.makedirs(os.path.join(other_ws, ".agent-studio"), exist_ok=True)
        with open(os.path.join(other_ws, ".agent-studio", "board.json"), "w") as f:
            json.dump(CONFIG_A, f)
        other = self.add("elsewhere", workspace=other_ws)
        self.assertEqual(other["key"], "T-001")  # per-workspace sequence
        self.assertEqual([e["name"] for e in self.events("T-001")], ["ticket.created"])

    def test_two_status_sets_drive_tickets_without_code_change(self):
        self.write_config(CONFIG_B)
        ticket = self.add("b")
        self.assertEqual(ticket["status"], "todo")
        self.move("T-001", "doing")
        self.move("T-001", "done")
        shown = boardmodel.board_show(self.conn, self.ws)
        columns = shown["phases"][0]["columns"]  # the default phase holds every ticket
        self.assertEqual([c["status"] for c in columns], ["todo", "doing", "review", "done", "dropped"])
        self.assertEqual(columns[3]["tickets"][0]["key"], "T-001")
        self.assertEqual(shown["currentPhase"]["slug"], "default")

    def test_move_rules_and_events(self):
        self.add("a")
        with self.assertRaises(AsError) as caught:
            self.move("T-001", "nowhere")
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")
        self.assertEqual(caught.exception.data["statuses"], ["open", "wip", "finished"])
        with self.assertRaises(AsError) as caught:
            self.move("T-001", "open")
        self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")
        self.move("T-001", "finished")
        before = self.count("ticket_events")
        with self.assertRaises(AsError) as caught:  # stale terminal state without --force
            self.move("T-001", "wip")
        self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")
        self.assertIn("--force", caught.exception.remediation)
        self.assertEqual(self.count("ticket_events"), before)  # refused moves write nothing
        moved = self.move("T-001", "wip", force=True)
        self.assertEqual((moved["from"], moved["ticket"]["status"]), ("finished", "wip"))
        events = self.events("T-001")
        self.assertEqual([(e["name"], e["from_status"], e["to_status"], e["actor"]) for e in events],
                         [("ticket.created", None, "open", "operator"),
                          ("ticket.moved", "open", "finished", "operator"),
                          ("ticket.moved", "finished", "wip", "operator")])

    def test_claimed_ticket_cannot_move_to_another_status(self):
        self.add("claimed")
        assignee = "f" * 8 + "-0000-4000-8000-" + "f" * 12
        self.conn.execute("UPDATE tickets SET assignee = ? WHERE key = 'T-001'", (assignee,))
        with self.assertRaises(AsError) as caught:
            self.move("T-001", "wip")
        self.assertEqual(caught.exception.code, "TICKET_BUSY")
        self.assertEqual(self.conn.execute("SELECT status FROM tickets WHERE key = 'T-001'").fetchone()[0], "open")
        self.assertEqual([event["name"] for event in self.events("T-001")], ["ticket.created"])

    def test_move_to_coordinator_merge_status_reports_activity(self):
        self.write_config({"version": 2, "statuses": [
            {"id": "open", "kind": "initial"}, {"id": "merge"}, {"id": "done", "kind": "done"}],
            "ticketFields": [], "rules": [
                {"when": {"status": "merge"}, "action": "merge", "onPass": "done", "onFail": "open"}]})
        self.add("ready to merge")
        moved = self.move("T-001", "merge")
        self.assertEqual(moved["ticket"]["activity"],
                         {"state": "not started", "waitingFor": "coordinator"})

    def test_closed_is_terminal_too(self):
        self.write_config(CONFIG_B)
        self.add("a")
        self.move("T-001", "dropped")
        with self.assertRaises(AsError) as caught:
            self.move("T-001", "todo")
        self.assertEqual(caught.exception.code, "TICKET_TRANSITION_INVALID")
        self.move("T-001", "todo", force=True)

    def test_unknown_ticket_and_dependencies(self):
        with self.assertRaises(AsError) as caught:
            self.move("T-999", "wip")
        self.assertEqual(caught.exception.code, "TICKET_NOT_FOUND")
        a, b, c = self.add("a"), self.add("b"), self.add("c")
        self.depend("T-001", on=["T-002"])
        self.depend("T-002", on=["T-003"])
        with self.assertRaises(AsError) as caught:  # cycle
            self.depend("T-003", on=["T-001"])
        self.assertEqual(caught.exception.code, "TICKET_DEPENDENCY_CYCLE")
        with self.assertRaises(AsError) as caught:  # self
            self.depend("T-001", on=["T-001"])
        self.assertEqual(caught.exception.code, "TICKET_DEPENDENCY_CYCLE")
        with self.assertRaises(AsError) as caught:  # unknown dependency
            self.depend("T-001", on=["T-999"])
        self.assertEqual(caught.exception.code, "TICKET_NOT_FOUND")
        before = self.count("ticket_events")
        self.depend("T-001", on=["T-002"])  # duplicate edge: no change, no event
        self.depend("T-001", remove=["T-003"])  # not there: no change, no event
        self.assertEqual(self.count("ticket_events"), before)
        detail = boardmodel.ticket_detail(self.conn, self.ws, "T-001")
        self.assertEqual(detail["dependsOn"], ["T-002"])
        self.assertEqual(boardmodel.ticket_detail(self.conn, self.ws, "T-002")["dependents"], ["T-001"])
        self.depend("T-001", remove=["T-002"])
        self.assertEqual(boardmodel.ticket_detail(self.conn, self.ws, "T-001")["dependsOn"], [])

    def test_list_orders_and_filters(self):
        self.add("low", priority=500)
        self.add("high", priority=10)
        self.add("mid", priority=100)
        self.move("T-002", "wip")
        listed = boardmodel.ticket_list(self.conn, self.ws)
        self.assertEqual([t["key"] for t in listed["tickets"]], ["T-002", "T-003", "T-001"])  # wip first
        self.assertEqual([t["key"] for t in boardmodel.ticket_list(self.conn, self.ws, "open")["tickets"]],
                         ["T-003", "T-001"])
        with self.assertRaises(AsError) as caught:
            boardmodel.ticket_list(self.conn, self.ws, "nowhere")
        self.assertEqual(caught.exception.code, "BOARD_STATUS_UNKNOWN")

    def test_board_show_groups_in_config_order(self):
        self.add("a")
        self.add("b")
        self.move("T-002", "finished")
        shown = boardmodel.board_show(self.conn, self.ws)
        self.assertEqual([(p["slug"], p["ticketCount"]) for p in shown["phases"]], [("default", 2)])
        columns = shown["phases"][0]["columns"]
        self.assertEqual([c["status"] for c in columns], ["open", "wip", "finished"])
        self.assertEqual([(c["count"], [t["key"] for t in c["tickets"]]) for c in columns],
                         [(1, ["T-001"]), (0, []), (1, ["T-002"])])
        self.assertTrue(shown["phases"][0]["current"])


class DispatchTests(BoardCase):
    def test_validators(self):
        ws = os.path.realpath(self.ws)
        self.assertEqual(dispatch._validate_ticket_add({"workspace": ws, "title": "x"}),
                         {"workspace": ws, "title": "x", "priority": 100})
        for bad in ({"workspace": ws}, {"workspace": ws, "title": ""}):
            with self.assertRaises(AsError):
                dispatch._validate_ticket_add(bad)
        with self.assertRaises(AsError) as caught:
            dispatch._validate_ticket_depend({"workspace": ws, "key": "T-001", "on": ["T-002"],
                                              "remove": ["T-002"]})
        self.assertEqual(caught.exception.code, "BAD_REQUEST")
        with self.assertRaises(AsError):
            dispatch._validate_ticket_move({"workspace": ws, "key": "T1", "to": "wip"})

    def test_command_table_has_exactly_the_board_commands(self):
        """S07 added the generic ticket commands; S08 ticket.phase and phase.*; S09 ticket.apply/unblock;
        S10 board.run/board.stop. The P03 scheduler and operator commands stay gone."""
        for name in ("ticket.add", "ticket.move", "ticket.depend", "ticket.show", "ticket.list",
                     "ticket.phase", "ticket.apply", "ticket.unblock", "board.show", "board.run",
                     "board.stop"):
            self.assertIn(name, dispatch.COMMANDS)
        self.assertEqual(sorted(n for n in dispatch.COMMANDS if n.startswith("ticket.")),
                         ["ticket.add", "ticket.apply", "ticket.depend", "ticket.list", "ticket.move",
                          "ticket.phase", "ticket.retry", "ticket.show", "ticket.unblock", "ticket.update"])
        self.assertEqual(sorted(n for n in dispatch.COMMANDS if n.startswith("phase.")),
                         ["phase.add", "phase.clear-current", "phase.close", "phase.edit", "phase.list",
                          "phase.remove", "phase.reopen", "phase.set-current", "phase.show"])
        for name in ("ticket.start", "ticket.cancel", "ticket.create", "board.pause"):
            self.assertNotIn(name, dispatch.COMMANDS)


class CliTests(BoardCase):
    def run_cli(self, reply, *argv):
        import contextlib
        import io
        from unittest import mock

        def fake(req, require_id=False):
            return reply(req)

        raw, err = io.BytesIO(), io.StringIO()
        out = io.TextIOWrapper(raw, encoding="utf-8", write_through=True)
        with mock.patch("agent_studio.dispatch.handle_request", fake), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = cli.main(list(argv))
        return rc, raw.getvalue().decode(), err.getvalue()

    def test_human_and_json_output(self):
        ticket = {"key": "T-001", "title": "Write it", "status": "open", "priority": 100, "phase": "default",
                  "phaseName": "Default", "assignee": None, "body": None, "leaseUntil": None}
        def reply(req):
            self.assertEqual(req["command"], "ticket.add")
            self.assertTrue(req["idempotencyKey"])
            return {"ok": True, "data": {"ticket": ticket, "phase": {"slug": "default", "name": "Default"}}}
        rc, out, err = self.run_cli(reply, "ticket", "add", "--workspace", self.ws, "--title", "Write it")
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(out, "added T-001 to phase Default (status open, priority 100): Write it\n")
        rc, out, _ = self.run_cli(reply, "ticket", "add", "--workspace", self.ws, "--title", "Write it", "--json")
        self.assertEqual(json.loads(out)["data"]["ticket"]["key"], "T-001")

        def fail(req):
            return {"ok": False, "error": {"code": "BOARD_STATUS_UNKNOWN", "message": "no", "retryable": False,
                                           "remediation": "pick from the board"}}
        rc, out, err = self.run_cli(fail, "ticket", "move", "--workspace", self.ws, "T-001", "--to", "x")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("BOARD_STATUS_UNKNOWN: no"), err)
        self.assertIn("pick from the board", err)

    def test_board_show_human_output(self):
        ticket = {"key": "T-001", "title": "One", "status": "todo", "priority": 100, "phase": "default",
                  "phaseName": "Default"}
        data = {"workspace": self.ws, "currentPhase": {"slug": "default", "name": "Default"},
                "phases": [
                    {"slug": "default", "name": "Default", "description": None, "position": 0, "status": "open",
                     "current": True, "ticketCount": 1,
                     "columns": [{"status": "todo", "kind": "initial", "title": "todo", "count": 1,
                                  "tickets": [ticket]},
                                 {"status": "doing", "kind": None, "title": "doing", "count": 0, "tickets": []}]},
                    {"slug": "later", "name": "Later", "description": None, "position": 1, "status": "closed",
                     "current": False, "ticketCount": 0, "columns": []}]}
        rc, out, err = self.run_cli(lambda req: {"ok": True, "data": data}, "board", "show",
                                    "--workspace", self.ws)
        self.assertEqual((rc, err), (0, ""))
        self.assertIn("current phase: Default", out)
        self.assertIn("default  Default  (current)", out)
        self.assertIn("todo (1) [initial]", out)
        self.assertIn("T-001", out)
        self.assertIn("later  Later  [closed]", out)
        self.assertIn("(no tickets)", out)

    def test_depend_needs_on_or_remove(self):
        rc, out, err = self.run_cli(lambda req: {"ok": True}, "ticket", "depend", "--workspace", self.ws, "T-001")
        self.assertEqual(rc, 1)
        self.assertTrue(err.startswith("BAD_REQUEST:"), err)


class NoNamesInBoardCode(unittest.TestCase):
    """The board modules name no role, provider, status or host command (design contract §D). The words
    'workflow', 'branch' and 'merge' are allowed since S09/S10: they are rules-schema keys
    (`rules[].workflow`, the top-level `baseBranch`, the `merge` action) — the board still cannot hardcode
    a specific workflow, role, branch name or host command."""

    FORBIDDEN = re.compile(r"\b(developer|reviewer|teamlead|qa|codex|claude|agy|opencode|fake|develop|final|"
                           r"tests|git|commit)\b", re.I)

    def words(self, node):
        skip = set()
        for n in ast.walk(node):
            if isinstance(n, (ast.FunctionDef, ast.ClassDef, ast.Module)) and n.body \
                    and isinstance(n.body[0], ast.Expr) and isinstance(getattr(n.body[0], "value", None), ast.Constant):
                skip.add(id(n.body[0].value))
        for n in ast.walk(node):
            if isinstance(n, ast.Name):
                yield n.id
            elif isinstance(n, ast.Attribute):
                yield n.attr
            elif isinstance(n, ast.Constant) and isinstance(n.value, str) and id(n) not in skip:
                yield n.value

    def test_board_modules_are_clean(self):
        import agent_studio
        for name in ("boardmodel.py", "boardcli.py"):
            path = os.path.join(os.path.dirname(agent_studio.__file__), name)
            with open(path, encoding="utf-8") as f:
                tree = ast.parse(f.read(), filename=name)
            hits = sorted({m.group(0) for w in self.words(tree) for m in [self.FORBIDDEN.search(w)] if m})
            self.assertEqual(hits, [], name)


if __name__ == "__main__":
    unittest.main()
